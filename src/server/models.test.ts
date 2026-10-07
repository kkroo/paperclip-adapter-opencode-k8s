import { afterEach, describe, expect, it, vi } from "vitest";

const runChildProcessMock = vi.fn();

vi.mock("@paperclipai/adapter-utils/server-utils", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@paperclipai/adapter-utils/server-utils")>();
  return { ...actual, runChildProcess: runChildProcessMock };
});

const { listK8sModels, discoverK8sModels, resetK8sModelsCacheForTests } = await import("./models.js");

type MockResult = { exitCode: number | null; stdout: string; stderr: string; timedOut: boolean };

function mockSuccess(stdout: string): void {
  runChildProcessMock.mockResolvedValue({ exitCode: 0, stdout, stderr: "", timedOut: false } satisfies MockResult);
}

function mockFailure(stderr = "ENOENT: opencode not found"): void {
  runChildProcessMock.mockResolvedValue({ exitCode: 1, stdout: "", stderr, timedOut: false } satisfies MockResult);
}

function mockTimeout(): void {
  runChildProcessMock.mockResolvedValue({ exitCode: null, stdout: "", stderr: "", timedOut: true } satisfies MockResult);
}

describe("listK8sModels", () => {
  afterEach(() => {
    runChildProcessMock.mockReset();
    resetK8sModelsCacheForTests();
  });

  it("parses provider/model lines into AdapterModel entries", async () => {
    mockSuccess(["anthropic/claude-opus-4-7", "openai/gpt-4o", "google/gemini-2.5-pro"].join("\n"));

    const models = await listK8sModels();

    expect(models).toHaveLength(3);
    expect(models.find((m) => m.id === "anthropic/claude-opus-4-7")).toEqual({
      id: "anthropic/claude-opus-4-7",
      label: "anthropic/claude-opus-4-7",
    });
  });

  it("ignores blank lines and trims whitespace", async () => {
    mockSuccess("\nanthropic/claude-opus-4-7\n\n  openai/gpt-4o  \n\n");

    const models = await listK8sModels();

    expect(models.map((m) => m.id)).toEqual(
      ["anthropic/claude-opus-4-7", "openai/gpt-4o"].sort(),
    );
  });

  it("skips lines without a provider/model slash", async () => {
    mockSuccess("anthropic/claude-opus-4-7\nnot-a-model-line\nopenai/gpt-4o");

    const models = await listK8sModels();

    expect(models.map((m) => m.id)).not.toContain("not-a-model-line");
    expect(models).toHaveLength(2);
  });

  it("deduplicates repeated model IDs", async () => {
    mockSuccess("anthropic/claude-opus-4-7\nanthropic/claude-opus-4-7\nopenai/gpt-4o");

    const models = await listK8sModels();

    expect(models.filter((m) => m.id === "anthropic/claude-opus-4-7")).toHaveLength(1);
  });

  it("returns models sorted alphabetically by ID", async () => {
    mockSuccess("openai/gpt-4o\nanthropic/claude-opus-4-7");

    const models = await listK8sModels();

    expect(models[0].id).toBe("anthropic/claude-opus-4-7");
    expect(models[1].id).toBe("openai/gpt-4o");
  });

  it("returns empty array when the CLI fails", async () => {
    mockFailure("ENOENT: opencode not found");

    expect(await listK8sModels()).toEqual([]);
  });

  it("returns empty array when the CLI times out", async () => {
    mockTimeout();

    expect(await listK8sModels()).toEqual([]);
  });

  it("returns empty array when the CLI returns empty stdout", async () => {
    mockSuccess("");

    expect(await listK8sModels()).toEqual([]);
  });

  it("caches results and only calls the CLI once within the TTL", async () => {
    mockSuccess("anthropic/claude-opus-4-7");

    await listK8sModels();
    await listK8sModels();

    expect(runChildProcessMock).toHaveBeenCalledTimes(1);
  });

  it("re-fetches after the cache is reset", async () => {
    mockSuccess("anthropic/claude-opus-4-7");

    await listK8sModels();
    resetK8sModelsCacheForTests();
    await listK8sModels();

    expect(runChildProcessMock).toHaveBeenCalledTimes(2);
  });
});

describe("discoverK8sModels", () => {
  afterEach(() => {
    runChildProcessMock.mockReset();
    resetK8sModelsCacheForTests();
  });

  it("passes OPENCODE_DISABLE_PROJECT_CONFIG=true to the subprocess", async () => {
    mockSuccess("anthropic/claude-opus-4-7");

    await discoverK8sModels();

    const [, , , opts] = runChildProcessMock.mock.calls[0] as [unknown, unknown, unknown, { env: Record<string, string> }];
    expect(opts.env).toMatchObject({ OPENCODE_DISABLE_PROJECT_CONFIG: "true" });
  });

  it("invokes opencode with the models subcommand", async () => {
    mockSuccess("anthropic/claude-opus-4-7");

    await discoverK8sModels();

    const [, command, args] = runChildProcessMock.mock.calls[0] as [unknown, string, string[]];
    expect(command).toBe("opencode");
    expect(args).toEqual(["models"]);
  });

  it("throws when the CLI exits non-zero", async () => {
    mockFailure("provider not configured");

    await expect(discoverK8sModels()).rejects.toThrow("opencode models` failed");
  });

  it("throws when the CLI times out", async () => {
    mockTimeout();

    await expect(discoverK8sModels()).rejects.toThrow("timed out");
  });
});

describe("STATIC_MODELS", () => {
  it("lists the OpenAI lineup Codex presents (GPT-6.1 Sol through GPT-5.5)", async () => {
    const { STATIC_MODELS } = await import("./models.js");
    const ids = STATIC_MODELS.map((m) => m.id);
    for (const id of [
      "openai/gpt-6.1-sol",
      "openai/gpt-6-astra",
      "openai/gpt-6-sol",
      "openai/gpt-6-luna",
      "openai/gpt-5.6-sol",
      "openai/gpt-5.6-terra",
      "openai/gpt-5.6-luna",
      "openai/gpt-5.5",
    ]) {
      expect(ids, id).toContain(id);
    }
    expect(new Set(ids).size).toBe(ids.length);
  });
});
