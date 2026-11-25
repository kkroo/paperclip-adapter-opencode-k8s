/**
 * PEN-1305 Layer 1 (plugin arm) — enforced pre-execution block for
 * full-environment dumps in opencode_k8s Job pods.
 *
 * Background: PR #44 shipped the config arm (`permission.bash` deny globs in
 * buildRuntimeConfigJson). Glob matching cannot catch shell-wrapper forms
 * (`sh -lc "env"`) or command chains (`ls && printenv`), so this module adds
 * the robust belt: an opencode `tool.execute.before` plugin that runs the full
 * regex guard with shell unwrapping, mirroring the claude adapter's PreToolUse
 * hook (paperclip-adapter-claude-k8s src/server/env-guard.ts) and the
 * Paperclip server's server/src/agent-shell-guard.ts. Keep all three in
 * behavioural lockstep when any changes.
 *
 * opencode plugin API facts (validated against the fleet's opencode 1.15.12
 * binary and the sst/opencode v1.15.12 source, 2026-08-04):
 *  - Plugin discovery: for each config directory — the global config dir
 *    `${XDG_CONFIG_HOME:-~/.config}/opencode` first — opencode globs
 *    `{plugin,plugins}/*.{ts,js}` (config/plugin.ts `ConfigPlugin.load`).
 *  - `tool.execute.before` fires before the permission ask AND before tool
 *    execution, for built-in and MCP tools, with input
 *    `{tool, sessionID, callID}` and output `{args}` (session/tools.ts).
 *  - Throwing from the hook is the documented block mechanism: the AI SDK
 *    catches the tool-execute rejection and feeds the message to the model
 *    as the tool result.
 *  - Legacy plugin module shape: every module export must be a function
 *    `(input) => Promise<Hooks>`; a non-function export makes the loader
 *    throw (plugin/index.ts getLegacyPlugins). The embedded script therefore
 *    exports exactly ONE symbol.
 *
 * Rollout is canary-gated behind adapter config `envGuardPlugin` (default
 * off). The `permission.bash` deny config and server-side transcript
 * redaction remain independent layers.
 */

export type AgentShellCommandDecision =
  | { action: "allow"; reason: "safe_env_inspection" | "not_environment_dump" }
  | { action: "block"; reason: "full_environment_dump" };

const SAFE_ENV_INSPECTION_COMMAND_RE =
  /^(?:node\s+)?(?:~\/\.claude\/safe-env-inspect\.mjs|\.\/scripts\/safe-env-inspect\.mjs|scripts\/safe-env-inspect\.mjs|safe-env-inspect|paperclip-safe-env)\s*$/;

const SHELL_COMMAND_PREFIX_RE = /^(?:\/bin\/)?(?:ba|z|)?sh\s+-l?c(?:\s+|$)/;

const FULL_ENV_DUMP_RE = new RegExp(
  [
    String.raw`(?:^|[;&|]\s*)(?:command\s+)?(?:\/usr\/bin\/)?(?:env|printenv)(?:\s*(?:[;&|]|$))`,
    String.raw`(?:^|[;&|]\s*)(?:set)(?:\s*(?:[;&|]|$))`,
    String.raw`(?:^|[;&|]\s*)export\s+-p(?:\s*(?:[;&|]|$))`,
    String.raw`(?:^|[;&|]\s*)declare\s+-x(?:\s*(?:[;&|]|$))`,
    String.raw`(?:^|[;&|]\s*)cat\s+\/proc\/(?:self|\d+)\/environ(?:\s*(?:[;&|]|$))`,
    String.raw`\/proc\/(?:self|\d+)\/environ`,
  ].join("|"),
  "i",
);

function readShellCommandArgument(input: string): string {
  const rest = input.trimStart();
  if (!rest) return "";
  const quote = rest[0];
  if (quote === "'" || quote === '"') {
    let out = "";
    for (let i = 1; i < rest.length; i += 1) {
      const ch = rest[i];
      if (ch === quote) return out;
      if (quote === '"' && ch === "\\" && i + 1 < rest.length) {
        i += 1;
        out += rest[i] ?? "";
      } else {
        out += ch;
      }
    }
    return out;
  }
  return /^[^\s]+/.exec(rest)?.[0] ?? "";
}

function unwrapShell(command: string): string {
  let current = command.trim();
  for (let i = 0; i < 3; i += 1) {
    const match = SHELL_COMMAND_PREFIX_RE.exec(current);
    if (!match) return current;
    current = readShellCommandArgument(current.slice(match[0].length));
  }
  return current;
}

/**
 * Classify an agent shell command. `block` for a full-environment dump; `allow`
 * for the allowlisted names-only helper or any non-dump command.
 */
export function classifyAgentShellCommand(command: string): AgentShellCommandDecision {
  const normalized = unwrapShell(command).trim();
  if (!normalized) return { action: "allow", reason: "not_environment_dump" };
  if (FULL_ENV_DUMP_RE.test(normalized)) return { action: "block", reason: "full_environment_dump" };
  if (SAFE_ENV_INSPECTION_COMMAND_RE.test(normalized)) return { action: "allow", reason: "safe_env_inspection" };
  return { action: "allow", reason: "not_environment_dump" };
}

/**
 * The literal opencode plugin file written into the pod's global opencode
 * config plugin dir and auto-loaded by opencode's `{plugin,plugins}/*.{ts,js}`
 * glob. Plain JS with zero imports so a loader/runtime quirk can never take
 * the whole session down with a resolution error.
 *
 * Fail-open discipline: classification runs inside try/catch (any guard bug
 * degrades to allow — server-side redaction backstops), and the block `throw`
 * happens OUTSIDE the try so we never swallow our own rejection. Only the
 * single plugin function is exported: opencode's legacy plugin loader throws
 * on any non-function export.
 *
 * Authored with regex literals (not `new RegExp(...)`) so the surrounding
 * String.raw preserves single backslashes verbatim. Keep behaviourally
 * identical to `classifyAgentShellCommand` above; env-guard-plugin.test.ts
 * runs the same command corpus through both.
 */
export const ENV_GUARD_PLUGIN_SCRIPT = String.raw`// paperclip-env-guard.js — PEN-1305 Layer 1 opencode plugin arm. Generated by
// paperclip-adapter-opencode-k8s; do not edit in the pod.
const SAFE_ENV_INSPECTION_COMMAND_RE =
  /^(?:node\s+)?(?:~\/\.claude\/safe-env-inspect\.mjs|\.\/scripts\/safe-env-inspect\.mjs|scripts\/safe-env-inspect\.mjs|safe-env-inspect|paperclip-safe-env)\s*$/;
const SHELL_COMMAND_PREFIX_RE = /^(?:\/bin\/)?(?:ba|z|)?sh\s+-l?c(?:\s+|$)/;
const FULL_ENV_DUMP_RE = /(?:^|[;&|]\s*)(?:command\s+)?(?:\/usr\/bin\/)?(?:env|printenv)(?:\s*(?:[;&|]|$))|(?:^|[;&|]\s*)(?:set)(?:\s*(?:[;&|]|$))|(?:^|[;&|]\s*)export\s+-p(?:\s*(?:[;&|]|$))|(?:^|[;&|]\s*)declare\s+-x(?:\s*(?:[;&|]|$))|(?:^|[;&|]\s*)cat\s+\/proc\/(?:self|\d+)\/environ(?:\s*(?:[;&|]|$))|\/proc\/(?:self|\d+)\/environ/i;
function readShellCommandArgument(input) {
  const rest = String(input || "").trimStart();
  if (!rest) return "";
  const quote = rest[0];
  if (quote === "'" || quote === '"') {
    let out = "";
    for (let i = 1; i < rest.length; i += 1) {
      const ch = rest[i];
      if (ch === quote) return out;
      if (quote === '"' && ch === "\\" && i + 1 < rest.length) {
        i += 1;
        out += rest[i] || "";
      } else {
        out += ch;
      }
    }
    return out;
  }
  const match = /^[^\s]+/.exec(rest);
  return match ? match[0] : "";
}
function unwrapShell(command) {
  let current = String(command || "").trim();
  for (let i = 0; i < 3; i += 1) {
    const match = SHELL_COMMAND_PREFIX_RE.exec(current);
    if (!match) return current;
    current = readShellCommandArgument(current.slice(match[0].length));
  }
  return current;
}
function isFullEnvDump(command) {
  const normalized = unwrapShell(command).trim();
  if (!normalized) return false;
  if (FULL_ENV_DUMP_RE.test(normalized)) return true;
  if (SAFE_ENV_INSPECTION_COMMAND_RE.test(normalized)) return false;
  return false;
}
export const PaperclipEnvGuard = async () => {
  return {
    "tool.execute.before": async (input, output) => {
      let block = false;
      try {
        if (!input || input.tool !== "bash") return;
        const args = output && output.args ? output.args : {};
        const command = typeof args.command === "string" ? args.command : "";
        block = Boolean(command) && isFullEnvDump(command);
      } catch (_e) {
        return; // fail open: never wedge a run on guard error; redaction backstops.
      }
      if (!block) return;
      const xdg = process.env.XDG_CONFIG_HOME;
      const home = process.env.HOME || "/paperclip";
      const helper = (xdg ? xdg : home + "/.config") + "/opencode/safe-env-inspect.mjs";
      throw new Error(
        "Blocked by Paperclip env-guard (PEN-1305): full-environment dumps " +
          "(env/printenv/set/export -p/declare -x/cat /proc/*/environ) are disallowed " +
          "because they leak secret-bearing runtime variables into the run transcript. " +
          "To inspect environment variable NAMES safely, run: node " + helper,
      );
    },
  };
};
`;

/**
 * Names-only environment inspection helper — the allowlisted alternative the
 * guard's block message points at. Prints variable NAMES, never values.
 * Identical artifact to the claude adapter's SAFE_ENV_INSPECT_SCRIPT.
 */
export const SAFE_ENV_INSPECT_SCRIPT = String.raw`#!/usr/bin/env node
// safe-env-inspect.mjs — PEN-1305 allowlisted env inspection: NAMES ONLY, never values.
for (const name of Object.keys(process.env).sort()) console.log(name);
`;

/**
 * Build a `;`-joinable shell fragment that installs the guard plugin into the
 * pod's global opencode config plugin dir plus the safe helper next to it.
 * Scripts are base64-embedded so arbitrary JS survives `sh -c` with no quoting
 * hazard (mirrors the claude adapter's buildEnvGuardSetupShell). Resolves
 * `${XDG_CONFIG_HOME:-$HOME/.config}` at pod runtime — the same base the
 * runtime opencode.json setup uses and the same base opencode resolves its
 * global config dir from, so the plugin is discovered in every isolation mode.
 * Fails open (`|| echo … >&2`) so an install error can never block a run.
 */
export function buildEnvGuardPluginSetupShell(): string {
  const pluginB64 = Buffer.from(ENV_GUARD_PLUGIN_SCRIPT, "utf8").toString("base64");
  const helperB64 = Buffer.from(SAFE_ENV_INSPECT_SCRIPT, "utf8").toString("base64");
  return [
    `GUARD_OC_DIR="\${XDG_CONFIG_HOME:-$HOME/.config}/opencode"`,
    `{ mkdir -p "$GUARD_OC_DIR/plugin" && printf %s '${pluginB64}' | base64 -d > "$GUARD_OC_DIR/plugin/paperclip-env-guard.js" && printf %s '${helperB64}' | base64 -d > "$GUARD_OC_DIR/safe-env-inspect.mjs"; } || echo "[paperclip-env-guard] plugin install skipped" >&2`,
  ].join("; ");
}

export function buildEnvGuardPluginCleanupShell(): string {
  return [
    `GUARD_OC_DIR="\${XDG_CONFIG_HOME:-$HOME/.config}/opencode"`,
    `{ rm -f "$GUARD_OC_DIR/plugin/paperclip-env-guard.js" "$GUARD_OC_DIR/safe-env-inspect.mjs"; } || echo "[paperclip-env-guard] plugin cleanup skipped" >&2`,
  ].join("; ");
}
