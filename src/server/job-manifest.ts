import { createHash } from "crypto";
import type * as k8s from "@kubernetes/client-node";
import type { AdapterExecutionContext } from "@paperclipai/adapter-utils";
import {
  asString,
  asNumber,
  asBoolean,
  asStringArray,
  parseObject,
  buildPaperclipEnv,
  renderTemplate,
  joinPromptSections,
  stringifyPaperclipWakePayload,
  renderPaperclipWakePrompt,
} from "@paperclipai/adapter-utils/server-utils";
import type { SelfPodInfo } from "./k8s-client.js";

export const LARGE_PROMPT_THRESHOLD_BYTES = 256 * 1024;

export interface JobBuildInput {
  ctx: AdapterExecutionContext;
  selfPod: SelfPodInfo;
  /** Content of the agent's instructions file (e.g. AGENTS.md), prepended to the prompt. */
  instructionsContent?: string;
  /** Concatenated content of desired skill markdown files, prepended after instructions. */
  skillsBundleContent?: string;
  /**
   * When set, the prompt is stored in this K8s Secret (already created by the caller)
   * and the init container mounts and copies it instead of using an env var.
   * Required when the prompt exceeds LARGE_PROMPT_THRESHOLD_BYTES.
   */
  promptSecretName?: string;
  /**
   * Claim name of the dedicated agent DB PVC (dedicated_pvc mode) or null for ephemeral emptyDir.
   * When provided (string or null), mounts /opencode-db and sets OPENCODE_DB=/opencode-db.
   * When undefined, no opencode-db volume is added.
   */
  agentDbClaimName?: string | null;
}

export interface JobBuildResult {
  job: k8s.V1Job;
  jobName: string;
  namespace: string;
  prompt: string;
  opencodeArgs: string[];
  promptMetrics: Record<string, number>;
}

/**
 * Parse a config field that may be a JSON object, a plain object, or a textarea
 * with "key=value" lines (one per line). Used for nodeSelector and labels.
 */
function parseKeyValueOrObject(value: unknown): Record<string, string> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, v]) => typeof v === "string")
        .map(([k, v]) => [k, v as string]),
    );
  }
  if (typeof value !== "string") return {};
  const text = value.trim();
  if (!text) return {};
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return Object.fromEntries(
        Object.entries(parsed as Record<string, unknown>)
          .filter(([, v]) => typeof v === "string")
          .map(([k, v]) => [k, v as string]),
      );
    }
  } catch {
    // fall through to key=value parsing
  }
  const result: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const val = trimmed.slice(eqIdx + 1).trim();
    if (key) result[key] = val;
  }
  return result;
}

function sanitizeForK8sName(value: string, maxLen = 16): string {
  return value.toLowerCase().replace(/[^a-z0-9-]/g, "").slice(0, maxLen);
}

/**
 * Strips chars outside [a-z0-9._-], lowercases, truncates to 63 chars (K8s label value limit).
 * Emits a stderr warning via `warn` when chars are dropped.
 */
export function sanitizeLabelValue(value: string, warn?: (msg: string) => void): string {
  const lower = value.toLowerCase();
  const sanitized = lower.replace(/[^a-z0-9._-]/g, "").slice(0, 63);
  if (warn && sanitized !== lower.slice(0, 63)) {
    warn(`[paperclip] sanitizeLabelValue: dropped chars from "${value}" -> "${sanitized}"\n`);
  }
  return sanitized;
}

function nameHash(...parts: string[]): string {
  return createHash("sha256").update(parts.join(":")).digest("hex").slice(0, 6);
}

function buildEnvVars(
  ctx: AdapterExecutionContext,
  selfPod: SelfPodInfo,
  config: Record<string, unknown>,
): k8s.V1EnvVar[] {
  const { runId, agent, context } = ctx;
  const envConfig = parseObject(config.env);

  // Layer 1: PAPERCLIP_* base vars
  const paperclipEnv = buildPaperclipEnv(agent);
  paperclipEnv.PAPERCLIP_RUN_ID = runId;

  const setIfPresent = (envKey: string, value: unknown) => {
    if (typeof value === "string" && value.trim().length > 0) {
      paperclipEnv[envKey] = value.trim();
    }
  };

  setIfPresent("PAPERCLIP_TASK_ID", context.taskId ?? context.issueId);
  setIfPresent("PAPERCLIP_WAKE_REASON", context.wakeReason);
  setIfPresent("PAPERCLIP_WAKE_COMMENT_ID", context.wakeCommentId ?? context.commentId);
  setIfPresent("PAPERCLIP_APPROVAL_ID", context.approvalId);
  setIfPresent("PAPERCLIP_APPROVAL_STATUS", context.approvalStatus);

  const wakePayloadJson = stringifyPaperclipWakePayload(context.paperclipWake);
  if (wakePayloadJson) {
    paperclipEnv.PAPERCLIP_WAKE_PAYLOAD_JSON = wakePayloadJson;
  }

  const workspaceContext = parseObject(context.paperclipWorkspace);
  setIfPresent("PAPERCLIP_WORKSPACE_CWD", workspaceContext.cwd);
  setIfPresent("PAPERCLIP_WORKSPACE_SOURCE", workspaceContext.source);
  setIfPresent("PAPERCLIP_WORKSPACE_STRATEGY", workspaceContext.strategy);
  setIfPresent("PAPERCLIP_WORKSPACE_ID", workspaceContext.workspaceId);
  setIfPresent("PAPERCLIP_WORKSPACE_REPO_URL", workspaceContext.repoUrl);
  setIfPresent("PAPERCLIP_WORKSPACE_REPO_REF", workspaceContext.repoRef);
  setIfPresent("PAPERCLIP_WORKSPACE_BRANCH", workspaceContext.branchName);
  setIfPresent("PAPERCLIP_WORKSPACE_WORKTREE_PATH", workspaceContext.worktreePath);
  setIfPresent("AGENT_HOME", workspaceContext.agentHome);

  const linkedIssueIds = Array.isArray(context.issueIds)
    ? context.issueIds.filter((v): v is string => typeof v === "string" && v.trim().length > 0)
    : [];
  if (linkedIssueIds.length > 0) {
    paperclipEnv.PAPERCLIP_LINKED_ISSUE_IDS = linkedIssueIds.join(",");
  }
  if (Array.isArray(context.paperclipWorkspaces) && context.paperclipWorkspaces.length > 0) {
    paperclipEnv.PAPERCLIP_WORKSPACES_JSON = JSON.stringify(context.paperclipWorkspaces);
  }
  if (Array.isArray(context.paperclipRuntimeServiceIntents) && context.paperclipRuntimeServiceIntents.length > 0) {
    paperclipEnv.PAPERCLIP_RUNTIME_SERVICE_INTENTS_JSON = JSON.stringify(context.paperclipRuntimeServiceIntents);
  }
  if (Array.isArray(context.paperclipRuntimeServices) && context.paperclipRuntimeServices.length > 0) {
    paperclipEnv.PAPERCLIP_RUNTIME_SERVICES_JSON = JSON.stringify(context.paperclipRuntimeServices);
  }
  setIfPresent("PAPERCLIP_RUNTIME_PRIMARY_URL", context.paperclipRuntimePrimaryUrl);

  if (ctx.authToken) {
    paperclipEnv.PAPERCLIP_API_KEY = ctx.authToken;
  }

  // Inherit PAPERCLIP_API_URL from Deployment env (in-cluster service URL)
  if (selfPod.inheritedEnv.PAPERCLIP_API_URL) {
    paperclipEnv.PAPERCLIP_API_URL = selfPod.inheritedEnv.PAPERCLIP_API_URL;
  }
  // Layer 3: Inherited from Deployment (Bedrock, API keys, etc.)
  const merged: Record<string, string> = {
    ...selfPod.inheritedEnv,
    ...paperclipEnv,
  };

  // Layer 4: User-defined overrides from adapterConfig.env
  for (const [key, value] of Object.entries(envConfig)) {
    if (typeof value === "string") merged[key] = value;
  }

  // OpenCode-specific: prevent project config pollution, always set after user overrides
  merged.OPENCODE_DISABLE_PROJECT_CONFIG = "true";
  merged.HOME = "/paperclip";

  // Convert literal-value vars to V1EnvVar array
  const envVars: k8s.V1EnvVar[] = Object.entries(merged).map(([name, value]) => ({
    name,
    value,
  }));

  // Append valueFrom vars (Secret/ConfigMap-backed) only for names not already overridden
  for (const envVar of selfPod.inheritedEnvValueFrom) {
    if (!Object.prototype.hasOwnProperty.call(merged, envVar.name)) {
      envVars.push({ name: envVar.name, valueFrom: envVar.valueFrom });
    }
  }

  return envVars;
}

/**
 * Build the OpenCode runtime config JSON for permission.external_directory=allow.
 * Returned as a string to be written inside the Job container.
 */
function buildRuntimeConfigJson(config: Record<string, unknown>): string | null {
  const skipPermissions = asBoolean(config.dangerouslySkipPermissions, true);
  if (!skipPermissions) return null;
  return JSON.stringify({ permission: { external_directory: "allow" } }, null, 2);
}

export function buildJobManifest(input: JobBuildInput): JobBuildResult {
  const { ctx, selfPod } = input;
  const { runId, agent, runtime, config: rawConfig, context, onLog } = ctx;
  const warnLabel = (msg: string) => void onLog("stderr", msg).catch(() => {});
  const config = parseObject(rawConfig);

  const namespace = asString(config.namespace, "") || selfPod.namespace;
  const image = asString(config.image, "") || selfPod.image;
  const model = asString(config.model, "").trim();
  const variant = asString(config.variant, "").trim();
  const extraArgs = asStringArray(config.extraArgs);
  const timeoutSec = asNumber(config.timeoutSec, 0);
  const ttlSeconds = asNumber(config.ttlSecondsAfterFinished, 300);
  const resources = parseObject(config.resources);
  const hasConfigKey = (key: string) => Object.prototype.hasOwnProperty.call(config, key);
  const configuredNodeSelector = parseKeyValueOrObject(config.nodeSelector);
  const nodeSelector = hasConfigKey("nodeSelector") ? configuredNodeSelector : selfPod.nodeSelector;
  const configuredTolerations = Array.isArray(config.tolerations) ? config.tolerations : [];
  const tolerations = hasConfigKey("tolerations") ? configuredTolerations : selfPod.tolerations;
  const extraLabels = parseKeyValueOrObject(config.labels);

  // Resolve working directory
  const workspaceContext = parseObject(context.paperclipWorkspace);
  const workspaceCwd = asString(workspaceContext.cwd, "");
  const configuredCwd = asString(config.cwd, "");
  const workingDir = workspaceCwd || configuredCwd || "/paperclip";

  // Job naming: slug + 6-char hash for collision resistance; strip trailing hyphens
  const agentSlug = sanitizeForK8sName(agent.id);
  const runSlug = sanitizeForK8sName(runId);
  const hash = nameHash(agent.id, runId);
  const jobName = `agent-opencode-${agentSlug}-${runSlug}-${hash}`.replace(/-+$/, "");

  // Build prompt
  const promptTemplate = asString(
    config.promptTemplate,
    "You are agent {{agent.id}} ({{agent.name}}). Continue your Paperclip work.",
  );
  const bootstrapPromptTemplate = asString(config.bootstrapPromptTemplate, "");
  const runtimeSessionParams = parseObject(runtime.sessionParams);
  const runtimeSessionId = asString(runtimeSessionParams.sessionId, runtime.sessionId ?? "");
  const templateData = {
    agentId: agent.id,
    companyId: agent.companyId,
    runId,
    company: { id: agent.companyId },
    agent,
    run: { id: runId, source: "on_demand" },
    context,
  };
  const renderedBootstrapPrompt =
    !runtimeSessionId && bootstrapPromptTemplate.trim().length > 0
      ? renderTemplate(bootstrapPromptTemplate, templateData).trim()
      : "";
  const wakePrompt = renderPaperclipWakePrompt(context.paperclipWake, { resumedSession: Boolean(runtimeSessionId) });
  const shouldUseResumeDeltaPrompt = Boolean(runtimeSessionId) && wakePrompt.length > 0;
  const renderedPrompt = shouldUseResumeDeltaPrompt ? "" : renderTemplate(promptTemplate, templateData);
  const sessionHandoffNote = asString(context.paperclipSessionHandoffMarkdown, "").trim();
  const instructionsContent = input.instructionsContent?.trim() ?? "";
  const skillsBundleContent = input.skillsBundleContent?.trim() ?? "";
  const prompt = joinPromptSections([
    instructionsContent,
    skillsBundleContent,
    renderedBootstrapPrompt,
    wakePrompt,
    sessionHandoffNote,
    renderedPrompt,
  ]);
  const promptMetrics = {
    promptChars: prompt.length,
    instructionsChars: instructionsContent.length,
    skillsBundleChars: skillsBundleContent.length,
    bootstrapPromptChars: renderedBootstrapPrompt.length,
    wakePromptChars: wakePrompt.length,
    sessionHandoffChars: sessionHandoffNote.length,
    heartbeatPromptChars: renderedPrompt.length,
  };

  // Build opencode CLI args
  const opencodeArgs = ["run", "--format", "json"];
  // resumeLastSession defaults to true (preserve existing behaviour); set to false to start fresh.
  const resumeLastSession = asBoolean(config.resumeLastSession, true);
  if (runtimeSessionId && resumeLastSession) opencodeArgs.push("--session", runtimeSessionId);
  if (model) opencodeArgs.push("--model", model);
  if (variant) opencodeArgs.push("--variant", variant);
  if (extraArgs.length > 0) opencodeArgs.push(...extraArgs);

  // Build env vars
  const envVars = buildEnvVars(ctx, selfPod, config);

  // OPENCODE_DB: set when a DB volume is present (dedicated PVC or ephemeral emptyDir)
  if (input.agentDbClaimName !== undefined) {
    const dbEnvIdx = envVars.findIndex((e) => e.name === "OPENCODE_DB");
    if (dbEnvIdx >= 0) {
      envVars[dbEnvIdx] = { name: "OPENCODE_DB", value: "/opencode-db/opencode.db" };
    } else {
      envVars.push({ name: "OPENCODE_DB", value: "/opencode-db/opencode.db" });
    }
  }

  // Runtime config for permissions
  const runtimeConfigJson = buildRuntimeConfigJson(config);

  // Resource defaults
  const resourceRequests = parseObject(resources.requests);
  const resourceLimits = parseObject(resources.limits);
  const containerResources: k8s.V1ResourceRequirements = {
    requests: {
      cpu: asString(resourceRequests.cpu, "1000m"),
      memory: asString(resourceRequests.memory, "2Gi"),
    },
    limits: {
      cpu: asString(resourceLimits.cpu, "4000m"),
      memory: asString(resourceLimits.memory, "8Gi"),
    },
  };

  // Labels: sanitize all values to [a-z0-9._-] max 63 chars (K8s RFC 1123)
  const labels: Record<string, string> = {
    "app.kubernetes.io/managed-by": "paperclip",
    "app.kubernetes.io/component": "agent-job",
    "paperclip.io/agent-id": sanitizeLabelValue(agent.id, warnLabel),
    "paperclip.io/run-id": sanitizeLabelValue(runId, warnLabel),
    "paperclip.io/company-id": sanitizeLabelValue(agent.companyId, warnLabel),
    "paperclip.io/adapter-type": "opencode_k8s",
  };
  const taskId = asString(context.taskId ?? context.issueId, "").trim();
  if (taskId) labels["paperclip.io/task-id"] = sanitizeLabelValue(taskId, warnLabel);
  if (runtimeSessionId) labels["paperclip.io/session-id"] = sanitizeLabelValue(runtimeSessionId, warnLabel);
  for (const [key, value] of Object.entries(extraLabels)) {
    if (typeof value === "string") labels[key] = sanitizeLabelValue(value, warnLabel);
  }

  // Volumes
  const volumes: k8s.V1Volume[] = [{ name: "prompt", emptyDir: {} }];
  const volumeMounts: k8s.V1VolumeMount[] = [{ name: "prompt", mountPath: "/tmp/prompt" }];

  if (input.promptSecretName) {
    volumes.push({ name: "prompt-secret", secret: { secretName: input.promptSecretName } });
  }

  if (selfPod.pvcClaimName) {
    volumes.push({
      name: "data",
      persistentVolumeClaim: { claimName: selfPod.pvcClaimName },
    });
    volumeMounts.push({ name: "data", mountPath: "/paperclip" });
  }

  // OpenCode DB volume: dedicated PVC (string claim name) or ephemeral emptyDir (null)
  if (input.agentDbClaimName !== undefined) {
    volumes.push(
      input.agentDbClaimName !== null
        ? { name: "opencode-db", persistentVolumeClaim: { claimName: input.agentDbClaimName } }
        : { name: "opencode-db", emptyDir: {} },
    );
    volumeMounts.push({ name: "opencode-db", mountPath: "/opencode-db" });
  }

  // Mount secret volumes inherited from the Deployment pod
  for (const sv of selfPod.secretVolumes) {
    volumes.push({
      name: sv.volumeName,
      secret: { secretName: sv.secretName, defaultMode: sv.defaultMode, optional: true },
    });
    volumeMounts.push({
      name: sv.volumeName,
      mountPath: sv.mountPath,
      readOnly: true,
    });
  }

  const securityContext: k8s.V1SecurityContext = {
    capabilities: { drop: ["ALL"] },
    readOnlyRootFilesystem: false,
    runAsNonRoot: true,
    runAsUser: 1000,
    allowPrivilegeEscalation: false,
  };

  const podSecurityContext: k8s.V1PodSecurityContext = {
    runAsNonRoot: true,
    runAsUser: 1000,
    runAsGroup: 1000,
    fsGroup: 1000,
    fsGroupChangePolicy: "OnRootMismatch",
  };

  // Build the main container command
  // 1. Refresh OAuth credentials via ccrotate so opencode reads fresh codex auth
  // 2. Optionally write opencode runtime config for permission bypass
  // 3. Pipe prompt into opencode
  //
  // The codex auth file on the shared PVC may contain an expired access token
  // (codex tokens expire ~30-60 min after issue and the paperclip pod doesn't
  // refresh them automatically). Without a per-Job refresh, opencode in the
  // Job pod fails authentication whenever the cached token is past expiry.
  //
  // `snap --force` saves the current account's just-refreshed tokens back to
  // the codex profile (cron-equivalent of the Stop hook). `next --yes` then
  // rotates: --yes is required because Job pods have no stdin, so without it
  // ccrotate prompts and hangs/exits when all accounts are at extra usage.
  // Failure is non-fatal: if ccrotate isn't on PATH or all accounts are
  // exhausted, we still try opencode with whatever credentials are on disk.
  const opencodeArgsEscaped = opencodeArgs.map((a) => `'${a.replace(/'/g, "'\\''")}'`).join(" ");
  const ccrotateRefresh = `(command -v ccrotate >/dev/null 2>&1 && ccrotate snap --force --target codex >/dev/null 2>&1; ccrotate next --yes --target codex >/dev/null 2>&1) || true`;
  const configSetup = runtimeConfigJson
    ? `mkdir -p ~/.config/opencode && echo '${runtimeConfigJson.replace(/'/g, "'\\''")}' > ~/.config/opencode/opencode.json && `
    : "";
  const mainCommand = `${ccrotateRefresh}; ${configSetup}cat /tmp/prompt/prompt.txt | opencode ${opencodeArgsEscaped}`;

  const job: k8s.V1Job = {
    apiVersion: "batch/v1",
    kind: "Job",
    metadata: {
      name: jobName,
      namespace,
      labels,
      annotations: {
        "paperclip.io/adapter-type": "opencode_k8s",
        "paperclip.io/agent-name": agent.name,
      },
    },
    spec: {
      backoffLimit: 0,
      ...(timeoutSec > 0 ? { activeDeadlineSeconds: timeoutSec } : {}),
      ttlSecondsAfterFinished: ttlSeconds,
      template: {
        metadata: { labels },
        spec: {
          restartPolicy: "Never",
          serviceAccountName: asString(config.serviceAccountName, "") || undefined,
          securityContext: podSecurityContext,
          ...(selfPod.imagePullSecrets.length > 0 ? { imagePullSecrets: selfPod.imagePullSecrets } : {}),
          ...(selfPod.dnsConfig ? { dnsConfig: selfPod.dnsConfig } : {}),
          ...(Object.keys(nodeSelector).length > 0 ? { nodeSelector: nodeSelector as Record<string, string> } : {}),
          ...(tolerations.length > 0 ? { tolerations: tolerations as k8s.V1Toleration[] } : {}),
          initContainers: [
            {
              name: "write-prompt",
              image: "busybox:1.36",
              imagePullPolicy: "IfNotPresent",
              ...(input.promptSecretName
                ? {
                    command: ["sh", "-c", "cp /tmp/prompt-secret/prompt /tmp/prompt/prompt.txt"],
                    volumeMounts: [
                      { name: "prompt", mountPath: "/tmp/prompt" },
                      { name: "prompt-secret", mountPath: "/tmp/prompt-secret", readOnly: true },
                    ],
                  }
                : {
                    command: ["sh", "-c", "printf '%s' \"$PROMPT_CONTENT\" > /tmp/prompt/prompt.txt"],
                    env: [{ name: "PROMPT_CONTENT", value: prompt }],
                    volumeMounts: [{ name: "prompt", mountPath: "/tmp/prompt" }],
                  }),
              securityContext,
              resources: {
                requests: { cpu: "10m", memory: "16Mi" },
                limits: { cpu: "100m", memory: "64Mi" },
              },
            },
          ],
          containers: [
            {
              name: "opencode",
              image,
              imagePullPolicy: asString(config.imagePullPolicy, "IfNotPresent"),
              workingDir,
              command: ["sh", "-c", mainCommand],
              env: envVars,
              ...(selfPod.inheritedEnvFrom.length > 0 ? { envFrom: selfPod.inheritedEnvFrom } : {}),
              volumeMounts,
              securityContext,
              resources: containerResources,
            },
          ],
          volumes,
        },
      },
    },
  };

  return { job, jobName, namespace, prompt, opencodeArgs, promptMetrics };
}
