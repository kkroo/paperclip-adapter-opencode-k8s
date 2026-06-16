import { describe, it, expect } from "vitest";
import {
  parseOpenCodeJsonl,
  isOpenCodeUnknownSessionError,
  isOpenCodeStepLimitResult,
  isOpenCodeContextOverflowResult,
  isOpenCodeStreamEofResult,
  isOpenCodeResponseTypeCrash,
} from "./parse.js";

describe("parseOpenCodeJsonl", () => {
  it("parses text messages", () => {
    const stdout = [
      JSON.stringify({ type: "text", part: { text: "Hello" }, sessionID: "ses_123" }),
      JSON.stringify({ type: "text", part: { text: "World" }, sessionID: "ses_123" }),
    ].join("\n");

    const result = parseOpenCodeJsonl(stdout);

    expect(result.sessionId).toBe("ses_123");
    expect(result.summary).toBe("Hello\n\nWorld");
    expect(result.errorMessage).toBeNull();
  });

  it("accumulates usage from step_finish events", () => {
    const stdout = [
      JSON.stringify({
        type: "step_finish",
        part: { tokens: { input: 100, output: 50, reasoning: 20, cache: { read: 80 } }, cost: 0.001 },
      }),
    ].join("\n");

    const result = parseOpenCodeJsonl(stdout);

    expect(result.usage.inputTokens).toBe(100);
    expect(result.usage.cachedInputTokens).toBe(80);
    expect(result.usage.outputTokens).toBe(70);
    expect(result.costUsd).toBeCloseTo(0.001);
  });

  it("captures text from step_finish message field", () => {
    const stdout = [
      JSON.stringify({
        type: "step_finish",
        part: { message: "Final response text", tokens: { input: 10, output: 5 } },
      }),
    ].join("\n");

    const result = parseOpenCodeJsonl(stdout);

    expect(result.summary).toBe("Final response text");
  });

  it("captures errors from error type events", () => {
    const stdout = [
      JSON.stringify({ type: "error", error: { message: "Something went wrong" } }),
    ].join("\n");

    const result = parseOpenCodeJsonl(stdout);

    expect(result.errorMessage).toBe("Something went wrong");
  });

  it("captures tool_use errors with error state", () => {
    const stdout = [
      JSON.stringify({
        type: "tool_use",
        part: { state: { status: "error", error: "Tool failed" } },
      }),
    ].join("\n");

    const result = parseOpenCodeJsonl(stdout);

    expect(result.errorMessage).toBe("Tool failed");
  });

  it("extracts sessionId from any event", () => {
    const stdout = [
      JSON.stringify({ type: "text", part: { text: "Hi" }, sessionID: "ses_abc" }),
    ].join("\n");

    const result = parseOpenCodeJsonl(stdout);

    expect(result.sessionId).toBe("ses_abc");
  });

  it("handles empty stdout", () => {
    const result = parseOpenCodeJsonl("");

    expect(result.sessionId).toBeNull();
    expect(result.summary).toBe("");
    expect(result.errorMessage).toBeNull();
  });

  it("skips malformed JSON lines", () => {
    const stdout = [
      "not json at all",
      JSON.stringify({ type: "text", part: { text: "Valid" }, sessionID: "ses_1" }),
      "",
    ].join("\n");

    const result = parseOpenCodeJsonl(stdout);

    expect(result.summary).toBe("Valid");
  });

  it("combines multiple errors", () => {
    const stdout = [
      JSON.stringify({ type: "error", error: { message: "Error 1" } }),
      JSON.stringify({ type: "error", error: { message: "Error 2" } }),
    ].join("\n");

    const result = parseOpenCodeJsonl(stdout);

    expect(result.errorMessage).toBe("Error 1\nError 2");
  });

  it("parses nested error message in data field", () => {
    const stdout = [
      JSON.stringify({ type: "error", error: { data: { message: "Nested error" } } }),
    ].join("\n");

    const result = parseOpenCodeJsonl(stdout);

    expect(result.errorMessage).toBe("Nested error");
  });
});

describe("isOpenCodeStepLimitResult", () => {
  it("returns true for step_finish with reason max_turns", () => {
    const stdout = JSON.stringify({ type: "step_finish", part: { reason: "max_turns", tokens: {} } });
    expect(isOpenCodeStepLimitResult(stdout)).toBe(true);
  });

  it("returns true for step_finish with reason max_steps", () => {
    const stdout = JSON.stringify({ type: "step_finish", part: { reason: "max_steps", tokens: {} } });
    expect(isOpenCodeStepLimitResult(stdout)).toBe(true);
  });

  it("returns true for step_finish with reason step_limit", () => {
    const stdout = JSON.stringify({ type: "step_finish", part: { reason: "step_limit", tokens: {} } });
    expect(isOpenCodeStepLimitResult(stdout)).toBe(true);
  });

  it("returns false for step_finish with reason end_turn", () => {
    const stdout = JSON.stringify({ type: "step_finish", part: { reason: "end_turn", tokens: {} } });
    expect(isOpenCodeStepLimitResult(stdout)).toBe(false);
  });

  it("returns false with no step_finish events", () => {
    const stdout = JSON.stringify({ type: "text", part: { text: "Hello" } });
    expect(isOpenCodeStepLimitResult(stdout)).toBe(false);
  });

  it("returns false for empty stdout", () => {
    expect(isOpenCodeStepLimitResult("")).toBe(false);
  });
});

describe("isOpenCodeUnknownSessionError", () => {
  it("detects 'unknown session' in stdout", () => {
    const stdout = "Error: unknown session";
    expect(isOpenCodeUnknownSessionError(stdout, "")).toBe(true);
  });

  it("detects 'session not found' in stdout", () => {
    const stdout = "session not found";
    expect(isOpenCodeUnknownSessionError(stdout, "")).toBe(true);
  });

  it("detects 'resource not found' with session path in stdout", () => {
    const stdout = "resource not found: /session/abc.json";
    expect(isOpenCodeUnknownSessionError(stdout, "")).toBe(true);
  });

  it("detects 'no session' in combined output", () => {
    const stdout = "";
    const stderr = "no session available";
    expect(isOpenCodeUnknownSessionError(stdout, stderr)).toBe(true);
  });

  it("returns false for normal errors", () => {
    const stdout = "Something went wrong";
    expect(isOpenCodeUnknownSessionError(stdout, "")).toBe(false);
  });

  it("handles case insensitivity", () => {
    const stdout = "UNKNOWN SESSION";
    expect(isOpenCodeUnknownSessionError(stdout, "")).toBe(true);
  });
});

describe("parseOpenCodeJsonl — errorText fallback paths", () => {
  it("uses nested data.message when top-level message is missing", () => {
    const stdout = JSON.stringify({
      type: "error",
      error: { data: { message: "nested issue" } },
      sessionID: "ses_x",
    });
    const result = parseOpenCodeJsonl(stdout);
    expect(result.errorMessage).toContain("nested issue");
  });

  it("uses error.name when no message or nested message", () => {
    const stdout = JSON.stringify({
      type: "error",
      error: { name: "ProviderAuthError" },
      sessionID: "ses_x",
    });
    const result = parseOpenCodeJsonl(stdout);
    expect(result.errorMessage).toContain("ProviderAuthError");
  });

  it("uses error.code when no message/name", () => {
    const stdout = JSON.stringify({
      type: "error",
      error: { code: "E_TIMEOUT" },
      sessionID: "ses_x",
    });
    const result = parseOpenCodeJsonl(stdout);
    expect(result.errorMessage).toContain("E_TIMEOUT");
  });

  it("falls back to JSON.stringify of the error object when nothing matches", () => {
    const stdout = JSON.stringify({
      type: "error",
      error: { unexpectedShape: { foo: "bar" } },
      sessionID: "ses_x",
    });
    const result = parseOpenCodeJsonl(stdout);
    expect(result.errorMessage).toContain("unexpectedShape");
  });
});

describe("isOpenCodeContextOverflowResult", () => {
  it("detects the ContextOverflowError shape opencode emits", () => {
    const stdout = JSON.stringify({
      type: "error",
      error: {
        name: "ContextOverflowError",
        data: { message: "Input exceeds context window of this model" },
      },
      sessionID: "ses_overflow",
    });
    expect(isOpenCodeContextOverflowResult(stdout)).toBe(true);
  });

  it("detects nested responseBody with context_length_exceeded (openai surface)", () => {
    const stdout = JSON.stringify({
      type: "error",
      error: {
        name: "SomeOtherError",
        data: {
          responseBody: JSON.stringify({
            type: "error",
            error: {
              type: "invalid_request_error",
              code: "context_length_exceeded",
              message: "Your input exceeds the context window of this model.",
            },
          }),
        },
      },
    });
    expect(isOpenCodeContextOverflowResult(stdout)).toBe(true);
  });

  it("detects bare context_length_exceeded on an error line (defensive)", () => {
    const stdout = `{"type":"error","error":{"code":"context_length_exceeded"}}`;
    expect(isOpenCodeContextOverflowResult(stdout)).toBe(true);
  });

  it("returns false for unrelated error events", () => {
    const stdout = JSON.stringify({
      type: "error",
      error: { name: "ProviderAuthError", data: { message: "Invalid API key" } },
    });
    expect(isOpenCodeContextOverflowResult(stdout)).toBe(false);
  });

  it("returns false for non-error events even if they mention overflow", () => {
    const stdout = JSON.stringify({
      type: "text",
      part: { text: "context_length_exceeded was the prior error" },
    });
    expect(isOpenCodeContextOverflowResult(stdout)).toBe(false);
  });

  it("returns false for empty stdout", () => {
    expect(isOpenCodeContextOverflowResult("")).toBe(false);
  });

  it("only treats error-type lines as evidence, not arbitrary text matching the code", () => {
    // Defensive: a tool_use output that happens to mention the code string
    // should not trigger the detector.
    const stdout = JSON.stringify({
      type: "tool_use",
      part: { state: { status: "ok", output: "{\"code\":\"context_length_exceeded\"}" } },
    });
    expect(isOpenCodeContextOverflowResult(stdout)).toBe(false);
  });
});

describe("isOpenCodeStreamEofResult", () => {
  it("detects opencode UnknownError stream EOF after clean step_finish output", () => {
    const stdout = [
      JSON.stringify({
        type: "step_finish",
        part: { reason: "end_turn", tokens: { input: 100, output: 25, cache: { read: 90 } } },
        sessionID: "ses_eof",
      }),
      JSON.stringify({
        type: "error",
        error: {
          name: "UnknownError",
          data: { message: "JSON Parse error: Unexpected EOF" },
        },
        sessionID: "ses_eof",
      }),
    ].join("\n");

    expect(isOpenCodeStreamEofResult(stdout)).toBe(true);
  });

  it("returns false for clean step_finish output without an EOF error", () => {
    const stdout = JSON.stringify({
      type: "step_finish",
      part: { reason: "end_turn", tokens: { input: 100, output: 25, cache: { read: 90 } } },
      sessionID: "ses_clean",
    });

    expect(isOpenCodeStreamEofResult(stdout)).toBe(false);
  });

  it("returns false for UnknownError with a non-EOF message", () => {
    const stdout = JSON.stringify({
      type: "error",
      error: {
        name: "UnknownError",
        data: { message: "Provider returned HTTP 502" },
      },
      sessionID: "ses_other",
    });

    expect(isOpenCodeStreamEofResult(stdout)).toBe(false);
  });
});

describe("isOpenCodeResponseTypeCrash", () => {
  it("detects Bun-style missing response item type crashes", () => {
    const stdout = [
      JSON.stringify({ type: "step_start", sessionID: "ses_type_crash" }),
      "undefined is not an object (evaluating 'M.type')",
      "    at parseResponseItem (opencode.js:123:45)",
    ].join("\n");

    expect(isOpenCodeResponseTypeCrash(stdout)).toBe(true);
  });

  it("detects V8-style missing type crashes", () => {
    const stdout = "TypeError: Cannot read properties of undefined (reading 'type')";

    expect(isOpenCodeResponseTypeCrash(stdout)).toBe(true);
  });

  it("does not match ordinary tool output mentioning type", () => {
    const stdout = JSON.stringify({
      type: "tool_use",
      part: { state: { status: "completed", output: "field type is optional here" } },
    });

    expect(isOpenCodeResponseTypeCrash(stdout)).toBe(false);
  });
});
