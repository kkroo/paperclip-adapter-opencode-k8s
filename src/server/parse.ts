import { asNumber, asString, parseJson, parseObject } from "@paperclipai/adapter-utils/server-utils";

function errorText(value: unknown): string {
  if (typeof value === "string") return value;
  const rec = parseObject(value);
  const message = asString(rec.message, "").trim();
  if (message) return message;
  const data = parseObject(rec.data);
  const nestedMessage = asString(data.message, "").trim();
  if (nestedMessage) return nestedMessage;
  const name = asString(rec.name, "").trim();
  if (name) return name;
  const code = asString(rec.code, "").trim();
  if (code) return code;
  try {
    return JSON.stringify(rec);
  } catch {
    return "";
  }
}

export function parseOpenCodeJsonl(stdout: string) {
  let sessionId: string | null = null;
  const messages: string[] = [];
  // Run-level errors: model/session `error` events. These are real failures.
  const errors: string[] = [];
  // In-session tool-call errors (e.g. a `read` on a missing file). The agent
  // sees these as tool results and routinely recovers from them — they must
  // NOT be conflated with a run failure (PEN-906). Tracked separately for
  // diagnostics only.
  const toolErrors: string[] = [];
  // Reason of the last `step_finish` event. "stop" means opencode reached a
  // clean final answer; anything else (tool-calls, max_turns, ...) is mid-run
  // or a limit. Used to recognize a successful completion even when the CLI
  // process exits non-zero due to non-fatal tool errors.
  let lastStepReason: string | null = null;
  const usage = {
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
  };
  let costUsd = 0;

  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;

    const event = parseJson(line);
    if (!event) continue;

    const currentSessionId = asString(event.sessionID, "").trim();
    if (currentSessionId) sessionId = currentSessionId;

    const type = asString(event.type, "");

    if (type === "text") {
      const part = parseObject(event.part);
      const text = asString(part.text, "").trim();
      if (text) messages.push(text);
      continue;
    }

    if (type === "step_finish") {
      const part = parseObject(event.part);
      const text = asString(part.message, "").trim();
      if (text) messages.push(text);
      const reason = asString(part.reason, "").trim();
      if (reason) lastStepReason = reason;
      const tokens = parseObject(part.tokens);
      const cache = parseObject(tokens.cache);
      usage.inputTokens += asNumber(tokens.input, 0);
      usage.cachedInputTokens += asNumber(cache.read, 0);
      usage.outputTokens += asNumber(tokens.output, 0) + asNumber(tokens.reasoning, 0);
      costUsd += asNumber(part.cost, 0);
      continue;
    }

    if (type === "tool_use") {
      const part = parseObject(event.part);
      const state = parseObject(part.state);
      if (asString(state.status, "") === "error") {
        const text = asString(state.error, "").trim();
        if (text) toolErrors.push(text);
      }
      continue;
    }

    if (type === "error") {
      const text = errorText(event.error ?? event.message).trim();
      if (text) errors.push(text);
      continue;
    }
  }

  return {
    sessionId,
    summary: messages.join("\n\n").trim(),
    usage,
    costUsd,
    errorMessage: errors.length > 0 ? errors.join("\n") : null,
    toolErrorMessage: toolErrors.length > 0 ? toolErrors.join("\n") : null,
    // True when opencode reached a clean final answer (last step_finish
    // reason === "stop"). A clean completion is a successful run even if the
    // CLI process exits non-zero because of non-fatal in-session tool errors.
    completedCleanly: lastStepReason === "stop",
  };
}

export function isOpenCodeStepLimitResult(stdout: string): boolean {
  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const event = parseJson(line);
    if (!event) continue;
    if (asString(event.type, "") === "step_finish") {
      const part = parseObject(event.part);
      const reason = asString(part.reason, "").toLowerCase();
      if (reason === "max_turns" || reason === "max_steps" || reason === "step_limit") {
        return true;
      }
    }
  }
  return false;
}

export function isOpenCodeUnknownSessionError(stdout: string, stderr: string): boolean {
  const haystack = `${stdout}\n${stderr}`
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .join("\n");

  return /unknown\s+session|session\b.*\bnot\s+found|resource\s+not\s+found:.*[\\/]session[\\/].*\.json|notfounderror|no session/i.test(
    haystack,
  );
}

// Detect when the model rejected the prompt because the session's accumulated
// context exceeded the model's context window. Without auto-remediation, the
// same poisoned session is re-used on every retry and the agent burns wakes
// forever (observed 2026-05-15 on Staff Engineer / opencode_k8s /
// openai/gpt-5.5 — every retry produced an empty stdout + `adapter_failed`
// stopReason because the model rejected the prompt before any output).
//
// Pairs with `sessionParams.needsCompactBeforeNextRun: true` in execute.ts:
// the next wake's command pipeline prepends `/compact` (handled in
// job-manifest.ts) so the session history is summarized BEFORE the real
// prompt is sent. This preserves the agent's working context (vs. rotating
// the session, which loses it) while making sure the next prompt fits.
//
// Surfaces:
//   {"type":"error","error":{"name":"ContextOverflowError", ...}}
//   nested responseBody containing {"code":"context_length_exceeded"}
// Codex/openai surface the latter inside `responseBody`; opencode emits the
// outer ContextOverflowError. Match either to be provider-agnostic.
export function isOpenCodeContextOverflowResult(stdout: string): boolean {
  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const event = parseJson(line);
    if (!event) continue;
    if (asString(event.type, "") !== "error") continue;
    const errorObj = parseObject(event.error);
    if (asString(errorObj.name, "") === "ContextOverflowError") return true;
    const data = parseObject(errorObj.data);
    const responseBody = asString(data.responseBody, "");
    if (responseBody && /["']code["']\s*:\s*["']context_length_exceeded["']/.test(responseBody)) {
      return true;
    }
    if (/["']code["']\s*:\s*["']context_length_exceeded["']/.test(line)) return true;
  }
  return false;
}

// Detect opencode's internal event-stream parser crash when a Responses-API
// stream item arrives with a missing/undefined `type` field. In the minified
// bundle this surfaces as a JavaScriptCore runtime error:
//   "undefined is not an object (evaluating 'M.type')"
// The V8 equivalent is:
//   "Cannot read properties of undefined (reading 'type')"
// Both are caused by a specific item shape from gpt-5.5 that the adapter's
// event mapper doesn't guard. The opencode session on disk is untouched —
// the crash happens before any write — so the next wake can retry the same
// session intact (observed: failed at 07:11/07:14/07:15, clean run at 07:18).
export function isOpenCodeTypeDerefError(stdout: string, errorMessage: string): boolean {
  const haystack = `${stdout}\n${errorMessage}`;
  // JavaScriptCore (Bun): "undefined is not an object (evaluating 'X.type')"
  if (/undefined is not an object \(evaluating '[^']*\.type'\)/i.test(haystack)) return true;
  // V8: "Cannot read properties of undefined (reading 'type')"
  if (/cannot read propert(?:y|ies) of undefined[^)]*\breading ['"]type['"]/i.test(haystack)) return true;
  return false;
}

// Detect opencode's internal model-stream parser failure when the upstream
// closes mid-JSON chunk. This is transient stream truncation, not session
// corruption: the next wake should retry with the same session intact.
export function isOpenCodeStreamEofResult(stdout: string): boolean {
  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const event = parseJson(line);
    if (!event) continue;
    if (asString(event.type, "") !== "error") continue;
    const errorObj = parseObject(event.error);
    if (asString(errorObj.name, "") !== "UnknownError") continue;
    const data = parseObject(errorObj.data);
    const message = asString(data.message, "");
    if (/JSON\s+Parse\s+error.*Unexpected\s+EOF/i.test(message)) return true;
  }
  return false;
}
