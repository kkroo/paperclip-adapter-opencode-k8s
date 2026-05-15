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
  const errors: string[] = [];
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
        if (text) errors.push(text);
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
