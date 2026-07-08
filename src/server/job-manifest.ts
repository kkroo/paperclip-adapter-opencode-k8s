import { createHash } from "crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
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

/**
 * Path to the project-scope .mcp.json that paperclip's helm-chart seed-init
 * writes on every pod start (claude-style schema). The opencode adapter
 * runs inside the paperclip StatefulSet pod, which mounts the same
 * /paperclip PVC the Job pods will mount, so reading this path here gives
 * us the same baseline the claude_k8s adapter uses. We translate it into
 * opencode's `mcp` schema (different from claude's `mcpServers`) and ship
 * it via OPENCODE_CONFIG.
 */
const SHARED_MCP_BASELINE_PATH = "/paperclip/.mcp.json";

function loadSharedMcpBaseline(): Record<string, unknown> {
  try {
    const raw = readFileSync(SHARED_MCP_BASELINE_PATH, "utf8");
    const parsed = JSON.parse(raw) as { mcpServers?: unknown };
    if (parsed && typeof parsed === "object" && parsed.mcpServers && typeof parsed.mcpServers === "object") {
      return parsed.mcpServers as Record<string, unknown>;
    }
  } catch {
    // Missing / unreadable / malformed baseline → start from empty.
  }
  return {};
}

/**
 * Translate one MCP server entry from claude's .mcp.json schema into
 * opencode's opencode.json `mcp` schema. The two schemas express the
 * same intent with different field names:
 *   claude  {command: "X", args: [...], env: {...}}
 *     -> opencode {type: "local", command: ["X", ...args], environment: {...}}
 *   claude  {type: "http", url: "...", headers: {...}} / {type: "sse", url: "..."}
 *     -> opencode {type: "remote", url: "...", headers: {...}}
 * SSE entries are emitted as remote — opencode's MCP client may surface a
 * per-server transport error if it can't negotiate SSE; the rest of the
 * fleet stays usable.
 *
 * Already-opencode-shaped entries (have `type: "local" | "remote"`) pass
 * through unchanged so per-agent adapterConfig.mcpServers can be authored
 * directly in opencode's native schema when the operator prefers it.
 */
function translateMcpEntryToOpencode(spec: unknown): Record<string, unknown> | null {
  if (!spec || typeof spec !== "object") return null;
  const s = spec as Record<string, unknown>;
  if (s.type === "local" || s.type === "remote") {
    return s;
  }
  if (typeof s.command === "string") {
    const args = Array.isArray(s.args) ? (s.args as unknown[]).filter((x): x is string => typeof x === "string") : [];
    const out: Record<string, unknown> = {
      type: "local",
      command: [s.command as string, ...args],
    };
    if (s.env && typeof s.env === "object") out.environment = s.env;
    return out;
  }
  if (typeof s.url === "string") {
    const out: Record<string, unknown> = { type: "remote", url: s.url };
    if (s.headers && typeof s.headers === "object" && !Array.isArray(s.headers)) out.headers = s.headers;
    return out;
  }
  return null;
}

function buildOpencodeMcpSection(merged: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [name, raw] of Object.entries(merged)) {
    const translated = translateMcpEntryToOpencode(raw);
    if (translated) out[name] = translated;
  }
  return out;
}

// Linux's per-env-var kernel limit is MAX_ARG_STRLEN = PAGE_SIZE * 32 =
// 131072 bytes (128 KiB). Setting any single env var beyond that makes the
// kernel reject the next exec with E2BIG ("argument list too long"), so the
// busybox init container fails before it can `printf "$PROMPT_CONTENT"` to
// disk. The previous 256 KiB threshold meant prompts in the 128–256 KiB
// band were silently routed via env var instead of via Secret and crashed
// the pod with exit code 255 at write-prompt. Pull the threshold below
// MAX_ARG_STRLEN with headroom for command line + other env values.
export const LARGE_PROMPT_THRESHOLD_BYTES = 100 * 1024;

const RUNTIME_CACHE_VOLUME_NAME = "runtime-cache";
const RUNTIME_CACHE_MOUNT_PATH = "/runtime-cache";
const RUNTIME_CACHE_SIZE_LIMIT = "20Gi";
const AGENT_CACHE_ENV_LEAVES: Record<string, string> = {
  XDG_CACHE_HOME: "xdg",
  // opencode (Bun) is XDG-driven and mkdir's its config/data/state dirs at
  // boot. With only XDG_CACHE_HOME reserved, the other three were unset and
  // opencode fell back to an unwritable path (`/runtime-config`), crashing
  // every run with `EACCES: permission denied, mkdir '/runtime-config'` before
  // any model call (BLO-14003). Reserve all four onto the writable
  // runtime-cache emptyDir. These leaves match the values that were applied as
  // a per-agent adapterConfig.env workaround and verified booting clean, so
  // shipping this makes those overrides redundant.
  XDG_CONFIG_HOME: "xdg/config",
  XDG_DATA_HOME: "xdg/data",
  XDG_STATE_HOME: "xdg/state",
  GOCACHE: "go-build",
  GOMODCACHE: "gomod",
  npm_config_cache: "npm",
  BUN_INSTALL_CACHE: "bun",
  PIP_CACHE_DIR: "pip",
  PLAYWRIGHT_BROWSERS_PATH: "ms-playwright",
  TMPDIR: "tmp",
};

export type RunIsolationMode = "shared" | "isolated";

export interface RunIsolationDescriptor {
  mode: RunIsolationMode;
  key: string | null;
  keyHash: string | null;
  workspaceRoot: string | null;
  homeRoot: string | null;
  cacheRoot: string | null;
  sessionScope: string | null;
}

const SHARED_RUN_ISOLATION: RunIsolationDescriptor = {
  mode: "shared",
  key: null,
  keyHash: null,
  workspaceRoot: null,
  homeRoot: null,
  cacheRoot: null,
  sessionScope: null,
};

function readObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function readDescriptorString(obj: Record<string, unknown>, key: string): string | null {
  const value = obj[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function isolationKeyHash(key: string): string {
  return createHash("sha256").update(key).digest("hex").slice(0, 16);
}

export function readRunIsolationDescriptor(
  ctx: AdapterExecutionContext,
  config: Record<string, unknown> = parseObject(ctx.config),
): RunIsolationDescriptor {
  const context = (ctx.context ?? {}) as Record<string, unknown>;
  const candidates = [
    context.k8sRunIsolation,
    context.runIsolation,
    context.isolation,
    config.k8sRunIsolation,
    config.runIsolation,
    config.isolation,
  ];
  const raw = candidates.map(readObject).find((candidate): candidate is Record<string, unknown> => Boolean(candidate));
  if (!raw) return SHARED_RUN_ISOLATION;

  const mode = readDescriptorString(raw, "isolationMode") ?? readDescriptorString(raw, "mode");
  const key = readDescriptorString(raw, "isolationKey") ?? readDescriptorString(raw, "key");
  if (mode !== "isolated" || !key) return SHARED_RUN_ISOLATION;

  return {
    mode: "isolated",
    key,
    keyHash: isolationKeyHash(key),
    workspaceRoot: readDescriptorString(raw, "workspaceRoot"),
    homeRoot: readDescriptorString(raw, "homeRoot"),
    cacheRoot: readDescriptorString(raw, "cacheRoot"),
    sessionScope: readDescriptorString(raw, "sessionScope"),
  };
}

function assertSafePathComponent(field: string, value: string): void {
  // Allow alphanumeric, hyphens, and colons (UUIDs like "550e8400-e29b-41d4-a716-446655440000")
  if (!/^[a-zA-Z0-9-:]+$/.test(value)) {
    throw new Error(`Invalid ${field} for log path: ${value}`);
  }
}

export function buildPodLogPath(companyId: string, agentId: string, runId: string): string {
  return `/paperclip/instances/default/data/run-logs/${companyId}/${agentId}/${runId}.pod.ndjson`;
}

function buildIsolatedPodLogPath(isolation: RunIsolationDescriptor, runId: string): string | null {
  if (isolation.mode !== "isolated" || !isolation.cacheRoot) return null;
  return path.posix.join(isolation.cacheRoot, "run-logs", `${runId}.pod.ndjson`);
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

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
   *
   * Mutually exclusive with `agentDbWorkspaceSubPath` — pass at most one.
   */
  agentDbClaimName?: string | null;
  /**
   * workspace_subpath mode: mount /opencode-db on the existing workspace
   * (`data`) PVC at this subPath. Caller supplies the full relative path
   * (e.g. `.opencode-db/<companyId>/<agentId>/<sanitized-taskKey>`); the
   * kubelet creates the directory lazily on first write.
   *
   * Use a per-(agent, taskKey) path so concurrent runs of the same agent on
   * different tasks each get their own SQLite file — the heartbeat scheduler
   * already serializes runs per (agent, task), so this gives single-writer
   * semantics on each opencode.db without needing RWX storage.
   *
   * Mutually exclusive with `agentDbClaimName`. When both are undefined, no
   * opencode-db volume is added (legacy behavior).
   */
  agentDbWorkspaceSubPath?: string;
  /**
   * Phase E.2: workspace PVC claim name supplied by a paperclip k8s execution
   * target's environment config. When set, overrides `selfPod.pvcClaimName`
   * for the workspace `data` volume. When unset, falls back to selfPod.
   */
  workspaceVolumeClaim?: string;
  /**
   * Phase E.2: workspace mount path supplied by a paperclip k8s execution
   * target's environment config. Defaults to `/paperclip` when unset.
   */
  workspaceMountPath?: string;
  isolation?: RunIsolationDescriptor;
}

export interface JobBuildResult {
  job: k8s.V1Job;
  jobName: string;
  namespace: string;
  prompt: string;
  opencodeArgs: string[];
  promptMetrics: Record<string, number>;
  podLogPath: string;
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
  isolation: RunIsolationDescriptor,
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

  // AGENT_HOME resolution.
  //
  // The agent's instructions (AGENTS.md) point at companion files via
  // `$AGENT_HOME/HEARTBEAT.md`, `$AGENT_HOME/SOUL.md`, `$AGENT_HOME/TOOLS.md`,
  // and `$AGENT_HOME/skills/*.md`. For an "external" instructions bundle the
  // server materializes that whole tree into `instructionsRootPath` (a stable
  // per-agent dir), NOT into the per-task workspace. If AGENT_HOME stays
  // pointed at the workspace (which only ever holds repo checkouts), every
  // `Read $AGENT_HOME/HEARTBEAT.md` the agent performs hits "File not found"
  // and the run dies before doing useful work — the failure mode that kept
  // opencode_k8s agents with an external bundle at 100% failure while
  // claude_k8s agents (whose AGENT_HOME already IS the bundle dir) worked.
  // Point AGENT_HOME at the bundle root so the companions resolve, mirroring
  // claude_k8s. Falls back to the server-provided workspace agentHome when no
  // external bundle is configured (single-file / legacy agents — unchanged).
  const instructionsBundleMode = asString(config.instructionsBundleMode, "").trim();
  const instructionsRootPath = asString(config.instructionsRootPath, "").trim();
  const externalBundleHome =
    instructionsBundleMode === "external" && instructionsRootPath ? instructionsRootPath : "";
  setIfPresent("AGENT_HOME", externalBundleHome || workspaceContext.agentHome);

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

  // Agent jobs do dev/build work (npm install with devDependencies, running
  // source build/test toolchains). The base paperclip image bakes
  // NODE_ENV=production, which makes `npm install`/`npm ci` omit
  // devDependencies and breaks toolchain bootstrap for source builds
  // (e.g. shaka's closure-make-deps). Default to a non-production NODE_ENV so
  // dev tooling installs. Set before Layer 4 so the Deployment env (above) or
  // user config.env can still override it. See BLO-8661.
  if (!("NODE_ENV" in merged)) {
    merged.NODE_ENV = "development";
  }

  // Layer 4: User-defined overrides from adapterConfig.env
  for (const [key, value] of Object.entries(envConfig)) {
    if (typeof value === "string") merged[key] = value;
  }

  // Agent Jobs mount their own runtime-cache emptyDir. Keep regenerable build,
  // package, browser, temp caches AND opencode's XDG config/data/state off the
  // shared /paperclip PVC — opencode regenerates all of these per run, and its
  // XDG dirs must land somewhere writable or the process crashes at boot
  // (BLO-14003). These keys are reserved so stale adapterConfig.env overrides
  // cannot move them back onto the shared PVC.
  const cacheMountPath = isolation.cacheRoot ?? RUNTIME_CACHE_MOUNT_PATH;
  for (const [key, leaf] of Object.entries(AGENT_CACHE_ENV_LEAVES)) {
    merged[key] = `${cacheMountPath}/${leaf}`;
  }

  // OpenCode-specific: prevent project config pollution, always set after user overrides
  merged.OPENCODE_DISABLE_PROJECT_CONFIG = "true";
  merged.HOME = isolation.homeRoot ?? "/paperclip";
  if (isolation.mode === "isolated") {
    merged.PAPERCLIP_K8S_ISOLATION_MODE = isolation.mode;
    if (isolation.key) merged.PAPERCLIP_K8S_ISOLATION_KEY = isolation.key;
    if (isolation.workspaceRoot) merged.PAPERCLIP_K8S_WORKSPACE_ROOT = isolation.workspaceRoot;
    if (isolation.homeRoot) merged.PAPERCLIP_K8S_HOME_ROOT = isolation.homeRoot;
    if (isolation.cacheRoot) merged.PAPERCLIP_K8S_CACHE_ROOT = isolation.cacheRoot;
    if (isolation.sessionScope) merged.PAPERCLIP_K8S_SESSION_SCOPE = isolation.sessionScope;
  }

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
 * Build the OpenCode runtime config JSON written to ~/.config/opencode/opencode.json.
 *
 * Two responsibilities:
 *  1. `permission.external_directory: "allow"` — preserves the original behavior
 *     of bypassing opencode's per-directory permission prompt (Job pods have no
 *     stdin).
 *  2. Force opencode away from the default `opencode.ai/zen` provider, which
 *     anonymously returns `FreeUsageLimitError` 429 within seconds and then
 *     wedges the pod (the AI SDK marks the error retryable but never retries).
 *     Instead route to the bundled `openai` provider in chatgpt-OAuth mode,
 *     using the refreshed codex tokens that ccrotate writes to
 *     ~/.codex/auth.json (see buildOpencodeAuthBootstrapShell).
 *
 * `disabled_providers: ["opencode"]` makes the failure loud (opencode exits
 * immediately if no other provider is configured) instead of silently
 * falling through to zen.
 */
// Reasoning models (notably gpt-5.5) routinely pause for long stretches between
// streamed SSE chunks while thinking. OpenCode's default inter-chunk idle guard
// (`provider.options.chunkTimeout`) aborts the request when no chunk arrives
// within its window, surfacing `API Error: Stream idle timeout - partial
// response` and persisting the TRUNCATED assistant turn — e.g. an issue
// description cut mid-sentence, which then mirrors verbatim to Linear and reads
// as a "sync clipped my body" bug. 240_000 ms (240s) sits just under the
// /responses shim's 255s Bun socket idle (onprem-k8s opencode-ccrotate-responses-shim)
// and matches the MCP idleTimeout=240 convention, so opencode tolerates the same
// reasoning gap the upstream socket does instead of aborting first. Applied to
// BOTH config paths because opencode does not merge config sources — whichever
// of ~/.config/opencode/opencode.json (no-MCP) or OPENCODE_CONFIG (MCP) wins
// must carry it.
const OPENAI_PROVIDER_CHUNK_TIMEOUT_MS = 240_000;

/**
 * Per-agent client-session header for the Penstock gateway (org_penstock
 * #accounts attribution). Every agent Job shares the one org API key, so
 * without this the whole fleet melts into a single UNTAGGED bucket on the
 * consumption dashboard. Penstock's client-session extraction gives
 * `x-penstock-session` top precedence, so each agent's traffic groups under
 * `agent:<name>` — one live entry per agent while it is actually flowing.
 *
 * Value hygiene mirrors the host's claude_local X-Anthropic-Agent-Id stamp:
 * strip CR/LF (header injection) and bound the length.
 */
function penstockSessionHeaders(agent: { id: string; name?: string | null }): Record<string, string> {
  const name = String(agent.name ?? "").replace(/[\r\n]/g, "").trim();
  const id = String(agent.id ?? "").replace(/[\r\n]/g, "").trim();
  const label = (name || id).slice(0, 128);
  return { "x-penstock-session": `agent:${label}` };
}

/**
 * Provider options for BOTH opencode config paths (opencode does not merge
 * config sources, so whichever file wins must carry the full set):
 *  - openai.chunkTimeout: generous inter-chunk idle window for reasoning models
 *  - per-provider headers: per-agent Penstock session identity (see
 *    penstockSessionHeaders) — opencode passes `options` to the AI SDK's
 *    provider factory, which merges `headers` into every request.
 */
function providerConfig(agent: { id: string; name?: string | null }): Record<string, unknown> {
  const headers = penstockSessionHeaders(agent);
  return {
    anthropic: { options: { headers } },
    openai: { options: { chunkTimeout: OPENAI_PROVIDER_CHUNK_TIMEOUT_MS, headers } },
  };
}

function buildRuntimeConfigJson(
  config: Record<string, unknown>,
  agent: { id: string; name?: string | null },
): string | null {
  const skipPermissions = asBoolean(config.dangerouslySkipPermissions, true);
  const runtime: Record<string, unknown> = {
    disabled_providers: ["opencode"],
    provider: providerConfig(agent),
  };
  if (skipPermissions) {
    runtime.permission = { external_directory: "allow" };
  }
  return JSON.stringify(runtime, null, 2);
}

/**
 * Shell snippet that translates ccrotate's codex auth file
 * (`~/.codex/auth.json`, chatgpt-OAuth shape) into opencode's auth store
 * (`~/.local/share/opencode/auth.json`, openai-OAuth shape) so opencode's
 * built-in `openai` provider authenticates against ChatGPT instead of
 * falling through to the anonymous zen free tier.
 *
 * Runs after `ccrotate next --target codex` so the codex auth file is fresh.
 * Best-effort: failures (missing codex auth, parse errors) leave the pod
 * to fail loud at the opencode invocation rather than masking the issue.
 *
 * Expiry is read from the id_token's `exp` claim; opencode's openai provider
 * will refresh through its codex device-flow refresh endpoint when the access
 * token expires.
 */
function buildOpencodeAuthBootstrapShell(): string {
  return `mkdir -p ~/.local/share/opencode && node -e 'const fs=require("fs"),p=require("path"),H=process.env.HOME||".";try{const c=JSON.parse(fs.readFileSync(p.join(H,".codex","auth.json"),"utf8"));if(c.auth_mode!=="chatgpt"||!c.tokens||!c.tokens.access_token||!c.tokens.refresh_token)process.exit(0);let exp=Date.now()+30*60*1000;try{const part=c.tokens.id_token.split(".")[1];const pad="=".repeat((4-part.length%4)%4);const payload=JSON.parse(Buffer.from((part+pad).replace(/-/g,"+").replace(/_/g,"/"),"base64").toString());if(payload.exp)exp=payload.exp*1000;}catch(e){}const out={openai:{type:"oauth",access:c.tokens.access_token,refresh:c.tokens.refresh_token,expires:exp,accountId:c.tokens.account_id||null}};fs.writeFileSync(p.join(H,".local","share","opencode","auth.json"),JSON.stringify(out));}catch(e){console.error("[opencode-auth-bootstrap] skipped:",e.message);}' || true`;
}

function buildOpencodeApiKeyAuthCleanupShell(): string {
  return `rm -f ~/.local/share/opencode/auth.json ~/.local/share/opencode/account.json 2>/dev/null || true`;
}

function hasEnvVarValue(envVars: k8s.V1EnvVar[], name: string): boolean {
  return envVars.some((envVar) => {
    if (envVar.name !== name) return false;
    if (typeof envVar.value === "string" && envVar.value.length > 0) return true;
    return Boolean(envVar.valueFrom);
  });
}

/**
 * docker:dind sidecar exposing /var/run/docker.sock to the agent container
 * via a shared emptyDir. Deployed as a native Kubernetes 1.29+ sidecar
 * (initContainer with restartPolicy: "Always"): starts before the main
 * container, lives for the duration of the Job, terminates when main exits.
 *
 * Privileged because dockerd needs cgroups + devices. The cluster does not
 * enforce PodSecurityStandards (see the k8s repo's
 * feedback_pss_enforcement.md), so a privileged Pod is acceptable for
 * opt-in agent toolchain use.
 *
 * DOCKER_TLS_CERTDIR="" disables dockerd's auto-TLS bootstrap — traffic
 * stays on the unix socket inside the pod network namespace, no TCP
 * exposure, no TLS handshakes adding to startup time.
 */
function buildDindSidecar(opts: {
  image: string;
  cpuLimit: string;
  memoryLimit: string;
}): k8s.V1Container {
  // restartPolicy: "Always" on an init container is the native sidecar
  // pattern (k8s 1.29 GA, 1.28 beta). The @kubernetes/client-node
  // V1Container type predates this addition, so we declare an intersection
  // type that adds the field instead of any-casting the whole container.
  type SidecarContainer = k8s.V1Container & { restartPolicy?: string };
  const sidecar: SidecarContainer = {
    name: "dind",
    image: opts.image,
    imagePullPolicy: "IfNotPresent",
    // `--group=1000` makes dockerd create /var/run/docker.sock with group 1000
    // (mode 0660 root:1000). The main agent container runs as uid 1000 with
    // podSecurityContext.fsGroup=1000, so without this it can't connect to the
    // socket (which dockerd otherwise creates root:root mode 0660). Pairs with
    // the pod-level runAsGroup=1000 / fsGroup=1000 that this adapter already
    // sets at line ~695. BLO-5492.
    args: ["dockerd", "--host=unix:///var/run/docker.sock", "--storage-driver=overlay2", "--group=1000"],
    securityContext: { privileged: true, runAsUser: 0, runAsNonRoot: false },
    env: [{ name: "DOCKER_TLS_CERTDIR", value: "" }],
    resources: {
      requests: { cpu: "100m", memory: "256Mi" },
      limits: { cpu: opts.cpuLimit, memory: opts.memoryLimit },
    },
    volumeMounts: [
      { name: "docker-graph", mountPath: "/var/lib/docker" },
      { name: "docker-sock", mountPath: "/var/run" },
    ],
    restartPolicy: "Always",
  };
  return sidecar;
}

/**
 * Shell snippet the main container prepends to its command when the DinD
 * sidecar is enabled. Polls for /var/run/docker.sock to appear (sidecar
 * dockerd needs ~5–15 s to come up) and bails out if it never does, so
 * agent runs never silently proceed without docker available.
 */
const DIND_WAIT_PREAMBLE =
  `i=0; while [ ! -S /var/run/docker.sock ] && [ $i -lt 60 ]; do sleep 0.5; i=$((i+1)); done; ` +
  `if [ ! -S /var/run/docker.sock ]; then echo "dind sidecar socket /var/run/docker.sock never appeared after 30s" >&2; exit 1; fi`;

export function buildJobManifest(input: JobBuildInput): JobBuildResult {
  const { ctx, selfPod } = input;
  const { runId, agent, runtime, config: rawConfig, context, onLog } = ctx;
  const warnLabel = (msg: string) => void onLog("stderr", msg).catch(() => {});
  const config = parseObject(rawConfig);
  const isolation = input.isolation ?? readRunIsolationDescriptor(ctx, config);

  // Validate path components for log file safety
  const companyId = agent.companyId;
  const agentId = agent.id;
  assertSafePathComponent("companyId", companyId);
  assertSafePathComponent("agentId", agentId);
  assertSafePathComponent("runId", runId);

  const namespace = asString(config.namespace, "") || selfPod.namespace;
  const image = asString(config.image, "") || selfPod.image;
  const enableDocker = asBoolean(config.enableDocker, false);
  const dockerImage = asString(config.dockerImage, "docker:28-dind");
  const dockerCpuLimit = asString(config.dockerCpuLimit, "4");
  const dockerMemoryLimit = asString(config.dockerMemoryLimit, "8Gi");
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
  const workingDir = isolation.workspaceRoot || workspaceCwd || configuredCwd || "/paperclip";

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
  // resumeLastSession defaults to true (preserve existing behaviour); set to false to start fresh.
  // A run "is resuming" only when there's a tracked session ID AND the agent
  // hasn't been configured to start fresh. Prompt-rendering paths below must
  // use this unified flag — using `Boolean(runtimeSessionId)` alone causes a
  // skew where `--session` is not passed to opencode (line ~540) but the
  // prompt is still rendered as a resume-delta, so opencode starts a brand-
  // new session with a wake-only prompt and no bootstrap/heartbeat context.
  const resumeLastSession = asBoolean(config.resumeLastSession, true);
  const isResuming = Boolean(runtimeSessionId) && resumeLastSession;
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
    !isResuming && bootstrapPromptTemplate.trim().length > 0
      ? renderTemplate(bootstrapPromptTemplate, templateData).trim()
      : "";
  const wakePrompt = renderPaperclipWakePrompt(context.paperclipWake, { resumedSession: isResuming });
  // Server's heartbeat composes `context.paperclipTaskMarkdown` for wakes
  // that carry first-class task context (PR-review wakes, issue wakes,
  // wake-comment wakes). renderPaperclipWakePrompt only covers the
  // issue/comment path via paperclipWake, so without this slot a
  // github_pr_* wake reaches the pod with NO PR number / repo in the
  // prompt and the reviewer agent has nothing to act on.
  const taskMarkdown = asString(context.paperclipTaskMarkdown, "").trim();
  const shouldUseResumeDeltaPrompt = isResuming && wakePrompt.length > 0;
  const renderedPrompt = shouldUseResumeDeltaPrompt ? "" : renderTemplate(promptTemplate, templateData);
  const sessionHandoffNote = asString(context.paperclipSessionHandoffMarkdown, "").trim();
  const instructionsContent = input.instructionsContent?.trim() ?? "";
  const skillsBundleContent = input.skillsBundleContent?.trim() ?? "";
  const prompt = joinPromptSections([
    instructionsContent,
    skillsBundleContent,
    renderedBootstrapPrompt,
    wakePrompt,
    taskMarkdown,
    sessionHandoffNote,
    renderedPrompt,
  ]);
  const promptMetrics = {
    promptChars: prompt.length,
    instructionsChars: instructionsContent.length,
    skillsBundleChars: skillsBundleContent.length,
    bootstrapPromptChars: renderedBootstrapPrompt.length,
    wakePromptChars: wakePrompt.length,
    taskMarkdownChars: taskMarkdown.length,
    sessionHandoffChars: sessionHandoffNote.length,
    heartbeatPromptChars: renderedPrompt.length,
  };

  // Build opencode CLI args
  const opencodeArgs = ["run", "--format", "json"];
  if (isResuming) opencodeArgs.push("--session", runtimeSessionId);
  if (model) opencodeArgs.push("--model", model);
  if (variant) opencodeArgs.push("--variant", variant);
  if (extraArgs.length > 0) opencodeArgs.push(...extraArgs);

  // Build env vars
  const envVars = buildEnvVars(ctx, selfPod, config, isolation);

  // OPENCODE_DB: set when a DB volume is present (dedicated PVC, ephemeral
  // emptyDir, or workspace subPath)
  if (input.agentDbClaimName !== undefined && input.agentDbWorkspaceSubPath !== undefined) {
    throw new Error(
      "agentDbClaimName and agentDbWorkspaceSubPath are mutually exclusive — pass at most one",
    );
  }
  const hasAgentDb =
    input.agentDbClaimName !== undefined || input.agentDbWorkspaceSubPath !== undefined;
  if (hasAgentDb) {
    const dbEnvIdx = envVars.findIndex((e) => e.name === "OPENCODE_DB");
    if (dbEnvIdx >= 0) {
      envVars[dbEnvIdx] = { name: "OPENCODE_DB", value: "/opencode-db/opencode.db" };
    } else {
      envVars.push({ name: "OPENCODE_DB", value: "/opencode-db/opencode.db" });
    }
  }

  // MCP fleet for this Job. Reads paperclip's seed-init baseline at
  // /paperclip/.mcp.json (claude schema) and translates to opencode's
  // schema, then spread-merges per-agent overrides from
  // adapterConfig.mcpServers (operator can author in either schema —
  // already-opencode-shaped entries pass through unchanged). The merged
  // result is materialized into /tmp/prompt/opencode.json by the
  // write-prompt init container, and OPENCODE_CONFIG points opencode at
  // it. When the merged set is empty (no baseline + no overrides) we
  // emit nothing — opencode falls back to ~/.config/opencode/opencode.json
  // exactly as before.
  const perAgentMcpServers = parseObject(config.mcpServers);
  const baselineMcpServers = loadSharedMcpBaseline();
  const mergedMcpServers = { ...baselineMcpServers, ...perAgentMcpServers };
  const opencodeMcpSection = buildOpencodeMcpSection(mergedMcpServers);
  const opencodeConfigJson =
    Object.keys(opencodeMcpSection).length > 0
      ? JSON.stringify({
          $schema: "https://opencode.ai/config.json",
          // permission.external_directory mirrors the chart-baseline at
          // /paperclip/.config/opencode/opencode.json so we don't lose
          // the "allow access outside cwd" behavior when overriding via
          // OPENCODE_CONFIG (opencode does not merge config sources).
          permission: { external_directory: "allow" },
          // Disable opencode.ai/zen for the same reason as
          // buildRuntimeConfigJson: it returns FreeUsageLimitError 429
          // anonymously and wedges the pod. Opencode falls through to
          // the bundled `openai` provider in chatgpt-OAuth mode, fed by
          // the auth.json that buildOpencodeAuthBootstrapShell writes
          // from ~/.codex/auth.json.
          disabled_providers: ["opencode"],
          // Chunk timeout + per-agent Penstock session identity; see
          // providerConfig / OPENAI_PROVIDER_CHUNK_TIMEOUT_MS.
          provider: providerConfig(agent),
          mcp: opencodeMcpSection,
        })
      : null;
  if (opencodeConfigJson) {
    envVars.push({ name: "OPENCODE_CONFIG", value: "/tmp/prompt/opencode.json" });
  }

  // Runtime config for permissions
  const runtimeConfigJson = buildRuntimeConfigJson(config, agent);

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
    "paperclip.io/isolation-mode": isolation.mode,
  };
  if (isolation.keyHash) labels["paperclip.io/isolation-key-hash"] = isolation.keyHash;
  if (isolation.sessionScope) labels["paperclip.io/session-scope"] = sanitizeLabelValue(isolation.sessionScope, warnLabel);
  const taskId = asString(context.taskId ?? context.issueId, "").trim();
  if (taskId) labels["paperclip.io/task-id"] = sanitizeLabelValue(taskId, warnLabel);
  if (runtimeSessionId) labels["paperclip.io/session-id"] = sanitizeLabelValue(runtimeSessionId, warnLabel);
  for (const [key, value] of Object.entries(extraLabels)) {
    if (typeof value === "string") labels[key] = sanitizeLabelValue(value, warnLabel);
  }

  // Volumes
  const volumes: k8s.V1Volume[] = [
    { name: "prompt", emptyDir: {} },
    { name: RUNTIME_CACHE_VOLUME_NAME, emptyDir: { sizeLimit: RUNTIME_CACHE_SIZE_LIMIT } },
  ];
  const volumeMounts: k8s.V1VolumeMount[] = [
    { name: "prompt", mountPath: "/tmp/prompt" },
    { name: RUNTIME_CACHE_VOLUME_NAME, mountPath: RUNTIME_CACHE_MOUNT_PATH },
  ];

  if (input.promptSecretName) {
    volumes.push({ name: "prompt-secret", secret: { secretName: input.promptSecretName } });
  }

  // Phase E.2: workspace PVC/mount can be overridden by env config.
  // workspaceVolumeClaim wins over selfPod.pvcClaimName when set.
  // workspaceMountPath defaults to /paperclip when unset.
  const workspaceClaim = input.workspaceVolumeClaim ?? selfPod.pvcClaimName;
  const workspaceMountPath = input.workspaceMountPath ?? "/paperclip";
  if (workspaceClaim) {
    volumes.push({
      name: "data",
      persistentVolumeClaim: { claimName: workspaceClaim },
    });
    volumeMounts.push({ name: "data", mountPath: workspaceMountPath });
  }

  // OpenCode DB volume: dedicated PVC (string claim name), ephemeral emptyDir
  // (null), or workspace subPath (reuses the data volume).
  if (input.agentDbClaimName !== undefined) {
    volumes.push(
      input.agentDbClaimName !== null
        ? { name: "opencode-db", persistentVolumeClaim: { claimName: input.agentDbClaimName } }
        : { name: "opencode-db", emptyDir: {} },
    );
    volumeMounts.push({ name: "opencode-db", mountPath: "/opencode-db" });
  } else if (input.agentDbWorkspaceSubPath !== undefined) {
    // Reuse the workspace `data` volume; mount at /opencode-db on the given
    // subPath. No new volume entry needed — kubelet creates the subdir lazily.
    if (!workspaceClaim) {
      throw new Error(
        "agentDbWorkspaceSubPath requires a workspace data volume (workspaceVolumeClaim or selfPod.pvcClaimName must be set)",
      );
    }
    volumeMounts.push({
      name: "data",
      mountPath: "/opencode-db",
      subPath: input.agentDbWorkspaceSubPath,
    });
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
  // 3. Pipe prompt into opencode, tee stdout to the shared PVC log file
  //
  // The codex auth file on the shared PVC may contain an expired access token
  // (codex tokens expire ~30-60 min after issue and the paperclip pod doesn't
  // refresh them automatically). Without a per-Job refresh, opencode in the
  // Job pod fails authentication whenever the cached token is past expiry.
  //
  // Just `next --yes` — no pre-snap. The codex CLI's Stop-equivalent
  // already snaps the active account's just-refreshed tokens at session
  // end, so the previous Job's exit handles the normal save path. Doing
  // an extra `snap --force` here under multiple-concurrent-Jobs raced
  // with another Job's `next` mid-write of the active codex auth file;
  // a pre-snap reading partial state then committed mismatched creds
  // into a profile labeled with the previous account, clobbering tokens
  // across unrelated profiles. Edge case lost: if a prior agent crashed
  // without firing its snap path, its just-refreshed access token isn't
  // saved — recoverable on the next switchTo via the refresh-token,
  // costing one extra OAuth refresh.
  // `--yes` is still required because Job pods have no stdin, so without
  // it ccrotate prompts and hangs/exits when all accounts are at extra
  // usage. Failure is non-fatal: if ccrotate isn't on PATH or all
  // accounts are exhausted, we still try opencode with whatever
  // credentials are on disk. Bound the preflight so a stuck Codex probe inside
  // ccrotate cannot block the Job before opencode starts.
  const podLogPath = buildIsolatedPodLogPath(isolation, runId) ?? buildPodLogPath(companyId, agentId, runId);
  const opencodeArgsEscaped = opencodeArgs.map((a) => `'${a.replace(/'/g, "'\\''")}'`).join(" ");
  // Phase G.5: per-env credential pool. When `providers.openai.accounts`
  // is a non-empty string array (sourced from the resolved k8s execution
  // target's environment config), pass it through as `--accounts <csv>` so
  // ccrotate rotates only within the env's pool. Absent/empty preserves the
  // existing global-rotation behavior bit-for-bit.
  const openaiAccounts = Array.isArray(
    (config.providers as { openai?: { accounts?: unknown } } | undefined)?.openai?.accounts,
  )
    ? ((config.providers as { openai: { accounts: unknown[] } }).openai.accounts as ReadonlyArray<unknown>).filter(
        (s): s is string => typeof s === "string" && s.length > 0,
      )
    : [];
  const accountsArg = openaiAccounts.length > 0 ? ` --accounts ${openaiAccounts.join(",")}` : "";
  const ccrotateRefresh = `(command -v ccrotate >/dev/null 2>&1 && timeout 30s ccrotate next --yes --target codex${accountsArg} >/dev/null 2>&1) || true`;
  const authBootstrap = hasEnvVarValue(envVars, "OPENAI_API_KEY")
    ? buildOpencodeApiKeyAuthCleanupShell()
    : buildOpencodeAuthBootstrapShell();
  const configSetup = runtimeConfigJson
    ? `mkdir -p ~/.config/opencode && echo '${runtimeConfigJson.replace(/'/g, "'\\''")}' > ~/.config/opencode/opencode.json && `
    : "";
  // `set -o pipefail` so an opencode binary crash surfaces as a non-zero
  // shell exit code instead of being masked by tee's exit code. Mirrors
  // the claude_k8s adapter's fix.
  //
  // mkdir + touch the podLogPath BEFORE invoking opencode so paperclip's
  // tailPodLogFile (30s file-existence wait) doesn't time out on the empty
  // string when opencode is slow to produce its first byte (e.g. ccrotate
  // negotiation, MCP server fetches, large model handshakes). Without
  // this, tail returns "" and the run is mis-classified as
  // adapter_failed/empty-stdout even though opencode is still working.
  // The marker line is also useful in pod logs for confirming the pod
  // reached the tee step at all.
  // Context-overflow auto-remediation: when the prior run set
  // sessionParams.needsCompactBeforeNextRun (overflow detected, or
  // proactive token-budget gate tripped — see execute.ts), prefix the
  // pipeline with a best-effort `/compact` invocation. `/compact` is an
  // opencode slash command that summarizes the session's accumulated
  // history; this preserves the agent's working context (vs. session
  // rotation, which discards it) while making sure the next real prompt
  // fits inside the model's window.
  //
  // Best-effort: any failure here (`/compact` unknown to the opencode
  // version in the image, model unavailable, session already empty)
  // shouldn't block the main run, so we suppress with `|| true`. The next
  // run's overflow detector will catch it again if the compact didn't
  // help. The flag is consumed by the time the main run completes —
  // execute.ts clears it from the returned sessionParams (and re-sets it
  // only if the proactive threshold trips again).
  const needsCompactBeforeNextRun =
    runtimeSessionId && Boolean((runtimeSessionParams as Record<string, unknown>).needsCompactBeforeNextRun);
  const compactArgsEscaped = ["run", "--session", runtimeSessionId, "--format", "json"]
    .map((a) => `'${a.replace(/'/g, "'\\''")}'`)
    .join(" ");
  const compactPrefix = needsCompactBeforeNextRun
    ? `echo "[paperclip] running /compact on session ${runtimeSessionId} before main prompt"; echo '/compact' | opencode ${compactArgsEscaped} >/dev/null 2>&1 || echo "[paperclip] /compact returned non-zero; continuing"; `
    : "";
  // Shared-docs bridge (BLO-10315). For an external instructions bundle, the
  // agent's AGENTS.md "## Shared Documentation" section tells it to `Read
  // docs/<x>.md` — resolved relative to the run's working dir. But those
  // company doc-templates are materialized one level above the per-agent
  // bundle (`<instructionsRootPath>/../../docs`, i.e. companies/<co>/docs/),
  // NOT in the per-run workspace, so every such read 404s and the run exits 1.
  // AGENT_HOME already points at the bundle root (the external-bundle fix), so
  // derive the company docs dir from it and symlink it into the working dir as
  // `docs/`. Guarded: skip when a `docs/` already exists (e.g. the project
  // repo's own), only link when the source dir is present, and never fail the
  // run on error.
  const sharedDocsBridge =
    asString(config.instructionsBundleMode, "").trim() === "external" &&
    asString(config.instructionsRootPath, "").trim()
      ? `( [ -e docs ] || { __pcd="$(dirname "$(dirname "\${AGENT_HOME:-/nonexistent}")")/docs"; [ -d "$__pcd" ] && ln -sfn "$__pcd" docs; } ) 2>/dev/null || true; `
      : "";
  const isolatedRuntimePrep = isolation.mode === "isolated"
    ? `mkdir -p ${[isolation.homeRoot, isolation.cacheRoot, isolation.workspaceRoot, path.posix.dirname(podLogPath)]
        .filter((p): p is string => Boolean(p))
        .map(shellQuote)
        .join(" ")} 2>/dev/null || true; `
    : "";
  // opencode-db schema-compat guard (root-caused 2026-06-21, BLO follow-up).
  // The persistent opencode.db is keyed per (company, agent, taskKey) and reused
  // across runs (workspace_subpath mode). When the vendored opencode binary is
  // upgraded, an opencode.db created by the OLD version can carry a schema the
  // NEW insert path violates — observed live: `NOT NULL constraint failed:
  // session_message.seq` at SessionPrompt.createUserMessage — which bricks
  // EVERY run with a generic "Unexpected server error / UnknownError" thrown
  // before any model call (so the model endpoint looks healthy while the agent
  // crashloops). A DB built fresh by the current binary is self-consistent, so
  // reset opencode.db (+ -wal/-shm) when the opencode version that built it
  // differs from the current binary, stamping the version next to the DB.
  // If the version is unchanged, cap DB growth by resetting when the DB + WAL
  // + SHM files exceed 500 MiB. Best-effort and idempotent: never fails the
  // run. Gated on hasAgentDb (only meaningful when /opencode-db is mounted).
  const dbResetGuard = hasAgentDb
    ? `__ocdb=/opencode-db/opencode.db; __ocdir="$(dirname "$__ocdb")"; __ocver="$(opencode --version 2>/dev/null | head -n1)"; __ocprev="$(cat "$__ocdir/.opencode-version" 2>/dev/null || true)"; if [ -n "$__ocver" ] && [ -f "$__ocdb" ] && [ "$__ocver" != "$__ocprev" ]; then echo "[paperclip] opencode upgraded ('$__ocprev' -> '$__ocver'); resetting $__ocdb to avoid stale-schema crash" >&2; rm -f "$__ocdb" "$__ocdb-shm" "$__ocdb-wal" 2>/dev/null || true; else __ocbytes=0; for __ocf in "$__ocdb" "$__ocdb-wal" "$__ocdb-shm"; do if [ -f "$__ocf" ]; then __ocsz="$(wc -c < "$__ocf" 2>/dev/null || echo 0)"; __ocsz="\${__ocsz##* }"; __ocbytes=$((__ocbytes + \${__ocsz:-0})); fi; done; if [ -f "$__ocdb" ] && [ "$__ocbytes" -gt 524288000 ]; then echo "[paperclip] opencode DB $__ocbytes bytes exceeds 524288000; resetting $__ocdb to cap growth" >&2; rm -f "$__ocdb" "$__ocdb-shm" "$__ocdb-wal" 2>/dev/null || true; fi; fi; if [ -n "$__ocver" ]; then mkdir -p "$__ocdir" 2>/dev/null || true; printf '%s' "$__ocver" > "$__ocdir/.opencode-version" 2>/dev/null || true; fi; `
    : "";
  const baseMainCommand = `set -o pipefail; ${isolatedRuntimePrep}${ccrotateRefresh}; ${authBootstrap}; ${configSetup}${dbResetGuard}${compactPrefix}${sharedDocsBridge}mkdir -p $(dirname ${shellQuote(podLogPath)}) && : > ${shellQuote(podLogPath)} && cat /tmp/prompt/prompt.txt | opencode ${opencodeArgsEscaped} | tee -a ${shellQuote(podLogPath)}`;
  // Redirect Chrome's BrowserMetrics spool off the shared CephFS HOME to the
  // main container's per-pod runtime-cache emptyDir. The
  // agent-browser designer tool launches system Chrome with the default
  // $HOME/.config/google-chrome profile; on headless Chrome's unclean shutdown
  // its ~4MiB BrowserMetrics-*.pma buffers are never reaped and accumulated to
  // 42GiB on the shared PVC, walling the agent fleet at workspace setup with
  // EDQUOT (BLO-10699). Only BrowserMetrics is redirected — the rest of the
  // profile (claude.ai/design auth + cookies) stays persistent. Best-effort
  // and idempotent: never fails the run, skipped when already a symlink.
  const CHROME_METRICS_REDIRECT =
    `mkdir -p "$HOME/.config/google-chrome" ${RUNTIME_CACHE_MOUNT_PATH}/chrome-browser-metrics 2>/dev/null; ` +
    `{ [ -L "$HOME/.config/google-chrome/BrowserMetrics" ] || { rm -rf "$HOME/.config/google-chrome/BrowserMetrics"; ln -sfn ${RUNTIME_CACHE_MOUNT_PATH}/chrome-browser-metrics "$HOME/.config/google-chrome/BrowserMetrics"; }; } 2>/dev/null || true`;
  // When the DinD sidecar is wired in, prepend the wait-for-socket loop
  // so the agent never starts before dockerd is listening on the shared
  // unix socket.
  const mainCommand = enableDocker
    ? `${CHROME_METRICS_REDIRECT}; ${DIND_WAIT_PREAMBLE}; ${baseMainCommand}`
    : `${CHROME_METRICS_REDIRECT}; ${baseMainCommand}`;

  // Wire the DinD sidecar's shared volumes + DOCKER_HOST env into the main
  // container. Done after volumes/volumeMounts/envVars are otherwise built
  // so this is a single localized change, easy to remove if we later move
  // dockerd to a dedicated pod.
  if (enableDocker) {
    volumes.push(
      { name: "docker-graph", emptyDir: {} },
      { name: "docker-sock", emptyDir: {} },
    );
    volumeMounts.push({ name: "docker-sock", mountPath: "/var/run" });
    envVars.push({ name: "DOCKER_HOST", value: "unix:///var/run/docker.sock" });
  }

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
            (() => {
              // Build the init container command + env. Always writes prompt.txt;
              // when an MCP fleet was assembled (baseline or per-agent override),
              // also writes the merged opencode.json next to it. opencode.json is
              // small (a few kB) so it travels via env var even when prompt itself
              // goes the Secret-volume route.
              const cmdParts = input.promptSecretName
                ? ["cp /tmp/prompt-secret/prompt /tmp/prompt/prompt.txt"]
                : [`printf '%s' \"$PROMPT_CONTENT\" > /tmp/prompt/prompt.txt`];
              const initEnv: k8s.V1EnvVar[] = input.promptSecretName
                ? []
                : [{ name: "PROMPT_CONTENT", value: prompt }];
              if (opencodeConfigJson) {
                cmdParts.push(`printf '%s' \"$OPENCODE_CONFIG_JSON\" > /tmp/prompt/opencode.json`);
                initEnv.push({ name: "OPENCODE_CONFIG_JSON", value: opencodeConfigJson });
              }
              const initVolumeMounts: k8s.V1VolumeMount[] = [
                { name: "prompt", mountPath: "/tmp/prompt" },
              ];
              if (input.promptSecretName) {
                initVolumeMounts.push({ name: "prompt-secret", mountPath: "/tmp/prompt-secret", readOnly: true });
              }
              const initContainer: k8s.V1Container = {
                name: "write-prompt",
                image: "busybox:1.36",
                imagePullPolicy: "IfNotPresent",
                command: ["sh", "-c", cmdParts.join("; ")],
                ...(initEnv.length > 0 ? { env: initEnv } : {}),
                volumeMounts: initVolumeMounts,
                securityContext,
                resources: {
                  requests: { cpu: "10m", memory: "16Mi" },
                  limits: { cpu: "100m", memory: "64Mi" },
                },
              };
              return initContainer;
            })(),
            ...(enableDocker
              ? [buildDindSidecar({ image: dockerImage, cpuLimit: dockerCpuLimit, memoryLimit: dockerMemoryLimit })]
              : []),
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

  return { job, jobName, namespace, prompt, opencodeArgs, promptMetrics, podLogPath };
}
