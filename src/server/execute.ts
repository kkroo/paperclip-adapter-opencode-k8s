import type { AdapterExecutionContext, AdapterExecutionResult } from "@paperclipai/adapter-utils";
import { inferOpenAiCompatibleBiller, redactHomePathUserSegments } from "@paperclipai/adapter-utils";
import { asString, asNumber, asBoolean, parseObject, readPaperclipRuntimeSkillEntries, resolvePaperclipDesiredSkillNames } from "@paperclipai/adapter-utils/server-utils";
import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  parseOpenCodeJsonl,
  isOpenCodeUnknownSessionError,
  isOpenCodeStepLimitResult,
} from "./parse.js";
import { getSelfPodInfo, getBatchApi, getCoreApi, getLogApi, getPvc, createPvc } from "./k8s-client.js";
import { buildJobManifest, LARGE_PROMPT_THRESHOLD_BYTES } from "./job-manifest.js";
import { LogLineDedupFilter } from "./log-dedup.js";
import type * as k8s from "@kubernetes/client-node";
import { Writable } from "node:stream";

const POLL_INTERVAL_MS = 2000;
const KEEPALIVE_INTERVAL_MS = 15_000;
const LOG_STREAM_RECONNECT_DELAY_MS = 3_000;
const LOG_STREAM_RECONNECT_MAX_DELAY_MS = 30_000;
const MAX_LOG_RECONNECT_ATTEMPTS = 50;
// Upper bound on how long streamPodLogsOnce will wait after stopSignal fires
// before force-returning, even if logApi.log has not yet resolved. Defensive
// against the K8s client library not propagating writable.destroy() into an
// abort of the underlying HTTP request.
const LOG_STREAM_BAIL_TIMEOUT_MS = 3_000;
const LOG_EXIT_COMPLETION_GRACE_MS = parseInt(process.env.LOG_EXIT_COMPLETION_GRACE_MS ?? "30000", 10);

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

export function parseModelProvider(model: string | null): string | null {
  if (!model) return null;
  const trimmed = model.trim();
  if (!trimmed.includes("/")) return null;
  return trimmed.slice(0, trimmed.indexOf("/")).trim() || null;
}

function isTransientVolumeSchedulingMessage(message: string): boolean {
  return /unbound immediate persistentvolumeclaims|waiting for a volume|pvc|persistentvolumeclaim|volume.*bind/i.test(message);
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

/**
 * Stream pod logs once via follow. Returns accumulated stdout when the
 * stream ends (container exit, API disconnect, or abort signal).
 */
async function streamPodLogsOnce(
  namespace: string,
  podName: string,
  onLog: AdapterExecutionContext["onLog"],
  kubeconfigPath?: string,
  sinceSeconds?: number,
  dedup?: LogLineDedupFilter,
  stopSignal?: { stopped: boolean },
): Promise<string> {
  const logApi = getLogApi(kubeconfigPath);
  const chunks: string[] = [];

  const writable = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      const text = redactHomePathUserSegments(chunk.toString("utf-8"));
      chunks.push(text);
      const emitted = dedup ? dedup.filter(text) : text;
      if (!emitted) {
        callback();
        return;
      }
      void onLog("stdout", emitted).then(() => callback(), callback);
    },
  });

  // When the job completion signal fires, destroy the writable to abort the
  // in-flight follow stream. Without this, logApi.log can hang indefinitely
  // when the pod terminates without closing the HTTP connection cleanly.
  let stopPoller: ReturnType<typeof setInterval> | null = null;
  let bailTimer: ReturnType<typeof setTimeout> | null = null;
  let bailResolve: (() => void) | null = null;
  const bailPromise = new Promise<void>((resolve) => {
    bailResolve = resolve;
  });
  if (stopSignal) {
    stopPoller = setInterval(() => {
      if (stopSignal.stopped) {
        if (!writable.destroyed) writable.destroy();
        if (!bailTimer && bailResolve) {
          bailTimer = setTimeout(() => {
            onLog("stderr", "[paperclip] Log stream bail timer fired — forcing return\n").catch(() => {});
            bailResolve!();
          }, LOG_STREAM_BAIL_TIMEOUT_MS);
        }
      }
    }, 200);
  }

  const logPromise = logApi.log(namespace, podName, "opencode", writable, {
    follow: true,
    pretty: false,
    ...(sinceSeconds ? { sinceSeconds } : {}),
  }).catch(() => {
    // follow may fail if the container already exited, the API connection
    // dropped, or we aborted via writable.destroy() — not fatal.
  });

  try {
    if (stopSignal) {
      await Promise.race([logPromise, bailPromise]);
    } else {
      await logPromise;
    }
  } finally {
    if (stopPoller) clearInterval(stopPoller);
    if (bailTimer) clearTimeout(bailTimer);
  }

  return chunks.join("");
}

/**
 * Stream pod logs with automatic reconnection. Keeps retrying the log
 * stream until the stop signal fires (job completed) or the container
 * exits normally. This handles silent K8s API connection drops that
 * would otherwise cause the UI to stop receiving real output.
 *
 * Capped at MAX_LOG_RECONNECT_ATTEMPTS to prevent infinite reconnect
 * loops during sustained API partitions.
 *
 * onFirstStreamExit is called the first time streamPodLogsOnce returns.
 * Used by execute() to start the LOG_EXIT_COMPLETION_GRACE_MS grace timer
 * without waiting for all reconnects to exhaust.
 */
async function streamPodLogs(
  namespace: string,
  podName: string,
  onLog: AdapterExecutionContext["onLog"],
  kubeconfigPath?: string,
  stopSignal?: { stopped: boolean },
  dedup?: LogLineDedupFilter,
  onFirstStreamExit?: () => void,
): Promise<string> {
  const allChunks: string[] = [];
  let attempt = 0;
  // Track the timestamp of the last successfully received log line so
  // reconnects use a tight window instead of an ever-growing one anchored
  // at stream start. This is the primary fix for duplicative logs on reconnect.
  let lastLogReceivedAt = Math.floor(Date.now() / 1000);
  if (!dedup) dedup = new LogLineDedupFilter();

  while (!stopSignal?.stopped) {
    if (attempt >= MAX_LOG_RECONNECT_ATTEMPTS) {
      await onLog("stderr", `[paperclip] Log stream: max reconnect attempts (${MAX_LOG_RECONNECT_ATTEMPTS}) reached — giving up.\n`);
      break;
    }

    // On reconnect, ask for logs since the last received line (+5s buffer)
    // instead of since stream start. This keeps the window tight and
    // avoids ever-growing duplicate output.
    const sinceSeconds = attempt > 0
      ? Math.max(1, Math.floor(Date.now() / 1000) - lastLogReceivedAt + 5)
      : undefined;

    if (attempt > 0) {
      await onLog("stdout", `[paperclip] Log stream disconnected — reconnecting (attempt ${attempt}/${MAX_LOG_RECONNECT_ATTEMPTS})...\n`);
    }

    const preStreamTs = Math.floor(Date.now() / 1000);
    const result = await streamPodLogsOnce(namespace, podName, onLog, kubeconfigPath, sinceSeconds, dedup, stopSignal);
    // Signal first stream exit immediately so the grace-period timer in
    // execute() can start without waiting for all reconnects to complete.
    if (attempt === 0) onFirstStreamExit?.();
    if (result) {
      allChunks.push(result);
      // Update last-received timestamp to now (the stream just ended,
      // so any log lines in `result` were received up to this moment).
      lastLogReceivedAt = Math.floor(Date.now() / 1000);
    } else if (attempt === 0) {
      // First attempt returned nothing — update timestamp so reconnect
      // window stays reasonable.
      lastLogReceivedAt = preStreamTs;
    }
    attempt++;

    if (stopSignal?.stopped) break;

    // Exponential backoff before reconnecting: start at 3s, double each
    // attempt, cap at 30s. Avoids hammering the API server during prolonged
    // network hiccups while staying responsive for brief disconnects.
    // Sleep in 200ms chunks so a stop signal can interrupt the backoff
    // without waiting for the full delay to expire.
    const backoffMs = Math.min(
      LOG_STREAM_RECONNECT_MAX_DELAY_MS,
      LOG_STREAM_RECONNECT_DELAY_MS * 2 ** (attempt - 1),
    );
    const backoffDeadline = Date.now() + backoffMs;
    while (!stopSignal?.stopped) {
      const remaining = backoffDeadline - Date.now();
      if (remaining <= 0) break;
      await new Promise<void>((resolve) => setTimeout(resolve, Math.min(200, remaining)));
    }
  }

  // Flush any buffered partial line so the final assistant/result chunk
  // isn't dropped when the stream ends mid-line.
  const tail = dedup.flush();
  if (tail) await onLog("stdout", tail);

  return allChunks.join("");
}

async function readPodLogs(
  namespace: string,
  podName: string,
  kubeconfigPath?: string,
): Promise<string> {
  const coreApi = getCoreApi(kubeconfigPath);
  try {
    const log = await coreApi.readNamespacedPodLog({
      name: podName,
      namespace,
      container: "opencode",
    });
    return typeof log === "string" ? log : "";
  } catch {
    return "";
  }
}

/**
 * Wait until the named pod's phase transitions to Succeeded, Failed, or Unknown,
 * or until the pod is gone (404). Returns immediately if the pod is already in a
 * terminal phase. Used as a pre-flight before readPodLogs when the K8s log stream
 * returns empty while the container is still running (Node.js stdout buffering +
 * the @kubernetes/client-node v1.x follow-stream known premature-close issue).
 */
async function waitForPodTermination(
  namespace: string,
  podName: string,
  timeoutMs: number,
  onLog: AdapterExecutionContext["onLog"],
  kubeconfigPath?: string,
): Promise<void> {
  const coreApi = getCoreApi(kubeconfigPath);
  const deadline = Date.now() + timeoutMs;
  let notified = false;
  while (Date.now() < deadline) {
    try {
      const pod = await coreApi.readNamespacedPod({ name: podName, namespace });
      const phase = pod.status?.phase;
      if (phase === "Succeeded" || phase === "Failed" || phase === "Unknown") return;
      if (!notified) {
        notified = true;
        await onLog(
          "stdout",
          `[paperclip] Container still running — waiting up to ${Math.round(timeoutMs / 1000)}s for it to exit to capture output...\n`,
        );
      }
    } catch {
      return; // Pod gone (404) — nothing left to wait for
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
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

  while (deadline === 0 || Date.now() < deadline) {
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

  return { succeeded: false, timedOut: true, jobGone: false };
}

export async function completionWithGrace(
  completionPromise: Promise<JobCompletionResult>,
  graceMs: number,
): Promise<JobCompletionResult> {
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

async function cleanupJob(
  namespace: string,
  jobName: string,
  onLog: AdapterExecutionContext["onLog"],
  kubeconfigPath?: string,
  promptSecretName?: string,
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
}

/**
 * Stream logs + await completion for an already-created Job, then harvest
 * and return the execution result. Used by both the normal create-then-run
 * path and the orphaned-job reattach path.
 */
async function streamAndAwaitJob(
  ctx: AdapterExecutionContext,
  jobName: string,
  namespace: string,
  timeoutSec: number,
  graceSec: number,
  kubeconfigPath: string | undefined,
  retainJobs: boolean,
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
    const logStopSignal = { stopped: false };
    const logDedup = new LogLineDedupFilter();

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

    // External cancel poll: watches Paperclip issue status at keepalive cadence.
    // Polls GET /api/issues/{issueId} (not /api/heartbeat-runs) because the adapter
    // key has read access to issues but not to the internal heartbeat-runs endpoint.
    // Uses await-setTimeout (not setInterval+void) so vi.advanceTimersByTimeAsync
    // can drive it in tests. Fire-and-forget; exits when logStopSignal.stopped.
    void (async (): Promise<void> => {
      const apiUrl = process.env.PAPERCLIP_API_URL;
      if (!apiUrl || !issueId) return;
      while (!logStopSignal.stopped && !cancelSignal.cancelled) {
        await new Promise<void>((resolve) => setTimeout(resolve, KEEPALIVE_INTERVAL_MS));
        if (logStopSignal.stopped || cancelSignal.cancelled) break;
        try {
          const apiKey = ctx.authToken ?? "";
          const resp = await fetch(`${apiUrl}/api/issues/${issueId}`, {
            headers: { Authorization: `Bearer ${apiKey}` },
          });
          if (resp.ok) {
            const data = await resp.json() as { status?: string };
            if (typeof data.status === "string" && data.status === "cancelled") {
              cancelSignal.cancelled = true;
              logStopSignal.stopped = true;
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

    let logExitTime: number | null = null;
    const trackedLogStream = streamPodLogs(
      namespace, podName, wrappedOnLog, kubeconfigPath, logStopSignal, logDedup,
      () => { logExitTime = Date.now(); },
    );

    let gracePoller: ReturnType<typeof setInterval> | null = null;
    // Maximum wall-clock time the grace poller will defer to pod-liveness checks.
    // When completionTimeoutMs is 0 (unlimited job), cap at 20 minutes so we
    // don't wait forever if the pod never exits but K8s never marks the job done.
    const graceMaxWaitMs = completionTimeoutMs > 0 ? completionTimeoutMs : 20 * 60_000;
    const graceStartTime = Date.now();
    const completionGraced = new Promise<JobCompletionResult>((resolve, reject) => {
      let settled = false;
      let graceCheckPending = false;
      const settleOk = (r: JobCompletionResult) => {
        if (settled) return;
        settled = true;
        if (gracePoller) { clearInterval(gracePoller); gracePoller = null; }
        logStopSignal.stopped = true;
        resolve(r);
      };
      const settleErr = (err: unknown) => {
        if (settled) return;
        settled = true;
        if (gracePoller) { clearInterval(gracePoller); gracePoller = null; }
        logStopSignal.stopped = true;
        reject(err);
      };
      waitForJobCompletion(namespace, jobName, completionTimeoutMs, kubeconfigPath).then(settleOk).catch(settleErr);
      gracePoller = setInterval(() => {
        if (graceCheckPending || settled) return;
        if (logExitTime !== null && Date.now() - logExitTime >= LOG_EXIT_COMPLETION_GRACE_MS) {
          graceCheckPending = true;
          void (async () => {
            try {
              // If we haven't exceeded the max wait, check whether the pod is still running.
              // The K8s log client v1.x closes the follow-stream prematurely even when the
              // container is still executing — the log exit does not mean the job is done.
              if (Date.now() - graceStartTime < graceMaxWaitMs) {
                try {
                  const pod = await getCoreApi(kubeconfigPath).readNamespacedPod({ name: podName, namespace });
                  const phase = pod.status?.phase;
                  if (phase === "Running" || phase === "Pending") {
                    // Pod still alive — reset the grace deadline and keep waiting
                    logExitTime = Date.now();
                    return;
                  }
                } catch {
                  // Pod gone (404) or K8s error — fall through to settleOk
                }
              }
              void onLog("stdout", `[paperclip] Log stream exited ${LOG_EXIT_COMPLETION_GRACE_MS / 1000}s ago without K8s Job condition update — proceeding with captured output\n`).catch(() => {});
              settleOk({ succeeded: false, timedOut: false, jobGone: true });
            } finally {
              graceCheckPending = false;
            }
          })();
        }
      }, 1_000);
    });

    const [logResult, completionResult] = await Promise.allSettled([
      trackedLogStream,
      completionGraced,
    ]);

    if (keepaliveTimer) {
      clearInterval(keepaliveTimer);
      keepaliveTimer = null;
    }

    if (logResult.status === "fulfilled") {
      stdout = logResult.value;
    }

    if (!stdout.trim()) {
      await onLog("stdout", `[paperclip] Log stream returned empty — reading pod logs directly...\n`);
      // The K8s client v1.x has a known issue where follow-stream closes prematurely,
      // causing the log stream to return empty even when the container is still running.
      // Node.js also buffers stdout when writing to a pipe, so logs only flush on exit.
      // Wait for the pod to actually terminate before attempting to read its final output.
      await waitForPodTermination(namespace, podName, 120_000, onLog, kubeconfigPath);
      stdout = await readPodLogs(namespace, podName, kubeconfigPath);
      if (stdout.trim()) {
        await onLog("stdout", stdout);
      }
    } else if (!parseOpenCodeJsonl(stdout).sessionId) {
      await onLog("stdout", `[paperclip] Partial stdout missing session result — reading pod logs directly...\n`);
      const fallbackLogs = await readPodLogs(namespace, podName, kubeconfigPath);
      if (fallbackLogs.trim()) {
        stdout = fallbackLogs;
        await onLog("stdout", fallbackLogs);
      }
    }

    if (completionResult.status === "fulfilled") {
      const completion = completionResult.value;
      jobTimedOut = completion.timedOut;
      if (completion.jobGone) {
        await onLog("stdout", `[paperclip] Job ${jobName} not found (likely TTL-cleaned after completion).\n`);
      }
    } else {
      jobTimedOut = true;
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
      await cleanupJob(namespace, jobName, onLog, kubeconfigPath, promptSecretName);
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

  const provider = parseModelProvider(model);
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
    sessionParams: resolvedSessionParams,
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

/**
 * Ensure the per-agent dedicated PVC exists (dedicated_pvc mode) or return null (ephemeral).
 * Returns the PVC claim name on success, null when agentDbMode is "ephemeral".
 * Throws when agentDbStorageClass is missing in dedicated_pvc mode.
 */
export async function ensureAgentDbPvc(
  agentId: string,
  namespace: string,
  config: Record<string, unknown>,
  kubeconfigPath?: string,
): Promise<string | null> {
  const agentDbMode = (asString(config.agentDbMode, "dedicated_pvc").trim() || "dedicated_pvc") as "dedicated_pvc" | "ephemeral";
  if (agentDbMode === "ephemeral") return null;

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
  const config = parseObject(rawConfig);
  const timeoutSec = asNumber(config.timeoutSec, 0);
  const graceSec = asNumber(config.graceSec, 60);
  const retainJobs = asBoolean(config.retainJobs, false);
  const reattachOrphanedJobs = asBoolean(config.reattachOrphanedJobs, false);
  const kubeconfigPath = asString(config.kubeconfig, "") || undefined;

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
    // When a concurrent job is detected, wait for it to finish and retry once rather
    // than returning k8s_concurrent_run_blocked immediately (which caused permanent
    // blocked state for all but the first task in a simultaneous batch assignment).
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
          // Separate Jobs matching the current task (orphaned from a prior server instance)
          // from Jobs belonging to a different concurrent task.
          const sameTaskJobs = taskId
            ? running.filter((j) => j.metadata?.labels?.["paperclip.io/task-id"] === taskId)
            : [];
          const otherJobs = running.filter((j) => !sameTaskJobs.includes(j));

          if (otherJobs.length > 0) {
            if (waitedForConcurrent) {
              // Already waited once — give up to avoid an infinite loop.
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
            // Wait up to the configured job timeout (+ grace + buffer); for unlimited jobs
            // cap at 1 hour so we don't block the mutex indefinitely.
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
              return streamAndAwaitJob(ctx, orphanJobName, guardNamespace, timeoutSec, graceSec, kubeconfigPath, retainJobs);
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

  // Read agent instructions file (instructionsFilePath config field → system prompt prepend)
  const instructionsFilePath = asString(config.instructionsFilePath, "").trim();
  let instructionsContent = "";
  if (instructionsFilePath) {
    try {
      instructionsContent = (await readFile(instructionsFilePath, "utf-8")).trim();
    } catch {
      await onLog("stderr", `[paperclip] Warning: instructionsFilePath not readable: ${instructionsFilePath}\n`);
    }
  }

  // Resolve and read desired skill content (injected into prompt bundle)
  let skillsBundleContent = "";
  try {
    const moduleDir = import.meta.dirname;
    // Add the standard Paperclip skills dir as an additional candidate — the relative
    // candidates in adapter-utils don't resolve to the PVC-mounted skills home.
    const paperclipSkillsHome = "/paperclip/.claude/skills";
    const availableEntries = await readPaperclipRuntimeSkillEntries(config, moduleDir, [paperclipSkillsHome]);
    const desiredSkillKeys = resolvePaperclipDesiredSkillNames(config, availableEntries);
    const skillTexts: string[] = [];
    for (const key of desiredSkillKeys) {
      const entry = availableEntries.find((e) => e.key === key);
      if (entry?.source) {
        try {
          // entry.source from listPaperclipSkillEntries is a directory; read SKILL.md from it.
          // Fall back to reading entry.source directly for file-based paperclipRuntimeSkills entries.
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

  // Ensure per-agent DB PVC exists (or get null for ephemeral mode)
  let agentDbClaimName: string | null | undefined;
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

  const buildArgs = {
    ctx,
    selfPod,
    instructionsContent: instructionsContent || undefined,
    skillsBundleContent: skillsBundleContent || undefined,
    agentDbClaimName,
    retainJobs,
  };
  const firstBuild = buildJobManifest(buildArgs);
  const { jobName, namespace, prompt, opencodeArgs, promptMetrics } = firstBuild;

  // For prompts larger than the threshold, store in a K8s Secret so the PodSpec
  // stays within the 1 MiB API limit. The init container mounts and copies the file.
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

  // Create the prompt Secret before the Job so the init container can mount it.
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

  // Set ownerReference on the prompt Secret so K8s GC deletes it when the Job is removed.
  if (promptSecretName && createdJob?.metadata?.uid) {
    try {
      const coreApi = getCoreApi(kubeconfigPath);
      await coreApi.patchNamespacedSecret({
        name: promptSecretName,
        namespace,
        body: {
          metadata: {
            ownerReferences: [
              {
                apiVersion: "batch/v1",
                kind: "Job",
                name: jobName,
                uid: createdJob.metadata.uid,
                controller: true,
                blockOwnerDeletion: true,
              },
            ],
          },
        } as k8s.V1Secret,
      });
    } catch {
      // non-fatal — Secret will still be removed by cleanupJob in the finally block
    }
  }

    // Register job for SIGTERM cleanup before releasing the mutex.
    activeJobs.set(jobName, { namespace, kubeconfigPath, promptSecretName });

    await onLog("stdout", `[paperclip] Created K8s Job: ${jobName} in namespace ${namespace} (deadline: ${timeoutSec > 0 ? `${timeoutSec}s` : "none"})\n`);

    // return evaluates streamAndAwaitJob() (creating the promise) before finally runs,
    // so the mutex releases as soon as the job is registered — not after the full lifecycle.
    return streamAndAwaitJob(ctx, jobName, namespace, timeoutSec, graceSec, kubeconfigPath, retainJobs, promptSecretName);
  } finally {
    releaseLock();
  }
}
