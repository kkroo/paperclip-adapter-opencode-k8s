import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { AdapterExecutionContext } from "@paperclipai/adapter-utils";
import { execute, ensureAgentDbPvc, tailPodLogFile, mergeEnvironmentConfig, captureContainerLogTail } from "./execute.js";
import { getSelfPodInfo, getBatchApi, getCoreApi, getLogApi, getPvc, createPvc } from "./k8s-client.js";
import { PassThrough } from "node:stream";
import { buildJobManifest, buildPodLogPath } from "./job-manifest.js";

// Mock node:fs/promises so tailPodLogFile (used by execute()) reads a
// configurable JSONL payload and returns. Individual tests override the
// payload via setMockJsonl(...) before calling execute().
const { readMock, statMock, fhStatMock, resetFsMocks, setMockJsonl, getMockPayload } = vi.hoisted(() => {
  const HAPPY = [
    JSON.stringify({ type: "text", part: { text: "Task complete" }, sessionID: "ses_happy" }),
    JSON.stringify({ type: "step_finish", part: { tokens: { input: 100, output: 50, cache: { read: 20 } }, cost: 0.002 } }),
  ].join("\n");
  let payload = HAPPY;
  let buffer = Buffer.from(payload);
  let readOffset = 0;
  const apply = (next: string) => { payload = next; buffer = Buffer.from(payload); readOffset = 0; };
  return {
    readMock: vi.fn().mockImplementation(async (buf: Buffer, off: number, len: number, _pos: number) => {
      if (readOffset >= buffer.byteLength) return { bytesRead: 0, buffer: buf };
      const remaining = buffer.byteLength - readOffset;
      const toRead = Math.min(len, remaining);
      buffer.copy(buf, off, readOffset, readOffset + toRead);
      readOffset += toRead;
      return { bytesRead: toRead, buffer: buf };
    }),
    statMock: vi.fn().mockImplementation(async () => ({ size: buffer.byteLength })),
    fhStatMock: vi.fn().mockImplementation(async () => ({ size: buffer.byteLength })),
    resetFsMocks: () => { apply(HAPPY); },
    setMockJsonl: (jsonl: string) => { apply(jsonl); },
    // Exposed so makeLogApiFromFsMock() can pull the *current* payload
    // at the moment .log() is called (after any per-test setMockJsonl).
    getMockPayload: () => payload,
  };
});

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    stat: statMock,
    open: vi.fn().mockResolvedValue({
      stat: fhStatMock,
      read: readMock,
      close: vi.fn().mockResolvedValue(undefined),
    }),
    unlink: vi.fn().mockResolvedValue(undefined),
  };
});

vi.mock("./k8s-client.js", () => ({
  getSelfPodInfo: vi.fn(),
  getBatchApi: vi.fn(),
  getCoreApi: vi.fn(),
  getLogApi: vi.fn(),
  getPvc: vi.fn().mockResolvedValue({ metadata: { name: "opencode-db-agent-id-test" } }),
  createPvc: vi.fn().mockResolvedValue({}),
}));

vi.mock("./job-manifest.js", () => ({
  buildJobManifest: vi.fn(),
  buildPodLogPath: vi.fn((companyId: string, agentId: string, runId: string) =>
    `/paperclip/instances/default/data/run-logs/${companyId}/${agentId}/${runId}.pod.ndjson`
  ),
  LARGE_PROMPT_THRESHOLD_BYTES: 256 * 1024,
}));

// Prevent skill loading from reading real SKILL.md files during tests — the
// real filesystem read delays timer registration and breaks fake-timer tests.
vi.mock("@paperclipai/adapter-utils/server-utils", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@paperclipai/adapter-utils/server-utils")>();
  return { ...actual, readPaperclipRuntimeSkillEntries: vi.fn().mockResolvedValue([]) };
});

const MOCK_SELF_POD = {
  namespace: "test-ns",
  image: "test-image:latest",
  imagePullSecrets: [],
  nodeSelector: {},
  tolerations: [],
  dnsConfig: undefined,
  pvcClaimName: null,
  secretVolumes: [],
  inheritedEnv: {},
  inheritedEnvValueFrom: [],
  inheritedEnvFrom: [],
};

const MOCK_JOB = {
  spec: {
    template: {
      spec: {
        containers: [{ image: "test-image:latest" }],
      },
    },
  },
};

const JOB_NAME = "agent-opencode-testjob";
const NAMESPACE = "test-ns";
const POD_NAME = "agent-opencode-testjob-abcde";

const HAPPY_JSONL = [
  JSON.stringify({ type: "text", part: { text: "Task complete" }, sessionID: "ses_happy" }),
  JSON.stringify({ type: "step_finish", part: { tokens: { input: 100, output: 50, cache: { read: 20 } }, cost: 0.002 } }),
].join("\n");

function makeCtx(configOverrides: Record<string, unknown> = {}, contextOverrides: Record<string, unknown> = {}, authToken = "test-auth-token"): AdapterExecutionContext {
  return {
    runId: "run-test-123",
    agent: { id: "agent-id-test", name: "Test Agent", companyId: "co-1", adapterType: null, adapterConfig: null },
    runtime: { sessionId: null, sessionParams: {}, sessionDisplayId: null, taskKey: null },
    config: configOverrides,
    authToken,
    context: {
      taskId: null,
      issueId: null,
      paperclipWorkspace: null,
      issueIds: null,
      paperclipWorkspaces: null,
      paperclipRuntimeServiceIntents: null,
      paperclipRuntimeServices: null,
      ...contextOverrides,
    },
    onLog: vi.fn().mockResolvedValue(undefined),
  } as unknown as AdapterExecutionContext;
}

/**
 * Mock for `getLogApi()` — returns an object whose `.log()` matches the
 * @kubernetes/client-node Log.log signature: writes the configured
 * payload into the Writable stream then resolves with an AbortController.
 *
 * `payload` defaults to "" — tests that need to assert on streamed
 * stdout (happy path, reattach, etc.) override per-test by passing the
 * full pod stdout JSONL string. Empty payload is the right default for
 * tests that exercise other code paths (concurrency guard, SIGTERM,
 * scheduling failure) and don't care what the tail emits.
 */
/**
 * Variant of makeLogApi that pulls the streamed payload from the fs
 * mock's current buffer at the moment `.log()` is called. This lets
 * tests that override the fs payload via `setMockJsonl(...)` also drive
 * the new k8s-logs streaming path without per-test getLogApi setup.
 */
function makeLogApiFromFsMock() {
  return {
    log: vi.fn(async (
      _namespace: string,
      _podName: string,
      _container: string,
      stream: import("node:stream").Writable,
    ) => {
      // Pull the current shared payload (mutated by setMockJsonl per test).
      const payload = getMockPayload();
      if (payload) stream.write(payload);
      stream.end();
      return { abort: vi.fn() } as unknown as AbortController;
    }),
  };
}

function makeLogApi(payload: string = "") {
  return {
    log: vi.fn(async (
      _namespace: string,
      _podName: string,
      _container: string,
      stream: import("node:stream").Writable,
    ) => {
      // Push the payload then end the stream so the consumer flips
      // `streamEnded=true` and exits its hold loop without waiting for
      // the test's job-completion poll to fire.
      if (payload) stream.write(payload);
      stream.end();
      return { abort: vi.fn() } as unknown as AbortController;
    }),
  };
}

function makeBatchApi(runningJobItems: unknown[] = []) {
  return {
    listNamespacedJob: vi.fn().mockResolvedValue({ items: runningJobItems }),
    createNamespacedJob: vi.fn().mockResolvedValue({ metadata: { uid: "test-job-uid" } }),
    readNamespacedJob: vi.fn().mockResolvedValue({
      status: { conditions: [{ type: "Complete", status: "True" }] },
    }),
    deleteNamespacedJob: vi.fn().mockResolvedValue({}),
  };
}

function makeCoreApi(
  exitCode: number | null = 0,
  terminatedReason: string | null = null,
) {
  const exitCodePod =
    exitCode === null
      ? { items: [] }
      : {
          items: [
            {
              status: {
                containerStatuses: [
                  {
                    name: "opencode",
                    state: {
                      terminated: {
                        exitCode,
                        ...(terminatedReason ? { reason: terminatedReason } : {}),
                      },
                    },
                  },
                ],
              },
            },
          ],
        };

  return {
    listNamespacedPod: vi.fn()
      .mockResolvedValueOnce({
        items: [{ metadata: { name: POD_NAME }, status: { phase: "Running" } }],
      })
      .mockResolvedValueOnce(exitCodePod),
    createNamespacedSecret: vi.fn().mockResolvedValue({}),
    deleteNamespacedSecret: vi.fn().mockResolvedValue({}),
    patchNamespacedSecret: vi.fn().mockResolvedValue({}),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  resetFsMocks();

  vi.mocked(getSelfPodInfo).mockResolvedValue(MOCK_SELF_POD as ReturnType<typeof getSelfPodInfo> extends Promise<infer T> ? T : never);
  vi.mocked(buildJobManifest).mockReturnValue({
    job: MOCK_JOB as ReturnType<typeof buildJobManifest>["job"],
    jobName: JOB_NAME,
    namespace: NAMESPACE,
    prompt: "Test prompt",
    opencodeArgs: [],
    promptMetrics: null,
    podLogPath: `/paperclip/instances/default/data/run-logs/co-1/agent-id-test/run-test-123.pod.ndjson`,
  } as unknown as ReturnType<typeof buildJobManifest>);

  const batchApi = makeBatchApi();
  const coreApi = makeCoreApi();

  vi.mocked(getBatchApi).mockReturnValue(batchApi as unknown as ReturnType<typeof getBatchApi>);
  vi.mocked(getCoreApi).mockReturnValue(coreApi as unknown as ReturnType<typeof getCoreApi>);

  // Default log-stream mock: tailPodContainerLogs calls
  // `getLogApi().log(ns, pod, container, stream)` which writes the
  // current fs mock payload into the Writable + returns an
  // AbortController. We delegate the payload to the fs mock helper
  // (`setMockJsonl` mutates the same shared buffer) so existing tests
  // that call setMockJsonl(...) continue to drive both surfaces from a
  // single source of truth. Default is the same HAPPY_JSONL the
  // file-based mock used (sessionID: ses_happy + step_finish with
  // tokens) so happy-path assertions on result.sessionId / usage pass
  // unchanged.
  vi.mocked(getLogApi).mockReturnValue(
    makeLogApiFromFsMock() as unknown as ReturnType<typeof getLogApi>,
  );
});

describe("execute — budget enforcement", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.PAPERCLIP_API_URL;
  });

  it("fails fast and pauses the agent before creating a Job when the current agent is over budget", async () => {
    process.env.PAPERCLIP_API_URL = "http://test-api";

    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === "http://test-api/api/agents/agent-id-test" && (!init?.method || init.method === "GET")) {
        return {
          ok: true,
          json: async () => ({
            id: "agent-id-test",
            name: "Test Agent",
            spentMonthlyCents: 22_385,
            budgetMonthlyCents: 20_000,
            pauseReason: null,
            pausedAt: null,
          }),
        } as Response;
      }
      if (url === "http://test-api/api/agents/agent-id-test" && init?.method === "PATCH") {
        return { ok: true, json: async () => ({}) } as Response;
      }
      if (url === "http://test-api/api/issues/issue-test-456/comments" && init?.method === "POST") {
        return { ok: true, json: async () => ({}) } as Response;
      }
      throw new Error(`unexpected fetch ${init?.method ?? "GET"} ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const batchApi = makeBatchApi();
    vi.mocked(getBatchApi).mockReturnValue(batchApi as unknown as ReturnType<typeof getBatchApi>);

    const ctx = makeCtx({}, { issueId: "issue-test-456" }, "run-jwt-token");
    const result = await execute(ctx);

    expect(result.errorCode).toBe("budget_exceeded");
    expect(result.exitCode).toBeNull();
    expect(result.errorMessage).toContain("Budget exceeded");
    expect(batchApi.createNamespacedJob).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledWith(
      "http://test-api/api/agents/agent-id-test",
      expect.objectContaining({ headers: expect.objectContaining({ Authorization: "Bearer run-jwt-token" }) }),
    );
    expect(fetchMock).toHaveBeenCalledWith(
      "http://test-api/api/agents/agent-id-test",
      expect.objectContaining({
        method: "PATCH",
        headers: expect.objectContaining({ Authorization: "Bearer run-jwt-token" }),
        body: expect.stringContaining("budget exceeded"),
      }),
    );
    expect(fetchMock).toHaveBeenCalledWith(
      "http://test-api/api/issues/issue-test-456/comments",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ Authorization: "Bearer run-jwt-token" }),
        body: expect.stringContaining("$223.85 spent / $200.00 cap"),
      }),
    );
  });
});

describe("execute — concurrency guard", () => {
  it("blocks when a running job already exists for the agent", async () => {
    const batchApi = makeBatchApi([
      {
        metadata: { name: "old-job" },
        status: { conditions: [] }, // no Complete/Failed → still running
      },
    ]);
    vi.mocked(getBatchApi).mockReturnValue(batchApi as unknown as ReturnType<typeof getBatchApi>);

    const ctx = makeCtx();
    const result = await execute(ctx);

    expect(result.errorCode).toBe("k8s_concurrent_run_blocked");
    expect(result.exitCode).toBeNull();
    expect(batchApi.createNamespacedJob).not.toHaveBeenCalled();
  });

  it("proceeds when existing job has Complete condition", async () => {
    const batchApi = makeBatchApi([
      {
        metadata: { name: "finished-job" },
        status: { conditions: [{ type: "Complete", status: "True" }] },
      },
    ]);
    vi.mocked(getBatchApi).mockReturnValue(batchApi as unknown as ReturnType<typeof getBatchApi>);

    const ctx = makeCtx();
    await execute(ctx);

    expect(batchApi.createNamespacedJob).toHaveBeenCalled();
  });

  it("proceeds when existing job has Failed condition", async () => {
    const batchApi = makeBatchApi([
      {
        metadata: { name: "failed-job" },
        status: { conditions: [{ type: "Failed", status: "True" }] },
      },
    ]);
    vi.mocked(getBatchApi).mockReturnValue(batchApi as unknown as ReturnType<typeof getBatchApi>);

    const ctx = makeCtx();
    await execute(ctx);

    expect(batchApi.createNamespacedJob).toHaveBeenCalled();
  });

  it("proceeds when no running jobs exist", async () => {
    const ctx = makeCtx();
    await execute(ctx);

    expect(vi.mocked(getBatchApi)().createNamespacedJob).toHaveBeenCalled();
  });

  it("returns k8s_concurrency_guard_unreachable when concurrency check throws (fail-closed)", async () => {
    const batchApi = makeBatchApi();
    batchApi.listNamespacedJob.mockRejectedValue(new Error("RBAC denied"));
    vi.mocked(getBatchApi).mockReturnValue(batchApi as unknown as ReturnType<typeof getBatchApi>);

    const ctx = makeCtx();
    const result = await execute(ctx);

    expect(result.errorCode).toBe("k8s_concurrency_guard_unreachable");
    expect(result.exitCode).toBeNull();
    expect(batchApi.createNamespacedJob).not.toHaveBeenCalled();
  });

  it("blocks (k8s_concurrent_run_blocked) when a different-task job is running even with reattachOrphanedJobs=true", async () => {
    const batchApi = makeBatchApi([
      {
        metadata: { name: "other-task-job", labels: { "paperclip.io/task-id": "other-task-id" } },
        status: { conditions: [] },
      },
    ]);
    vi.mocked(getBatchApi).mockReturnValue(batchApi as unknown as ReturnType<typeof getBatchApi>);

    const ctx = makeCtx({ reattachOrphanedJobs: true });
    // ctx.context.taskId is null in makeCtx, so the running job is always an "other" job
    const result = await execute(ctx);

    expect(result.errorCode).toBe("k8s_concurrent_run_blocked");
    expect(batchApi.createNamespacedJob).not.toHaveBeenCalled();
  });

  it("reattaches and streams logs when same-task orphaned Job exists and reattachOrphanedJobs=true", async () => {
    const TASK_ID = "task-uuid-123";
    const ORPHAN_JOB = "orphaned-job-abc";
    const batchApi = makeBatchApi([
      {
        metadata: {
          name: ORPHAN_JOB,
          labels: { "paperclip.io/task-id": TASK_ID },
        },
        status: { conditions: [] },
      },
    ]);
    vi.mocked(getBatchApi).mockReturnValue(batchApi as unknown as ReturnType<typeof getBatchApi>);

    const ctx = {
      ...makeCtx({ reattachOrphanedJobs: true }),
      context: { taskId: TASK_ID, issueId: null, paperclipWorkspace: null, issueIds: null, paperclipWorkspaces: null, paperclipRuntimeServiceIntents: null, paperclipRuntimeServices: null },
    } as unknown as AdapterExecutionContext;
    const result = await execute(ctx);

    // Should NOT create a new Job — reattached to the orphan
    expect(batchApi.createNamespacedJob).not.toHaveBeenCalled();
    // Should have succeeded by reattaching
    expect(result.exitCode).toBe(0);
    expect(result.sessionId).toBe("ses_happy");
  });

  it("blocks (k8s_concurrent_run_blocked) when same-task orphaned Job exists but reattachOrphanedJobs=false", async () => {
    const TASK_ID = "task-uuid-456";
    const batchApi = makeBatchApi([
      {
        metadata: {
          name: "orphaned-job-xyz",
          labels: { "paperclip.io/task-id": TASK_ID },
        },
        status: { conditions: [] },
      },
    ]);
    vi.mocked(getBatchApi).mockReturnValue(batchApi as unknown as ReturnType<typeof getBatchApi>);

    const ctx = {
      ...makeCtx({ reattachOrphanedJobs: false }),
      context: { taskId: TASK_ID, issueId: null, paperclipWorkspace: null, issueIds: null, paperclipWorkspaces: null, paperclipRuntimeServiceIntents: null, paperclipRuntimeServices: null },
    } as unknown as AdapterExecutionContext;
    const result = await execute(ctx);

    expect(result.errorCode).toBe("k8s_concurrent_run_blocked");
    expect(batchApi.createNamespacedJob).not.toHaveBeenCalled();
  });
});

describe("execute — mutex serialization", () => {
  it("second call waits for first job to finish then creates its own job (no permanent block)", async () => {
    // First call's createNamespacedJob blocks until we release it.
    let releaseFn!: () => void;
    const releasePromise = new Promise<void>((resolve) => { releaseFn = resolve; });

    const batchApi = makeBatchApi();
    batchApi.createNamespacedJob.mockImplementationOnce(async () => {
      await releasePromise;
      return { metadata: { uid: "uid-1" } };
    });
    // First guard call: no running jobs; second guard call: sees the running job.
    // Third call (re-check after wait): default [] from makeBatchApi.
    batchApi.listNamespacedJob
      .mockResolvedValueOnce({ items: [] })
      .mockResolvedValueOnce({
        items: [{ metadata: { name: JOB_NAME }, status: { conditions: [] } }],
      });

    vi.mocked(getBatchApi).mockReturnValue(batchApi as unknown as ReturnType<typeof getBatchApi>);

    // Extended coreApi that satisfies both execute() calls' pod queries:
    // waitForPod needs phase=Running; getPodTerminatedInfo needs terminated.exitCode.
    const coreApi = {
      listNamespacedPod: vi.fn().mockResolvedValue({
        items: [{
          metadata: { name: POD_NAME },
          status: {
            phase: "Running",
            containerStatuses: [{ name: "opencode", state: { terminated: { exitCode: 0 } } }],
          },
        }],
      }),
      readNamespacedPodLog: vi.fn().mockResolvedValue(HAPPY_JSONL),
      createNamespacedSecret: vi.fn().mockResolvedValue({}),
      deleteNamespacedSecret: vi.fn().mockResolvedValue({}),
      patchNamespacedSecret: vi.fn().mockResolvedValue({}),
    };
    vi.mocked(getCoreApi).mockReturnValue(coreApi as unknown as ReturnType<typeof getCoreApi>);

    const ctx = makeCtx();
    const first = execute(ctx);
    // Second call races for the mutex; will wait until first releases.
    const second = execute(ctx);

    // Unblock first call's job creation so it completes and releases the mutex.
    releaseFn();

    const [, secondResult] = await Promise.all([first, second]);

    // Second call should NOT be permanently blocked — it waited and created its own job.
    expect(secondResult.errorCode).toBeUndefined();
    expect(secondResult.exitCode).toBe(0);
    // Both tasks created jobs (sequential, not concurrent).
    expect(batchApi.createNamespacedJob).toHaveBeenCalledTimes(2);
  });

  it("returns k8s_concurrent_run_blocked if job is still running after wait", async () => {
    // Simulate a job that never completes from listNamespacedJob's perspective
    // (always returns running), even though readNamespacedJob says Complete.
    // This covers the re-check failing after the wait (e.g. a new job appeared).
    const batchApi = makeBatchApi([
      {
        metadata: { name: "persistent-job" },
        status: { conditions: [] }, // always appears running in list
      },
    ]);
    vi.mocked(getBatchApi).mockReturnValue(batchApi as unknown as ReturnType<typeof getBatchApi>);

    const ctx = makeCtx();
    const result = await execute(ctx);

    // Waited for the job (readNamespacedJob returned Complete), re-checked (still
    // appears running in list), returned blocked.
    expect(result.errorCode).toBe("k8s_concurrent_run_blocked");
    expect(batchApi.createNamespacedJob).not.toHaveBeenCalled();
  });
});

describe("execute — SIGTERM handler", () => {
  it("registers a SIGTERM handler via process.once on first execute() call", async () => {
    // Spy before execute() so we can verify the handler is installed.
    const onceSpy = vi.spyOn(process, "once");
    const ctx = makeCtx();
    await execute(ctx);

    // ensureSigtermHandler() should call process.once('SIGTERM', ...) at most once per process.
    // Since we can't reset module state between tests, assert it was called at some point.
    const sigtermCalls = onceSpy.mock.calls.filter(([event]) => event === "SIGTERM");
    // Either this test triggered the registration, or an earlier test did.
    // In either case, the handler must exist on process.
    const listenerCount = process.listenerCount("SIGTERM");
    expect(listenerCount).toBeGreaterThanOrEqual(1);
    onceSpy.mockRestore();
  });

  it("SIGTERM handler deletes tracked jobs and calls process.exit(0)", async () => {
    // Capture the SIGTERM handler by temporarily intercepting process.once.
    let capturedHandler: (() => void) | null = null;
    const onceSpy = vi.spyOn(process, "once").mockImplementation(
      (event: string | symbol, handler: (...args: unknown[]) => void) => {
        if (event === "SIGTERM") capturedHandler = handler as () => void;
        return process;
      },
    );
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => { throw new Error("process.exit"); });

    // Reset the SIGTERM flag by re-importing with resetModules (only works first-time per suite).
    // Instead, we test the handler by intercepting the first registration that fires.
    // If the handler was already installed, capturedHandler stays null and we skip.
    const ctx = makeCtx();
    await execute(ctx);

    onceSpy.mockRestore();
    exitSpy.mockRestore();

    if (capturedHandler) {
      const batchApi = vi.mocked(getBatchApi)();
      // Fire the handler and verify it deletes the job that was just created.
      try { (capturedHandler as () => void)(); } catch { /* swallow process.exit throw */ }
      await new Promise((r) => setTimeout(r, 50)); // let async handler tick
      expect(batchApi.deleteNamespacedJob).toHaveBeenCalled();
    }
    // If capturedHandler is null, sigtermHandlerInstalled was already true from
    // a prior test — handler registration is idempotent, which is also correct.
  });
});

describe("execute — job creation failure", () => {
  it("returns k8s_job_create_failed when createNamespacedJob throws", async () => {
    const batchApi = makeBatchApi();
    batchApi.createNamespacedJob.mockRejectedValue(new Error("Namespace not found"));
    vi.mocked(getBatchApi).mockReturnValue(batchApi as unknown as ReturnType<typeof getBatchApi>);

    const ctx = makeCtx();
    const result = await execute(ctx);

    expect(result.errorCode).toBe("k8s_job_create_failed");
    expect(result.exitCode).toBeNull();
  });
});

describe("execute — pod scheduling failure", () => {
  it("returns k8s_pod_schedule_failed when init container fails", async () => {
    const coreApi = {
      listNamespacedPod: vi.fn().mockResolvedValue({
        items: [
          {
            metadata: { name: POD_NAME },
            status: {
              phase: "Pending",
              initContainerStatuses: [
                { name: "write-prompt", state: { terminated: { exitCode: 1, reason: "Error" } } },
              ],
            },
          },
        ],
      }),
      readNamespacedPodLog: vi.fn().mockResolvedValue(""),
    };
    vi.mocked(getCoreApi).mockReturnValue(coreApi as unknown as ReturnType<typeof getCoreApi>);

    const ctx = makeCtx();
    const result = await execute(ctx);

    expect(result.errorCode).toBe("k8s_pod_schedule_failed");
    expect(result.exitCode).toBeNull();
  });

  it("returns k8s_pod_schedule_failed when image pull fails", async () => {
    const coreApi = {
      listNamespacedPod: vi.fn().mockResolvedValue({
        items: [
          {
            metadata: { name: POD_NAME },
            status: {
              phase: "Pending",
              containerStatuses: [
                { name: "opencode", state: { waiting: { reason: "ImagePullBackOff", message: "Back-off pulling image" } } },
              ],
            },
          },
        ],
      }),
      readNamespacedPodLog: vi.fn().mockResolvedValue(""),
    };
    vi.mocked(getCoreApi).mockReturnValue(coreApi as unknown as ReturnType<typeof getCoreApi>);

    const ctx = makeCtx();
    const result = await execute(ctx);

    expect(result.errorCode).toBe("k8s_pod_schedule_failed");
  });

  it("returns k8s_pod_schedule_failed when pod is unschedulable", async () => {
    const coreApi = {
      listNamespacedPod: vi.fn().mockResolvedValue({
        items: [
          {
            metadata: { name: POD_NAME },
            status: {
              phase: "Pending",
              conditions: [
                { type: "PodScheduled", status: "False", reason: "Unschedulable", message: "0/3 nodes available" },
              ],
            },
          },
        ],
      }),
      readNamespacedPodLog: vi.fn().mockResolvedValue(""),
    };
    vi.mocked(getCoreApi).mockReturnValue(coreApi as unknown as ReturnType<typeof getCoreApi>);

    const ctx = makeCtx();
    const result = await execute(ctx);

    expect(result.errorCode).toBe("k8s_pod_schedule_failed");
  });

  it("waits through transient PVC binding before the pod schedules", async () => {
    const coreApi = makeCoreApi();
    coreApi.listNamespacedPod = vi.fn()
      .mockResolvedValueOnce({
        items: [
          {
            metadata: { name: POD_NAME },
            status: {
              phase: "Pending",
              conditions: [
                {
                  type: "PodScheduled",
                  status: "False",
                  reason: "Unschedulable",
                  message: "0/5 nodes are available: pod has unbound immediate PersistentVolumeClaims. not found",
                },
              ],
            },
          },
        ],
      })
      .mockResolvedValueOnce({
        items: [{ metadata: { name: POD_NAME }, status: { phase: "Running" } }],
      })
      .mockResolvedValueOnce({
        items: [
          {
            status: {
              containerStatuses: [
                { name: "opencode", state: { terminated: { exitCode: 0 } } },
              ],
            },
          },
        ],
      });
    vi.mocked(getCoreApi).mockReturnValue(coreApi as unknown as ReturnType<typeof getCoreApi>);

    const ctx = makeCtx();
    const result = await execute(ctx);

    expect(result.exitCode).toBe(0);
    expect(result.errorCode).toBeUndefined();
    expect(ctx.onLog).toHaveBeenCalledWith(
      "stdout",
      expect.stringContaining("Waiting for PVC/volume binding before scheduling"),
    );
  });

  it("does not apply the scheduler timeout after the pod is already assigned", async () => {
    const nowSpy = vi.spyOn(Date, "now")
      .mockReturnValueOnce(0)
      .mockReturnValue(121_000);
    try {
      const coreApi = makeCoreApi();
      coreApi.listNamespacedPod = vi.fn()
        .mockResolvedValueOnce({
          items: [
            {
              metadata: { name: POD_NAME },
              spec: { nodeName: "k8s-paperclip-3" },
              status: {
                phase: "Pending",
                conditions: [{ type: "PodScheduled", status: "True" }],
                initContainerStatuses: [
                  { name: "write-prompt", state: { running: {} } },
                ],
                containerStatuses: [
                  { name: "opencode", state: { waiting: { reason: "PodInitializing" } } },
                ],
              },
            },
          ],
        })
        .mockResolvedValueOnce({
          items: [
            {
              metadata: { name: POD_NAME },
              spec: { nodeName: "k8s-paperclip-3" },
              status: { phase: "Running" },
            },
          ],
        })
        .mockResolvedValueOnce({
          items: [
            {
              status: {
                containerStatuses: [
                  { name: "opencode", state: { terminated: { exitCode: 0 } } },
                ],
              },
            },
          ],
        });
      vi.mocked(getCoreApi).mockReturnValue(coreApi as unknown as ReturnType<typeof getCoreApi>);

      const ctx = makeCtx();
      const result = await execute(ctx);

      expect(result.errorCode).toBeUndefined();
      expect(result.exitCode).toBe(0);
      expect(ctx.onLog).toHaveBeenCalledWith(
        "stdout",
        expect.stringContaining("scheduled; waiting for containers to start"),
      );
    } finally {
      nowSpy.mockRestore();
    }
  });
});

describe("execute — happy path", () => {
  it("returns success with sessionId and usage metrics", async () => {
    const ctx = makeCtx();
    const result = await execute(ctx);

    expect(result.exitCode).toBe(0);
    expect(result.timedOut).toBe(false);
    expect(result.sessionId).toBe("ses_happy");
    expect(result.summary).toBe("Task complete");
    expect(result.usage?.inputTokens).toBe(100);
    expect(result.usage?.outputTokens).toBe(50);
    expect(result.usage?.cachedInputTokens).toBe(20);
    expect(result.costUsd).toBeCloseTo(0.002);
    expect(result.errorMessage).toBeNull();
    expect(result.clearSession).toBe(false);
  });

  it("cleans up the job after completion", async () => {
    const batchApi = makeBatchApi();
    vi.mocked(getBatchApi).mockReturnValue(batchApi as unknown as ReturnType<typeof getBatchApi>);

    const ctx = makeCtx();
    await execute(ctx);

    expect(batchApi.deleteNamespacedJob).toHaveBeenCalledWith(
      expect.objectContaining({ name: JOB_NAME, namespace: NAMESPACE }),
    );
  });

  it("creates job in the correct namespace", async () => {
    const batchApi = makeBatchApi();
    vi.mocked(getBatchApi).mockReturnValue(batchApi as unknown as ReturnType<typeof getBatchApi>);

    const ctx = makeCtx();
    await execute(ctx);

    expect(batchApi.createNamespacedJob).toHaveBeenCalledWith(
      expect.objectContaining({ namespace: NAMESPACE }),
    );
  });

  it("calls onMeta when provided", async () => {
    const onMeta = vi.fn().mockResolvedValue(undefined);
    const ctx = { ...makeCtx(), onMeta } as unknown as AdapterExecutionContext;

    await execute(ctx);

    expect(onMeta).toHaveBeenCalledWith(
      expect.objectContaining({ adapterType: "opencode_k8s" }),
    );
  });
});

describe("execute — session unavailable (reattach classification)", () => {
  it("returns clearSession=true and session_unavailable code for unknown session error", async () => {
    setMockJsonl(JSON.stringify({ type: "error", error: { message: "Unknown session ses_xxx" } }));
    const coreApi = makeCoreApi(1);
    vi.mocked(getCoreApi).mockReturnValue(coreApi as unknown as ReturnType<typeof getCoreApi>);

    const ctx = makeCtx();
    const result = await execute(ctx);

    expect(result.clearSession).toBe(true);
    expect(result.errorCode).toBe("session_unavailable");
  });

  it("returns clearSession=true for 'session not found' error", async () => {
    setMockJsonl(JSON.stringify({ type: "error", error: { message: "Session ses_xxx not found" } }));
    const coreApi = makeCoreApi(1);
    vi.mocked(getCoreApi).mockReturnValue(coreApi as unknown as ReturnType<typeof getCoreApi>);

    const ctx = makeCtx();
    const result = await execute(ctx);

    expect(result.clearSession).toBe(true);
  });

  it("does not set clearSession for unrelated errors", async () => {
    const coreApi = makeCoreApi(1);
    vi.mocked(getCoreApi).mockReturnValue(coreApi as unknown as ReturnType<typeof getCoreApi>);

    const ctx = makeCtx();
    const result = await execute(ctx);

    expect(result.clearSession).toBe(false);
  });
});

describe("execute — stream EOF transient classification", () => {
  it("preserves session params and tags opencode JSON EOF as transient", async () => {
    const eofJsonl = [
      JSON.stringify({
        type: "step_finish",
        part: { reason: "end_turn", tokens: { input: 100, output: 25, cache: { read: 20 } } },
        sessionID: "ses_stream_eof",
      }),
      JSON.stringify({
        type: "error",
        error: {
          name: "UnknownError",
          data: { message: "JSON Parse error: Unexpected EOF" },
        },
        sessionID: "ses_stream_eof",
      }),
    ].join("\n");
    setMockJsonl(eofJsonl);
    const coreApi = makeCoreApi(1);
    vi.mocked(getCoreApi).mockReturnValue(coreApi as unknown as ReturnType<typeof getCoreApi>);

    const ctx = makeCtx({}, { paperclipWorkspace: { cwd: "/workspace" } });
    const result = await execute(ctx);

    expect(result.errorCode).toBe("stream_eof_transient");
    expect(result.errorMessage).toMatch(/stream truncated/i);
    expect(result.sessionId).toBe("ses_stream_eof");
    expect(result.sessionParams).toEqual({ sessionId: "ses_stream_eof", cwd: "/workspace" });
    expect(result.sessionParams && "needsCompactBeforeNextRun" in result.sessionParams).toBe(false);
    expect(result.clearSession).toBeUndefined();
  });
});

describe("execute — timeout", () => {
  it("returns timedOut=true when job reports DeadlineExceeded", async () => {
    const batchApi = makeBatchApi();
    batchApi.readNamespacedJob.mockResolvedValue({
      status: { conditions: [{ type: "Failed", status: "True", reason: "DeadlineExceeded" }] },
    });
    vi.mocked(getBatchApi).mockReturnValue(batchApi as unknown as ReturnType<typeof getBatchApi>);

    const ctx = makeCtx({ timeoutSec: 300 });
    const result = await execute(ctx);

    expect(result.timedOut).toBe(true);
    expect(result.errorCode).toBe("timeout");
  });
});

describe("execute — retainJobs config", () => {
  it("does not delete job when retainJobs=true", async () => {
    const batchApi = makeBatchApi();
    vi.mocked(getBatchApi).mockReturnValue(batchApi as unknown as ReturnType<typeof getBatchApi>);

    const ctx = makeCtx({ retainJobs: true });
    await execute(ctx);

    expect(batchApi.deleteNamespacedJob).not.toHaveBeenCalled();
  });

  it("deletes job when retainJobs=false (default)", async () => {
    const batchApi = makeBatchApi();
    vi.mocked(getBatchApi).mockReturnValue(batchApi as unknown as ReturnType<typeof getBatchApi>);

    const ctx = makeCtx();
    await execute(ctx);

    expect(batchApi.deleteNamespacedJob).toHaveBeenCalled();
  });
});

describe("execute — exit code handling", () => {
  it("propagates non-zero exit code from pod", async () => {
    const coreApi = makeCoreApi(2);
    vi.mocked(getCoreApi).mockReturnValue(coreApi as unknown as ReturnType<typeof getCoreApi>);

    const ctx = makeCtx();
    const result = await execute(ctx);

    expect(result.exitCode).toBe(2);
    expect(result.errorMessage).toBeTruthy();
  });

  it("synthesizes exitCode=1 when error message exists but pod reported exitCode=0", async () => {
    setMockJsonl(JSON.stringify({ type: "error", error: { message: "something went wrong" } }));
    const coreApi = makeCoreApi(0);
    vi.mocked(getCoreApi).mockReturnValue(coreApi as unknown as ReturnType<typeof getCoreApi>);

    const ctx = makeCtx();
    const result = await execute(ctx);

    // Exit code should be synthesized to 1 because errorMessage is non-empty
    expect(result.exitCode).toBe(1);
  });

  it("handles null exit code gracefully (pod not found — 404 tolerance)", async () => {
    const coreApi = makeCoreApi(null);
    vi.mocked(getCoreApi).mockReturnValue(coreApi as unknown as ReturnType<typeof getCoreApi>);

    const ctx = makeCtx();
    const result = await execute(ctx);

    // null exitCode with no error → synthesized to null (no forced failure)
    expect(result.exitCode).toBeNull();
    expect(result.timedOut).toBe(false);
  });
});

describe("execute — pod failure classification", () => {
  it("includes pod terminated reason in errorMessage when reason is OOMKilled", async () => {
    // OOMKilled: process is killed by kernel — no JSONL error event, just empty output
    const coreApi = makeCoreApi(137, "OOMKilled");
    vi.mocked(getCoreApi).mockReturnValue(coreApi as unknown as ReturnType<typeof getCoreApi>);

    const ctx = makeCtx();
    const result = await execute(ctx);

    expect(result.exitCode).toBe(137);
    expect(result.errorMessage).toContain("OOMKilled");
  });

  it("includes pod terminated reason for Error exit", async () => {
    const coreApi = makeCoreApi(1, "Error");
    vi.mocked(getCoreApi).mockReturnValue(coreApi as unknown as ReturnType<typeof getCoreApi>);

    const ctx = makeCtx();
    const result = await execute(ctx);

    expect(result.errorMessage).toContain("Error");
    expect(result.errorMessage).toContain("exit 1");
  });

  it("falls back gracefully when no terminated reason is available", async () => {
    const coreApi = makeCoreApi(1, null);
    vi.mocked(getCoreApi).mockReturnValue(coreApi as unknown as ReturnType<typeof getCoreApi>);

    const ctx = makeCtx();
    const result = await execute(ctx);

    expect(result.exitCode).toBe(1);
    expect(result.errorMessage).toBeTruthy();
  });
});

describe("execute — llm_api_error signal", () => {
  it("returns llm_api_error when session exists but LLM produced no output tokens", async () => {
    // JSONL has a sessionID but no step_finish tokens and no text messages
    const emptyOutputJsonl = JSON.stringify({ sessionID: "ses_empty", type: "step_finish", part: { tokens: { input: 100, output: 0, cache: {} }, cost: 0 } });
    setMockJsonl(emptyOutputJsonl);
    const coreApi = makeCoreApi(0);
    vi.mocked(getCoreApi).mockReturnValue(coreApi as unknown as ReturnType<typeof getCoreApi>);

    const ctx = makeCtx();
    const result = await execute(ctx);

    expect(result.errorCode).toBe("llm_api_error");
    expect(result.errorMessage).toMatch(/empty response/i);
  });

  it("does not emit llm_api_error when there are output tokens", async () => {
    const ctx = makeCtx();
    const result = await execute(ctx);

    expect(result.errorCode).toBeUndefined();
    expect(result.exitCode).toBe(0);
  });

  it("does not emit llm_api_error when there is an explicit error event", async () => {
    const errorJsonl = [
      JSON.stringify({ sessionID: "ses_err", type: "error", error: { message: "API quota exceeded" } }),
    ].join("\n");
    setMockJsonl(errorJsonl);
    const coreApi = makeCoreApi(1);
    vi.mocked(getCoreApi).mockReturnValue(coreApi as unknown as ReturnType<typeof getCoreApi>);

    const ctx = makeCtx();
    const result = await execute(ctx);

    expect(result.errorCode).not.toBe("llm_api_error");
    expect(result.errorMessage).toContain("quota");
  });

  it("does not emit llm_api_error when sessionId is null", async () => {
    const coreApi = makeCoreApi(0);
    vi.mocked(getCoreApi).mockReturnValue(coreApi as unknown as ReturnType<typeof getCoreApi>);

    const ctx = makeCtx();
    const result = await execute(ctx);

    expect(result.errorCode).toBeUndefined();
  });
});

describe("execute — log dedup (waitForPod status dedup)", () => {
  it("logs pod Running status only once when pod is immediately Running", async () => {
    const logMessages: string[] = [];
    const ctx = {
      ...makeCtx(),
      onLog: vi.fn(async (_type: string, msg: string) => {
        logMessages.push(msg);
      }),
    } as unknown as AdapterExecutionContext;

    await execute(ctx);

    // "Pod running: <name>" should appear at most once
    const runningMsgs = logMessages.filter((m) => m.includes(`Pod running: ${POD_NAME}`));
    expect(runningMsgs.length).toBeLessThanOrEqual(1);
  });

  it("logs each distinct pod phase transition exactly once", async () => {
    // Two Pending observations + one Running observation force waitForPod
    // to sleep POLL_INTERVAL_MS (2s) twice. Under real timers that's >4s
    // of wall time, blowing vitest's 5s testTimeout. Use fake timers and
    // advance manually so the loop completes in test time.
    vi.useFakeTimers();
    try {
      const logMessages: string[] = [];
      const coreApi = {
        listNamespacedPod: vi.fn()
          .mockResolvedValueOnce({
            items: [{ metadata: { name: POD_NAME }, status: { phase: "Pending" } }],
          })
          .mockResolvedValueOnce({
            // Same Pending state — should NOT produce duplicate log
            items: [{ metadata: { name: POD_NAME }, status: { phase: "Pending" } }],
          })
          .mockResolvedValueOnce({
            items: [{ metadata: { name: POD_NAME }, status: { phase: "Running" } }],
          })
          .mockResolvedValueOnce({
            // getPodExitCode call
            items: [{
              status: { containerStatuses: [{ name: "opencode", state: { terminated: { exitCode: 0 } } }] },
            }],
          }),
        readNamespacedPodLog: vi.fn().mockResolvedValue(HAPPY_JSONL),
        // execute() creates a prompt Secret before streaming and cleans
        // it up in the finally block. Without these stubs the calls
        // return undefined; non-fatal in practice but leaves a hanging
        // promise that gets blamed on subsequent tests' coreApi mocks
        // when this one times out (cascading "podList.items is undefined"
        // in unrelated tests).
        createNamespacedSecret: vi.fn().mockResolvedValue({}),
        deleteNamespacedSecret: vi.fn().mockResolvedValue({}),
        patchNamespacedSecret: vi.fn().mockResolvedValue({}),
      };
      vi.mocked(getCoreApi).mockReturnValue(coreApi as unknown as ReturnType<typeof getCoreApi>);

      const ctx = {
        ...makeCtx(),
        onLog: vi.fn(async (_type: string, msg: string) => {
          logMessages.push(msg);
        }),
      } as unknown as AdapterExecutionContext;

      const executePromise = execute(ctx);

      // Drain the two POLL_INTERVAL_MS sleeps in waitForPod plus the
      // log-streaming completion path. Advance in 1s steps so each
      // microtask level settles before the next.
      for (let i = 0; i < 10; i++) {
        await vi.advanceTimersByTimeAsync(1_000);
      }

      await executePromise;

      // Pending status should appear exactly once even though listNamespacedPod was called twice
      const pendingMsgs = logMessages.filter((m) => m.includes("phase=Pending"));
      expect(pendingMsgs.length).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("execute — external cancel polling", () => {
  const KEEPALIVE_MS = 15_000;

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    delete process.env.PAPERCLIP_API_URL;
  });

  it("returns errorCode=cancelled and deletes job when issue status is cancelled", async () => {
    vi.useFakeTimers();

    process.env.PAPERCLIP_API_URL = "http://test-api";

    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ status: "cancelled" }),
    });
    vi.stubGlobal("fetch", fetchMock);

    let jobDeleted = false;
    const batchApi = makeBatchApi();
    batchApi.deleteNamespacedJob.mockImplementation(() => {
      jobDeleted = true;
      return Promise.resolve({});
    });
    batchApi.readNamespacedJob.mockImplementation(() => {
      if (jobDeleted) {
        const err = Object.assign(new Error("not found"), { statusCode: 404 });
        return Promise.reject(err);
      }
      return Promise.resolve({ status: { conditions: [] } }); // non-terminal until deleted
    });
    vi.mocked(getBatchApi).mockReturnValue(batchApi as unknown as ReturnType<typeof getBatchApi>);

    const ctx = makeCtx({}, { issueId: "issue-test-456" }, "run-jwt-token");
    const executePromise = execute(ctx);

    // Advance in 1-second steps. vi.advanceTimersByTimeAsync fires fake timers
    // but only drains one microtask level per call. Advancing in small chunks
    // gives multi-level Promise chains (fetch → json → cancel logic) time to
    // fully settle between steps before we await the resolved execute result.
    for (let i = 0; i < 20; i++) {
      await vi.advanceTimersByTimeAsync(1_000);
    }

    const result = await executePromise;

    expect(result.errorCode).toBe("cancelled");
    expect(result.exitCode).toBeNull();
    expect(result.timedOut).toBe(false);
    expect(batchApi.deleteNamespacedJob).toHaveBeenCalledWith(
      expect.objectContaining({ name: JOB_NAME, namespace: NAMESPACE, body: { propagationPolicy: "Background" } }),
    );
    expect(fetchMock).toHaveBeenCalledWith(
      "http://test-api/api/issues/issue-test-456",
      expect.objectContaining({ headers: expect.objectContaining({ Authorization: "Bearer run-jwt-token" }) }),
    );
  });

  it("does not cancel when PAPERCLIP_API_URL is absent", async () => {
    // No PAPERCLIP_API_URL set — cancel polling is skipped; normal completion runs.
    delete process.env.PAPERCLIP_API_URL;

    const ctx = makeCtx();
    const result = await execute(ctx);

    expect(result.errorCode).toBeUndefined();
    expect(result.exitCode).toBe(0);
  });

  it("does not cancel when issue status is not cancelled", async () => {
    vi.useFakeTimers();

    process.env.PAPERCLIP_API_URL = "http://test-api";

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ status: "in_progress" }),
    }));

    const ctx = makeCtx({}, { issueId: "issue-test-456" });
    const executePromise = execute(ctx);

    await vi.advanceTimersByTimeAsync(KEEPALIVE_MS + 500);

    const result = await executePromise;

    // Should complete normally, not be cancelled.
    expect(result.errorCode).toBeUndefined();
    expect(result.exitCode).toBe(0);
  });
});

describe("execute — large-prompt Secret path", () => {
  const LARGE_PROMPT = "x".repeat(300 * 1024); // 300 KiB > 256 KiB threshold

  function mockLargePrompt() {
    vi.mocked(buildJobManifest).mockReturnValue({
      job: MOCK_JOB as ReturnType<typeof buildJobManifest>["job"],
      jobName: JOB_NAME,
      namespace: NAMESPACE,
      prompt: LARGE_PROMPT,
      opencodeArgs: [],
      promptMetrics: null,
      podLogPath: `/paperclip/instances/default/data/run-logs/co-1/agent-id-test/run-test-123.pod.ndjson`,
    } as unknown as ReturnType<typeof buildJobManifest>);
  }

  it("calls buildJobManifest twice and passes promptSecretName on second call", async () => {
    mockLargePrompt();

    const ctx = makeCtx();
    await execute(ctx);

    expect(vi.mocked(buildJobManifest)).toHaveBeenCalledTimes(2);
    const secondCall = vi.mocked(buildJobManifest).mock.calls[1][0];
    expect(secondCall.promptSecretName).toBe(`${JOB_NAME}-prompt`);
  });

  it("creates a Secret with the prompt content before creating the Job", async () => {
    mockLargePrompt();
    const coreApi = makeCoreApi();
    vi.mocked(getCoreApi).mockReturnValue(coreApi as unknown as ReturnType<typeof getCoreApi>);
    const batchApi = makeBatchApi();
    vi.mocked(getBatchApi).mockReturnValue(batchApi as unknown as ReturnType<typeof getBatchApi>);

    const ctx = makeCtx();
    await execute(ctx);

    expect(coreApi.createNamespacedSecret).toHaveBeenCalledWith(
      expect.objectContaining({
        namespace: NAMESPACE,
        body: expect.objectContaining({
          metadata: expect.objectContaining({ name: `${JOB_NAME}-prompt` }),
          stringData: expect.objectContaining({ prompt: LARGE_PROMPT }),
        }),
      }),
    );
    // Secret must be created before Job
    const secretOrder = coreApi.createNamespacedSecret.mock.invocationCallOrder[0];
    const jobOrder = batchApi.createNamespacedJob.mock.invocationCallOrder[0];
    expect(secretOrder).toBeLessThan(jobOrder);
  });

  it("patches the Secret with a Job ownerReference after Job creation", async () => {
    mockLargePrompt();
    const batchApi = makeBatchApi();
    batchApi.createNamespacedJob.mockResolvedValue({ metadata: { uid: "uid-abc-123" } });
    vi.mocked(getBatchApi).mockReturnValue(batchApi as unknown as ReturnType<typeof getBatchApi>);
    const coreApi = makeCoreApi();
    vi.mocked(getCoreApi).mockReturnValue(coreApi as unknown as ReturnType<typeof getCoreApi>);

    const ctx = makeCtx();
    await execute(ctx);

    // JSON Patch (RFC 6902) body shape — matches @kubernetes/client-node's
    // default application/json-patch+json content-type. Previously this was
    // a strategic-merge object which the client-node SDK rejected silently,
    // letting the Secret leak (BLO-5310).
    expect(coreApi.patchNamespacedSecret).toHaveBeenCalledWith(
      expect.objectContaining({
        name: `${JOB_NAME}-prompt`,
        namespace: NAMESPACE,
        body: [
          expect.objectContaining({
            op: "add",
            path: "/metadata/ownerReferences",
            value: [
              expect.objectContaining({
                apiVersion: "batch/v1",
                kind: "Job",
                name: JOB_NAME,
                uid: "uid-abc-123",
                blockOwnerDeletion: false,
              }),
            ],
          }),
        ],
      }),
    );
  });

  it("cleans up the Secret in the finally block", async () => {
    mockLargePrompt();
    const coreApi = makeCoreApi();
    vi.mocked(getCoreApi).mockReturnValue(coreApi as unknown as ReturnType<typeof getCoreApi>);

    const ctx = makeCtx();
    await execute(ctx);

    expect(coreApi.deleteNamespacedSecret).toHaveBeenCalledWith(
      expect.objectContaining({ name: `${JOB_NAME}-prompt`, namespace: NAMESPACE }),
    );
  });

  it("cleans up the Secret when Job creation fails", async () => {
    mockLargePrompt();
    const batchApi = makeBatchApi();
    batchApi.createNamespacedJob.mockRejectedValue(new Error("quota exceeded"));
    vi.mocked(getBatchApi).mockReturnValue(batchApi as unknown as ReturnType<typeof getBatchApi>);
    const coreApi = makeCoreApi();
    vi.mocked(getCoreApi).mockReturnValue(coreApi as unknown as ReturnType<typeof getCoreApi>);

    const ctx = makeCtx();
    const result = await execute(ctx);

    expect(result.errorCode).toBe("k8s_job_create_failed");
    expect(coreApi.deleteNamespacedSecret).toHaveBeenCalledWith(
      expect.objectContaining({ name: `${JOB_NAME}-prompt` }),
    );
  });

  it("does not create a Secret for prompts within threshold", async () => {
    // Default beforeEach mock returns "Test prompt" (11 bytes < 256 KiB)
    const coreApi = makeCoreApi();
    vi.mocked(getCoreApi).mockReturnValue(coreApi as unknown as ReturnType<typeof getCoreApi>);

    const ctx = makeCtx();
    await execute(ctx);

    expect(vi.mocked(buildJobManifest)).toHaveBeenCalledTimes(1);
    expect(coreApi.createNamespacedSecret).not.toHaveBeenCalled();
  });
});

describe("ensureAgentDbPvc — unit", () => {
  const NAMESPACE = "test-ns";
  const AGENT_ID = "agent-uuid-1234";
  const EXPECTED_PVC_NAME = `opencode-db-${AGENT_ID}`;

  it("returns null when agentDbMode is ephemeral", async () => {
    const result = await ensureAgentDbPvc(AGENT_ID, NAMESPACE, { agentDbMode: "ephemeral" });
    expect(result).toBeNull();
    expect(vi.mocked(getPvc)).not.toHaveBeenCalled();
    expect(vi.mocked(createPvc)).not.toHaveBeenCalled();
  });

  it("returns existing PVC claim name without calling createPvc", async () => {
    vi.mocked(getPvc).mockResolvedValueOnce({ metadata: { name: EXPECTED_PVC_NAME } } as Awaited<ReturnType<typeof getPvc>>);

    const result = await ensureAgentDbPvc(AGENT_ID, NAMESPACE, { agentDbMode: "dedicated_pvc", agentDbStorageClass: "standard" });

    expect(result).toBe(EXPECTED_PVC_NAME);
    expect(vi.mocked(getPvc)).toHaveBeenCalledWith(NAMESPACE, EXPECTED_PVC_NAME, undefined);
    expect(vi.mocked(createPvc)).not.toHaveBeenCalled();
  });

  it("creates PVC and returns claim name when PVC does not exist", async () => {
    vi.mocked(getPvc).mockResolvedValueOnce(null);
    vi.mocked(createPvc).mockResolvedValueOnce({} as Awaited<ReturnType<typeof createPvc>>);

    const result = await ensureAgentDbPvc(AGENT_ID, NAMESPACE, {
      agentDbMode: "dedicated_pvc",
      agentDbStorageClass: "standard",
      agentDbStorageCapacity: "5Gi",
    });

    expect(result).toBe(EXPECTED_PVC_NAME);
    expect(vi.mocked(createPvc)).toHaveBeenCalledWith(
      NAMESPACE,
      expect.objectContaining({
        metadata: expect.objectContaining({ name: EXPECTED_PVC_NAME }),
        spec: expect.objectContaining({
          accessModes: ["ReadWriteOnce"],
          storageClassName: "standard",
          resources: { requests: { storage: "5Gi" } },
        }),
      }),
      undefined,
    );
  });

  it("defaults to 1Gi capacity when agentDbStorageCapacity is not set", async () => {
    vi.mocked(getPvc).mockResolvedValueOnce(null);
    vi.mocked(createPvc).mockResolvedValueOnce({} as Awaited<ReturnType<typeof createPvc>>);

    await ensureAgentDbPvc(AGENT_ID, NAMESPACE, { agentDbMode: "dedicated_pvc", agentDbStorageClass: "fast" });

    expect(vi.mocked(createPvc)).toHaveBeenCalledWith(
      NAMESPACE,
      expect.objectContaining({
        spec: expect.objectContaining({ resources: { requests: { storage: "1Gi" } } }),
      }),
      undefined,
    );
  });

  it("throws when agentDbStorageClass is missing and PVC does not exist", async () => {
    vi.mocked(getPvc).mockResolvedValueOnce(null);

    await expect(
      ensureAgentDbPvc(AGENT_ID, NAMESPACE, { agentDbMode: "dedicated_pvc" }),
    ).rejects.toThrow(/agentDbStorageClass/);
    expect(vi.mocked(createPvc)).not.toHaveBeenCalled();
  });

  it("defaults to workspace_subpath when agentDbMode is not set (no dedicated PVC provisioned)", async () => {
    const result = await ensureAgentDbPvc(AGENT_ID, NAMESPACE, {});
    expect(result).toBeNull();
    expect(vi.mocked(getPvc)).not.toHaveBeenCalled();
    expect(vi.mocked(createPvc)).not.toHaveBeenCalled();
  });

  it("derives PVC name from agent ID, keeping alphanumeric and hyphens", async () => {
    const weirdAgentId = "Agent_ID/with+special@chars";
    const expectedSlug = "agentidwithspecialchars"; // [^a-z0-9-] stripped
    vi.mocked(getPvc).mockResolvedValueOnce({ metadata: { name: `opencode-db-${expectedSlug}` } } as Awaited<ReturnType<typeof getPvc>>);

    const result = await ensureAgentDbPvc(weirdAgentId, NAMESPACE, { agentDbMode: "dedicated_pvc" });
    expect(result).toBe(`opencode-db-${expectedSlug}`);
    expect(vi.mocked(getPvc)).toHaveBeenCalledWith(NAMESPACE, `opencode-db-${expectedSlug}`, undefined);
  });
});

describe("isK8s404", () => {
  it("recognizes @kubernetes/client-node v1.x ApiException with code=404", async () => {
    const { isK8s404 } = await import("./execute.js");
    const err = Object.assign(new Error("not found"), { code: 404 });
    expect(isK8s404(err)).toBe(true);
  });

  it("still recognizes legacy errors with statusCode=404", async () => {
    const { isK8s404 } = await import("./execute.js");
    const err = Object.assign(new Error("not found"), { statusCode: 404 });
    expect(isK8s404(err)).toBe(true);
  });

  it("still recognizes errors with response.statusCode=404", async () => {
    const { isK8s404 } = await import("./execute.js");
    const err = Object.assign(new Error("not found"), { response: { statusCode: 404 } });
    expect(isK8s404(err)).toBe(true);
  });

  it("returns false for non-404 errors", async () => {
    const { isK8s404 } = await import("./execute.js");
    expect(isK8s404(Object.assign(new Error("server error"), { code: 500 }))).toBe(false);
    expect(isK8s404(new Error("plain error"))).toBe(false);
    expect(isK8s404(null)).toBe(false);
  });
});

describe("parseModelProvider", () => {
  it("returns null for null input", async () => {
    const { parseModelProvider } = await import("./execute.js");
    expect(parseModelProvider(null)).toBeNull();
  });

  it("returns null for whitespace-only or empty input", async () => {
    const { parseModelProvider } = await import("./execute.js");
    expect(parseModelProvider("  ")).toBeNull();
    expect(parseModelProvider("")).toBeNull();
  });

  it("returns null for bare model ids that don't match a known prefix", async () => {
    const { parseModelProvider } = await import("./execute.js");
    expect(parseModelProvider("some-private-model")).toBeNull();
    expect(parseModelProvider("custom123")).toBeNull();
  });

  it("infers provider from bare model id by name prefix", async () => {
    const { parseModelProvider } = await import("./execute.js");
    expect(parseModelProvider("gpt-4")).toBe("openai");
    expect(parseModelProvider("gpt-5.5")).toBe("openai");
    expect(parseModelProvider("o1-mini")).toBe("openai");
    expect(parseModelProvider("o3")).toBe("openai");
    expect(parseModelProvider("chatgpt-classic")).toBe("openai");
    expect(parseModelProvider("claude-sonnet-4-6")).toBe("anthropic");
    expect(parseModelProvider("opus")).toBe("anthropic");
    expect(parseModelProvider("gemini-2.5-pro")).toBe("google");
  });

  it("returns the provider segment from a slash-separated model id", async () => {
    const { parseModelProvider } = await import("./execute.js");
    expect(parseModelProvider("anthropic/claude-opus-4")).toBe("anthropic");
    expect(parseModelProvider("openai/gpt-4o")).toBe("openai");
  });

  it("trims whitespace inside the provider segment", async () => {
    const { parseModelProvider } = await import("./execute.js");
    expect(parseModelProvider("  bedrock  /claude")).toBe("bedrock");
  });

  it("returns null when provider segment is whitespace only", async () => {
    const { parseModelProvider } = await import("./execute.js");
    expect(parseModelProvider(" /model")).toBeNull();
  });
});

describe("completionWithGrace", () => {
  it("returns the completion result when it resolves before grace expires", async () => {
    const { completionWithGrace } = await import("./execute.js");
    const result = await completionWithGrace(
      Promise.resolve({ succeeded: true, timedOut: false, jobGone: false }),
      1000,
    );
    expect(result).toEqual({ succeeded: true, timedOut: false, jobGone: false });
  });

  it("returns timedOut result when grace expires first", async () => {
    const { completionWithGrace } = await import("./execute.js");
    vi.useFakeTimers();
    try {
      const slowCompletion = new Promise<{ succeeded: boolean; timedOut: boolean; jobGone: boolean }>(() => {});
      const racePromise = completionWithGrace(slowCompletion, 50);
      await vi.advanceTimersByTimeAsync(60);
      const result = await racePromise;
      expect(result).toEqual({ succeeded: false, timedOut: true, jobGone: false });
    } finally {
      vi.useRealTimers();
    }
  });

  it("does NOT report a timeout when the completion promise rejects — a poll error is not a deadline (BLO-10448)", async () => {
    const { completionWithGrace } = await import("./execute.js");
    // With a grace cap configured: a rejected completion poll must surface as
    // "outcome unknown" (timedOut:false), not a spurious deadline. The caller
    // adjudicates via the pod's real exit code.
    const withGrace = await completionWithGrace(Promise.reject(new Error("boom")), 1000);
    expect(withGrace).toEqual({ succeeded: false, timedOut: false, jobGone: false });
    // And in the no-timeout-configured branch (graceMs <= 0) — this is the path
    // that produced the bogus "Timed out after 0s" for timeoutSec:0 agents.
    const noGrace = await completionWithGrace(Promise.reject(new Error("boom")), 0);
    expect(noGrace).toEqual({ succeeded: false, timedOut: false, jobGone: false });
  });

  it("does not apply grace cap when graceMs <= 0 (no timeout configured) — BLO-2436", async () => {
    const { completionWithGrace } = await import("./execute.js");
    vi.useFakeTimers();
    try {
      const slowCompletion = new Promise<{ succeeded: boolean; timedOut: boolean; jobGone: boolean }>(
        (resolve) => {
          setTimeout(() => resolve({ succeeded: true, timedOut: false, jobGone: false }), 100_000);
        },
      );
      const racePromise = completionWithGrace(slowCompletion, 0);
      // Advance past what a buggy setTimeout(_, 0) would fire on, but well
      // short of slowCompletion's 100s resolution.  After the fix, racePromise
      // must still be pending — the grace cap must not have armed.
      await vi.advanceTimersByTimeAsync(60_000);
      const probe = await Promise.race([
        racePromise.then(() => "race-resolved" as const),
        Promise.resolve("still-pending" as const),
      ]);
      expect(probe).toBe("still-pending");
      // Now let slowCompletion resolve and assert the underlying value passed through.
      await vi.advanceTimersByTimeAsync(100_000);
      const result = await racePromise;
      expect(result).toEqual({ succeeded: true, timedOut: false, jobGone: false });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("waitForJobCompletion — transient read tolerance (BLO-10448)", () => {
  it("rides out a transient read error and then observes completion", async () => {
    const { waitForJobCompletion } = await import("./execute.js");
    const readNamespacedJob = vi.fn()
      .mockRejectedValueOnce(new Error("apiserver 500"))
      .mockResolvedValueOnce({ status: { conditions: [{ type: "Complete", status: "True" }] } });
    vi.mocked(getBatchApi).mockReturnValue(
      { readNamespacedJob } as unknown as ReturnType<typeof getBatchApi>,
    );
    vi.useFakeTimers();
    try {
      const p = waitForJobCompletion(NAMESPACE, JOB_NAME, 0);
      await vi.advanceTimersByTimeAsync(2000);
      const result = await p;
      expect(result).toEqual({ succeeded: true, timedOut: false, jobGone: false });
      expect(readNamespacedJob).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("gives up by throwing (NOT masquerading as a timeout) after sustained read errors", async () => {
    const { waitForJobCompletion } = await import("./execute.js");
    const readNamespacedJob = vi.fn().mockRejectedValue(new Error("apiserver down"));
    vi.mocked(getBatchApi).mockReturnValue(
      { readNamespacedJob } as unknown as ReturnType<typeof getBatchApi>,
    );
    vi.useFakeTimers();
    try {
      const p = waitForJobCompletion(NAMESPACE, JOB_NAME, 0);
      const expectation = expect(p).rejects.toThrow("apiserver down");
      await vi.advanceTimersByTimeAsync(2000 * 5);
      await expectation;
      // MAX_CONSECUTIVE_READ_ERRORS reads, then it throws — the caller surfaces a
      // truthful k8s error instead of a bogus "Timed out after 0s".
      expect(readNamespacedJob).toHaveBeenCalledTimes(5);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("execute — config edge paths", () => {
  it("uses an ephemeral opencode DB for default workspace_subpath no-task runs", async () => {
    const ctx = makeCtx({ agentDbMode: "workspace_subpath" });
    const result = await execute(ctx);

    expect(result.errorCode).toBeUndefined();
    const buildArgs = vi.mocked(buildJobManifest).mock.calls[0][0];
    expect(buildArgs.agentDbClaimName).toBeNull();
    expect(buildArgs.agentDbWorkspaceSubPath).toBeUndefined();
    expect(vi.mocked(getPvc)).not.toHaveBeenCalled();
  });

  it("keeps issue-scoped workspace_subpath opencode DB persistence", async () => {
    const ctx = makeCtx({ agentDbMode: "workspace_subpath" });
    (ctx.runtime as { taskKey: string | null }).taskKey = "BLO-11715";
    const result = await execute(ctx);

    expect(result.errorCode).toBeUndefined();
    const buildArgs = vi.mocked(buildJobManifest).mock.calls[0][0];
    expect(buildArgs.agentDbWorkspaceSubPath).toBe(".opencode-db/co-1/agent-id-test/blo-11715");
    expect(buildArgs.agentDbClaimName).toBeUndefined();
    expect(vi.mocked(getPvc)).not.toHaveBeenCalled();
  });

  it("logs a warning but continues when instructionsFilePath cannot be read", async () => {
    const ctx = makeCtx({ instructionsFilePath: "/does/not/exist/AGENTS.md" });
    const result = await execute(ctx);
    expect(result.errorCode).toBeUndefined();
    const logCalls = vi.mocked(ctx.onLog).mock.calls;
    const warning = logCalls.find(([_kind, msg]: [string, string]) => typeof msg === "string" && msg.includes("instructionsFilePath not readable"));
    expect(warning).toBeDefined();
  });

  it("returns k8s_job_create_failed when ensureAgentDbPvc throws (PVC create rejected)", async () => {
    vi.mocked(getPvc).mockResolvedValueOnce(null);
    vi.mocked(createPvc).mockRejectedValueOnce(new Error("storage class missing"));
    const ctx = makeCtx({
      agentDbMode: "dedicated_pvc",
      agentDbStorageClass: "fast",
    });
    const result = await execute(ctx);
    expect(result.errorCode).toBe("k8s_job_create_failed");
    expect(result.errorMessage).toContain("storage class missing");
  });

  it("returns k8s_job_create_failed when ensureAgentDbPvc throws because storage class is missing", async () => {
    vi.mocked(getPvc).mockResolvedValueOnce(null);
    const ctx = makeCtx({ agentDbMode: "dedicated_pvc" });
    const result = await execute(ctx);
    expect(result.errorCode).toBe("k8s_job_create_failed");
    expect(result.errorMessage).toContain("agentDbStorageClass is required");
  });
});

describe("execute — large-prompt Secret create failure", () => {
  const LARGE_PROMPT = "y".repeat(300 * 1024);

  it("returns k8s_job_create_failed when createNamespacedSecret throws", async () => {
    vi.mocked(buildJobManifest).mockReturnValue({
      job: MOCK_JOB as ReturnType<typeof buildJobManifest>["job"],
      jobName: JOB_NAME,
      namespace: NAMESPACE,
      prompt: LARGE_PROMPT,
      opencodeArgs: [],
      promptMetrics: null,
      podLogPath: `/paperclip/instances/default/data/run-logs/co-1/agent-id-test/run-test-123.pod.ndjson`,
    } as unknown as ReturnType<typeof buildJobManifest>);

    const coreApi = makeCoreApi();
    coreApi.createNamespacedSecret.mockRejectedValue(new Error("etcd full"));
    vi.mocked(getCoreApi).mockReturnValue(coreApi as unknown as ReturnType<typeof getCoreApi>);

    const ctx = makeCtx();
    const result = await execute(ctx);

    expect(result.errorCode).toBe("k8s_job_create_failed");
    expect(result.errorMessage).toContain("Failed to create prompt Secret");
    expect(result.errorMessage).toContain("etcd full");
  });
});

describe("ensureAgentDbPvc — verification failure (FAR-85 belt-and-suspenders)", () => {
  it("throws when getPvc returns null after createPvc resolved (verification failed)", async () => {
    vi.mocked(getPvc)
      .mockResolvedValueOnce(null)   // first existence check: not found
      .mockResolvedValueOnce(null);  // post-create verification: still not found
    vi.mocked(createPvc).mockResolvedValueOnce({} as never);
    await expect(
      ensureAgentDbPvc("agent-x", "ns-x", { agentDbMode: "dedicated_pvc", agentDbStorageClass: "fast" }),
    ).rejects.toThrow(/PVC opencode-db-agent-x was not created/);
  });
});

describe("execute — step limit detection", () => {
  it("logs that the step limit was reached when a step_finish event has reason=max_steps", async () => {
    const STEP_LIMIT_JSONL = [
      JSON.stringify({ type: "text", part: { text: "partial" }, sessionID: "ses_step" }),
      JSON.stringify({ type: "step_finish", part: { reason: "max_steps", tokens: { input: 10, output: 5 }, cost: 0 } }),
    ].join("\n");
    setMockJsonl(STEP_LIMIT_JSONL);

    const coreApi = makeCoreApi(0);
    vi.mocked(getCoreApi).mockReturnValue(coreApi as unknown as ReturnType<typeof getCoreApi>);

    const ctx = makeCtx();
    await execute(ctx);

    const logCalls = vi.mocked(ctx.onLog).mock.calls;
    const limitLog = logCalls.find(
      ([_kind, msg]: [string, string]) => typeof msg === "string" && msg.includes("step limit reached"),
    );
    expect(limitLog).toBeDefined();
  });
});

describe("execute — waitForPod 'no pod yet' messaging", () => {
  it("emits a 'Waiting for Job controller to create pod' log when pod is not yet present", async () => {
    const coreApi = makeCoreApi();
    // First listNamespacedPod call returns empty (no pod yet), second returns Running
    coreApi.listNamespacedPod = vi.fn()
      .mockResolvedValueOnce({ items: [] })
      .mockResolvedValueOnce({
        items: [{ metadata: { name: POD_NAME }, status: { phase: "Running" } }],
      })
      .mockResolvedValue({
        items: [{ status: { containerStatuses: [{ name: "opencode", state: { terminated: { exitCode: 0 } } }] } }],
      });
    vi.mocked(getCoreApi).mockReturnValue(coreApi as unknown as ReturnType<typeof getCoreApi>);

    const ctx = makeCtx();
    await execute(ctx);

    const logCalls = vi.mocked(ctx.onLog).mock.calls;
    const waitLog = logCalls.find(
      ([_kind, msg]: [string, string]) => typeof msg === "string" && msg.includes("Waiting for Job controller to create pod"),
    );
    expect(waitLog).toBeDefined();
  });
});

describe("execute — pod scheduling failure (extra paths)", () => {
  it("returns k8s_pod_schedule_failed when init container is in ImagePullBackOff", async () => {
    const coreApi = {
      listNamespacedPod: vi.fn().mockResolvedValue({
        items: [
          {
            metadata: { name: POD_NAME },
            status: {
              phase: "Pending",
              initContainerStatuses: [
                { name: "write-prompt", state: { waiting: { reason: "ImagePullBackOff", message: "back-off" } } },
              ],
            },
          },
        ],
      }),
      readNamespacedPodLog: vi.fn().mockResolvedValue(""),
    };
    vi.mocked(getCoreApi).mockReturnValue(coreApi as unknown as ReturnType<typeof getCoreApi>);
    const result = await execute(makeCtx());
    expect(result.errorCode).toBe("k8s_pod_schedule_failed");
    expect(result.errorMessage).toMatch(/Init container.*image pull failed/);
  });

  it("returns k8s_pod_schedule_failed when init container is in CrashLoopBackOff", async () => {
    const coreApi = {
      listNamespacedPod: vi.fn().mockResolvedValue({
        items: [
          {
            metadata: { name: POD_NAME },
            status: {
              phase: "Pending",
              initContainerStatuses: [
                { name: "write-prompt", state: { waiting: { reason: "CrashLoopBackOff", message: "loop" } } },
              ],
            },
          },
        ],
      }),
      readNamespacedPodLog: vi.fn().mockResolvedValue(""),
    };
    vi.mocked(getCoreApi).mockReturnValue(coreApi as unknown as ReturnType<typeof getCoreApi>);
    const result = await execute(makeCtx());
    expect(result.errorCode).toBe("k8s_pod_schedule_failed");
    expect(result.errorMessage).toMatch(/Init container.*crash loop/);
  });

  it("returns k8s_pod_schedule_failed when main container is in CrashLoopBackOff", async () => {
    const coreApi = {
      listNamespacedPod: vi.fn().mockResolvedValue({
        items: [
          {
            metadata: { name: POD_NAME },
            status: {
              phase: "Pending",
              containerStatuses: [
                { name: "opencode", state: { waiting: { reason: "CrashLoopBackOff", message: "loop" } } },
              ],
            },
          },
        ],
      }),
      readNamespacedPodLog: vi.fn().mockResolvedValue(""),
    };
    vi.mocked(getCoreApi).mockReturnValue(coreApi as unknown as ReturnType<typeof getCoreApi>);
    const result = await execute(makeCtx());
    expect(result.errorCode).toBe("k8s_pod_schedule_failed");
    expect(result.errorMessage).toMatch(/crash loop/);
  });

  it("proceeds when all init containers terminated successfully and main is running", async () => {
    const coreApi = {
      listNamespacedPod: vi.fn()
        .mockResolvedValueOnce({
          items: [
            {
              metadata: { name: POD_NAME },
              status: {
                phase: "Pending",
                initContainerStatuses: [
                  { name: "write-prompt", state: { terminated: { exitCode: 0 } } },
                ],
                containerStatuses: [{ name: "opencode", state: { running: {} } }],
              },
            },
          ],
        })
        .mockResolvedValue({
          items: [{ status: { containerStatuses: [{ name: "opencode", state: { terminated: { exitCode: 0 } } }] } }],
        }),
      readNamespacedPodLog: vi.fn().mockResolvedValue(HAPPY_JSONL),
    };
    vi.mocked(getCoreApi).mockReturnValue(coreApi as unknown as ReturnType<typeof getCoreApi>);
    const result = await execute(makeCtx());
    expect(result.errorCode).toBeUndefined();
    expect(result.exitCode).toBe(0);
  });
});

describe("execute — skill bundle source loading", () => {
  it("reads SKILL.md from entry.source dir and bundles content into the prompt", async () => {
    const { mkdtempSync, writeFileSync, mkdirSync } = await import("node:fs");
    const os = await import("node:os");
    const path = await import("node:path");
    const tmpDir = mkdtempSync(path.join(os.tmpdir(), "skills-test-"));
    const skillDir = path.join(tmpDir, "skill-a");
    mkdirSync(skillDir);
    writeFileSync(path.join(skillDir, "SKILL.md"), "skill A content");

    const utils = await import("@paperclipai/adapter-utils/server-utils");
    vi.mocked(utils.readPaperclipRuntimeSkillEntries).mockResolvedValueOnce([
      { key: "paperclip/skill-a", runtimeName: "skill-a", source: skillDir, required: true } as never,
    ]);

    const ctx = makeCtx();
    await execute(ctx);

    // buildJobManifest should have received the skills bundle content
    const buildArgs = vi.mocked(buildJobManifest).mock.calls[0][0];
    expect(buildArgs.skillsBundleContent).toContain("skill A content");
  });

  it("falls back to reading entry.source as a file when SKILL.md path read throws", async () => {
    const { mkdtempSync, writeFileSync } = await import("node:fs");
    const os = await import("node:os");
    const path = await import("node:path");
    const tmpDir = mkdtempSync(path.join(os.tmpdir(), "skills-flat-"));
    const skillFile = path.join(tmpDir, "skill-b.md");
    writeFileSync(skillFile, "skill B flat content");

    const utils = await import("@paperclipai/adapter-utils/server-utils");
    vi.mocked(utils.readPaperclipRuntimeSkillEntries).mockResolvedValueOnce([
      { key: "paperclip/skill-b", runtimeName: "skill-b", source: skillFile, required: true } as never,
    ]);

    const ctx = makeCtx();
    await execute(ctx);

    const buildArgs = vi.mocked(buildJobManifest).mock.calls[0][0];
    expect(buildArgs.skillsBundleContent).toContain("skill B flat content");
  });
});

describe("execute — SIGTERM handler body (FAR-86 coverage)", () => {
  it("invoking the captured SIGTERM handler deletes tracked Jobs and Secrets", async () => {
    // Force a fresh module so sigtermHandlerInstalled starts false again.
    vi.resetModules();
    vi.doMock("./k8s-client.js", () => ({
      getSelfPodInfo: vi.fn().mockResolvedValue(MOCK_SELF_POD),
      getBatchApi: vi.fn(),
      getCoreApi: vi.fn(),
      getPvc: vi.fn().mockResolvedValue({ metadata: { name: "opencode-db-x" } }),
      createPvc: vi.fn().mockResolvedValue({}),
    }));
    vi.doMock("./job-manifest.js", () => ({
      buildJobManifest: vi.fn().mockReturnValue({
        job: MOCK_JOB,
        jobName: "fresh-job",
        namespace: NAMESPACE,
        prompt: "p",
        opencodeArgs: [],
        promptMetrics: null,
        podLogPath: `/paperclip/instances/default/data/run-logs/co-1/agent-id-test/run-test-123.pod.ndjson`,
      }),
      buildPodLogPath: vi.fn((companyId: string, agentId: string, runId: string) =>
        `/paperclip/instances/default/data/run-logs/${companyId}/${agentId}/${runId}.pod.ndjson`
      ),
      LARGE_PROMPT_THRESHOLD_BYTES: 256 * 1024,
    }));

    const fresh = await import("./execute.js");
    const k8s = await import("./k8s-client.js");
    const batchApi = makeBatchApi();
    const coreApi = makeCoreApi();
    vi.mocked(k8s.getBatchApi).mockReturnValue(batchApi as unknown as ReturnType<typeof k8s.getBatchApi>);
    vi.mocked(k8s.getCoreApi).mockReturnValue(coreApi as unknown as ReturnType<typeof k8s.getCoreApi>);

    let capturedHandler: (() => void) | null = null;
    const onceSpy = vi.spyOn(process, "once").mockImplementation(
      (event: string | symbol, handler: (...args: unknown[]) => void) => {
        if (event === "SIGTERM") capturedHandler = handler as () => void;
        return process;
      },
    );
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {}) as never);

    await fresh.execute(makeCtx());
    onceSpy.mockRestore();

    expect(capturedHandler).not.toBeNull();
    (capturedHandler as unknown as () => void)();
    // Wait long enough for the async handler body to settle
    await new Promise((r) => setTimeout(r, 50));
    expect(batchApi.deleteNamespacedJob).toHaveBeenCalled();
    expect(exitSpy).toHaveBeenCalled();

    exitSpy.mockRestore();
    vi.doUnmock("./k8s-client.js");
    vi.doUnmock("./job-manifest.js");
  });
});


// tailPodLogFile tests deferred — requires file-system module isolation
// not available in the shared test suite's vi.mock("node:fs/promises") setup

describe("mergeEnvironmentConfig — Phase E.2 helper", () => {
  it("returns adapter config unchanged when env config is undefined", () => {
    const adapter = { foo: "a", bar: 1 };
    expect(mergeEnvironmentConfig(adapter, undefined)).toEqual(adapter);
  });

  it("returns adapter config unchanged when env config is null", () => {
    const adapter = { foo: "a", bar: 1 };
    expect(mergeEnvironmentConfig(adapter, null)).toEqual(adapter);
  });

  it("env config wins for present fields", () => {
    const adapter = { namespace: "adapter-ns", foo: "a" };
    const env = { namespace: "env-ns" };
    expect(mergeEnvironmentConfig(adapter, env)).toEqual({ namespace: "env-ns", foo: "a" });
  });

  it("skips null/undefined env values (does not clobber adapter config)", () => {
    // Type as Record<string, unknown> — passing { namespace: null } where
    // namespace was string in adapter collapses the inferred A & E
    // intersection to `never` and breaks property access. The runtime
    // behavior we're testing is type-erased.
    const adapter: Record<string, unknown> = { namespace: "adapter-ns", workspaceVolumeClaim: "adapter-claim" };
    const env: Record<string, unknown> = { namespace: null, workspaceVolumeClaim: undefined, kubeconfig: "envcontent" };
    const merged = mergeEnvironmentConfig(adapter, env);
    expect(merged.namespace).toBe("adapter-ns");
    expect(merged.workspaceVolumeClaim).toBe("adapter-claim");
    expect(merged.kubeconfig).toBe("envcontent");
  });

  it("does not mutate either input", () => {
    const adapter = { a: 1 };
    const env = { a: 2 };
    const merged = mergeEnvironmentConfig(adapter, env);
    expect(adapter).toEqual({ a: 1 });
    expect(env).toEqual({ a: 2 });
    expect(merged).toEqual({ a: 2 });
  });
});

describe("execute — environment.config (Phase E.2)", () => {
  it("passes workspaceVolumeClaim from executionTarget to buildJobManifest", async () => {
    const ctx = makeCtx();
    (ctx as unknown as Record<string, unknown>).executionTarget = {
      kind: "remote",
      transport: "k8s",
      remoteCwd: "/paperclip",
      config: {
        kubeconfig: null,
        namespace: null,
        workspaceVolumeClaim: "env-claim-name",
        workspaceMountPath: null,
        secretsNamespace: null,
        nodeSelector: {},
        tolerations: [],
        labels: {},
        serviceAccountName: null,
        imagePullPolicy: null,
        resources: null,
      },
    };

    await execute(ctx);

    expect(buildJobManifest).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceVolumeClaim: "env-claim-name" }),
    );
  });

  it("passes workspaceMountPath from executionTarget to buildJobManifest", async () => {
    const ctx = makeCtx();
    (ctx as unknown as Record<string, unknown>).executionTarget = {
      kind: "remote",
      transport: "k8s",
      remoteCwd: "/workspace",
      config: {
        kubeconfig: null,
        namespace: null,
        workspaceVolumeClaim: null,
        workspaceMountPath: "/workspace",
        secretsNamespace: null,
        nodeSelector: {},
        tolerations: [],
        labels: {},
        serviceAccountName: null,
        imagePullPolicy: null,
        resources: null,
      },
    };

    await execute(ctx);

    expect(buildJobManifest).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceMountPath: "/workspace" }),
    );
  });

  it("environment namespace overrides adapter config namespace for downstream calls", async () => {
    const ctx = makeCtx({ namespace: "adapter-ns" });
    (ctx as unknown as Record<string, unknown>).executionTarget = {
      kind: "remote",
      transport: "k8s",
      remoteCwd: "/paperclip",
      config: {
        kubeconfig: null,
        namespace: "env-ns",
        workspaceVolumeClaim: null,
        workspaceMountPath: null,
        secretsNamespace: null,
        nodeSelector: {},
        tolerations: [],
        labels: {},
        serviceAccountName: null,
        imagePullPolicy: null,
        resources: null,
      },
    };

    await execute(ctx);

    // The buildJobManifest stub's ctx config should have been merged with env config
    const callArgs = vi.mocked(buildJobManifest).mock.calls[0]?.[0];
    expect(callArgs?.ctx.config.namespace).toBe("env-ns");
  });

  it("does not override config when executionTarget is local", async () => {
    const ctx = makeCtx({ namespace: "adapter-ns", workspaceVolumeClaim: "adapter-claim" });
    (ctx as unknown as Record<string, unknown>).executionTarget = { kind: "local" };

    await execute(ctx);

    const callArgs = vi.mocked(buildJobManifest).mock.calls[0]?.[0];
    expect(callArgs?.ctx.config.namespace).toBe("adapter-ns");
    // workspaceVolumeClaim from adapter config is NOT plumbed when target isn't k8s
    // (env-config wiring is gated on remote/k8s)
    expect(callArgs?.workspaceVolumeClaim).toBeUndefined();
  });

  it("works when executionTarget is absent (legacy path)", async () => {
    const ctx = makeCtx();
    // No executionTarget at all
    const result = await execute(ctx);
    expect(result.exitCode).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// captureContainerLogTail (BLO-10448 B): recover the failure cause when a pod
// exits non-zero but the live follow-stream captured nothing, so the opaque
// "Pod exited: Error (exit 1)" becomes self-explaining.
// ---------------------------------------------------------------------------
describe("captureContainerLogTail", () => {
  beforeEach(() => { vi.clearAllMocks(); });
  afterEach(() => { vi.restoreAllMocks(); });

  /** Log API mock that writes `payload` to the sink then ends, like Log.log. */
  function logApiWithPayload(payload: string) {
    return {
      log: vi.fn(async (_ns: string, _pod: string, _c: string, stream: import("node:stream").Writable) => {
        if (payload) stream.write(payload);
        stream.end();
        return { abort: vi.fn() } as unknown as AbortController;
      }),
    };
  }

  it("returns the container log tail (combined stdout+stderr) on a non-follow read", async () => {
    vi.mocked(getLogApi).mockReturnValue(
      logApiWithPayload("Traceback: boom\nfatal: config missing\n") as unknown as ReturnType<typeof getLogApi>,
    );
    const out = await captureContainerLogTail("ns", "pod-x", "opencode", { kubeconfigPath: "/kc" });
    expect(out).toContain("fatal: config missing");
    // non-follow read requested with a bounded tail
    const logFn = vi.mocked(getLogApi).mock.results[0].value.log;
    expect(logFn).toHaveBeenCalledWith("ns", "pod-x", "opencode", expect.anything(),
      expect.objectContaining({ follow: false, tailLines: 80, previous: false }));
  });

  it("passes previous:true through for the restarted-container retry", async () => {
    vi.mocked(getLogApi).mockReturnValue(
      logApiWithPayload("prev-instance crash\n") as unknown as ReturnType<typeof getLogApi>,
    );
    const out = await captureContainerLogTail("ns", "pod-x", "opencode", { previous: true });
    expect(out).toBe("prev-instance crash");
    const logFn = vi.mocked(getLogApi).mock.results[0].value.log;
    expect(logFn).toHaveBeenCalledWith("ns", "pod-x", "opencode", expect.anything(),
      expect.objectContaining({ previous: true }));
  });

  it("is best-effort: returns '' when the log API throws (never masks the failure)", async () => {
    vi.mocked(getLogApi).mockReturnValue({
      log: vi.fn(async () => { throw new Error("logs unavailable"); }),
    } as unknown as ReturnType<typeof getLogApi>);
    await expect(captureContainerLogTail("ns", "pod-x", "opencode")).resolves.toBe("");
  });
});
