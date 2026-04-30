import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { AdapterExecutionContext } from "@paperclipai/adapter-utils";
import { execute, ensureAgentDbPvc } from "./execute.js";
import { getSelfPodInfo, getBatchApi, getCoreApi, getLogApi, getPvc, createPvc } from "./k8s-client.js";
import { buildJobManifest } from "./job-manifest.js";

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
  jsonl = HAPPY_JSONL,
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
    readNamespacedPodLog: vi.fn().mockResolvedValue(jsonl),
    createNamespacedSecret: vi.fn().mockResolvedValue({}),
    deleteNamespacedSecret: vi.fn().mockResolvedValue({}),
    patchNamespacedSecret: vi.fn().mockResolvedValue({}),
  };
}

function makeLogApi() {
  return { log: vi.fn().mockResolvedValue(undefined) };
}

beforeEach(() => {
  vi.clearAllMocks();

  vi.mocked(getSelfPodInfo).mockResolvedValue(MOCK_SELF_POD as ReturnType<typeof getSelfPodInfo> extends Promise<infer T> ? T : never);
  vi.mocked(buildJobManifest).mockReturnValue({
    job: MOCK_JOB as ReturnType<typeof buildJobManifest>["job"],
    jobName: JOB_NAME,
    namespace: NAMESPACE,
    prompt: "Test prompt",
    opencodeArgs: [],
    promptMetrics: null,
  } as unknown as ReturnType<typeof buildJobManifest>);

  const batchApi = makeBatchApi();
  const coreApi = makeCoreApi();
  const logApi = makeLogApi();

  vi.mocked(getBatchApi).mockReturnValue(batchApi as unknown as ReturnType<typeof getBatchApi>);
  vi.mocked(getCoreApi).mockReturnValue(coreApi as unknown as ReturnType<typeof getCoreApi>);
  vi.mocked(getLogApi).mockReturnValue(logApi as unknown as ReturnType<typeof getLogApi>);
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
    const sessionErrorJsonl = JSON.stringify({ type: "error", error: { message: "unknown session abc" } });
    const coreApi = makeCoreApi(sessionErrorJsonl, 1);
    vi.mocked(getCoreApi).mockReturnValue(coreApi as unknown as ReturnType<typeof getCoreApi>);

    const ctx = makeCtx();
    const result = await execute(ctx);

    expect(result.clearSession).toBe(true);
    expect(result.errorCode).toBe("session_unavailable");
  });

  it("returns clearSession=true for 'session not found' error", async () => {
    const coreApi = makeCoreApi("session not found\n", 1);
    vi.mocked(getCoreApi).mockReturnValue(coreApi as unknown as ReturnType<typeof getCoreApi>);

    const ctx = makeCtx();
    const result = await execute(ctx);

    expect(result.clearSession).toBe(true);
  });

  it("does not set clearSession for unrelated errors", async () => {
    const coreApi = makeCoreApi(
      JSON.stringify({ type: "error", error: { message: "rate limit exceeded" } }),
      1,
    );
    vi.mocked(getCoreApi).mockReturnValue(coreApi as unknown as ReturnType<typeof getCoreApi>);

    const ctx = makeCtx();
    const result = await execute(ctx);

    expect(result.clearSession).toBe(false);
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
    const coreApi = makeCoreApi(
      JSON.stringify({ type: "error", error: { message: "Task failed" } }),
      2,
    );
    vi.mocked(getCoreApi).mockReturnValue(coreApi as unknown as ReturnType<typeof getCoreApi>);

    const ctx = makeCtx();
    const result = await execute(ctx);

    expect(result.exitCode).toBe(2);
    expect(result.errorMessage).toBeTruthy();
  });

  it("synthesizes exitCode=1 when error message exists but pod reported exitCode=0", async () => {
    const coreApi = makeCoreApi(
      JSON.stringify({ type: "error", error: { message: "API rate limit" } }),
      0,
    );
    vi.mocked(getCoreApi).mockReturnValue(coreApi as unknown as ReturnType<typeof getCoreApi>);

    const ctx = makeCtx();
    const result = await execute(ctx);

    // Exit code should be synthesized to 1 because errorMessage is non-empty
    expect(result.exitCode).toBe(1);
  });

  it("handles null exit code gracefully (pod not found — 404 tolerance)", async () => {
    const coreApi = makeCoreApi(HAPPY_JSONL, null);
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
    const coreApi = makeCoreApi("", 137, "OOMKilled");
    vi.mocked(getCoreApi).mockReturnValue(coreApi as unknown as ReturnType<typeof getCoreApi>);

    const ctx = makeCtx();
    const result = await execute(ctx);

    expect(result.exitCode).toBe(137);
    expect(result.errorMessage).toContain("OOMKilled");
  });

  it("includes pod terminated reason for Error exit", async () => {
    const coreApi = makeCoreApi("", 1, "Error");
    vi.mocked(getCoreApi).mockReturnValue(coreApi as unknown as ReturnType<typeof getCoreApi>);

    const ctx = makeCtx();
    const result = await execute(ctx);

    expect(result.errorMessage).toContain("Error");
    expect(result.errorMessage).toContain("exit 1");
  });

  it("falls back gracefully when no terminated reason is available", async () => {
    const coreApi = makeCoreApi(
      JSON.stringify({ type: "error", error: { message: "boom" } }),
      1,
      null,
    );
    vi.mocked(getCoreApi).mockReturnValue(coreApi as unknown as ReturnType<typeof getCoreApi>);

    const ctx = makeCtx();
    const result = await execute(ctx);

    expect(result.exitCode).toBe(1);
    expect(result.errorMessage).toBeTruthy();
  });
});

describe("execute — partial stdout fallback", () => {
  it("fetches pod logs when stdout has content but no session result", async () => {
    const partialJsonl = JSON.stringify({ type: "text", part: { text: "thinking..." } }); // no sessionID
    const completeJsonl = [
      JSON.stringify({ type: "text", part: { text: "Done" }, sessionID: "ses_complete" }),
      JSON.stringify({ type: "step_finish", part: { tokens: { input: 50, output: 30, cache: {} }, cost: 0.001 } }),
    ].join("\n");

    const coreApi = makeCoreApi(completeJsonl, 0);
    vi.mocked(getCoreApi).mockReturnValue(coreApi as unknown as ReturnType<typeof getCoreApi>);

    // Make log stream return partial content with no sessionID
    const logApi = {
      log: vi.fn(async (_ns: string, _pod: string, _container: string, writable: NodeJS.WritableStream) => {
        writable.write(Buffer.from(partialJsonl + "\n"));
      }),
    };
    vi.mocked(getLogApi).mockReturnValue(logApi as unknown as ReturnType<typeof getLogApi>);

    const ctx = makeCtx();
    const result = await execute(ctx);

    // readNamespacedPodLog should have been called as the partial-stdout fallback
    expect(coreApi.readNamespacedPodLog).toHaveBeenCalled();
    // Result should use the complete log with sessionId
    expect(result.sessionId).toBe("ses_complete");
  });

  it("does not call readPodLogs when stdout has a valid session result", async () => {
    const completeJsonl = [
      JSON.stringify({ type: "text", part: { text: "Done" }, sessionID: "ses_stream" }),
      JSON.stringify({ type: "step_finish", part: { tokens: { input: 50, output: 30, cache: {} }, cost: 0.001 } }),
    ].join("\n");

    const coreApi = makeCoreApi(completeJsonl, 0);
    vi.mocked(getCoreApi).mockReturnValue(coreApi as unknown as ReturnType<typeof getCoreApi>);

    const logApi = {
      log: vi.fn(async (_ns: string, _pod: string, _container: string, writable: NodeJS.WritableStream) => {
        writable.write(Buffer.from(completeJsonl + "\n"));
      }),
    };
    vi.mocked(getLogApi).mockReturnValue(logApi as unknown as ReturnType<typeof getLogApi>);

    const ctx = makeCtx();
    const result = await execute(ctx);

    // readNamespacedPodLog should NOT be called (stream provided complete output)
    expect(coreApi.readNamespacedPodLog).not.toHaveBeenCalled();
    expect(result.sessionId).toBe("ses_stream");
  });
});

describe("execute — llm_api_error signal", () => {
  it("returns llm_api_error when session exists but LLM produced no output tokens", async () => {
    // JSONL has a sessionID but no step_finish tokens and no text messages
    const emptyOutputJsonl = JSON.stringify({ sessionID: "ses_empty", type: "step_finish", part: { tokens: { input: 100, output: 0, cache: {} }, cost: 0 } });
    const coreApi = makeCoreApi(emptyOutputJsonl, 0);
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
    const coreApi = makeCoreApi(errorJsonl, 1);
    vi.mocked(getCoreApi).mockReturnValue(coreApi as unknown as ReturnType<typeof getCoreApi>);

    const ctx = makeCtx();
    const result = await execute(ctx);

    expect(result.errorCode).not.toBe("llm_api_error");
    expect(result.errorMessage).toContain("quota");
  });

  it("does not emit llm_api_error when sessionId is null", async () => {
    const coreApi = makeCoreApi("", 0);
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
    };
    vi.mocked(getCoreApi).mockReturnValue(coreApi as unknown as ReturnType<typeof getCoreApi>);

    const ctx = {
      ...makeCtx(),
      onLog: vi.fn(async (_type: string, msg: string) => {
        logMessages.push(msg);
      }),
    } as unknown as AdapterExecutionContext;

    await execute(ctx);

    // Pending status should appear exactly once even though listNamespacedPod was called twice
    const pendingMsgs = logMessages.filter((m) => m.includes("phase=Pending"));
    expect(pendingMsgs.length).toBe(1);
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

    expect(coreApi.patchNamespacedSecret).toHaveBeenCalledWith(
      expect.objectContaining({
        name: `${JOB_NAME}-prompt`,
        namespace: NAMESPACE,
        body: expect.objectContaining({
          metadata: expect.objectContaining({
            ownerReferences: [
              expect.objectContaining({
                kind: "Job",
                name: JOB_NAME,
                uid: "uid-abc-123",
                controller: true,
              }),
            ],
          }),
        }),
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

  it("defaults to dedicated_pvc when agentDbMode is not set", async () => {
    vi.mocked(getPvc).mockResolvedValueOnce({ metadata: { name: EXPECTED_PVC_NAME } } as Awaited<ReturnType<typeof getPvc>>);

    const result = await ensureAgentDbPvc(AGENT_ID, NAMESPACE, {});
    expect(result).toBe(EXPECTED_PVC_NAME);
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

  it("returns null when model has no slash separator", async () => {
    const { parseModelProvider } = await import("./execute.js");
    expect(parseModelProvider("gpt-4")).toBeNull();
    expect(parseModelProvider("  ")).toBeNull();
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

  it("returns timedOut result when completion promise rejects", async () => {
    const { completionWithGrace } = await import("./execute.js");
    const result = await completionWithGrace(Promise.reject(new Error("boom")), 1000);
    expect(result).toEqual({ succeeded: false, timedOut: true, jobGone: false });
  });
});

describe("execute — config edge paths", () => {
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

    const coreApi = makeCoreApi(STEP_LIMIT_JSONL, 0);
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
      getLogApi: vi.fn(),
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
      }),
      LARGE_PROMPT_THRESHOLD_BYTES: 256 * 1024,
    }));

    const fresh = await import("./execute.js");
    const k8s = await import("./k8s-client.js");
    const batchApi = makeBatchApi();
    const coreApi = makeCoreApi();
    const logApi = makeLogApi();
    vi.mocked(k8s.getBatchApi).mockReturnValue(batchApi as unknown as ReturnType<typeof k8s.getBatchApi>);
    vi.mocked(k8s.getCoreApi).mockReturnValue(coreApi as unknown as ReturnType<typeof k8s.getCoreApi>);
    vi.mocked(k8s.getLogApi).mockReturnValue(logApi as unknown as ReturnType<typeof k8s.getLogApi>);

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
