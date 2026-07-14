import { describe, it, expect, vi } from "vitest";
import { buildJobManifest, sanitizeLabelValue, type JobBuildInput } from "./job-manifest.js";

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    readFileSync: vi.fn((file: Parameters<typeof actual.readFileSync>[0], ...args: unknown[]) => {
      if (file === "/paperclip/.mcp.json") {
        throw new Error("test baseline absent");
      }
      return actual.readFileSync(file, ...(args as [Parameters<typeof actual.readFileSync>[1]]));
    }),
  };
});

const mockSelfPod: JobBuildInput["selfPod"] = {
  namespace: "paperclip",
  image: "paperclip/paperclip:latest",
  imagePullSecrets: [],
  nodeSelector: {},
  tolerations: [],
  inheritedEnv: {},
  inheritedEnvValueFrom: [],
  inheritedEnvFrom: [],
  pvcClaimName: null,
  dnsConfig: undefined,
  secretVolumes: [],
};

const mockCtx: JobBuildInput["ctx"] = {
  runId: "run123456",
  agent: { id: "agent-abc", name: "Test Agent", companyId: "co123", adapterType: null, adapterConfig: null },
  runtime: { sessionId: null, sessionParams: {}, sessionDisplayId: null, taskKey: null },
  config: {},
  context: {
    taskId: null,
    issueId: null,
    paperclipWorkspace: null,
    issueIds: null,
    paperclipWorkspaces: null,
    paperclipRuntimeServiceIntents: null,
    paperclipRuntimeServices: null,
  },
  onLog: async () => {},
};

describe("buildJobManifest — context-overflow auto-remediation (/compact prefix)", () => {
  // Pairs with parse.ts isOpenCodeContextOverflowResult + execute.ts which
  // sets sessionParams.needsCompactBeforeNextRun = true when overflow is
  // detected (or proactively when inputTokens > threshold). The next pod's
  // shell pipeline must invoke `/compact` against the prior session before
  // the real prompt so the context window has room.
  const sessionId = "ses_overflow_recovery";

  function getMainShellCommand(result: ReturnType<typeof buildJobManifest>) {
    const containers = result.job.spec?.template?.spec?.containers ?? [];
    const main = containers.find((c) => c.name === "opencode");
    const cmd = main?.command ?? [];
    // `command: ["sh", "-c", "<script>"]`
    return cmd[2] ?? "";
  }

  it("does NOT inject /compact when sessionParams.needsCompactBeforeNextRun is unset", () => {
    const ctx = {
      ...mockCtx,
      runtime: { sessionId, sessionParams: { sessionId }, sessionDisplayId: sessionId, taskKey: null },
    };
    const result = buildJobManifest({ ctx, selfPod: mockSelfPod });
    expect(getMainShellCommand(result)).not.toContain("/compact");
  });

  it("injects /compact before the main prompt when the flag is true", () => {
    const ctx = {
      ...mockCtx,
      runtime: {
        sessionId,
        sessionParams: { sessionId, needsCompactBeforeNextRun: true },
        sessionDisplayId: sessionId,
        taskKey: null,
      },
    };
    const result = buildJobManifest({ ctx, selfPod: mockSelfPod });
    const script = getMainShellCommand(result);
    // Compact step appears
    expect(script).toContain("echo '/compact' | opencode");
    expect(script).toContain(`--session' '${sessionId}'`);
    // Best-effort: trailing `|| echo ...` keeps the main run alive on failure
    expect(script).toMatch(/\/compact[\s\S]*\|\| echo "\[paperclip\] \/compact returned non-zero/);
    // /compact precedes the cat-of-prompt step (order matters)
    const compactIdx = script.indexOf("'/compact'");
    const promptIdx = script.indexOf("cat /tmp/prompt/prompt.txt");
    expect(compactIdx).toBeGreaterThan(-1);
    expect(promptIdx).toBeGreaterThan(compactIdx);
  });

  it("does NOT inject /compact when the flag is true but no session id exists (fresh-session case)", () => {
    // Without a session, /compact has nothing to compact. The detector in
    // execute.ts shouldn't set the flag in that case, but defend in depth.
    const ctx = {
      ...mockCtx,
      runtime: {
        sessionId: null,
        sessionParams: { needsCompactBeforeNextRun: true },
        sessionDisplayId: null,
        taskKey: null,
      },
    };
    const result = buildJobManifest({ ctx, selfPod: mockSelfPod });
    expect(getMainShellCommand(result)).not.toContain("/compact");
  });
});

describe("buildJobManifest", () => {
  it("creates job with agent-opencode- prefix in name", () => {
    const result = buildJobManifest({ ctx: mockCtx, selfPod: mockSelfPod });

    expect(result.jobName).toMatch(/^agent-opencode-/);
  });

  it("uses default image from selfPod", () => {
    const result = buildJobManifest({ ctx: mockCtx, selfPod: mockSelfPod });

    const container = result.job.spec?.template?.spec?.containers?.[0];
    expect(container?.image).toBe("paperclip/paperclip:latest");
  });

  it("uses config.image when provided, overriding selfPod image", () => {
    const ctxWithImage = {
      ...mockCtx,
      config: { image: "my-custom-image:v1.2.3" },
    };
    const result = buildJobManifest({ ctx: ctxWithImage, selfPod: mockSelfPod });

    const container = result.job.spec?.template?.spec?.containers?.[0];
    expect(container?.image).toBe("my-custom-image:v1.2.3");
  });

  it("sets the non-root uid and primary gid without requesting volume ownership changes", () => {
    const result = buildJobManifest({ ctx: mockCtx, selfPod: mockSelfPod });

    const securityContext = result.job.spec?.template?.spec?.securityContext;
    expect(securityContext?.runAsNonRoot).toBe(true);
    expect(securityContext?.runAsUser).toBe(1000);
    expect(securityContext?.runAsGroup).toBe(1000);
    expect(securityContext?.fsGroup).toBeUndefined();
    expect(securityContext?.fsGroupChangePolicy).toBeUndefined();
  });

  it("maps labels to job metadata", () => {
    const result = buildJobManifest({ ctx: mockCtx, selfPod: mockSelfPod });

    expect(result.job.metadata?.labels?.["app.kubernetes.io/managed-by"]).toBe("paperclip");
    expect(result.job.metadata?.labels?.["paperclip.io/adapter-type"]).toBe("opencode_k8s");
    expect(result.job.metadata?.labels?.["paperclip.io/agent-id"]).toBe("agent-abc");
    expect(result.job.metadata?.labels?.["paperclip.io/run-id"]).toBe("run123456");
  });

  it("sets paperclip.io/task-id label when context.taskId is present", () => {
    const ctx = {
      ...mockCtx,
      context: { ...mockCtx.context, taskId: "7e0829c0-cbf7-4652-9554-4d777ce84bff" },
    };
    const result = buildJobManifest({ ctx, selfPod: mockSelfPod });

    expect(result.job.metadata?.labels?.["paperclip.io/task-id"]).toBe("7e0829c0-cbf7-4652-9554-4d777ce84bff");
  });

  it("falls back to context.issueId for paperclip.io/task-id when taskId is null", () => {
    const ctx = {
      ...mockCtx,
      context: { ...mockCtx.context, taskId: null, issueId: "issue-uuid-xyz" },
    };
    const result = buildJobManifest({ ctx, selfPod: mockSelfPod });

    expect(result.job.metadata?.labels?.["paperclip.io/task-id"]).toBe("issue-uuid-xyz");
  });

  it("omits paperclip.io/task-id label when context.taskId and issueId are both null", () => {
    const result = buildJobManifest({ ctx: mockCtx, selfPod: mockSelfPod });

    expect(result.job.metadata?.labels?.["paperclip.io/task-id"]).toBeUndefined();
  });

  it("sets paperclip.io/session-id label when runtime.sessionParams.sessionId is present", () => {
    const ctx = {
      ...mockCtx,
      runtime: { ...mockCtx.runtime, sessionParams: { sessionId: "ses_abc123" } },
    };
    const result = buildJobManifest({ ctx, selfPod: mockSelfPod });

    expect(result.job.metadata?.labels?.["paperclip.io/session-id"]).toBe("ses_abc123");
  });

  it("omits paperclip.io/session-id label when no session exists", () => {
    const result = buildJobManifest({ ctx: mockCtx, selfPod: mockSelfPod });

    expect(result.job.metadata?.labels?.["paperclip.io/session-id"]).toBeUndefined();
  });

  it("creates init container for prompt", () => {
    const result = buildJobManifest({ ctx: mockCtx, selfPod: mockSelfPod });

    const initContainers = result.job.spec?.template?.spec?.initContainers;
    expect(initContainers?.length).toBe(1);
    expect(initContainers?.[0].name).toBe("write-prompt");
    expect(initContainers?.[0].image).toBe("busybox:1.36");
  });

  it("sets HOME to /paperclip", () => {
    const result = buildJobManifest({ ctx: mockCtx, selfPod: mockSelfPod });

    const env = result.job.spec?.template?.spec?.containers?.[0].env ?? [];
    const homeEnv = env.find((e) => e.name === "HOME");
    expect(homeEnv?.value).toBe("/paperclip");
  });

  it("uses server-supplied isolated roots for HOME, caches, workdir, labels, and pod logs", () => {
    const ctx = {
      ...mockCtx,
      context: {
        ...mockCtx.context,
        taskId: "task-123",
        k8sRunIsolation: {
          isolationMode: "isolated",
          isolationKey: "co123:agent-abc:task-123",
          workspaceRoot: "/paperclip/isolated/task-123/workspace",
          homeRoot: "/paperclip/isolated/task-123/home",
          cacheRoot: "/paperclip/isolated/task-123/cache",
          sessionScope: "co123:agent-abc:task-123",
        },
      },
    };

    const result = buildJobManifest({ ctx, selfPod: mockSelfPod });
    const labels = result.job.metadata?.labels ?? {};
    const container = result.job.spec?.template?.spec?.containers?.[0];
    const env = container?.env ?? [];
    const envValue = (name: string) => env.find((e) => e.name === name)?.value;

    expect(labels["paperclip.io/isolation-mode"]).toBe("isolated");
    expect(labels["paperclip.io/isolation-key-hash"]).toMatch(/^[0-9a-f]{16}$/);
    expect(container?.workingDir).toBe("/paperclip/isolated/task-123/workspace");
    expect(envValue("HOME")).toBe("/paperclip/isolated/task-123/home");
    expect(envValue("XDG_CACHE_HOME")).toBe("/paperclip/isolated/task-123/cache/xdg");
    expect(envValue("PAPERCLIP_K8S_ISOLATION_KEY")).toBe("co123:agent-abc:task-123");
    expect(result.podLogPath).toBe("/paperclip/isolated/task-123/cache/run-logs/run123456.pod.ndjson");
  });

  it("falls back to shared mode when isolation metadata is incomplete", () => {
    const ctx = {
      ...mockCtx,
      context: {
        ...mockCtx.context,
        k8sRunIsolation: { isolationMode: "isolated" },
      },
    };

    const result = buildJobManifest({ ctx, selfPod: mockSelfPod });
    const labels = result.job.metadata?.labels ?? {};
    const env = result.job.spec?.template?.spec?.containers?.[0].env ?? [];

    expect(labels["paperclip.io/isolation-mode"]).toBe("shared");
    expect(labels["paperclip.io/isolation-key-hash"]).toBeUndefined();
    expect(env.find((e) => e.name === "HOME")?.value).toBe("/paperclip");
  });

  it("sets OPENCODE_DISABLE_PROJECT_CONFIG=true", () => {
    const result = buildJobManifest({ ctx: mockCtx, selfPod: mockSelfPod });

    const env = result.job.spec?.template?.spec?.containers?.[0].env ?? [];
    const opencodeEnv = env.find((e) => e.name === "OPENCODE_DISABLE_PROJECT_CONFIG");
    expect(opencodeEnv?.value).toBe("true");
  });

  // The base paperclip image bakes NODE_ENV=production. In an agent workspace
  // that breaks `npm install`/`npm ci` (devDependencies omitted), so source
  // builds that need dev tooling fail to bootstrap (e.g. shaka's
  // closure-make-deps). Agent jobs do dev/build work, so default them to a
  // non-production NODE_ENV. See BLO-8661.
  it("defaults NODE_ENV to development so agent npm installs include devDependencies", () => {
    const result = buildJobManifest({ ctx: mockCtx, selfPod: mockSelfPod });

    const env = result.job.spec?.template?.spec?.containers?.[0].env ?? [];
    const nodeEnv = env.find((e) => e.name === "NODE_ENV");
    expect(nodeEnv?.value).toBe("development");
  });

  it("lets config.env override the default NODE_ENV", () => {
    const ctx = { ...mockCtx, config: { env: { NODE_ENV: "production" } } };
    const result = buildJobManifest({ ctx, selfPod: mockSelfPod });

    const env = result.job.spec?.template?.spec?.containers?.[0].env ?? [];
    const nodeEnv = env.find((e) => e.name === "NODE_ENV");
    expect(nodeEnv?.value).toBe("production");
  });

  it("respects NODE_ENV inherited from the Deployment env", () => {
    const selfPod = { ...mockSelfPod, inheritedEnv: { NODE_ENV: "staging" } };
    const result = buildJobManifest({ ctx: mockCtx, selfPod });

    const env = result.job.spec?.template?.spec?.containers?.[0].env ?? [];
    const nodeEnv = env.find((e) => e.name === "NODE_ENV");
    expect(nodeEnv?.value).toBe("staging");
  });

  it("keeps agent cache dirs under the job-local runtime-cache emptyDir (PEN-389)", () => {
    // The server pod also points its cache env at /runtime-cache. Agent Jobs now
    // mount their own emptyDir there instead of rebasing caches onto the PVC.
    const selfPod = {
      ...mockSelfPod,
      inheritedEnv: {
        BUN_INSTALL_CACHE: "/runtime-cache/bun",
        XDG_CACHE_HOME: "/runtime-cache/xdg",
        GOCACHE: "/runtime-cache/go-build",
        GOMODCACHE: "/runtime-cache/gomod",
        npm_config_cache: "/runtime-cache/npm",
        PIP_CACHE_DIR: "/runtime-cache/pip",
        PLAYWRIGHT_BROWSERS_PATH: "/runtime-cache/ms-playwright",
        TMPDIR: "/runtime-cache/tmp",
      },
    };
    const result = buildJobManifest({ ctx: mockCtx, selfPod });
    const env = result.job.spec?.template?.spec?.containers?.[0].env ?? [];
    const val = (name: string) => env.find((e) => e.name === name)?.value;

    expect(val("BUN_INSTALL_CACHE")).toBe("/runtime-cache/bun");
    expect(val("XDG_CACHE_HOME")).toBe("/runtime-cache/xdg");
    expect(val("GOCACHE")).toBe("/runtime-cache/go-build");
    expect(val("TMPDIR")).toBe("/runtime-cache/tmp");
    expect(val("PLAYWRIGHT_BROWSERS_PATH")).toBe("/runtime-cache/ms-playwright");
  });

  it("reserves opencode XDG config/data/state onto runtime-cache so it can't crash at boot (BLO-14003)", () => {
    // opencode mkdir's its XDG config/data/state dirs at startup; if they land
    // on an unwritable path it dies with EACCES before any model call. Reserve
    // them onto the writable runtime-cache emptyDir, matching the values that
    // were applied as a per-agent env workaround and verified booting clean.
    const result = buildJobManifest({ ctx: mockCtx, selfPod: mockSelfPod });
    const env = result.job.spec?.template?.spec?.containers?.[0].env ?? [];
    const val = (name: string) => env.find((e) => e.name === name)?.value;

    expect(val("XDG_CONFIG_HOME")).toBe("/runtime-cache/xdg/config");
    expect(val("XDG_DATA_HOME")).toBe("/runtime-cache/xdg/data");
    expect(val("XDG_STATE_HOME")).toBe("/runtime-cache/xdg/state");
    // still under the same writable mount as the cache leaf
    expect(val("XDG_CACHE_HOME")).toBe("/runtime-cache/xdg");
  });

  it("forces opencode XDG dirs onto runtime-cache even when adapterConfig.env sets stale unwritable paths (BLO-14003)", () => {
    const ctx = {
      ...mockCtx,
      config: {
        env: {
          XDG_CONFIG_HOME: "/runtime-config",
          XDG_DATA_HOME: "/runtime-data",
          XDG_STATE_HOME: "/runtime-state",
        },
      },
    };
    const result = buildJobManifest({ ctx, selfPod: mockSelfPod });
    const env = result.job.spec?.template?.spec?.containers?.[0].env ?? [];
    const val = (name: string) => env.find((e) => e.name === name)?.value;

    expect(val("XDG_CONFIG_HOME")).toBe("/runtime-cache/xdg/config");
    expect(val("XDG_DATA_HOME")).toBe("/runtime-cache/xdg/data");
    expect(val("XDG_STATE_HOME")).toBe("/runtime-cache/xdg/state");
  });

  it("keeps reserved cache envs on runtime-cache even when adapterConfig.env has stale PVC overrides", () => {
    const ctx = {
      ...mockCtx,
      config: {
        env: {
          BUN_INSTALL_CACHE: "/paperclip/.runtime-cache/bun",
          XDG_CACHE_HOME: "/paperclip/.runtime-cache/xdg",
          GOCACHE: "/paperclip/.runtime-cache/go-build",
          TMPDIR: "/paperclip/.runtime-cache/tmp",
        },
      },
    };
    const selfPod = {
      ...mockSelfPod,
      inheritedEnv: { BUN_INSTALL_CACHE: "/runtime-cache/bun" },
    };
    const result = buildJobManifest({ ctx, selfPod });
    const env = result.job.spec?.template?.spec?.containers?.[0].env ?? [];
    const val = (name: string) => env.find((e) => e.name === name)?.value;

    expect(val("BUN_INSTALL_CACHE")).toBe("/runtime-cache/bun");
    expect(val("XDG_CACHE_HOME")).toBe("/runtime-cache/xdg");
    expect(val("GOCACHE")).toBe("/runtime-cache/go-build");
    expect(val("TMPDIR")).toBe("/runtime-cache/tmp");
  });

  it("applies default ttlSecondsAfterFinished of 300", () => {
    const result = buildJobManifest({ ctx: mockCtx, selfPod: mockSelfPod });

    expect(result.job.spec?.ttlSecondsAfterFinished).toBe(300);
  });

  it("sets backoffLimit to 0", () => {
    const result = buildJobManifest({ ctx: mockCtx, selfPod: mockSelfPod });

    expect(result.job.spec?.backoffLimit).toBe(0);
  });

  it("uses job template restartPolicy Never", () => {
    const result = buildJobManifest({ ctx: mockCtx, selfPod: mockSelfPod });

    expect(result.job.spec?.template?.spec?.restartPolicy).toBe("Never");
  });

  it("applies nodeSelector from key=value textarea string", () => {
    const ctx = { ...mockCtx, config: { nodeSelector: "kubernetes.io/arch=amd64\nkubernetes.io/os=linux" } };
    const result = buildJobManifest({ ctx, selfPod: mockSelfPod });

    expect(result.job.spec?.template?.spec?.nodeSelector).toEqual({
      "kubernetes.io/arch": "amd64",
      "kubernetes.io/os": "linux",
    });
  });

  it("applies nodeSelector from JSON object string", () => {
    const ctx = { ...mockCtx, config: { nodeSelector: '{"node-type":"gpu"}' } };
    const result = buildJobManifest({ ctx, selfPod: mockSelfPod });

    expect(result.job.spec?.template?.spec?.nodeSelector).toEqual({ "node-type": "gpu" });
  });

  it("applies nodeSelector from plain object config", () => {
    const ctx = { ...mockCtx, config: { nodeSelector: { "zone": "us-east-1" } } };
    const result = buildJobManifest({ ctx, selfPod: mockSelfPod });

    expect(result.job.spec?.template?.spec?.nodeSelector).toEqual({ zone: "us-east-1" });
  });

  it("inherits nodeSelector from the paperclip pod by default", () => {
    const selfPod = { ...mockSelfPod, nodeSelector: { workload: "paperclip" } };
    const result = buildJobManifest({ ctx: mockCtx, selfPod });

    expect(result.job.spec?.template?.spec?.nodeSelector).toEqual({ workload: "paperclip" });
  });

  it("inherits tolerations from the paperclip pod by default", () => {
    const inherited = [{ key: "dedicated", operator: "Equal", value: "paperclip", effect: "NoSchedule" }];
    const selfPod = { ...mockSelfPod, tolerations: inherited };
    const result = buildJobManifest({ ctx: mockCtx, selfPod });

    expect(result.job.spec?.template?.spec?.tolerations).toEqual(inherited);
  });

  it("allows explicit empty scheduling config to opt out of inherited scheduling", () => {
    const selfPod = {
      ...mockSelfPod,
      nodeSelector: { workload: "paperclip" },
      tolerations: [{ key: "dedicated", operator: "Equal", value: "paperclip", effect: "NoSchedule" }],
    };
    const ctx = { ...mockCtx, config: { nodeSelector: "", tolerations: [] } };
    const result = buildJobManifest({ ctx, selfPod });

    expect(result.job.spec?.template?.spec?.nodeSelector).toBeUndefined();
    expect(result.job.spec?.template?.spec?.tolerations).toBeUndefined();
  });

  it("ignores blank lines and comments in nodeSelector textarea", () => {
    const ctx = {
      ...mockCtx,
      config: { nodeSelector: "# comment\n\nkubernetes.io/arch=amd64\n" },
    };
    const result = buildJobManifest({ ctx, selfPod: mockSelfPod });

    expect(result.job.spec?.template?.spec?.nodeSelector).toEqual({ "kubernetes.io/arch": "amd64" });
  });

  it("forwards inheritedEnvValueFrom entries onto the opencode container env", () => {
    const selfPod = {
      ...mockSelfPod,
      inheritedEnvValueFrom: [
        { name: "MY_SECRET", valueFrom: { secretKeyRef: { name: "my-secret", key: "token" } } },
      ],
    };
    const result = buildJobManifest({ ctx: mockCtx, selfPod });

    const env = result.job.spec?.template?.spec?.containers?.[0].env ?? [];
    const secretEnv = env.find((e) => e.name === "MY_SECRET");
    expect(secretEnv?.valueFrom?.secretKeyRef?.name).toBe("my-secret");
    expect(secretEnv?.valueFrom?.secretKeyRef?.key).toBe("token");
  });

  it("does not duplicate an inheritedEnvValueFrom entry if the name is already set as a literal", () => {
    const selfPod = {
      ...mockSelfPod,
      inheritedEnv: { HOME: "/custom" },
      inheritedEnvValueFrom: [
        { name: "HOME", valueFrom: { secretKeyRef: { name: "s", key: "k" } } },
      ],
    };
    const result = buildJobManifest({ ctx: mockCtx, selfPod });

    const env = result.job.spec?.template?.spec?.containers?.[0].env ?? [];
    const homeEntries = env.filter((e) => e.name === "HOME");
    // HOME is overridden by merged (HOME=/paperclip hardcoded last), so valueFrom must not appear
    expect(homeEntries.every((e) => e.value !== undefined)).toBe(true);
  });

  it("forwards inheritedEnvFrom onto the opencode container envFrom", () => {
    const selfPod = {
      ...mockSelfPod,
      inheritedEnvFrom: [{ secretRef: { name: "my-config-secret" } }],
    };
    const result = buildJobManifest({ ctx: mockCtx, selfPod });

    const container = result.job.spec?.template?.spec?.containers?.[0];
    expect(container?.envFrom).toEqual([{ secretRef: { name: "my-config-secret" } }]);
  });

  it("omits envFrom when inheritedEnvFrom is empty", () => {
    const result = buildJobManifest({ ctx: mockCtx, selfPod: mockSelfPod });

    const container = result.job.spec?.template?.spec?.containers?.[0];
    expect(container?.envFrom).toBeUndefined();
  });

  it("job name includes 6-char hash suffix", () => {
    const result = buildJobManifest({ ctx: mockCtx, selfPod: mockSelfPod });

    // format: agent-opencode-{agentSlug}-{runSlug}-{6hexchars}
    expect(result.jobName).toMatch(/^agent-opencode-[a-z0-9-]+-[a-f0-9]{6}$/);
  });

  it("job name has no trailing hyphens even when slug sanitization creates them", () => {
    const ctx = {
      ...mockCtx,
      agent: { ...mockCtx.agent, id: "agent---" },
      runId: "run---",
    };
    const result = buildJobManifest({ ctx, selfPod: mockSelfPod });

    expect(result.jobName).not.toMatch(/-$/);
  });

  it("label values are sanitized to [a-z0-9._-]", () => {
    const ctx = {
      ...mockCtx,
      agent: { ...mockCtx.agent, id: "agent-id-123", companyId: "company-456" },
      runId: "run-789",
    };
    const result = buildJobManifest({ ctx, selfPod: mockSelfPod });

    const labels = result.job.metadata?.labels ?? {};
    expect(labels["paperclip.io/agent-id"]).toMatch(/^[a-z0-9._-]*$/);
    expect(labels["paperclip.io/run-id"]).toMatch(/^[a-z0-9._-]*$/);
    expect(labels["paperclip.io/company-id"]).toMatch(/^[a-z0-9._-]*$/);
  });

  it("same agent+run always produces the same job name (deterministic hash)", () => {
    const r1 = buildJobManifest({ ctx: mockCtx, selfPod: mockSelfPod });
    const r2 = buildJobManifest({ ctx: mockCtx, selfPod: mockSelfPod });

    expect(r1.jobName).toBe(r2.jobName);
  });

  it("different runIds produce different job names", () => {
    const ctx2 = { ...mockCtx, runId: "run-different-999" };
    const r1 = buildJobManifest({ ctx: mockCtx, selfPod: mockSelfPod });
    const r2 = buildJobManifest({ ctx: ctx2, selfPod: mockSelfPod });

    expect(r1.jobName).not.toBe(r2.jobName);
  });
});

describe("agentDbClaimName — OPENCODE_DB env var", () => {
  it("sets OPENCODE_DB to /opencode-db/opencode.db when agentDbClaimName is a string (dedicated PVC)", () => {
    const result = buildJobManifest({ ctx: mockCtx, selfPod: mockSelfPod, agentDbClaimName: "opencode-db-agent-abc" });
    const env = result.job.spec?.template?.spec?.containers?.[0].env ?? [];
    expect(env.find((e) => e.name === "OPENCODE_DB")?.value).toBe("/opencode-db/opencode.db");
  });

  it("sets OPENCODE_DB to /opencode-db/opencode.db when agentDbClaimName is null (ephemeral)", () => {
    const result = buildJobManifest({ ctx: mockCtx, selfPod: mockSelfPod, agentDbClaimName: null });
    const env = result.job.spec?.template?.spec?.containers?.[0].env ?? [];
    expect(env.find((e) => e.name === "OPENCODE_DB")?.value).toBe("/opencode-db/opencode.db");
  });

  it("does not set OPENCODE_DB when agentDbClaimName is undefined", () => {
    const result = buildJobManifest({ ctx: mockCtx, selfPod: mockSelfPod });
    const env = result.job.spec?.template?.spec?.containers?.[0].env ?? [];
    expect(env.find((e) => e.name === "OPENCODE_DB")).toBeUndefined();
  });

  it("replaces a user-provided OPENCODE_DB env override with /opencode-db/opencode.db", () => {
    const selfPod = { ...mockSelfPod, inheritedEnv: { OPENCODE_DB: "/user/override" } };
    const result = buildJobManifest({ ctx: mockCtx, selfPod, agentDbClaimName: "opencode-db-agent-abc" });
    const env = result.job.spec?.template?.spec?.containers?.[0].env ?? [];
    const dbEntries = env.filter((e) => e.name === "OPENCODE_DB");
    expect(dbEntries).toHaveLength(1);
    expect(dbEntries[0].value).toBe("/opencode-db/opencode.db");
  });
});

describe("agentDbClaimName — volume wiring", () => {
  it("mounts dedicated PVC at /opencode-db when agentDbClaimName is a string", () => {
    const result = buildJobManifest({ ctx: mockCtx, selfPod: mockSelfPod, agentDbClaimName: "opencode-db-agent-abc" });
    const volumes = result.job.spec?.template?.spec?.volumes ?? [];
    const dbVol = volumes.find((v) => v.name === "opencode-db");
    expect(dbVol?.persistentVolumeClaim?.claimName).toBe("opencode-db-agent-abc");

    const mounts = result.job.spec?.template?.spec?.containers?.[0].volumeMounts ?? [];
    expect(mounts.find((m) => m.name === "opencode-db")?.mountPath).toBe("/opencode-db");
  });

  it("mounts emptyDir at /opencode-db when agentDbClaimName is null (ephemeral)", () => {
    const result = buildJobManifest({ ctx: mockCtx, selfPod: mockSelfPod, agentDbClaimName: null });
    const volumes = result.job.spec?.template?.spec?.volumes ?? [];
    const dbVol = volumes.find((v) => v.name === "opencode-db");
    expect(dbVol?.emptyDir).toBeDefined();
    expect(dbVol?.persistentVolumeClaim).toBeUndefined();

    const mounts = result.job.spec?.template?.spec?.containers?.[0].volumeMounts ?? [];
    expect(mounts.find((m) => m.name === "opencode-db")?.mountPath).toBe("/opencode-db");
  });

  it("does not add opencode-db volume when agentDbClaimName is undefined", () => {
    const result = buildJobManifest({ ctx: mockCtx, selfPod: mockSelfPod });
    const volumes = result.job.spec?.template?.spec?.volumes ?? [];
    expect(volumes.find((v) => v.name === "opencode-db")).toBeUndefined();
  });
});

describe("agentDbWorkspaceSubPath — workspace_subpath mode", () => {
  // workspace_subpath needs a workspace data volume to live under, so these
  // tests give selfPod a pvcClaimName.
  const selfPodWithPvc = { ...mockSelfPod, pvcClaimName: "paperclip-data" };

  it("sets OPENCODE_DB to /opencode-db/opencode.db when agentDbWorkspaceSubPath is set", () => {
    const result = buildJobManifest({
      ctx: mockCtx,
      selfPod: selfPodWithPvc,
      agentDbWorkspaceSubPath: ".opencode-db/co123/agent-abc/__heartbeat__",
    });
    const env = result.job.spec?.template?.spec?.containers?.[0].env ?? [];
    expect(env.find((e) => e.name === "OPENCODE_DB")?.value).toBe("/opencode-db/opencode.db");
  });

  it("mounts /opencode-db on the data volume at the given subPath without adding a new volume", () => {
    const result = buildJobManifest({
      ctx: mockCtx,
      selfPod: selfPodWithPvc,
      agentDbWorkspaceSubPath: ".opencode-db/co123/agent-abc/issue-uuid",
    });
    const volumes = result.job.spec?.template?.spec?.volumes ?? [];
    expect(volumes.find((v) => v.name === "opencode-db")).toBeUndefined();

    const mounts = result.job.spec?.template?.spec?.containers?.[0].volumeMounts ?? [];
    const dbMount = mounts.find((m) => m.mountPath === "/opencode-db");
    expect(dbMount).toBeDefined();
    expect(dbMount?.name).toBe("data");
    expect(dbMount?.subPath).toBe(".opencode-db/co123/agent-abc/issue-uuid");
  });

  it("throws when agentDbClaimName and agentDbWorkspaceSubPath are both set", () => {
    expect(() =>
      buildJobManifest({
        ctx: mockCtx,
        selfPod: selfPodWithPvc,
        agentDbClaimName: "opencode-db-agent-abc",
        agentDbWorkspaceSubPath: ".opencode-db/co123/agent-abc/__heartbeat__",
      }),
    ).toThrow(/mutually exclusive/);
  });

  it("throws when agentDbWorkspaceSubPath is set without a workspace data volume", () => {
    expect(() =>
      buildJobManifest({
        ctx: mockCtx,
        selfPod: mockSelfPod, // pvcClaimName: null
        agentDbWorkspaceSubPath: ".opencode-db/co123/agent-abc/__heartbeat__",
      }),
    ).toThrow(/requires a workspace data volume/);
  });
});

describe("init container is unchanged by agentDbClaimName", () => {
  it("does not add extra env vars to init container for dedicated PVC mode", () => {
    const result = buildJobManifest({ ctx: mockCtx, selfPod: mockSelfPod, agentDbClaimName: "opencode-db-agent-abc" });
    const initCmd = result.job.spec?.template?.spec?.initContainers?.[0].command;
    // init container only writes the prompt; no mkdir (log dir exists on PVC) and no OPENCODE_DB_PATH env var
    expect(initCmd?.[2]).not.toContain("mkdir");
    expect(initCmd?.[2]).toContain("/tmp/prompt/prompt.txt");
    const initEnv = result.job.spec?.template?.spec?.initContainers?.[0].env ?? [];
    expect(initEnv.some((e) => e.name === "OPENCODE_DB_PATH")).toBe(false);
  });

  it("does not add PVC mount to init container for dedicated PVC mode", () => {
    const result = buildJobManifest({ ctx: mockCtx, selfPod: mockSelfPod, agentDbClaimName: "opencode-db-agent-abc" });
    const initMounts = result.job.spec?.template?.spec?.initContainers?.[0].volumeMounts ?? [];
    expect(initMounts.some((m) => m.name === "opencode-db")).toBe(false);
  });
});

describe("opencode-db schema-compat reset guard", () => {
  function mainScript(result: ReturnType<typeof buildJobManifest>) {
    const main = (result.job.spec?.template?.spec?.containers ?? []).find((c) => c.name === "opencode");
    return main?.command?.[2] ?? "";
  }

  it("injects the version-stamped reset guard when an agent DB is mounted", () => {
    const result = buildJobManifest({ ctx: mockCtx, selfPod: mockSelfPod, agentDbClaimName: "opencode-db-agent-abc" });
    const script = mainScript(result);
    expect(script).toContain("opencode --version");
    expect(script).toContain(".opencode-version");
    expect(script).toContain('rm -f "$__ocdb" "$__ocdb-shm" "$__ocdb-wal"');
    // Guard must run BEFORE the prompt is piped into opencode, so a stale-schema
    // DB is reset before any session insert is attempted.
    expect(script.indexOf(".opencode-version")).toBeLessThan(script.indexOf("cat /tmp/prompt/prompt.txt"));
    expect(script.indexOf(".opencode-version")).toBeGreaterThan(-1);
  });

  it("only resets on a version change (guarded by .opencode-version comparison, not unconditional)", () => {
    const script = mainScript(
      buildJobManifest({ ctx: mockCtx, selfPod: mockSelfPod, agentDbClaimName: "opencode-db-agent-abc" }),
    );
    // The rm is inside a `[ "$__ocver" != "$__ocprev" ]` branch — never a bare wipe.
    expect(script).toContain('"$__ocver" != "$__ocprev"');
  });

  it("resets unchanged DBs when main DB plus WAL/SHM exceeds 500 MiB", () => {
    const script = mainScript(
      buildJobManifest({ ctx: mockCtx, selfPod: mockSelfPod, agentDbClaimName: "opencode-db-agent-abc" }),
    );
    expect(script).toContain("524288000");
    expect(script).toContain('for __ocf in "$__ocdb" "$__ocdb-wal" "$__ocdb-shm"');
    expect(script).toContain('wc -c < "$__ocf"');
    expect(script).toContain('"$__ocbytes" -gt 524288000');
    expect(script).toContain("to cap growth");
    expect(script.indexOf('"$__ocver" != "$__ocprev"')).toBeLessThan(script.indexOf('"$__ocbytes" -gt 524288000'));
  });

  it("does NOT inject the guard when no agent DB is mounted", () => {
    const result = buildJobManifest({ ctx: mockCtx, selfPod: mockSelfPod });
    expect(mainScript(result)).not.toContain(".opencode-version");
    expect(mainScript(result)).not.toContain("524288000");
  });
});

describe("sanitizeLabelValue", () => {
  it("passes through clean values unchanged", () => {
    expect(sanitizeLabelValue("abc-123")).toBe("abc-123");
    expect(sanitizeLabelValue("foo.bar_baz")).toBe("foo.bar_baz");
  });

  it("lowercases uppercase letters", () => {
    expect(sanitizeLabelValue("MyAgent")).toBe("myagent");
  });

  it("strips chars outside [a-z0-9._-]", () => {
    expect(sanitizeLabelValue("agent/id:test@v1")).toBe("agentidtestv1");
  });

  it("truncates to 63 chars", () => {
    const long = "a".repeat(80);
    expect(sanitizeLabelValue(long)).toHaveLength(63);
  });

  it("calls warn when chars are dropped", () => {
    const warned: string[] = [];
    sanitizeLabelValue("agent/id", (msg) => warned.push(msg));
    expect(warned.length).toBe(1);
    expect(warned[0]).toContain("agent/id");
  });

  it("does not call warn when nothing is dropped", () => {
    const warned: string[] = [];
    sanitizeLabelValue("clean-value.123", (msg) => warned.push(msg));
    expect(warned.length).toBe(0);
  });

  it("does not call warn when the only change is truncation to exactly 63", () => {
    const warned: string[] = [];
    // 63 chars all lowercase clean — no warn expected
    sanitizeLabelValue("a".repeat(63), (msg) => warned.push(msg));
    expect(warned.length).toBe(0);
  });

  it("calls warn when value contains invalid chars even if truncated result looks clean", () => {
    const warned: string[] = [];
    // 'a/b' repeated — '/' is stripped, so sanitized differs from lower.slice(0,63)
    sanitizeLabelValue("a/b".repeat(25), (msg) => warned.push(msg));
    expect(warned.length).toBe(1);
  });
});

describe("buildJobManifest — env wiring branches", () => {
  it("sets PAPERCLIP_WAKE_PAYLOAD_JSON when paperclipWake is provided", () => {
    const ctx = { ...mockCtx, context: { ...mockCtx.context, paperclipWake: { reason: "issue_assigned", issue: { id: "x" } } } };
    const result = buildJobManifest({ ctx, selfPod: mockSelfPod });
    const env = result.job.spec?.template.spec?.containers[0]?.env ?? [];
    expect(env.find((e) => e.name === "PAPERCLIP_WAKE_PAYLOAD_JSON")?.value).toBeTruthy();
  });

  it("forwards workspace context and AGENT_HOME from paperclipWorkspace", () => {
    const ctx = {
      ...mockCtx,
      context: {
        ...mockCtx.context,
        paperclipWorkspace: {
          cwd: "/work",
          source: "main",
          strategy: "shared",
          workspaceId: "ws_1",
          repoUrl: "https://example.com/r.git",
          repoRef: "main",
          branchName: "feature/x",
          worktreePath: "/wt/x",
          agentHome: "/home/agent",
        },
      },
    };
    const result = buildJobManifest({ ctx, selfPod: mockSelfPod });
    const env = result.job.spec?.template.spec?.containers[0]?.env ?? [];
    expect(env.find((e) => e.name === "PAPERCLIP_WORKSPACE_CWD")?.value).toBe("/work");
    expect(env.find((e) => e.name === "PAPERCLIP_WORKSPACE_BRANCH")?.value).toBe("feature/x");
    expect(env.find((e) => e.name === "AGENT_HOME")?.value).toBe("/home/agent");
  });

  it("points AGENT_HOME at instructionsRootPath for an external instructions bundle (companions resolve)", () => {
    const ctx = {
      ...mockCtx,
      config: {
        instructionsBundleMode: "external",
        instructionsRootPath: "/paperclip/.paperclip/instances/default/companies/Penstock/agents/devops",
        instructionsEntryFile: "AGENTS.md",
      },
      context: {
        ...mockCtx.context,
        // server pointed agentHome at the per-task workspace (the broken default
        // that made every `Read $AGENT_HOME/HEARTBEAT.md` miss); the external
        // bundle root must win so the companions resolve.
        paperclipWorkspace: { agentHome: "/paperclip/instances/default/workspaces/agent-abc" },
      },
    };
    const result = buildJobManifest({ ctx, selfPod: mockSelfPod });
    const env = result.job.spec?.template.spec?.containers[0]?.env ?? [];
    expect(env.find((e) => e.name === "AGENT_HOME")?.value).toBe(
      "/paperclip/.paperclip/instances/default/companies/Penstock/agents/devops",
    );
  });

  it("leaves AGENT_HOME as the workspace agentHome when no external bundle is configured", () => {
    const ctx = {
      ...mockCtx,
      config: { instructionsFilePath: "/paperclip/.paperclip/.../agents/ceo/AGENTS.md" },
      context: {
        ...mockCtx.context,
        paperclipWorkspace: { agentHome: "/home/agent" },
      },
    };
    const result = buildJobManifest({ ctx, selfPod: mockSelfPod });
    const env = result.job.spec?.template.spec?.containers[0]?.env ?? [];
    expect(env.find((e) => e.name === "AGENT_HOME")?.value).toBe("/home/agent");
  });

  it("symlinks company shared-docs into cwd for an external bundle (BLO-10315), and skips otherwise", () => {
    const shell = (r: ReturnType<typeof buildJobManifest>) =>
      (r.job.spec?.template?.spec?.containers?.find((c) => c.name === "opencode")?.command?.[2] ?? "");
    const ext = buildJobManifest({
      ctx: {
        ...mockCtx,
        config: {
          instructionsBundleMode: "external",
          instructionsRootPath: "/paperclip/.paperclip/instances/default/companies/Penstock/agents/devops",
        },
      },
      selfPod: mockSelfPod,
    });
    const c = shell(ext);
    expect(c).toContain("[ -e docs ]");
    expect(c).toContain('ln -sfn "$__pcd" docs');
    expect(c).toContain('"$(dirname "$(dirname "${AGENT_HOME:-/nonexistent}")")/docs"');
    // no external bundle → no shared-docs symlink bridge (the unrelated
    // Chrome BrowserMetrics redirect also uses `ln -sfn`, so match the docs
    // bridge specifically rather than any symlink).
    const plain = buildJobManifest({ ctx: { ...mockCtx, config: { instructionsFilePath: "/x/AGENTS.md" } }, selfPod: mockSelfPod });
    expect(shell(plain)).not.toContain('ln -sfn "$__pcd" docs');
  });

  it("sets PAPERCLIP_LINKED_ISSUE_IDS from non-empty issueIds array (skipping blanks)", () => {
    const ctx = { ...mockCtx, context: { ...mockCtx.context, issueIds: ["a", "  ", "b", null as unknown as string, "c"] } };
    const result = buildJobManifest({ ctx, selfPod: mockSelfPod });
    const env = result.job.spec?.template.spec?.containers[0]?.env ?? [];
    expect(env.find((e) => e.name === "PAPERCLIP_LINKED_ISSUE_IDS")?.value).toBe("a,b,c");
  });

  it("encodes paperclipWorkspaces / paperclipRuntimeServiceIntents / paperclipRuntimeServices as JSON env", () => {
    const ctx = {
      ...mockCtx,
      context: {
        ...mockCtx.context,
        paperclipWorkspaces: [{ id: "w1" }],
        paperclipRuntimeServiceIntents: [{ name: "redis" }],
        paperclipRuntimeServices: [{ name: "redis", url: "redis://r" }],
        paperclipRuntimePrimaryUrl: "https://primary",
      },
    };
    const result = buildJobManifest({ ctx, selfPod: mockSelfPod });
    const env = result.job.spec?.template.spec?.containers[0]?.env ?? [];
    expect(env.find((e) => e.name === "PAPERCLIP_WORKSPACES_JSON")?.value).toContain("w1");
    expect(env.find((e) => e.name === "PAPERCLIP_RUNTIME_SERVICE_INTENTS_JSON")?.value).toContain("redis");
    expect(env.find((e) => e.name === "PAPERCLIP_RUNTIME_SERVICES_JSON")?.value).toContain("redis://r");
    expect(env.find((e) => e.name === "PAPERCLIP_RUNTIME_PRIMARY_URL")?.value).toBe("https://primary");
  });

  it("sets PAPERCLIP_API_KEY from ctx.authToken when provided", () => {
    const ctx = { ...mockCtx, authToken: "tok_abc" };
    const result = buildJobManifest({ ctx, selfPod: mockSelfPod });
    const env = result.job.spec?.template.spec?.containers[0]?.env ?? [];
    expect(env.find((e) => e.name === "PAPERCLIP_API_KEY")?.value).toBe("tok_abc");
  });

  it("inherits PAPERCLIP_API_URL from selfPod inheritedEnv", () => {
    const selfPod = {
      ...mockSelfPod,
      inheritedEnv: { PAPERCLIP_API_URL: "http://api" },
    };
    const result = buildJobManifest({ ctx: mockCtx, selfPod });
    const env = result.job.spec?.template.spec?.containers[0]?.env ?? [];
    expect(env.find((e) => e.name === "PAPERCLIP_API_URL")?.value).toBe("http://api");
  });
});

describe("buildJobManifest — volume wiring branches", () => {
  it("mounts the prompt secret volume when promptSecretName is provided", () => {
    const result = buildJobManifest({ ctx: mockCtx, selfPod: mockSelfPod, promptSecretName: "prompt-x" });
    const volumes = result.job.spec?.template.spec?.volumes ?? [];
    expect(volumes.find((v) => v.name === "prompt-secret")?.secret?.secretName).toBe("prompt-x");
  });

  it("mounts the data PVC at /paperclip when selfPod has a pvcClaimName", () => {
    const selfPod = { ...mockSelfPod, pvcClaimName: "paperclip-data" };
    const result = buildJobManifest({ ctx: mockCtx, selfPod });
    const volumes = result.job.spec?.template.spec?.volumes ?? [];
    expect(volumes.find((v) => v.name === "data")?.persistentVolumeClaim?.claimName).toBe("paperclip-data");
    const mounts = result.job.spec?.template.spec?.containers[0]?.volumeMounts ?? [];
    expect(mounts.find((m) => m.name === "data")?.mountPath).toBe("/paperclip");
    const securityContext = result.job.spec?.template.spec?.securityContext;
    expect(securityContext?.fsGroup).toBeUndefined();
    expect(securityContext?.fsGroupChangePolicy).toBeUndefined();
  });

  it("mounts the runtime-cache emptyDir at /runtime-cache for agent caches", () => {
    const result = buildJobManifest({ ctx: mockCtx, selfPod: mockSelfPod });
    const volumes = result.job.spec?.template.spec?.volumes ?? [];
    expect(volumes.find((v) => v.name === "runtime-cache")?.emptyDir?.sizeLimit).toBe("20Gi");
    const mounts = result.job.spec?.template.spec?.containers[0]?.volumeMounts ?? [];
    expect(mounts.find((m) => m.name === "runtime-cache")?.mountPath).toBe("/runtime-cache");
  });

  it("mounts inherited secret volumes from selfPod.secretVolumes", () => {
    const selfPod = {
      ...mockSelfPod,
      secretVolumes: [{ volumeName: "tls", secretName: "tls-secret", mountPath: "/etc/tls", defaultMode: 0o400 }],
    };
    const result = buildJobManifest({ ctx: mockCtx, selfPod });
    const volumes = result.job.spec?.template.spec?.volumes ?? [];
    expect(volumes.find((v) => v.name === "tls")?.secret?.secretName).toBe("tls-secret");
    const mounts = result.job.spec?.template.spec?.containers[0]?.volumeMounts ?? [];
    expect(mounts.find((m) => m.name === "tls")).toEqual({ name: "tls", mountPath: "/etc/tls", readOnly: true });
  });
});

describe("buildJobManifest — MCP fleet wiring", () => {
  it("emits no OPENCODE_CONFIG and no opencode.json init step when no baseline + no per-agent override", () => {
    // The shared /paperclip/.mcp.json is absent in the test environment
    // (loadSharedMcpBaseline returns {} on read failure), and config.mcpServers
    // is empty. Result: opencode falls back to ~/.config/opencode/opencode.json
    // exactly as before.
    const result = buildJobManifest({ ctx: mockCtx, selfPod: mockSelfPod });
    const mainEnv = result.job.spec!.template.spec!.containers[0]!.env ?? [];
    expect(mainEnv.find((e) => e.name === "OPENCODE_CONFIG")).toBeUndefined();
    const init = result.job.spec!.template.spec!.initContainers![0]!;
    const initEnvNames = (init.env ?? []).map((e) => e.name);
    expect(initEnvNames).not.toContain("OPENCODE_CONFIG_JSON");
    const initCmd = (init.command ?? []).join(" ");
    expect(initCmd).not.toContain("opencode.json");
  });

  it("translates per-agent mcpServers (claude shape + native opencode shape) and ships OPENCODE_CONFIG", () => {
    const ctx: JobBuildInput["ctx"] = {
      ...mockCtx,
      config: {
        mcpServers: {
          // claude shape: split command + args
          paperclip: {
            command: "node",
            args: ["/app/packages/mcp-server/dist/stdio.js"],
          },
          // claude shape with env
          github: {
            command: "/usr/local/bin/github-mcp-server",
            args: ["stdio"],
            env: { LOG_LEVEL: "info" },
          },
          // claude http
          prometheus: {
            type: "http",
            url: "http://prometheus-mcp-server.paperclip.svc.cluster.local:8080/mcp",
          },
          // claude http with auth headers
          gbrain: {
            type: "http",
            url: "http://gbrain-mcp-admin.paperclip.svc.cluster.local:3130/mcp",
            headers: { Authorization: "Bearer test-token" },
          },
          // claude sse — translates to remote (best-effort)
          kubernetes: {
            type: "sse",
            url: "http://kubernetes-mcp-server-admin.paperclip.svc.cluster.local:8080/sse",
          },
          // already-opencode shape — pass through
          figma: {
            type: "remote",
            url: "http://figma-mcp-server.paperclip.svc.cluster.local:8080/mcp",
          },
        },
      },
    };
    const result = buildJobManifest({ ctx, selfPod: mockSelfPod });

    const mainEnv = result.job.spec!.template.spec!.containers[0]!.env ?? [];
    expect(mainEnv.find((e) => e.name === "OPENCODE_CONFIG")?.value).toBe("/tmp/prompt/opencode.json");

    const init = result.job.spec!.template.spec!.initContainers![0]!;
    const cfgEnv = (init.env ?? []).find((e) => e.name === "OPENCODE_CONFIG_JSON");
    expect(cfgEnv).toBeDefined();
    const parsed = JSON.parse(cfgEnv!.value!) as {
      $schema: string;
      permission: { external_directory: string };
      disabled_providers: string[];
      mcp: Record<string, Record<string, unknown>>;
    };
    expect(parsed.$schema).toBe("https://opencode.ai/config.json");
    expect(parsed.permission.external_directory).toBe("allow");
    // disabled_providers includes "opencode" so the zen free tier never
    // catches a Job pod (it returned FreeUsageLimitError 429 within 3s
    // and opencode silently wedged on retryable errors). With zen
    // disabled the pod falls through to the bundled `openai` chatgpt
    // OAuth provider, populated by buildOpencodeAuthBootstrapShell.
    expect(parsed.disabled_providers).toEqual(["opencode"]);

    // claude split → opencode merged array
    expect(parsed.mcp.paperclip).toEqual({
      type: "local",
      command: ["node", "/app/packages/mcp-server/dist/stdio.js"],
    });

    // env carried through as `environment`
    expect(parsed.mcp.github).toEqual({
      type: "local",
      command: ["/usr/local/bin/github-mcp-server", "stdio"],
      environment: { LOG_LEVEL: "info" },
    });

    // http → remote
    expect(parsed.mcp.prometheus).toEqual({
      type: "remote",
      url: "http://prometheus-mcp-server.paperclip.svc.cluster.local:8080/mcp",
    });

    // auth headers are preserved for Bearer-protected remote MCPs
    expect(parsed.mcp.gbrain).toEqual({
      type: "remote",
      url: "http://gbrain-mcp-admin.paperclip.svc.cluster.local:3130/mcp",
      headers: { Authorization: "Bearer test-token" },
    });

    // sse → remote (lossy translation, documented)
    expect(parsed.mcp.kubernetes).toEqual({
      type: "remote",
      url: "http://kubernetes-mcp-server-admin.paperclip.svc.cluster.local:8080/sse",
    });

    // already-opencode shape passes through
    expect(parsed.mcp.figma).toEqual({
      type: "remote",
      url: "http://figma-mcp-server.paperclip.svc.cluster.local:8080/mcp",
    });

    const initCmd = (init.command ?? []).join(" ");
    expect(initCmd).toContain('printf \'%s\' "$OPENCODE_CONFIG_JSON" > /tmp/prompt/opencode.json');
  });
});

describe("buildJobManifest — environment.config wiring (Phase E.2)", () => {
  it("uses workspaceVolumeClaim from input as the workspace PVC claim name", () => {
    const selfPodWithPvc: JobBuildInput["selfPod"] = {
      ...mockSelfPod,
      pvcClaimName: "default-paperclip-pvc",
    };
    const result = buildJobManifest({
      ctx: mockCtx,
      selfPod: selfPodWithPvc,
      workspaceVolumeClaim: "env-supplied-claim",
    });

    const volumes = result.job.spec?.template?.spec?.volumes ?? [];
    const dataVol = volumes.find((v) => v.name === "data");
    expect(dataVol?.persistentVolumeClaim?.claimName).toBe("env-supplied-claim");
  });

  it("falls back to selfPod.pvcClaimName when workspaceVolumeClaim is undefined", () => {
    const selfPodWithPvc: JobBuildInput["selfPod"] = {
      ...mockSelfPod,
      pvcClaimName: "default-paperclip-pvc",
    };
    const result = buildJobManifest({ ctx: mockCtx, selfPod: selfPodWithPvc });

    const volumes = result.job.spec?.template?.spec?.volumes ?? [];
    const dataVol = volumes.find((v) => v.name === "data");
    expect(dataVol?.persistentVolumeClaim?.claimName).toBe("default-paperclip-pvc");
  });

  it("uses workspaceMountPath from input as the workspace volumeMount path", () => {
    const selfPodWithPvc: JobBuildInput["selfPod"] = {
      ...mockSelfPod,
      pvcClaimName: "default-paperclip-pvc",
    };
    const result = buildJobManifest({
      ctx: mockCtx,
      selfPod: selfPodWithPvc,
      workspaceMountPath: "/workspace",
    });

    const mounts = result.job.spec?.template?.spec?.containers?.[0]?.volumeMounts ?? [];
    const dataMount = mounts.find((m) => m.name === "data");
    expect(dataMount?.mountPath).toBe("/workspace");
  });

  it("defaults workspace mountPath to /paperclip when workspaceMountPath is unset", () => {
    const selfPodWithPvc: JobBuildInput["selfPod"] = {
      ...mockSelfPod,
      pvcClaimName: "default-paperclip-pvc",
    };
    const result = buildJobManifest({ ctx: mockCtx, selfPod: selfPodWithPvc });

    const mounts = result.job.spec?.template?.spec?.containers?.[0]?.volumeMounts ?? [];
    const dataMount = mounts.find((m) => m.name === "data");
    expect(dataMount?.mountPath).toBe("/paperclip");
  });

  describe("ccrotate preflight --accounts pool", () => {
    it("appends --accounts to ccrotate when providers.openai.accounts is populated", () => {
      const ctx = {
        ...mockCtx,
        config: {
          providers: {
            openai: { kind: "ccrotate", accounts: ["a@b.net", "c@d.net"] },
          },
        },
      };
      const result = buildJobManifest({ ctx, selfPod: mockSelfPod });
      const cmd = result.job.spec?.template?.spec?.containers?.[0]?.command;
      expect(cmd?.[2]).toMatch(/timeout 30s ccrotate next --yes --target codex --accounts a@b\.net,c@d\.net/);
    });

    it("falls through to global ccrotate when providers is undefined", () => {
      const result = buildJobManifest({ ctx: mockCtx, selfPod: mockSelfPod });
      const cmd = result.job.spec?.template?.spec?.containers?.[0]?.command;
      expect(cmd?.[2]).toMatch(/timeout 30s ccrotate next --yes --target codex(?! --accounts)/);
    });

    it("falls through to global ccrotate when only providers.anthropic is set (wrong key for opencode)", () => {
      const ctx = {
        ...mockCtx,
        config: {
          providers: {
            anthropic: { kind: "ccrotate", accounts: ["x@y.net"] },
          },
        },
      };
      const result = buildJobManifest({ ctx, selfPod: mockSelfPod });
      const cmd = result.job.spec?.template?.spec?.containers?.[0]?.command;
      expect(cmd?.[2]).not.toContain("--accounts");
    });
  });

  describe("opencode-auth-bootstrap (codex → opencode auth.json)", () => {
    // Background: opencode's default provider is opencode.ai/zen. With no
    // auth.json present, zen returns FreeUsageLimitError 429 within ~3s and
    // the AI SDK marks it retryable but never retries — opencode CLI then
    // sits in epoll_wait indefinitely, paperclip-0's keepalive keeps the
    // run "alive", and the watchdog never trips. The fix: translate the
    // codex chatgpt-OAuth tokens (which ccrotate refreshes per Job) into
    // opencode's openai-OAuth auth store on each Job spawn.

    it("emits the auth bootstrap step between ccrotateRefresh and the opencode invocation", () => {
      const result = buildJobManifest({ ctx: mockCtx, selfPod: mockSelfPod });
      const cmd = result.job.spec?.template?.spec?.containers?.[0]?.command?.[2] ?? "";
      const ccrotateIdx = cmd.indexOf("timeout 30s ccrotate next --yes --target codex");
      const bootstrapIdx = cmd.indexOf("XDG_DATA_HOME");
      const opencodeIdx = cmd.indexOf("| opencode ");
      expect(ccrotateIdx).toBeGreaterThan(-1);
      expect(bootstrapIdx).toBeGreaterThan(ccrotateIdx);
      expect(opencodeIdx).toBeGreaterThan(bootstrapIdx);
    });

    it("redirects Chrome BrowserMetrics to the runtime-cache emptyDir before the agent runs (BLO-10699)", () => {
      const result = buildJobManifest({ ctx: mockCtx, selfPod: mockSelfPod });
      const cmd = result.job.spec?.template?.spec?.containers?.[0]?.command?.[2] ?? "";
      const redirectIdx = cmd.indexOf("ln -sfn /runtime-cache/chrome-browser-metrics");
      const opencodeIdx = cmd.indexOf("| opencode ");
      // Only BrowserMetrics is redirected, idempotently, off the shared PVC.
      expect(cmd).toContain('[ -L "$HOME/.config/google-chrome/BrowserMetrics" ]');
      expect(redirectIdx).toBeGreaterThan(-1);
      // Redirect runs before the agent invocation.
      expect(opencodeIdx).toBeGreaterThan(redirectIdx);
    });

    it("translates the codex auth.json shape (auth_mode=chatgpt + tokens) into the openai-OAuth shape opencode expects", () => {
      const result = buildJobManifest({ ctx: mockCtx, selfPod: mockSelfPod });
      const cmd = result.job.spec?.template?.spec?.containers?.[0]?.command?.[2] ?? "";
      // Reads codex auth + checks chatgpt mode + writes opencode auth.json
      expect(cmd).toContain('".codex","auth.json"');
      expect(cmd).toContain('auth_mode!=="chatgpt"');
      expect(cmd).toContain('D=process.env.XDG_DATA_HOME||p.join(H,".local","share")');
      expect(cmd).toContain('p.join(D,"opencode","auth.json")');
      // Output keys: openai provider, oauth type, expiry from id_token exp claim
      expect(cmd).toContain('openai:{type:"oauth"');
      expect(cmd).toContain("payload.exp");
      // Best-effort: never fail the pod on bootstrap errors
      expect(cmd).toContain("|| true");
    });

    it("skips OAuth bootstrap and clears stale opencode auth when OPENAI_API_KEY is configured", () => {
      const ctx = {
        ...mockCtx,
        config: {
          env: {
            OPENAI_API_KEY: "test-key",
            OPENAI_BASE_URL: "http://opencode-ccrotate-responses-shim.paperclip.svc.cluster.local:8080/v1",
          },
        },
      };
      const result = buildJobManifest({ ctx, selfPod: mockSelfPod });
      const cmd = result.job.spec?.template?.spec?.containers?.[0]?.command?.[2] ?? "";

      expect(cmd).not.toContain('".codex","auth.json"');
      expect(cmd).not.toContain('auth_mode!=="chatgpt"');
      expect(cmd).toContain('rm -f "${XDG_DATA_HOME:-$HOME/.local/share}/opencode/auth.json" "${XDG_DATA_HOME:-$HOME/.local/share}/opencode/account.json"');
      expect(cmd.indexOf('rm -f "${XDG_DATA_HOME:-$HOME/.local/share}/opencode/auth.json"')).toBeLessThan(
        cmd.indexOf("cat /tmp/prompt/prompt.txt"),
      );
    });
  });

  describe("buildRuntimeConfigJson + opencodeConfigJson disable opencode.ai/zen", () => {
    it("default opencode.json (no per-agent MCP) sets disabled_providers=['opencode']", () => {
      const result = buildJobManifest({ ctx: mockCtx, selfPod: mockSelfPod });
      const cmd = result.job.spec?.template?.spec?.containers?.[0]?.command?.[2] ?? "";
      // The default-path config is inlined into the main command via
      // `echo '...' > "${XDG_CONFIG_HOME:-$HOME/.config}/opencode/opencode.json"`. Extract and parse.
      const match = cmd.match(/echo '([^']+(?:'\\''[^']*)*)' > \S*opencode\/opencode\.json/);
      expect(match).toBeTruthy();
      const parsed = JSON.parse(match![1].replace(/'\\''/g, "'")) as { disabled_providers?: string[] };
      expect(parsed.disabled_providers).toEqual(["opencode"]);
    });

    it("denies env-dump bash commands (PEN-1305) without blocking legit forms", () => {
      const result = buildJobManifest({ ctx: mockCtx, selfPod: mockSelfPod });
      const cmd = result.job.spec?.template?.spec?.containers?.[0]?.command?.[2] ?? "";
      const match = cmd.match(/echo '([^']+(?:'\\''[^']*)*)' > \S*opencode\/opencode\.json/);
      expect(match).toBeTruthy();
      const parsed = JSON.parse(match![1].replace(/'\\''/g, "'")) as {
        permission?: { external_directory?: string; bash?: Record<string, string> };
      };
      const bash = parsed.permission?.bash ?? {};
      // Default stays allow (unattended Job pods must not prompt).
      expect(bash["*"]).toBe("allow");
      // Dump forms are denied.
      for (const p of ["env", "printenv", "set", "export -p", "declare -x", "cat /proc/*/environ"]) {
        expect(bash[p]).toBe("deny");
      }
      // Legit set-and-run / flag forms are NOT present as deny keys (bare-token
      // globs never match args-carrying commands).
      expect(bash["env *"]).toBeUndefined();
      expect(bash["set *"]).toBeUndefined();
      expect(bash["printenv *"]).toBeUndefined();
      // external_directory bypass preserved under skipPermissions.
      expect(parsed.permission?.external_directory).toBe("allow");
    });

    // BLO-14758: opencode's turn-zero workspace snapshot (`git add --all
    // --sparse` into a shadow git store) pegs a core in uninterruptible
    // disk I/O for 20-30+ minutes against large/cold agent workspace dirs,
    // before the first LLM turn starts. Both config paths must disable it.
    it("default opencode.json (no per-agent MCP) sets snapshot=false", () => {
      const result = buildJobManifest({ ctx: mockCtx, selfPod: mockSelfPod });
      const cmd = result.job.spec?.template?.spec?.containers?.[0]?.command?.[2] ?? "";
      const match = cmd.match(/echo '([^']+(?:'\\''[^']*)*)' > \S*opencode\/opencode\.json/);
      expect(match).toBeTruthy();
      const parsed = JSON.parse(match![1].replace(/'\\''/g, "'")) as { snapshot?: boolean };
      expect(parsed.snapshot).toBe(false);
    });

    it("sets snapshot=false on the MCP-path opencode.json (OPENCODE_CONFIG_JSON)", () => {
      const ctx: JobBuildInput["ctx"] = {
        ...mockCtx,
        config: {
          mcpServers: {
            paperclip: { command: "node", args: ["/app/packages/mcp-server/dist/stdio.js"] },
          },
        },
      };
      const result = buildJobManifest({ ctx, selfPod: mockSelfPod });
      const init = result.job.spec!.template.spec!.initContainers![0]!;
      const cfgEnv = (init.env ?? []).find((e) => e.name === "OPENCODE_CONFIG_JSON");
      expect(cfgEnv).toBeDefined();
      const parsed = JSON.parse(cfgEnv!.value!) as { snapshot?: boolean };
      expect(parsed.snapshot).toBe(false);
    });

    // Reasoning models (gpt-5.5) can pause for long stretches between SSE
    // chunks while thinking. OpenCode's default inter-chunk idle guard
    // (provider.options.chunkTimeout) aborts the stream on these gaps,
    // surfacing "API Error: Stream idle timeout - partial response" and
    // persisting a TRUNCATED assistant turn (an issue body cut mid-sentence).
    // Both config paths must set a generous chunkTimeout so a healthy-but-slow
    // reasoning stream is never aborted.
    it("sets provider.openai.options.chunkTimeout on the default (no-MCP) opencode.json", () => {
      const result = buildJobManifest({ ctx: mockCtx, selfPod: mockSelfPod });
      const cmd = result.job.spec?.template?.spec?.containers?.[0]?.command?.[2] ?? "";
      const match = cmd.match(/echo '([^']+(?:'\\''[^']*)*)' > \S*opencode\/opencode\.json/);
      expect(match).toBeTruthy();
      const parsed = JSON.parse(match![1].replace(/'\\''/g, "'")) as {
        provider?: { openai?: { options?: { chunkTimeout?: number } } };
      };
      expect(parsed.provider?.openai?.options?.chunkTimeout).toBe(240_000);
    });

    it("sets provider.openai.options.chunkTimeout on the MCP-path opencode.json (OPENCODE_CONFIG_JSON)", () => {
      const ctx: JobBuildInput["ctx"] = {
        ...mockCtx,
        config: {
          mcpServers: {
            paperclip: { command: "node", args: ["/app/packages/mcp-server/dist/stdio.js"] },
          },
        },
      };
      const result = buildJobManifest({ ctx, selfPod: mockSelfPod });
      const init = result.job.spec!.template.spec!.initContainers![0]!;
      const cfgEnv = (init.env ?? []).find((e) => e.name === "OPENCODE_CONFIG_JSON");
      expect(cfgEnv).toBeDefined();
      const parsed = JSON.parse(cfgEnv!.value!) as {
        provider?: { openai?: { options?: { chunkTimeout?: number } } };
      };
      expect(parsed.provider?.openai?.options?.chunkTimeout).toBe(240_000);
    });
    // Per-agent Penstock attribution: every agent Job shares the one org API
    // key, so without a per-agent client-session header the whole fleet melts
    // into a single UNTAGGED bucket on the org_penstock consumption dashboard.
    type ProviderHeaderShape = {
      provider?: {
        anthropic?: { options?: { headers?: Record<string, string> } };
        openai?: { options?: { headers?: Record<string, string>; chunkTimeout?: number } };
      };
    };

    it("stamps x-penstock-session: agent:<name> on both providers (default path)", () => {
      const result = buildJobManifest({ ctx: mockCtx, selfPod: mockSelfPod });
      const cmd = result.job.spec?.template?.spec?.containers?.[0]?.command?.[2] ?? "";
      const match = cmd.match(/echo '([^']+(?:'\\''[^']*)*)' > \S*opencode\/opencode\.json/);
      expect(match).toBeTruthy();
      const parsed = JSON.parse(match![1].replace(/'\\''/g, "'")) as ProviderHeaderShape;
      expect(parsed.provider?.anthropic?.options?.headers).toEqual({
        "x-penstock-session": "agent:Test Agent",
      });
      expect(parsed.provider?.openai?.options?.headers).toEqual({
        "x-penstock-session": "agent:Test Agent",
      });
      // The identity headers must not displace the reasoning chunkTimeout.
      expect(parsed.provider?.openai?.options?.chunkTimeout).toBe(240_000);
    });

    it("stamps x-penstock-session on the MCP-path opencode.json too", () => {
      const ctx: JobBuildInput["ctx"] = {
        ...mockCtx,
        config: {
          mcpServers: {
            paperclip: { command: "node", args: ["/app/packages/mcp-server/dist/stdio.js"] },
          },
        },
      };
      const result = buildJobManifest({ ctx, selfPod: mockSelfPod });
      const init = result.job.spec!.template.spec!.initContainers![0]!;
      const cfgEnv = (init.env ?? []).find((e) => e.name === "OPENCODE_CONFIG_JSON");
      const parsed = JSON.parse(cfgEnv!.value!) as ProviderHeaderShape;
      expect(parsed.provider?.anthropic?.options?.headers?.["x-penstock-session"]).toBe(
        "agent:Test Agent",
      );
    });

    it("falls back to the agent id and strips header-injection characters from the name", () => {
      const ctx: JobBuildInput["ctx"] = {
        ...mockCtx,
        agent: { ...mockCtx.agent, id: "agent-xyz", name: "evil\r\nX-Injected: 1" },
      };
      const result = buildJobManifest({ ctx, selfPod: mockSelfPod });
      const cmd = result.job.spec?.template?.spec?.containers?.[0]?.command?.[2] ?? "";
      const match = cmd.match(/echo '([^']+(?:'\\''[^']*)*)' > \S*opencode\/opencode\.json/);
      const parsed = JSON.parse(match![1].replace(/'\\''/g, "'")) as ProviderHeaderShape;
      // CR/LF stripped — the value stays a single header line.
      expect(parsed.provider?.anthropic?.options?.headers?.["x-penstock-session"]).toBe(
        "agent:evilX-Injected: 1",
      );

      const noName: JobBuildInput["ctx"] = {
        ...mockCtx,
        agent: { ...mockCtx.agent, id: "agent-noname", name: "" },
      };
      const result2 = buildJobManifest({ ctx: noName, selfPod: mockSelfPod });
      const cmd2 = result2.job.spec?.template?.spec?.containers?.[0]?.command?.[2] ?? "";
      const match2 = cmd2.match(/echo '([^']+(?:'\\''[^']*)*)' > \S*opencode\/opencode\.json/);
      const parsed2 = JSON.parse(match2![1].replace(/'\\''/g, "'")) as ProviderHeaderShape;
      expect(parsed2.provider?.anthropic?.options?.headers?.["x-penstock-session"]).toBe(
        "agent:agent-noname",
      );
    });
  });

  describe("paperclipTaskMarkdown surfacing", () => {
    // Server-side heartbeat composes context.paperclipTaskMarkdown for wakes
    // that carry first-class task context (notably PR-review wakes via the
    // github webhook handler, which set contextSnapshot.githubPrNumber +
    // githubRepoFullName but never produce a paperclipWake because there's
    // no issue tied to the PR). Without this prompt slot, the PR review
    // agent reaches the pod with NO information about which PR to review.
    //
    // See:
    //   - server/services/heartbeat.ts buildPaperclipTaskMarkdown
    //   - server/routes/github-webhook.ts (the wake call that sets
    //     contextSnapshot.githubPrNumber + reviewKind)
    it("includes context.paperclipTaskMarkdown in the assembled prompt", () => {
      const taskMd = [
        "Paperclip task context:",
        "- PR: \"Blockcast/paperclip#59\"",
        "- Wake reason: \"github_pr_opened\"",
        "",
        "GitHub PR review directive:",
        "A GitHub webhook woke you to review this pull request.",
      ].join("\n");
      const ctx = { ...mockCtx, context: { ...mockCtx.context, paperclipTaskMarkdown: taskMd } };
      const result = buildJobManifest({ ctx, selfPod: mockSelfPod });
      expect(result.prompt).toContain("Blockcast/paperclip#59");
      expect(result.prompt).toContain("github_pr_opened");
      expect(result.prompt).toContain("GitHub PR review directive");
      expect(result.promptMetrics.taskMarkdownChars).toBe(taskMd.length);
    });

    it("does NOT inject anything when paperclipTaskMarkdown is absent (no spurious newlines)", () => {
      const result = buildJobManifest({ ctx: mockCtx, selfPod: mockSelfPod });
      expect(result.promptMetrics.taskMarkdownChars).toBe(0);
    });

    it("trims surrounding whitespace from paperclipTaskMarkdown before inclusion", () => {
      const taskMd = "\n\n  GitHub PR review directive:\n  ...\n\n";
      const ctx = { ...mockCtx, context: { ...mockCtx.context, paperclipTaskMarkdown: taskMd } };
      const result = buildJobManifest({ ctx, selfPod: mockSelfPod });
      expect(result.promptMetrics.taskMarkdownChars).toBe(taskMd.trim().length);
      expect(result.prompt).toContain("GitHub PR review directive");
    });

    // The whole point of inserting `taskMarkdown` at a *specific* position
    // is so the agent reads task context (what to work on) after wake
    // context (why it woke) but before the session handoff narrative
    // (which may reference the task). A position-blind .toContain check
    // would silently accept a reorder; this test pins the contract.
    it("places taskMarkdown after wakePrompt and before sessionHandoffNote", () => {
      const ctx = {
        ...mockCtx,
        context: {
          ...mockCtx.context,
          paperclipWake: {
            reason: "issue_assigned",
            issue: { id: "x", identifier: "WAKE-SENTINEL", title: "t" },
          },
          paperclipTaskMarkdown: "TASK-SENTINEL paperclipTaskMarkdown body",
          paperclipSessionHandoffMarkdown: "HANDOFF-SENTINEL paperclipSessionHandoffMarkdown body",
        },
      };
      const result = buildJobManifest({ ctx, selfPod: mockSelfPod });
      const wakeIdx = result.prompt.indexOf("WAKE-SENTINEL");
      const taskIdx = result.prompt.indexOf("TASK-SENTINEL");
      const handoffIdx = result.prompt.indexOf("HANDOFF-SENTINEL");
      expect(wakeIdx).toBeGreaterThan(-1);
      expect(taskIdx).toBeGreaterThan(wakeIdx);
      expect(handoffIdx).toBeGreaterThan(taskIdx);
    });

    // PR-review wakes overwhelmingly arrive WITH a resumed session: the
    // reviewer agent (Ally) keeps a long-running opencode session across
    // wakes. The resume-delta gate `Boolean(runtimeSessionId) && wakePrompt.length > 0`
    // evaluates to `false` for that shape (paperclipWake is null when
    // there's no issue tied to the PR), so `renderedPrompt` is NOT
    // suppressed — the agent gets the full bootstrap + the PR directive.
    // This test pins that behavior so a future refactor (e.g. gating
    // resume-delta on `taskMarkdown.length > 0`) doesn't silently land.
    it("does not gate resume-delta on taskMarkdown (PR-review wake shape: resumed session + no paperclipWake)", () => {
      const ctx = {
        ...mockCtx,
        runtime: {
          sessionId: "ses_pr_review",
          sessionParams: { sessionId: "ses_pr_review" },
          sessionDisplayId: "ses_pr_review",
          taskKey: null,
        },
        context: {
          ...mockCtx.context,
          paperclipTaskMarkdown: "GitHub PR review directive: review PR #59",
        },
      };
      const result = buildJobManifest({ ctx, selfPod: mockSelfPod });
      expect(result.prompt).toContain("GitHub PR review directive");
      expect(result.promptMetrics.taskMarkdownChars).toBeGreaterThan(0);
      // wakePrompt is empty (no paperclipWake) → resume-delta gate is OFF
      // → heartbeat prompt template still renders.
      expect(result.promptMetrics.wakePromptChars).toBe(0);
      expect(result.promptMetrics.heartbeatPromptChars).toBeGreaterThan(0);
    });

    // The complementary shape: issue-wake with both paperclipWake AND
    // paperclipTaskMarkdown set, on a resumed session. Resume-delta DOES
    // engage (wakePrompt > 0), so `renderedPrompt` IS suppressed — but
    // taskMarkdown must survive the suppression. Catches the "fix" where
    // someone gates taskMarkdown on the same condition as renderedPrompt.
    it("preserves taskMarkdown even when resume-delta suppresses the heartbeat prompt", () => {
      const ctx = {
        ...mockCtx,
        runtime: {
          sessionId: "ses_issue_wake",
          sessionParams: { sessionId: "ses_issue_wake" },
          sessionDisplayId: "ses_issue_wake",
          taskKey: null,
        },
        context: {
          ...mockCtx.context,
          paperclipWake: {
            reason: "issue_assigned",
            issue: { id: "iw", identifier: "BLO-1234", title: "t" },
          },
          paperclipTaskMarkdown: "Paperclip task context:\n- Issue: BLO-1234",
        },
      };
      const result = buildJobManifest({ ctx, selfPod: mockSelfPod });
      expect(result.prompt).toContain("Paperclip task context");
      expect(result.promptMetrics.taskMarkdownChars).toBeGreaterThan(0);
      // Resume-delta gate fires (wakePrompt > 0 + sessionId set) → heartbeat prompt suppressed
      expect(result.promptMetrics.wakePromptChars).toBeGreaterThan(0);
      expect(result.promptMetrics.heartbeatPromptChars).toBe(0);
    });
  });
});

describe("buildJobManifest — resumeLastSession:false unifies fresh-session semantics", () => {
  // Bug surfaced 2026-05-23 (originally Gotcha #6 in BLO-5492 handoff): the
  // CLI gate `if (runtimeSessionId && resumeLastSession) push --session`
  // skipped the flag when resumeLastSession was false, so opencode started
  // a brand-new session. But three prompt-rendering paths used the weaker
  // `Boolean(runtimeSessionId)` gate, so the prompt was still composed as
  // a resume-delta (no bootstrap, wakePrompt rendered as delta, heartbeat
  // prompt suppressed). Net effect: opencode came up cold but received a
  // prompt that assumed prior context. Symptom on the fleet was the
  // appearance of "stale session reuse" even with resumeLastSession:false
  // explicitly set.
  function buildResumeOffCtx(overrides: Partial<JobBuildInput["ctx"]["context"]> = {}) {
    return {
      ...mockCtx,
      runtime: {
        sessionId: "ses_should_not_resume",
        sessionParams: { sessionId: "ses_should_not_resume" },
        sessionDisplayId: "ses_should_not_resume",
        taskKey: null,
      },
      config: {
        resumeLastSession: false,
        bootstrapPromptTemplate: "BOOTSTRAP-SENTINEL agent {{agent.id}}",
      },
      context: {
        ...mockCtx.context,
        ...overrides,
      },
    };
  }

  function getMainShellCommand(result: ReturnType<typeof buildJobManifest>) {
    const containers = result.job.spec?.template?.spec?.containers ?? [];
    const main = containers.find((c) => c.name === "opencode");
    const cmd = main?.command ?? [];
    return cmd[2] ?? "";
  }

  it("renders bootstrap prompt when resumeLastSession is false even with a tracked sessionId", () => {
    const ctx = buildResumeOffCtx();
    const result = buildJobManifest({ ctx, selfPod: mockSelfPod });
    expect(result.prompt).toContain("BOOTSTRAP-SENTINEL");
    expect(result.promptMetrics.bootstrapPromptChars).toBeGreaterThan(0);
  });

  it("does NOT pass --session to opencode when resumeLastSession is false", () => {
    const ctx = buildResumeOffCtx();
    const result = buildJobManifest({ ctx, selfPod: mockSelfPod });
    const script = getMainShellCommand(result);
    expect(script).not.toContain("--session");
  });

  it("renders wakePrompt as a fresh (not resume-delta) prompt when resumeLastSession is false", () => {
    // The wake-prompt renderer formats DIFFERENTLY depending on whether
    // the session is being resumed. When starting fresh we want the full
    // wake context, not a delta against a phantom prior session.
    const ctx = buildResumeOffCtx({
      paperclipWake: {
        reason: "issue_assigned",
        issue: { id: "iw", identifier: "BLO-9999", title: "test wake" },
      },
    });
    const result = buildJobManifest({ ctx, selfPod: mockSelfPod });
    expect(result.promptMetrics.wakePromptChars).toBeGreaterThan(0);
    // Heartbeat prompt must NOT be suppressed by the resume-delta gate
    // (which only applies to genuinely-resumed sessions).
    expect(result.promptMetrics.heartbeatPromptChars).toBeGreaterThan(0);
  });

  it("preserves resume semantics when resumeLastSession is true (default)", () => {
    // Regression guard for the unified flag: existing resumed-session
    // behaviour must not change for agents that don't opt out.
    const ctx = {
      ...mockCtx,
      runtime: {
        sessionId: "ses_resuming",
        sessionParams: { sessionId: "ses_resuming" },
        sessionDisplayId: "ses_resuming",
        taskKey: null,
      },
      config: {
        bootstrapPromptTemplate: "BOOTSTRAP-SENTINEL",
      },
      context: {
        ...mockCtx.context,
        paperclipWake: {
          reason: "issue_assigned",
          issue: { id: "i2", identifier: "BLO-9998", title: "resume" },
        },
      },
    };
    const result = buildJobManifest({ ctx, selfPod: mockSelfPod });
    const script = getMainShellCommand(result);
    // Resuming path: --session passed, no bootstrap, heartbeat suppressed
    expect(script).toContain("--session' 'ses_resuming'");
    expect(result.promptMetrics.bootstrapPromptChars).toBe(0);
    expect(result.promptMetrics.heartbeatPromptChars).toBe(0);
  });
});
