import { describe, it, expect } from "vitest";
import { sessionCodec } from "./session.js";

describe("sessionCodec.deserialize", () => {
  it("returns null for null input", () => {
    expect(sessionCodec.deserialize(null)).toBeNull();
  });

  it("returns null for string input", () => {
    expect(sessionCodec.deserialize("string")).toBeNull();
  });

  it("returns null for number input", () => {
    expect(sessionCodec.deserialize(42)).toBeNull();
  });

  it("returns null for array input", () => {
    expect(sessionCodec.deserialize([])).toBeNull();
  });

  it("returns null when sessionId is absent", () => {
    expect(sessionCodec.deserialize({ cwd: "/foo" })).toBeNull();
  });

  it("returns null when sessionId is empty string", () => {
    expect(sessionCodec.deserialize({ sessionId: "" })).toBeNull();
  });

  it("returns null when sessionId is whitespace only", () => {
    expect(sessionCodec.deserialize({ sessionId: "   " })).toBeNull();
  });

  it("reads canonical sessionId", () => {
    const result = sessionCodec.deserialize({ sessionId: "ses_abc" });
    expect(result?.sessionId).toBe("ses_abc");
  });

  it("reads legacy session_id field", () => {
    const result = sessionCodec.deserialize({ session_id: "ses_legacy" });
    expect(result?.sessionId).toBe("ses_legacy");
  });

  it("reads legacy sessionID field", () => {
    const result = sessionCodec.deserialize({ sessionID: "ses_ID" });
    expect(result?.sessionId).toBe("ses_ID");
  });

  it("prefers sessionId over session_id", () => {
    const result = sessionCodec.deserialize({ sessionId: "canonical", session_id: "legacy" });
    expect(result?.sessionId).toBe("canonical");
  });

  it("prefers session_id over sessionID", () => {
    const result = sessionCodec.deserialize({ session_id: "mid", sessionID: "last" });
    expect(result?.sessionId).toBe("mid");
  });

  it("trims whitespace from sessionId", () => {
    const result = sessionCodec.deserialize({ sessionId: "  ses_123  " });
    expect(result?.sessionId).toBe("ses_123");
  });

  it("reads cwd field", () => {
    const result = sessionCodec.deserialize({ sessionId: "s1", cwd: "/work/dir" });
    expect(result?.cwd).toBe("/work/dir");
  });

  it("reads workdir as cwd fallback", () => {
    const result = sessionCodec.deserialize({ sessionId: "s1", workdir: "/workdir" });
    expect(result?.cwd).toBe("/workdir");
  });

  it("reads folder as cwd fallback", () => {
    const result = sessionCodec.deserialize({ sessionId: "s1", folder: "/folder" });
    expect(result?.cwd).toBe("/folder");
  });

  it("prefers cwd over workdir", () => {
    const result = sessionCodec.deserialize({ sessionId: "s1", cwd: "/cwd", workdir: "/workdir" });
    expect(result?.cwd).toBe("/cwd");
  });

  it("prefers workdir over folder", () => {
    const result = sessionCodec.deserialize({ sessionId: "s1", workdir: "/workdir", folder: "/folder" });
    expect(result?.cwd).toBe("/workdir");
  });

  it("reads workspaceId field", () => {
    const result = sessionCodec.deserialize({ sessionId: "s1", workspaceId: "ws-1" });
    expect(result?.workspaceId).toBe("ws-1");
  });

  it("reads workspace_id as workspaceId fallback", () => {
    const result = sessionCodec.deserialize({ sessionId: "s1", workspace_id: "ws-legacy" });
    expect(result?.workspaceId).toBe("ws-legacy");
  });

  it("reads repoUrl field", () => {
    const result = sessionCodec.deserialize({ sessionId: "s1", repoUrl: "https://github.com/org/repo" });
    expect(result?.repoUrl).toBe("https://github.com/org/repo");
  });

  it("reads repo_url as repoUrl fallback", () => {
    const result = sessionCodec.deserialize({ sessionId: "s1", repo_url: "https://github.com/org/repo" });
    expect(result?.repoUrl).toBe("https://github.com/org/repo");
  });

  it("reads repoRef field", () => {
    const result = sessionCodec.deserialize({ sessionId: "s1", repoRef: "main" });
    expect(result?.repoRef).toBe("main");
  });

  it("reads repo_ref as repoRef fallback", () => {
    const result = sessionCodec.deserialize({ sessionId: "s1", repo_ref: "feature/branch" });
    expect(result?.repoRef).toBe("feature/branch");
  });

  it("omits absent optional fields from result", () => {
    const result = sessionCodec.deserialize({ sessionId: "s1" });
    expect(result).toEqual({ sessionId: "s1" });
    expect(result && "cwd" in result).toBe(false);
    expect(result && "workspaceId" in result).toBe(false);
    expect(result && "repoUrl" in result).toBe(false);
    expect(result && "repoRef" in result).toBe(false);
    expect(result && "needsCompactBeforeNextRun" in result).toBe(false);
  });

  it("passes needsCompactBeforeNextRun=true through", () => {
    const result = sessionCodec.deserialize({ sessionId: "s1", needsCompactBeforeNextRun: true });
    expect(result?.needsCompactBeforeNextRun).toBe(true);
  });

  it("drops needsCompactBeforeNextRun when not strictly true", () => {
    // Defensive: a truthy non-boolean ("yes", 1, {}) shouldn't trigger
    // /compact injection on the next run.
    expect(sessionCodec.deserialize({ sessionId: "s1", needsCompactBeforeNextRun: false })?.needsCompactBeforeNextRun).toBeUndefined();
    expect(sessionCodec.deserialize({ sessionId: "s1", needsCompactBeforeNextRun: "true" } as unknown as Record<string, unknown>)?.needsCompactBeforeNextRun).toBeUndefined();
    expect(sessionCodec.deserialize({ sessionId: "s1", needsCompactBeforeNextRun: 1 } as unknown as Record<string, unknown>)?.needsCompactBeforeNextRun).toBeUndefined();
  });

  it("includes all fields when all are present", () => {
    const result = sessionCodec.deserialize({
      sessionId: "ses_full",
      cwd: "/work",
      workspaceId: "ws-1",
      repoUrl: "https://github.com/org/repo",
      repoRef: "main",
    });
    expect(result).toEqual({
      sessionId: "ses_full",
      cwd: "/work",
      workspaceId: "ws-1",
      repoUrl: "https://github.com/org/repo",
      repoRef: "main",
    });
  });
});

describe("sessionCodec.serialize", () => {
  it("returns null for null input", () => {
    expect(sessionCodec.serialize(null)).toBeNull();
  });

  it("returns null when sessionId is missing", () => {
    expect(sessionCodec.serialize({ cwd: "/foo" })).toBeNull();
  });

  it("returns null when sessionId is empty string", () => {
    expect(sessionCodec.serialize({ sessionId: "" })).toBeNull();
  });

  it("serializes canonical fields", () => {
    const result = sessionCodec.serialize({
      sessionId: "ses_abc",
      cwd: "/work",
      workspaceId: "ws-1",
      repoUrl: "https://github.com/org/repo",
      repoRef: "main",
    });
    expect(result).toEqual({
      sessionId: "ses_abc",
      cwd: "/work",
      workspaceId: "ws-1",
      repoUrl: "https://github.com/org/repo",
      repoRef: "main",
    });
  });

  it("reads legacy session_id field", () => {
    const result = sessionCodec.serialize({ session_id: "ses_legacy" });
    expect(result?.sessionId).toBe("ses_legacy");
  });

  it("reads legacy workdir as cwd", () => {
    const result = sessionCodec.serialize({ sessionId: "s1", workdir: "/workdir" });
    expect(result?.cwd).toBe("/workdir");
  });

  it("reads legacy workspace_id", () => {
    const result = sessionCodec.serialize({ sessionId: "s1", workspace_id: "ws-2" });
    expect(result?.workspaceId).toBe("ws-2");
  });

  it("reads legacy repo_url", () => {
    const result = sessionCodec.serialize({ sessionId: "s1", repo_url: "https://github.com/org/repo" });
    expect(result?.repoUrl).toBe("https://github.com/org/repo");
  });

  it("reads legacy repo_ref", () => {
    const result = sessionCodec.serialize({ sessionId: "s1", repo_ref: "develop" });
    expect(result?.repoRef).toBe("develop");
  });

  it("omits absent optional fields", () => {
    const result = sessionCodec.serialize({ sessionId: "s1" });
    expect(result).toEqual({ sessionId: "s1" });
  });

  it("passes needsCompactBeforeNextRun=true through (auto-compact lifecycle flag)", () => {
    // Without this, execute.ts can set the flag on its adapter result
    // but the next run won't see it — auto-compact never fires. See
    // session.ts for the full chain.
    const result = sessionCodec.serialize({
      sessionId: "ses_overflowed",
      needsCompactBeforeNextRun: true,
    });
    expect(result?.needsCompactBeforeNextRun).toBe(true);
  });

  it("drops needsCompactBeforeNextRun when false/unset/non-boolean", () => {
    expect(sessionCodec.serialize({ sessionId: "s1", needsCompactBeforeNextRun: false })?.needsCompactBeforeNextRun).toBeUndefined();
    expect(sessionCodec.serialize({ sessionId: "s1" })?.needsCompactBeforeNextRun).toBeUndefined();
  });
});

describe("sessionCodec.getDisplayId", () => {
  // getDisplayId is optional in the AdapterSessionCodec interface; use non-null assertion since we know it's implemented
  const getDisplayId = sessionCodec.getDisplayId!.bind(sessionCodec);

  it("returns null for null input", () => {
    expect(getDisplayId(null)).toBeNull();
  });

  it("returns sessionId", () => {
    expect(getDisplayId({ sessionId: "ses_abc" })).toBe("ses_abc");
  });

  it("returns session_id as fallback", () => {
    expect(getDisplayId({ session_id: "ses_legacy" })).toBe("ses_legacy");
  });

  it("returns sessionID as fallback", () => {
    expect(getDisplayId({ sessionID: "ses_ID" })).toBe("ses_ID");
  });

  it("prefers sessionId over session_id", () => {
    expect(getDisplayId({ sessionId: "canonical", session_id: "legacy" })).toBe("canonical");
  });

  it("returns null when no valid id field present", () => {
    expect(getDisplayId({ other: "value" })).toBeNull();
  });

  it("returns null when sessionId is empty string", () => {
    expect(getDisplayId({ sessionId: "" })).toBeNull();
  });
});
