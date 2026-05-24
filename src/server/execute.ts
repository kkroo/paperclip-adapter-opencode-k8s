import type { AdapterExecutionContext, AdapterExecutionResult } from "@paperclipai/adapter-utils";
import { inferOpenAiCompatibleBiller } from "@paperclipai/adapter-utils";
import { asString, asNumber, asBoolean, parseObject, readPaperclipRuntimeSkillEntries, resolvePaperclipDesiredSkillNames } from "@paperclipai/adapter-utils/server-utils";
import { readFile, open as fsOpen, stat as fsStat, writeFile as fsWriteFile, mkdtemp, type FileHandle } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  parseOpenCodeJsonl,
  isOpenCodeUnknownSessionError,
  isOpenCodeStepLimitResult,
  isOpenCodeContextOverflowResult,
} from "./parse.js";
import { getSelfPodInfo, getBatchApi, getCoreApi, getLogApi, getPvc, createPvc } from "./k8s-client.js";
import { PassThrough } from "node:stream";
import { buildJobManifest, LARGE_PROMPT_THRESHOLD_BYTES, buildPodLogPath } from "./job-manifest.js";
import type * as k8s from "@kubernetes/client-node";

const POLL_INTERVAL_MS = 2000;
const KEEPALIVE_INTERVAL_MS = 15_000;
const LOG_EXIT_COMPLETION_GRACE_MS = parseInt(process.env.LOG_EXIT_COMPLETION_GRACE_MS ?? "30000", 10);

type BudgetAgentSnapshot = {
  id: string;
  name?: string | null;
  spentMonthlyCents?: number | null;
  budgetMonthlyCents?: number | null;
  pauseReason?: string | null;
  pausedAt?: string | null;
};

// Single source of truth lives in @paperclipai/adapter-utils. Re-exported
// so existing test imports (`from "./execute.js"`) keep working.
import { mergeEnvironmentConfig } from "@paperclipai/adapter-utils";
export { mergeEnvironmentConfig };

/**
 * Materialize a kubeconfig string (env-supplied content) onto disk so the
 * existing kube client builders (which take a path) can consume it. Cached
 * per content hash so repeated execute() calls with the same env config
 * don't churn temp files. Returns the path; never throws — callers fall back
 * to in-cluster auth if this returns null.
 */
const kubeconfigPathCache = new Map<string, string>();
async function materializeKubeconfigContent(content: string): Promise<string | null> {
  const cached = kubeconfigPathCache.get(content);
  if (cached) return cached;
  try {
    const dir = await mkdtemp(path.join(tmpdir(), "opencode-k8s-kc-"));
    const file = path.join(dir, "kubeconfig");
    await fsWriteFile(file, content, { mode: 0o600 });
    kubeconfigPathCache.set(content, file);
    return file;
  } catch {
    return null;
  }
}

/**
 * Read the optional `executionTarget` field from an adapter execution context.
 * Older `@paperclipai/adapter-utils` releases don't yet declare this field on
 * `AdapterExecutionContext`, so we cast through unknown and validate at runtime.
 */
function readExecutionTarget(ctx: AdapterExecutionContext): {
  kind: string;
  transport?: string;
  config?: Record<string, unknown> | null;
} | null {
  const target = (ctx as unknown as Record<string, unknown>).executionTarget;
  if (!target || typeof target !== "object") return null;
  const t = target as Record<string, unknown>;
  if (typeof t.kind !== "string") return null;
  return {
    kind: t.kind,
    transport: typeof t.transport === "string" ? t.transport : undefined,
    config: t.config && typeof t.config === "object" ? (t.config as Record<string, unknown>) : null,
  };
}

export function isK8s404(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const asAny = err as unknown as Record<string, unknown>;
  // @kubernetes/client-node v1.x ApiException exposes HTTP status as `code`.
  if (typeof asAny.code === "number" && asAny.code === 404) return true;
  if (typeof asAny.statusCode === "number" && asAny.statusCode === 404) return true;
  const resp = asAny.response as Record<string, unknown> | undefined;
  if (typeof resp?.statusCode === "number" && resp.statusCode === 404) return true;
  return false;
}

// Map a bare model id (no `provider/` prefix) to a provider by name prefix.
// opencode accepts both `openai/gpt-5` and bare `gpt-5`; without this fallback
// the heartbeat ledger lands at provider="unknown" for any agent that doesn't
// set adapter_config.model in canonical `provider/model` form.
function inferProviderFromBareModelId(model: string): string | null {
  const lower = model.trim().toLowerCase();
  if (!lower) return null;
  if (/^(gpt[-.]|chatgpt[-.]|o\d+(-|$)|codex[-.]?)/.test(lower)) return "openai";
  if (/^(claude[-.]|sonnet|haiku|opus)/.test(lower)) return "anthropic";
  if (/^gemini[-.]/.test(lower)) return "google";
  return null;
}

export function parseModelProvider(model: string | null): string | null {
  if (!model) return null;
  const trimmed = model.trim();
  if (trimmed.includes("/")) {
    return trimmed.slice(0, trimmed.indexOf("/")).trim() || null;
  }
  return inferProviderFromBareModelId(trimmed);
}

function isTransientVolumeSchedulingMessage(message: string): boolean {
  return /unbound immediate persistentvolumeclaims|waiting for a volume|pvc|persistentvolumeclaim|volume.*bind/i.test(message);
}

function centsToDollars(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

function readBudgetAgentSnapshot(raw: unknown): BudgetAgentSnapshot | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;
  const id = asString(obj.id, "").trim();
  if (!id) return null;
  return {
    id,
    name: asString(obj.name, "") || null,
    spentMonthlyCents: typeof obj.spentMonthlyCents === "number" ? obj.spentMonthlyCents : null,
    budgetMonthlyCents: typeof obj.budgetMonthlyCents === "number" ? obj.budgetMonthlyCents : null,
    pauseReason: asString(obj.pauseReason, "") || null,
    pausedAt: asString(obj.pausedAt, "") || null,
  };
}

async function fetchCurrentAgentSnapshot(ctx: AdapterExecutionContext): Promise<BudgetAgentSnapshot | null> {
  const apiUrl = process.env.PAPERCLIP_API_URL?.replace(/\/+$/, "");
  const agentFromContext = readBudgetAgentSnapshot(ctx.agent);
  if (!apiUrl) return agentFromContext;

  try {
    const resp = await fetch(`${apiUrl}/api/agents/${encodeURIComponent(ctx.agent.id)}`, {
      headers: { Authorization: `Bearer ${ctx.authToken ?? ""}` },
    });
    if (!resp.ok) return agentFromContext;
    return readBudgetAgentSnapshot(await resp.json()) ?? agentFromContext;
  } catch {
    return agentFromContext;
  }
}

async function pauseAgentForBudgetExceeded(
  ctx: AdapterExecutionContext,
  agent: BudgetAgentSnapshot,
  crossedAt: string,
  pauseReason: string,
): Promise<void> {
  const apiUrl = process.env.PAPERCLIP_API_URL?.replace(/\/+$/, "");
  if (!apiUrl) return;

  const headers = {
    Authorization: `Bearer ${ctx.authToken ?? ""}`,
    "Content-Type": "application/json",
  };

  await fetch(`${apiUrl}/api/agents/${encodeURIComponent(agent.id)}`, {
    method: "PATCH",
    headers,
    body: JSON.stringify({ pauseReason, pausedAt: crossedAt }),
  });
}

async function postBudgetExceededComment(
  ctx: AdapterExecutionContext,
  agent: BudgetAgentSnapshot,
  crossedAt: string,
): Promise<void> {
  const apiUrl = process.env.PAPERCLIP_API_URL?.replace(/\/+$/, "");
  const issueId = asString(ctx.context.issueId ?? ctx.context.taskId, "").trim();
  if (!apiUrl || !issueId) return;

  const spent = agent.spentMonthlyCents ?? 0;
  const budget = agent.budgetMonthlyCents ?? 0;
  const over = spent - budget;
  const body = [
    "## Budget exceeded",
    "",
    `Agent ${agent.name ?? agent.id} is paused because it crossed its monthly budget cap.`,
    "",
    `- Spend: ${centsToDollars(spent)} spent / ${centsToDollars(budget)} cap`,
    `- Over cap: ${centsToDollars(over)}`,
    `- Detected at: ${crossedAt}`,
    "- Next action: bump the budget or explicitly unpause the agent before resuming work.",
  ].join("\n");

  await fetch(`${apiUrl}/api/issues/${encodeURIComponent(issueId)}/comments`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${ctx.authToken ?? ""}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ body }),
  });
}

async function enforceBudgetCapBeforeRun(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult | null> {
  const agent = await fetchCurrentAgentSnapshot(ctx);
  const spent = agent?.spentMonthlyCents;
  const budget = agent?.budgetMonthlyCents;
  if (!agent || spent == null || budget == null || spent <= budget || agent.pauseReason || agent.pausedAt) {
    return null;
  }

  const crossedAt = new Date().toISOString();
  const pauseReason = `budget exceeded: ${centsToDollars(spent)} spent / ${centsToDollars(budget)} cap`;

  try {
    await pauseAgentForBudgetExceeded(ctx, agent, crossedAt, pauseReason);
  } catch {
    // The safety gate still fails the run even if persisting the pause fails.
  }

  try {
    await postBudgetExceededComment(ctx, agent, crossedAt);
  } catch {
    // Non-fatal: failing closed matters more than the escalation receipt.
  }

  await ctx.onLog(
    "stderr",
    `[paperclip] Budget exceeded for agent ${agent.name ?? agent.id}: ${centsToDollars(spent)} spent / ${centsToDollars(budget)} cap. Run blocked before Job creation.\n`,
  );

  return {
    exitCode: null,
    signal: null,
    timedOut: false,
    errorMessage: `Budget exceeded: ${centsToDollars(spent)} spent / ${centsToDollars(budget)} cap`,
    errorCode: "budget_exceeded",
    errorMeta: {
      agentId: agent.id,
      spentMonthlyCents: spent,
      budgetMonthlyCents: budget,
      detectedAt: crossedAt,
    },
  };
}

async function waitForPod(
  namespace: string,
  jobName: string,
  timeoutMs: number,
  onLog: AdapterExecutionContext["onLog"],
  kubeconfigPath?: string,
): Promise<string> {
  const coreApi = getCoreApi(kubeconfigPath);
  const deadline = Date.now() + timeoutMs;
  const labelSelector = `job-name=${jobName}`;

  await onLog("stdout", `[paperclip] Waiting for pod to be scheduled (job: ${jobName})...\n`);

  let lastStatus = "";
  let lastUnschedulableMessage = "";
  while (Date.now() < deadline) {
    const podList = await coreApi.listNamespacedPod({
      namespace,
      labelSelector,
    });
    const pod = podList.items[0];

    if (!pod) {
      if (lastStatus !== "no-pod") {
        await onLog("stdout", `[paperclip] Waiting for Job controller to create pod...\n`);
        lastStatus = "no-pod";
      }
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
      continue;
    }

    const podName = pod.metadata?.name ?? "unknown";
    const phase = pod.status?.phase ?? "Unknown";
    const initStatuses = pod.status?.initContainerStatuses ?? [];
    const containerStatuses = pod.status?.containerStatuses ?? [];

    const statusKey = `${phase}:${initStatuses.map((s) => s.state?.waiting?.reason ?? s.state?.terminated?.reason ?? "ok").join(",")}:${containerStatuses.map((s) => s.state?.waiting?.reason ?? s.state?.running ? "running" : "waiting").join(",")}`;
    if (statusKey !== lastStatus) {
      const details: string[] = [`phase=${phase}`];
      for (const init of initStatuses) {
        if (init.state?.waiting) details.push(`init/${init.name}: waiting (${init.state.waiting.reason ?? "unknown"})`);
        else if (init.state?.running) details.push(`init/${init.name}: running`);
        else if (init.state?.terminated) details.push(`init/${init.name}: done (exit ${init.state.terminated.exitCode})`);
      }
      for (const cs of containerStatuses) {
        if (cs.state?.waiting) details.push(`${cs.name}: waiting (${cs.state.waiting.reason ?? "unknown"})`);
        else if (cs.state?.running) details.push(`${cs.name}: running`);
      }
      await onLog("stdout", `[paperclip] Pod ${podName}: ${details.join(", ")}\n`);
      lastStatus = statusKey;
    }

    if (phase === "Running" || phase === "Succeeded" || phase === "Failed") {
      return podName;
    }

    const allInitsDone = initStatuses.length > 0 && initStatuses.every(
      (s) => s.state?.terminated?.exitCode === 0,
    );
    const mainRunning = containerStatuses.some((s) => s.state?.running);
    if (allInitsDone && mainRunning) {
      return podName;
    }

    for (const init of initStatuses) {
      const terminated = init.state?.terminated;
      if (terminated && (terminated.exitCode ?? 0) !== 0) {
        throw new Error(`Init container "${init.name}" failed with exit code ${terminated.exitCode}: ${terminated.reason ?? terminated.message ?? "unknown"}`);
      }
      const waiting = init.state?.waiting;
      if (waiting?.reason === "ErrImagePull" || waiting?.reason === "ImagePullBackOff") {
        throw new Error(`Init container "${init.name}" image pull failed: ${waiting.message ?? waiting.reason}`);
      }
      if (waiting?.reason === "CrashLoopBackOff") {
        throw new Error(`Init container "${init.name}" crash loop: ${waiting.message ?? waiting.reason}`);
      }
    }

    const conditions = pod.status?.conditions ?? [];
    const unschedulable = conditions.find(
      (c) => c.type === "PodScheduled" && c.status === "False" && c.reason === "Unschedulable",
    );
    if (unschedulable) {
      const msg = unschedulable.message ?? "insufficient resources";
      if (isTransientVolumeSchedulingMessage(msg)) {
        if (msg !== lastUnschedulableMessage) {
          await onLog("stdout", `[paperclip] Waiting for PVC/volume binding before scheduling: ${msg}\n`);
          lastUnschedulableMessage = msg;
        }
        await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
        continue;
      }
      throw new Error(`Pod unschedulable: ${msg}`);
    }

    for (const cs of containerStatuses) {
      const waiting = cs.state?.waiting;
      if (waiting?.reason === "ErrImagePull" || waiting?.reason === "ImagePullBackOff") {
        throw new Error(`Image pull failed for "${cs.name}": ${waiting.message ?? waiting.reason}`);
      }
      if (waiting?.reason === "CrashLoopBackOff") {
        throw new Error(`Container "${cs.name}" crash loop: ${waiting.message ?? waiting.reason}`);
      }
      if (waiting?.reason === "MountVolumeFailed" || waiting?.reason === "ContainerCannotMount") {
        throw new Error(`Volume mount failed for "${cs.name}": ${waiting.message ?? waiting.reason}`);
      }
    }

    for (const cs of containerStatuses) {
      const terminated = cs.state?.terminated;
      if (terminated?.exitCode !== undefined && terminated.exitCode !== 0) {
        if (terminated.reason === "ContainerCannotMount" || terminated.reason === "MountVolumeFailed") {
          throw new Error(`Volume mount failed for "${cs.name}": ${terminated.message ?? terminated.reason}`);
        }
      }
    }

    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }

  throw new Error(`Timed out waiting for pod to be scheduled (${Math.round(timeoutMs / 1000)}s)`);
}

export type JobCompletionResult = { succeeded: boolean; timedOut: boolean; jobGone: boolean };

async function waitForJobCompletion(
  namespace: string,
  jobName: string,
  timeoutMs: number,
  kubeconfigPath?: string,
): Promise<JobCompletionResult> {
  const batchApi = getBatchApi(kubeconfigPath);
  const deadline = timeoutMs > 0 ? Date.now() + timeoutMs : 0;

  while (true) {
    if (deadline > 0 && Date.now() >= deadline) {
      return { succeeded: false, timedOut: true, jobGone: false };
    }
    let job: Awaited<ReturnType<typeof batchApi.readNamespacedJob>>;
    try {
      job = await batchApi.readNamespacedJob({ name: jobName, namespace });
    } catch (err) {
      if (isK8s404(err)) return { succeeded: false, timedOut: false, jobGone: true };
      throw err;
    }
    const conditions = job.status?.conditions ?? [];

    const complete = conditions.find((c) => c.type === "Complete" && c.status === "True");
    if (complete) return { succeeded: true, timedOut: false, jobGone: false };

    const failed = conditions.find((c) => c.type === "Failed" && c.status === "True");
    if (failed) {
      const isDeadlineExceeded = failed.reason === "DeadlineExceeded";
      return { succeeded: false, timedOut: isDeadlineExceeded, jobGone: false };
    }

    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
}

export async function completionWithGrace(
  completionPromise: Promise<JobCompletionResult>,
  graceMs: number,
): Promise<JobCompletionResult> {
  // graceMs <= 0 disables the cap entirely.  Without this guard a graceMs of 0
  // arms a setTimeout(_, 0) that fires on the next tick with timedOut=true and
  // wins the race against any in-flight job — turning "no timeout configured"
  // into a 0-second deadline (BLO-2436).
  if (graceMs <= 0) {
    try {
      return await completionPromise;
    } catch {
      return { succeeded: false, timedOut: true, jobGone: false };
    }
  }
  const graceExpired = new Promise<JobCompletionResult>(
    (resolve) => setTimeout(() => resolve({ succeeded: false, timedOut: true, jobGone: false }), graceMs),
  );
  try {
    return await Promise.race([completionPromise, graceExpired]);
  } catch {
    return { succeeded: false, timedOut: true, jobGone: false };
  }
}

async function getPodTerminatedInfo(
  namespace: string,
  jobName: string,
  kubeconfigPath?: string,
): Promise<{ exitCode: number | null; reason: string | null }> {
  const coreApi = getCoreApi(kubeconfigPath);
  const podList = await coreApi.listNamespacedPod({
    namespace,
    labelSelector: `job-name=${jobName}`,
  });
  const pod = podList.items[0];
  if (!pod) return { exitCode: null, reason: null };
  const containerStatus = pod.status?.containerStatuses?.find((s) => s.name === "opencode");
  const terminated = containerStatus?.state?.terminated;
  return {
    exitCode: terminated?.exitCode ?? null,
    reason: terminated?.reason ?? terminated?.message ?? null,
  };
}

interface TailOptions {
  onLog: AdapterExecutionContext["onLog"];
  stopSignal: { stopped: boolean };
}

/**
 * Tail the pod's stdout log file from the shared PVC.
 *
 * Polls the file system with adaptive cadence: 250 ms while the file is
 * growing, backing off to 1000 ms when idle for 5 consecutive polls.
 * Buffers partial lines and emits complete lines to onLog.
 */
export async function tailPodLogFile(
  filePath: string,
  opts: TailOptions,
): Promise<string> {
  const { onLog, stopSignal } = opts;
  const FILE_WAIT_TIMEOUT_MS = 30_000;
  const POLL_ACTIVE_MS = 250;
  const POLL_IDLE_MS = 1000;
  const IDLE_THRESHOLD = 5; // consecutive idle polls before backing off

  // Wait up to 30s for the file to appear
  const waitDeadline = Date.now() + FILE_WAIT_TIMEOUT_MS;
  while (Date.now() < waitDeadline) {
    try {
      await import("node:fs/promises").then((fs) => fs.stat(filePath));
      break; // file exists
    } catch {
      if (stopSignal.stopped) return "";
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    }
  }

  // Sanity-check existence before entering the loop; the loop reopens per
  // poll so we don't hold an fh that would cache stale data on CephFS.
  try {
    await fsStat(filePath);
  } catch {
    throw new Error(`Pod log file never appeared at ${filePath}`);
  }

  let offset = 0;
  let pending = "";
  let idleCount = 0;
  const accumulator: string[] = [];

  // The pod-side `tee` and this paperclip-side reader are separate CephFS
  // clients. A held FileHandle's data cap on the reader side does not
  // invalidate when the writer extends the file — both `fh.stat()` and
  // `fh.read(...)` will return the cached metadata + cached data from the
  // moment the handle was opened, even after the writer has flushed
  // hundreds of KB. We observed `<runId>.pod.ndjson` at 73 KiB / 107 KiB
  // with real opencode JSONL on disk while paperclip's `<runId>.ndjson`
  // (the run-log-store onLog target) had only `[paperclip] keepalive`
  // lines, because tail's drain loop kept seeing size=0 / bytesRead=0 on
  // the held fh.
  //
  // Open and close a fresh file handle per poll so each read goes through
  // the kernel's dentry/MDS path and pulls fresh data caps from CephFS.
  // Open + read + close is cheap on a single-digit-KB-per-poll write rate
  // and the alternative (kubectl logs streaming) would require a full
  // refactor of the tail interface.
  let firstGrowthLogged = false;
  const drain = async (): Promise<boolean> => {
    let fh: FileHandle | undefined;
    try {
      fh = await fsOpen(filePath, "r");
      const stat = await fh.stat();
      const size = stat.size;
      if (size <= offset) return false;
      const buf = Buffer.alloc(size - offset);
      const { bytesRead } = await fh.read(buf, 0, buf.length, offset);
      // Surface diagnostic on the FIRST poll where stat says the file grew
      // beyond `offset`. If we keep seeing growth-with-zero-bytes-read, that
      // is the smoking gun for CephFS data caching even after fresh open.
      if (!firstGrowthLogged) {
        firstGrowthLogged = true;
        try {
          await onLog(
            "stderr",
            `[paperclip] tail first-growth stat.size=${size} offset=${offset} bytesRead=${bytesRead}\n`,
          );
        } catch {
          /* non-fatal */
        }
      }
      offset += bytesRead;
      const chunk = buf.slice(0, bytesRead).toString("utf-8");
      const lineParts = (pending + chunk).split("\n");
      pending = lineParts.pop() ?? "";
      for (const line of lineParts) {
        await onLog("stdout", line + "\n");
        accumulator.push(line + "\n");
      }
      return bytesRead > 0;
    } catch (err) {
      // Best-effort drain — a transient open / read error must not kill the
      // outer poll loop. Swallow and let the next poll retry; if the failure
      // mode persists, the run-log will show only `[paperclip] keepalive`
      // lines (matching pre-fix behavior) rather than going completely
      // silent because tailPodLogFile threw out of `Promise.allSettled`.
      const message = err instanceof Error ? err.message : String(err);
      try {
        await onLog(
          "stderr",
          `[paperclip] tail drain error (will retry): ${message}\n`,
        );
      } catch {
        // onLog itself can fail; ignore.
      }
      return false;
    } finally {
      if (fh !== undefined) {
        await fh.close().catch(() => undefined);
      }
    }
  };

  while (!stopSignal.stopped) {
    const grew = await drain();
    if (grew) {
      idleCount = 0;
    } else {
      idleCount++;
    }
    if (stopSignal.stopped) break;
    const pollMs = idleCount >= IDLE_THRESHOLD ? POLL_IDLE_MS : POLL_ACTIVE_MS;
    await new Promise((r) => setTimeout(r, pollMs));
  }

  // Final drain after stopSignal — pick up any bytes written between the
  // last read and the job reaching terminal state.
  while (await drain()) { /* read until no more growth */ }

  if (pending) {
    await onLog("stdout", pending + "\n");
    accumulator.push(pending + "\n");
  }

  return accumulator.join("");
}

/**
 * Stream pod container logs via the Kubernetes API instead of polling the
 * tee'd PVC file. Solves the cephfs cross-client stale-stat problem that
 * silently truncated long agent runs to their first ~300 bytes of output.
 *
 * Background (2026-05-15 debugging session): paperclip-0 and the agent
 * pod are separate cephfs clients sharing the same RWX `paperclip-data`
 * PVC. Even with `open + stat + read + close` per poll, paperclip's stat
 * cap stayed pinned at the size from the moment the file first appeared.
 * The hundreds of KB the pod kept tee-ing past that point were on disk
 * and visible from the pod's perspective, but `fh.stat().size` from
 * paperclip-0 reported `304` forever — so the drain loop's
 * `if (size <= offset) return false;` short-circuited every subsequent
 * poll. The `tail first-growth stat.size=304 offset=0 bytesRead=304`
 * diagnostic across hundreds of Staff Engineer run-logs confirmed this.
 *
 * Switching to the kubelet's container-log streaming endpoint sidesteps
 * cephfs entirely: kubelet reads the container's stdout from its
 * runtime-level capture (containerd's log file on the agent node) and
 * proxies it through the API server. Both writer and reader see the
 * same authoritative byte stream, end of story.
 *
 * The pod-side `tee -a <podLogPath>` is left in place by job-manifest.ts
 * as forensic backup (operators can still `cat` the file when the API
 * is unavailable), but this function does not depend on it.
 */
export async function tailPodContainerLogs(
  namespace: string,
  podName: string,
  containerName: string,
  opts: TailOptions & { kubeconfigPath?: string },
): Promise<string> {
  const { onLog, stopSignal, kubeconfigPath } = opts;
  const STOP_POLL_MS = 250;
  const DRAIN_AFTER_STOP_MS = 1000;

  // The caller (streamAndAwaitJob) already resolved the pod name via
  // waitForPod() before calling us — by the time we run, the container
  // is in Running phase (or terminal). No need to re-poll listNamespacedPod
  // here; the @kubernetes/client-node Log API will block-and-retry until
  // the container log buffer is readable.

  const logApi = getLogApi(kubeconfigPath);
  const accumulator: string[] = [];
  let pending = "";
  let firstByteLogged = false;
  let streamEnded = false;

  // PassThrough acts as the Writable sink that @kubernetes/client-node's
  // Log.log() writes the proxied container output into. We split on
  // newlines and emit each complete line via onLog so heartbeat-side
  // parsing sees them in the same shape it would from the polled file.
  const stream = new PassThrough();
  stream.setEncoding("utf-8");
  stream.on("data", (chunk: string) => {
    if (!firstByteLogged) {
      firstByteLogged = true;
      void onLog("stderr", `[paperclip] kubectl-logs stream live (first chunk ${chunk.length}B)\n`).catch(
        () => undefined,
      );
    }
    const lineParts = (pending + chunk).split("\n");
    pending = lineParts.pop() ?? "";
    for (const line of lineParts) {
      void onLog("stdout", line + "\n").catch(() => undefined);
      accumulator.push(line + "\n");
    }
  });
  stream.on("end", () => {
    streamEnded = true;
  });

  let abortController: AbortController | undefined;
  try {
    abortController = await logApi.log(namespace, podName, containerName, stream, { follow: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to open log stream for ${namespace}/${podName}/${containerName}: ${message}`);
  }

  // Hold the function open until the heartbeat caller flips stopSignal
  // (waitForJobCompletion fired) OR the underlying stream ends on its
  // own (container terminated and kubelet closed the connection).
  while (!stopSignal.stopped && !streamEnded) {
    await new Promise((r) => setTimeout(r, STOP_POLL_MS));
  }

  // Give kubelet a moment to flush the tail of the buffer before we
  // abort the connection. Without this, the last few hundred bytes of
  // a fast-exiting container are sometimes dropped on the floor.
  await new Promise((r) => setTimeout(r, DRAIN_AFTER_STOP_MS));

  try {
    abortController?.abort();
  } catch {
    /* non-fatal */
  }

  if (pending) {
    await onLog("stdout", pending + "\n").catch(() => undefined);
    accumulator.push(pending + "\n");
  }

  return accumulator.join("");
}

async function cleanupJob(
  namespace: string,
  jobName: string,
  onLog: AdapterExecutionContext["onLog"],
  kubeconfigPath?: string,
  promptSecretName?: string,
  podLogPath?: string,
): Promise<void> {
  try {
    const batchApi = getBatchApi(kubeconfigPath);
    await batchApi.deleteNamespacedJob({
      name: jobName,
      namespace,
      body: { propagationPolicy: "Background" },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await onLog("stderr", `[paperclip] Warning: failed to cleanup job ${jobName}: ${msg}\n`);
  }
  if (promptSecretName) {
    try {
      const coreApi = getCoreApi(kubeconfigPath);
      await coreApi.deleteNamespacedSecret({ name: promptSecretName, namespace });
    } catch {
      // best-effort — Secret may already be GC'd via ownerReference
    }
  }
  if (podLogPath) {
    try {
      const { unlink } = await import("node:fs/promises");
      await unlink(podLogPath);
    } catch {
      // non-fatal
    }
  }
}

/**
 * Tail the pod log file and await completion for an already-created Job.
 */
async function streamAndAwaitJob(
  ctx: AdapterExecutionContext,
  jobName: string,
  namespace: string,
  timeoutSec: number,
  graceSec: number,
  kubeconfigPath: string | undefined,
  retainJobs: boolean,
  podLogPath: string,
  promptSecretName?: string,
): Promise<AdapterExecutionResult> {
  const { onLog } = ctx;
  const config = parseObject(ctx.config);
  const model = asString(config.model, "").trim();

  let stdout = "";
  let exitCode: number | null = null;
  let jobTimedOut = false;
  let podTerminatedReason: string | null = null;
  let keepaliveTimer: ReturnType<typeof setInterval> | null = null;
  const cancelSignal = { cancelled: false };

  try {
    const scheduleTimeoutMs = 120_000;
    let podName: string;
    try {
      podName = await waitForPod(namespace, jobName, scheduleTimeoutMs, onLog, kubeconfigPath);
      await onLog("stdout", `[paperclip] Pod running: ${podName}\n`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await onLog("stderr", `[paperclip] Pod scheduling failed: ${msg}\n`);
      return {
        exitCode: null,
        signal: null,
        timedOut: false,
        errorMessage: `Pod scheduling failed: ${msg}`,
        errorCode: "k8s_pod_schedule_failed",
      };
    }

    const completionTimeoutMs = timeoutSec > 0 ? (timeoutSec + graceSec) * 1000 : 0;
    const stopSignal = { stopped: false };

    const issueId = asString(ctx.context.issueId ?? ctx.context.taskId, "").trim();
    let lastLogAt = Date.now();
    let keepaliveJobTerminal = false;
    let consecutiveTerminalReadings = 0;
    keepaliveTimer = setInterval(() => {
      void (async () => {
        if (keepaliveJobTerminal || cancelSignal.cancelled) return;

        // Require two consecutive terminal readings before latching to
        // guard against a stale K8s API cache returning a false terminal
        // status on a single read.
        try {
          const j = await getBatchApi(kubeconfigPath).readNamespacedJob({ name: jobName, namespace });
          const terminal = j.status?.conditions?.some(
            (c) => (c.type === "Complete" || c.type === "Failed") && c.status === "True",
          );
          if (terminal) {
            consecutiveTerminalReadings++;
            if (consecutiveTerminalReadings >= 2) keepaliveJobTerminal = true;
            return;
          }
          consecutiveTerminalReadings = 0;
        } catch {
          return;
        }
        const silenceSec = Math.round((Date.now() - lastLogAt) / 1000);
        void onLog("stdout", `[paperclip] keepalive — job ${jobName} running (${silenceSec}s since last output)\n`).catch(() => {});
      })();
    }, KEEPALIVE_INTERVAL_MS);

    // External cancel poll
    void (async (): Promise<void> => {
      const apiUrl = process.env.PAPERCLIP_API_URL;
      if (!apiUrl || !issueId) return;
      while (!stopSignal.stopped && !cancelSignal.cancelled) {
        await new Promise<void>((resolve) => setTimeout(resolve, KEEPALIVE_INTERVAL_MS));
        if (stopSignal.stopped || cancelSignal.cancelled) break;
        try {
          const apiKey = ctx.authToken ?? "";
          const resp = await fetch(`${apiUrl}/api/issues/${issueId}`, {
            headers: { Authorization: `Bearer ${apiKey}` },
          });
          if (resp.ok) {
            const data = await resp.json() as { status?: string };
            if (typeof data.status === "string" && data.status === "cancelled") {
              cancelSignal.cancelled = true;
              stopSignal.stopped = true;
              try {
                await getBatchApi(kubeconfigPath).deleteNamespacedJob({
                  name: jobName,
                  namespace,
                  body: { propagationPolicy: "Background" },
                });
              } catch { /* best-effort */ }
            }
          }
        } catch { /* non-fatal */ }
      }
    })();

    const wrappedOnLog: typeof onLog = async (stream, chunk) => {
      lastLogAt = Date.now();
      return onLog(stream, chunk);
    };

    // Run the file tail and the job-completion poll in parallel so that the
    // tail loop has a way to stop: when waitForJobCompletion resolves it sets
    // stopSignal.stopped, which lets tailPodLogFile drain and return.
    const completionPromise = waitForJobCompletion(namespace, jobName, completionTimeoutMs, kubeconfigPath)
      .then((r) => { stopSignal.stopped = true; return r; });
    // When timeoutSec=0 (completionTimeoutMs=0), the user opted out of all
    // deadlines.  Passing 0 here disables the log-exit grace cap so it cannot
    // race the legitimate job completion (BLO-2436).
    const completionGraced = completionWithGrace(
      completionPromise,
      completionTimeoutMs > 0 ? LOG_EXIT_COMPLETION_GRACE_MS : 0,
    );
    // Stream pod stdout via the Kubernetes log API instead of polling
    // the tee'd PVC file. The previous file-polling path silently
    // truncated long runs to ~300 bytes because cephfs's metadata cap
    // pinned `stat().size` on this side even after the agent pod kept
    // writing — see tailPodContainerLogs doc-comment for the full
    // post-mortem. The tee is preserved by job-manifest.ts for forensic
    // backup but no longer participates in the live tail.
    const [tailSettled, completionSettled] = await Promise.allSettled([
      tailPodContainerLogs(namespace, podName, "opencode", {
        onLog: wrappedOnLog,
        stopSignal,
        kubeconfigPath,
      }),
      completionGraced,
    ]);
    stdout = tailSettled.status === "fulfilled" ? tailSettled.value : "";
    if (completionSettled.status === "rejected") {
      stopSignal.stopped = true;
      throw completionSettled.reason;
    }
    const completion = completionSettled.value;

    if (keepaliveTimer) {
      clearInterval(keepaliveTimer);
      keepaliveTimer = null;
    }

    jobTimedOut = completion.timedOut;
    if (completion.jobGone) {
      await onLog("stdout", `[paperclip] Job ${jobName} not found (likely TTL-cleaned after completion).\n`);
    }

    const terminatedInfo = await getPodTerminatedInfo(namespace, jobName, kubeconfigPath);
    exitCode = terminatedInfo.exitCode;
    podTerminatedReason = terminatedInfo.reason;
  } finally {
    if (keepaliveTimer) {
      clearInterval(keepaliveTimer);
      keepaliveTimer = null;
    }
    activeJobs.delete(jobName);
    if (!retainJobs) {
      await cleanupJob(namespace, jobName, onLog, kubeconfigPath, promptSecretName, podLogPath);
    } else {
      await onLog("stdout", `[paperclip] Retaining job ${jobName} for debugging (retainJobs=true)\n`);
    }
  }

  if (cancelSignal.cancelled) {
    return {
      exitCode: null,
      signal: null,
      timedOut: false,
      errorMessage: "Run cancelled",
      errorCode: "cancelled",
    };
  }

  if (jobTimedOut) {
    return {
      exitCode,
      signal: null,
      timedOut: true,
      errorMessage: `Timed out after ${timeoutSec}s`,
      errorCode: "timeout",
    };
  }

  const parsed = parseOpenCodeJsonl(stdout);
  const runtimeSessionParams = parseObject(ctx.runtime.sessionParams);
  const fallbackSessionId = asString(runtimeSessionParams.sessionId, ctx.runtime.sessionId ?? "");
  const workspaceContext = parseObject(ctx.context.paperclipWorkspace);
  const workspaceId = asString(workspaceContext.workspaceId, "") || null;
  const workspaceRepoUrl = asString(workspaceContext.repoUrl, "") || null;
  const workspaceRepoRef = asString(workspaceContext.repoRef, "") || null;
  const cwd = asString(workspaceContext.cwd, "");

  const resolvedSessionId = parsed.sessionId ?? (fallbackSessionId || null);
  const resolvedSessionParams = resolvedSessionId
    ? {
        sessionId: resolvedSessionId,
        ...(cwd ? { cwd } : {}),
        ...(workspaceId ? { workspaceId } : {}),
        ...(workspaceRepoUrl ? { repoUrl: workspaceRepoUrl } : {}),
        ...(workspaceRepoRef ? { repoRef: workspaceRepoRef } : {}),
      } as Record<string, unknown>
    : null;

  // opencode-k8s only ever invokes the opencode CLI, which on this fleet routes
  // to codex (chatgpt auth) or to anthropic via opencode's own provider config.
  // When no model is configured (`adapter_config.model` empty) opencode picks
  // its default — codex-flavored — so we default provider to "openai" rather
  // than letting it fall through to "unknown" in the heartbeat ledger.
  const provider = parseModelProvider(model) ?? "openai";
  const biller = inferOpenAiCompatibleBiller(process.env, null) ?? provider ?? "unknown";

  const parsedError = typeof parsed.errorMessage === "string" ? parsed.errorMessage.trim() : "";
  const rawExitCode = exitCode;
  const synthesizedExitCode = parsedError && (rawExitCode ?? 0) === 0 ? 1 : rawExitCode;
  const failed = (synthesizedExitCode ?? 0) !== 0;

  if (failed && isOpenCodeUnknownSessionError(stdout, parsedError)) {
    await onLog("stdout", `[paperclip] OpenCode session is unavailable; clearing for next run.\n`);
    return {
      exitCode: synthesizedExitCode,
      signal: null,
      timedOut: false,
      errorMessage: parsedError || "Session unavailable",
      errorCode: "session_unavailable",
      clearSession: true,
      resultJson: { stdout },
    };
  }

  const stepLimitReached = isOpenCodeStepLimitResult(stdout);
  if (stepLimitReached) {
    await onLog("stdout", `[paperclip] OpenCode step limit reached; clearing session for next run.\n`);
  }

  // Context-overflow auto-remediation. When the model rejects the prompt
  // because the session's accumulated history blew past the context window,
  // schedule a `/compact` for the next wake (handled in job-manifest's
  // command pipeline). Compaction is preferred over session rotation
  // because it preserves the agent's working context.
  //
  // Pairs with the proactive threshold below: between the two, we should
  // rarely actually hit the overflow path in steady state.
  const contextOverflow = failed && isOpenCodeContextOverflowResult(stdout);
  if (contextOverflow) {
    await onLog(
      "stdout",
      `[paperclip] Context window overflow detected; scheduling /compact for next wake (session preserved).\n`,
    );
    return {
      exitCode: synthesizedExitCode,
      signal: null,
      timedOut: false,
      errorMessage: "Context window exhausted; compaction scheduled for next wake",
      errorCode: "context_overflow",
      sessionId: resolvedSessionId,
      sessionParams: { ...resolvedSessionParams, needsCompactBeforeNextRun: true } as Record<string, unknown>,
      resultJson: { stdout },
    };
  }

  const hasLlmOutput = parsed.usage.outputTokens > 0 || !!parsed.summary;
  if (!jobTimedOut && parsed.sessionId !== null && !hasLlmOutput && !parsedError) {
    await onLog("stderr", `[paperclip] LLM returned empty response (0 output tokens).\n`);
    return {
      exitCode: synthesizedExitCode ?? 1,
      signal: null,
      timedOut: false,
      errorMessage: "LLM API returned empty response",
      errorCode: "llm_api_error",
      sessionId: resolvedSessionId,
      sessionParams: resolvedSessionParams,
      resultJson: { stdout },
    };
  }

  const firstStderrLine = stdout.split(/\r?\n/).map((l) => l.trim()).find(Boolean) ?? "";
  const podFailureDescription = podTerminatedReason
    ? `Pod exited: ${podTerminatedReason}${synthesizedExitCode != null ? ` (exit ${synthesizedExitCode})` : ""}`
    : null;
  const errorParts = [parsedError, podFailureDescription].filter(Boolean);
  const fallbackErrorMessage =
    errorParts.join("; ") || firstStderrLine || `OpenCode exited with code ${synthesizedExitCode ?? -1}`;

  // Proactive compaction gate. opencode reports `inputTokens` for the full
  // payload sent to the model (system + history + new prompt). When that's
  // close to the model's context window, compact the next wake before the
  // session actually overflows. Threshold is conservative: 90k matches
  // ~70% of a 128k window (the smallest mainstream window we ship — claude
  // 3.5 sonnet is 200k, openai/gpt-5.5 is larger still, codex/gpt-4 is
  // 128k). Better to compact a few wakes too early than burn a wake on a
  // hard overflow.
  const INPUT_TOKEN_COMPACT_THRESHOLD = 90_000;
  const approachingWindow = parsed.usage.inputTokens > INPUT_TOKEN_COMPACT_THRESHOLD;
  if (approachingWindow) {
    await onLog(
      "stdout",
      `[paperclip] Input tokens ${parsed.usage.inputTokens} > threshold ${INPUT_TOKEN_COMPACT_THRESHOLD}; scheduling /compact for next wake.\n`,
    );
  }

  // Whatever was set on the incoming sessionParams has already been
  // consumed by job-manifest (the /compact prefix ran at the start of this
  // pod). Always clear it on the return; re-set only if the proactive gate
  // tripped this run.
  const nextSessionParams: Record<string, unknown> = { ...resolvedSessionParams };
  delete nextSessionParams.needsCompactBeforeNextRun;
  if (approachingWindow) {
    nextSessionParams.needsCompactBeforeNextRun = true;
  }

  return {
    exitCode: synthesizedExitCode,
    signal: null,
    timedOut: false,
    errorMessage: (synthesizedExitCode ?? 0) === 0 ? null : fallbackErrorMessage,
    usage: {
      inputTokens: parsed.usage.inputTokens,
      outputTokens: parsed.usage.outputTokens,
      cachedInputTokens: parsed.usage.cachedInputTokens,
    },
    sessionId: resolvedSessionId,
    sessionParams: nextSessionParams,
    sessionDisplayId: resolvedSessionId,
    provider,
    model: model || null,
    billingType: "unknown",
    costUsd: parsed.costUsd,
    resultJson: { stdout },
    summary: parsed.summary,
    clearSession: stepLimitReached,
  } as AdapterExecutionResult;
}

// Per-agent mutex: serializes guard-check + job-create to prevent TOCTOU races.
const agentCreationMutex = new Map<string, Promise<void>>();

// Active Jobs tracked for SIGTERM cleanup.
const activeJobs = new Map<string, { namespace: string; kubeconfigPath?: string; promptSecretName?: string }>();
let sigtermHandlerInstalled = false;

function ensureSigtermHandler(): void {
  if (sigtermHandlerInstalled) return;
  sigtermHandlerInstalled = true;
  process.once("SIGTERM", () => {
    void (async () => {
      await Promise.allSettled(
        Array.from(activeJobs.entries()).flatMap(([jobName, { namespace, kubeconfigPath, promptSecretName }]) => {
          const ops: Promise<unknown>[] = [
            getBatchApi(kubeconfigPath)
              .deleteNamespacedJob({ name: jobName, namespace, body: { propagationPolicy: "Background" } })
              .catch(() => {}),
          ];
          if (promptSecretName) {
            ops.push(
              getCoreApi(kubeconfigPath)
                .deleteNamespacedSecret({ name: promptSecretName, namespace })
                .catch(() => {}),
            );
          }
          return ops;
        }),
      );
      process.exit(0);
    })();
  });
}

export type AgentDbMode = "dedicated_pvc" | "ephemeral" | "workspace_subpath";

/**
 * Sanitize a task_key for use as a filesystem path segment. UUIDs and
 * `__heartbeat__` (the only currently-used shapes) pass through unchanged
 * after lowercasing. Anything else is collapsed to underscores and capped
 * so a hostile/oddly-shaped value can't escape its directory.
 */
export function sanitizeTaskKeyForPath(taskKey: string | null): string {
  const raw = (taskKey ?? "").trim();
  if (!raw) return "_no_task_";
  return raw.toLowerCase().replace(/[^a-z0-9_-]/g, "_").slice(0, 128) || "_no_task_";
}

/**
 * Build the subPath used for `workspace_subpath` agent DB mode. Per-task so
 * that concurrent runs of the same agent on different tasks don't share a
 * SQLite file. The heartbeat scheduler enforces one running pod per
 * (company, agent, adapter, task_key), giving each subPath single-writer
 * semantics.
 */
export function buildAgentDbWorkspaceSubPath(
  companyId: string,
  agentId: string,
  taskKey: string | null,
): string {
  return `.opencode-db/${companyId}/${agentId}/${sanitizeTaskKeyForPath(taskKey)}`;
}

/**
 * Ensure the per-agent dedicated PVC exists (dedicated_pvc mode) or return
 * null (ephemeral / workspace_subpath, where no separate PVC is needed).
 * Returns the PVC claim name on success.
 * Throws when agentDbStorageClass is missing in dedicated_pvc mode.
 */
export async function ensureAgentDbPvc(
  agentId: string,
  namespace: string,
  config: Record<string, unknown>,
  kubeconfigPath?: string,
): Promise<string | null> {
  const agentDbMode = (asString(config.agentDbMode, "dedicated_pvc").trim() || "dedicated_pvc") as AgentDbMode;
  if (agentDbMode === "ephemeral" || agentDbMode === "workspace_subpath") return null;

  // Build a K8s-safe PVC name from the agent ID (UUIDs are already alphanumeric+hyphens)
  const agentSlug = agentId.toLowerCase().replace(/[^a-z0-9-]/g, "").replace(/^-+|-+$/g, "").slice(0, 208);
  const pvcName = `opencode-db-${agentSlug}`;

  const existing = await getPvc(namespace, pvcName, kubeconfigPath);
  if (existing) return pvcName;

  const storageClass = asString(config.agentDbStorageClass, "").trim();
  if (!storageClass) {
    throw new Error(
      "agentDbStorageClass is required when agentDbMode is \"dedicated_pvc\" but is not configured. " +
      "Set agentDbStorageClass in the adapter config or switch agentDbMode to \"ephemeral\".",
    );
  }
  const capacity = asString(config.agentDbStorageCapacity, "1Gi").trim() || "1Gi";

  await createPvc(namespace, {
    apiVersion: "v1",
    kind: "PersistentVolumeClaim",
    metadata: {
      name: pvcName,
      namespace,
      labels: {
        "app.kubernetes.io/managed-by": "paperclip",
        "paperclip.io/agent-id": agentId,
        "paperclip.io/pvc-type": "agent-db",
      },
    },
    spec: {
      accessModes: ["ReadWriteOnce"],
      storageClassName: storageClass,
      resources: { requests: { storage: capacity } },
    },
  }, kubeconfigPath);

  const verified = await getPvc(namespace, pvcName, kubeconfigPath);
  if (!verified) {
    throw new Error(`PVC ${pvcName} was not created in namespace ${namespace}`);
  }

  return pvcName;
}

export async function execute(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> {
  const { config: rawConfig, onLog, onMeta } = ctx;
  const adapterConfig = parseObject(rawConfig);

  // Phase E.2: when paperclip dispatches a heartbeat with a remote/k8s
  // execution target, merge `executionTarget.config` over `adapter_config`.
  // Environment fields win; null/undefined env values are skipped.
  // For non-k8s targets (or absent target), effectiveConfig === adapterConfig.
  const execTarget = readExecutionTarget(ctx);
  const isK8sRemote = execTarget?.kind === "remote" && execTarget?.transport === "k8s";
  const effectiveConfig: Record<string, unknown> = isK8sRemote
    ? mergeEnvironmentConfig(adapterConfig, execTarget?.config ?? null)
    : adapterConfig;

  // Replace ctx.config with the merged view so downstream callers
  // (buildJobManifest, buildEnvVars, etc.) read environment-supplied
  // overrides without further plumbing.
  if (isK8sRemote && effectiveConfig !== adapterConfig) {
    (ctx as unknown as { config: Record<string, unknown> }).config = effectiveConfig;
  }

  const config = effectiveConfig;
  const timeoutSec = asNumber(config.timeoutSec, 0);
  const graceSec = asNumber(config.graceSec, 60);
  const retainJobs = asBoolean(config.retainJobs, false);
  const reattachOrphanedJobs = asBoolean(config.reattachOrphanedJobs, false);

  const budgetGateResult = await enforceBudgetCapBeforeRun(ctx);
  if (budgetGateResult) return budgetGateResult;

  // kubeconfig: env config can supply either a path (legacy) or full content
  // (k8s-env-driver). When content is supplied, materialize to a temp file.
  // null/absent => fall through to in-cluster auth.
  let kubeconfigPath: string | undefined;
  const kubeconfigField = config.kubeconfig;
  if (typeof kubeconfigField === "string" && kubeconfigField.trim().length > 0) {
    const trimmed = kubeconfigField.trim();
    // Heuristic: kubeconfig content begins with "apiVersion:" (YAML) or "{"
    // (rare JSON form). Anything else is treated as a filesystem path.
    const looksLikeContent = trimmed.startsWith("apiVersion:") || trimmed.startsWith("{");
    if (looksLikeContent) {
      kubeconfigPath = (await materializeKubeconfigContent(trimmed)) ?? undefined;
    } else {
      kubeconfigPath = trimmed;
    }
  }

  // TODO(env-config): plumb cross-namespace secret resolution when
  // effectiveConfig.secretsNamespace differs from the Job namespace. Today
  // the adapter only reads secrets from the Job's own namespace, so this
  // task scopes to the merge only — `secretsNamespace` flows into ctx.config
  // and is available to future readers, but no resolver is wired yet.

  // Workspace volume + mount path overrides (Phase E.2).
  // Gated on remote/k8s targets: adapter_config-supplied workspace fields
  // are intentionally ignored unless the heartbeat declares a k8s execution
  // target — those settings are environment-driven, not agent-driven.
  const workspaceVolumeClaim = isK8sRemote
    ? (asString(config.workspaceVolumeClaim, "") || undefined)
    : undefined;
  const workspaceMountPath = isK8sRemote
    ? (asString(config.workspaceMountPath, "") || undefined)
    : undefined;

  const agentId = ctx.agent.id;
  const taskId = asString(ctx.context.taskId ?? ctx.context.issueId, "").trim();
  const selfPod = await getSelfPodInfo(kubeconfigPath);
  const guardNamespace = asString(config.namespace, "") || selfPod.namespace;
  ensureSigtermHandler();

  // Serialize guard-check + job-create per agent to prevent TOCTOU races.
  const prevLock = agentCreationMutex.get(agentId) ?? Promise.resolve();
  let releaseLock!: () => void;
  agentCreationMutex.set(
    agentId,
    prevLock.then(() => new Promise<void>((resolve) => { releaseLock = resolve; })),
  );
  await prevLock;

  try {
    // Guard: single concurrency per agent (shared PVC/session) — fail-closed.
    let waitedForConcurrent = false;
    while (true) {
      try {
        const batchApi = getBatchApi(kubeconfigPath);
        const existing = await batchApi.listNamespacedJob({
          namespace: guardNamespace,
          labelSelector: `paperclip.io/agent-id=${agentId},paperclip.io/adapter-type=opencode_k8s`,
        });
        const running = existing.items.filter(
          (j) => !j.status?.conditions?.some((c) => (c.type === "Complete" || c.type === "Failed") && c.status === "True"),
        );
        if (running.length > 0) {
          const sameTaskJobs = taskId
            ? running.filter((j) => j.metadata?.labels?.["paperclip.io/task-id"] === taskId)
            : [];
          const otherJobs = running.filter((j) => !sameTaskJobs.includes(j));

          if (otherJobs.length > 0) {
            if (waitedForConcurrent) {
              const names = otherJobs.map((j) => j.metadata?.name).join(", ");
              await onLog("stderr", `[paperclip] Concurrent run blocked: existing Job(s) still running for this agent: ${names}\n`);
              return {
                exitCode: null,
                signal: null,
                timedOut: false,
                errorMessage: `Concurrent run blocked: Job ${names} is still running for this agent`,
                errorCode: "k8s_concurrent_run_blocked",
              };
            }
            const names = otherJobs.map((j) => j.metadata?.name).join(", ");
            await onLog("stdout", `[paperclip] Waiting for concurrent Job(s) to finish before starting: ${names}\n`);
            const concurrentWaitMs = timeoutSec > 0
              ? (timeoutSec + graceSec + 120) * 1000
              : 60 * 60_000;
            await Promise.all(
              otherJobs.map((j) =>
                waitForJobCompletion(guardNamespace, j.metadata?.name ?? "", concurrentWaitMs, kubeconfigPath).catch(() => {}),
              ),
            );
            await onLog("stdout", `[paperclip] Concurrent Job(s) done — retrying guard check...\n`);
            waitedForConcurrent = true;
            continue;
          }

          if (sameTaskJobs.length > 0) {
            const orphanJob = sameTaskJobs[0];
            const orphanJobName = orphanJob.metadata?.name ?? "";
            if (reattachOrphanedJobs) {
              await onLog("stdout", `[paperclip] Reattaching to orphaned Job ${orphanJobName} from prior server instance (task: ${taskId})...\n`);
              activeJobs.set(orphanJobName, { namespace: guardNamespace, kubeconfigPath });
              // Reattach needs podLogPath — compute it here for the orphaned job
              const podLogPath = buildPodLogPath(ctx.agent.companyId, agentId, ctx.runId);
              return streamAndAwaitJob(ctx, orphanJobName, guardNamespace, timeoutSec, graceSec, kubeconfigPath, retainJobs, podLogPath);
            }
            await onLog("stderr", `[paperclip] Orphaned Job ${orphanJobName} found for this task but reattachOrphanedJobs is disabled.\n`);
            return {
              exitCode: null,
              signal: null,
              timedOut: false,
              errorMessage: `Orphaned Job ${orphanJobName} is still running (reattachOrphanedJobs disabled)`,
              errorCode: "k8s_concurrent_run_blocked",
            };
          }
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        await onLog("stderr", `[paperclip] Concurrency guard unreachable — cannot list Jobs: ${msg}\n`);
        return {
          exitCode: null,
          signal: null,
          timedOut: false,
          errorMessage: `Concurrency guard unreachable: ${msg}`,
          errorCode: "k8s_concurrency_guard_unreachable",
        };
      }
      break; // no blocking jobs — proceed to job creation
    }

  // Read agent instructions file
  const instructionsFilePath = asString(config.instructionsFilePath, "").trim();
  let instructionsContent = "";
  if (instructionsFilePath) {
    try {
      instructionsContent = (await readFile(instructionsFilePath, "utf-8")).trim();
    } catch {
      await onLog("stderr", `[paperclip] Warning: instructionsFilePath not readable: ${instructionsFilePath}\n`);
    }
  }

  // Resolve and read desired skill content
  let skillsBundleContent = "";
  try {
    const moduleDir = import.meta.dirname;
    const paperclipSkillsHome = "/paperclip/.claude/skills";
    const availableEntries = await readPaperclipRuntimeSkillEntries(config, moduleDir, [paperclipSkillsHome]);
    const desiredSkillKeys = resolvePaperclipDesiredSkillNames(config, availableEntries);
    const skillTexts: string[] = [];
    for (const key of desiredSkillKeys) {
      const entry = availableEntries.find((e) => e.key === key);
      if (entry?.source) {
        try {
          let text: string;
          try {
            text = (await readFile(path.join(entry.source, "SKILL.md"), "utf-8")).trim();
          } catch {
            text = (await readFile(entry.source, "utf-8")).trim();
          }
          if (text) skillTexts.push(text);
        } catch {
          // skip unreadable skill files — non-fatal
        }
      }
    }
    if (skillTexts.length > 0) skillsBundleContent = skillTexts.join("\n\n---\n\n");
  } catch {
    // non-fatal: skill bundle is optional
  }

  // Resolve agent DB mounting strategy.
  //
  // - dedicated_pvc: per-agent PVC (RWO) — only one pod can mount at a time,
  //   so this serializes runs of the same agent across all tasks.
  // - ephemeral: emptyDir per pod — no cross-pod persistence; opencode session
  //   resume always fails.
  // - workspace_subpath: per-(agent, task) subdir on the workspace data PVC;
  //   single-writer per task (heartbeat scheduler enforces one pod per
  //   (agent, task)) and survives pod restart, so resume actually works.
  const agentDbMode = (asString(config.agentDbMode, "dedicated_pvc").trim() || "dedicated_pvc") as AgentDbMode;
  let agentDbClaimName: string | null | undefined;
  let agentDbWorkspaceSubPath: string | undefined;
  if (agentDbMode === "workspace_subpath") {
    agentDbWorkspaceSubPath = buildAgentDbWorkspaceSubPath(
      ctx.agent.companyId,
      agentId,
      ctx.runtime.taskKey,
    );
  } else {
    try {
      agentDbClaimName = await ensureAgentDbPvc(agentId, guardNamespace, config, kubeconfigPath);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await onLog("stderr", `[paperclip] Failed to ensure agent DB PVC: ${msg}\n`);
      return {
        exitCode: null,
        signal: null,
        timedOut: false,
        errorMessage: msg,
        errorCode: "k8s_job_create_failed",
      };
    }
  }

  const buildArgs = {
    ctx,
    selfPod,
    instructionsContent: instructionsContent || undefined,
    skillsBundleContent: skillsBundleContent || undefined,
    ...(agentDbWorkspaceSubPath !== undefined
      ? { agentDbWorkspaceSubPath }
      : { agentDbClaimName }),
    retainJobs,
    // Phase E.2: env-config-supplied workspace overrides (k8s remote target).
    // When unset, buildJobManifest falls back to selfPod.pvcClaimName and
    // /paperclip respectively.
    ...(workspaceVolumeClaim !== undefined ? { workspaceVolumeClaim } : {}),
    ...(workspaceMountPath !== undefined ? { workspaceMountPath } : {}),
  };
  const firstBuild = buildJobManifest(buildArgs);
  const { jobName, namespace, prompt, opencodeArgs, promptMetrics, podLogPath } = firstBuild;

  // For prompts larger than the threshold, store in a K8s Secret
  let promptSecretName: string | undefined;
  let job = firstBuild.job;
  if (Buffer.byteLength(prompt, "utf-8") > LARGE_PROMPT_THRESHOLD_BYTES) {
    promptSecretName = `${jobName}-prompt`;
    job = buildJobManifest({ ...buildArgs, promptSecretName }).job;
  }

  if (onMeta) {
    await onMeta({
      adapterType: "opencode_k8s",
      command: `kubectl job/${jobName}`,
      cwd: namespace,
      commandArgs: opencodeArgs,
      commandNotes: [
        `Image: ${job.spec?.template.spec?.containers[0]?.image ?? "unknown"}`,
        `Namespace: ${namespace}`,
        `Timeout: ${timeoutSec}s`,
      ],
      prompt,
      ...(promptMetrics ? { promptMetrics } : {}),
      context: ctx.context,
    } as Parameters<typeof onMeta>[0]);
  }

  const batchApi = getBatchApi(kubeconfigPath);

  // Create the prompt Secret before the Job
  if (promptSecretName) {
    const coreApi = getCoreApi(kubeconfigPath);
    const promptSecret: k8s.V1Secret = {
      apiVersion: "v1",
      kind: "Secret",
      metadata: { name: promptSecretName, namespace, labels: job.metadata?.labels },
      stringData: { prompt },
    };
    try {
      await coreApi.createNamespacedSecret({ namespace, body: promptSecret });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await onLog("stderr", `[paperclip] Failed to create prompt Secret: ${msg}\n`);
      return {
        exitCode: null,
        signal: null,
        timedOut: false,
        errorMessage: `Failed to create prompt Secret: ${msg}`,
        errorCode: "k8s_job_create_failed",
      };
    }
  }

  let createdJob: k8s.V1Job | undefined;
  try {
    createdJob = await batchApi.createNamespacedJob({ namespace, body: job });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (promptSecretName) {
      try {
        const coreApi = getCoreApi(kubeconfigPath);
        await coreApi.deleteNamespacedSecret({ name: promptSecretName, namespace });
      } catch {
        // best-effort cleanup
      }
    }
    await onLog("stderr", `[paperclip] Failed to create K8s Job: ${msg}\n`);
    return {
      exitCode: null,
      signal: null,
      timedOut: false,
      errorMessage: `Failed to create Kubernetes Job: ${msg}`,
      errorCode: "k8s_job_create_failed",
    };
  }

  // Set ownerReference on the prompt Secret so kubelet cascade-deletes the
  // Secret when the Job is garbage-collected. Without this the per-run Secret
  // leaks forever (BLO-5310). The @kubernetes/client-node PATCH defaults to
  // `application/json-patch+json` content-type, which expects an RFC 6902
  // array-of-ops body — not the strategic-merge object we used to send. The
  // claude_k8s adapter (which has never leaked Secrets) uses the JSON Patch
  // shape below; mirror it here. blockOwnerDeletion=false so a stuck Secret
  // never blocks Job GC.
  if (promptSecretName && createdJob?.metadata?.uid) {
    try {
      const coreApi = getCoreApi(kubeconfigPath);
      await coreApi.patchNamespacedSecret({
        name: promptSecretName,
        namespace,
        body: [
          {
            op: "add",
            path: "/metadata/ownerReferences",
            value: [
              {
                apiVersion: "batch/v1",
                kind: "Job",
                name: jobName,
                uid: createdJob.metadata.uid,
                blockOwnerDeletion: false,
              },
            ],
          },
        ] as unknown as k8s.V1Secret,
      });
    } catch (err) {
      // Non-fatal: explicit cleanup paths still run on success/error/SIGTERM.
      // We log the failure so operators don't have to grep the cluster for
      // leaked Secrets (the pre-fix mode where the patch silently failed for
      // months and orphan Secrets piled up to 3,395 in the paperclip ns).
      const msg = err instanceof Error ? err.message : String(err);
      await onLog(
        "stderr",
        `[paperclip] Warning: failed to set ownerReference on prompt Secret ${promptSecretName}: ${msg}\n`,
      );
    }
  }

    // Register job for SIGTERM cleanup before releasing the mutex.
    activeJobs.set(jobName, { namespace, kubeconfigPath, promptSecretName });

    await onLog("stdout", `[paperclip] Created K8s Job: ${jobName} in namespace ${namespace} (deadline: ${timeoutSec > 0 ? `${timeoutSec}s` : "none"})\n`);

    return streamAndAwaitJob(ctx, jobName, namespace, timeoutSec, graceSec, kubeconfigPath, retainJobs, podLogPath, promptSecretName);
  } finally {
    releaseLock();
  }
}
