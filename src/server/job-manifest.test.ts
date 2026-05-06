import { describe, it, expect } from "vitest";
import { buildJobManifest, sanitizeLabelValue, type JobBuildInput } from "./job-manifest.js";

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

  it("sets fsGroupChangePolicy to OnRootMismatch", () => {
    const result = buildJobManifest({ ctx: mockCtx, selfPod: mockSelfPod });

    const securityContext = result.job.spec?.template?.spec?.securityContext;
    expect(securityContext?.fsGroupChangePolicy).toBe("OnRootMismatch");
  });

  it("sets runAsNonRoot and runAsUser 1000", () => {
    const result = buildJobManifest({ ctx: mockCtx, selfPod: mockSelfPod });

    const securityContext = result.job.spec?.template?.spec?.securityContext;
    expect(securityContext?.runAsNonRoot).toBe(true);
    expect(securityContext?.runAsUser).toBe(1000);
    expect(securityContext?.runAsGroup).toBe(1000);
    expect(securityContext?.fsGroup).toBe(1000);
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

  it("sets OPENCODE_DISABLE_PROJECT_CONFIG=true", () => {
    const result = buildJobManifest({ ctx: mockCtx, selfPod: mockSelfPod });

    const env = result.job.spec?.template?.spec?.containers?.[0].env ?? [];
    const opencodeEnv = env.find((e) => e.name === "OPENCODE_DISABLE_PROJECT_CONFIG");
    expect(opencodeEnv?.value).toBe("true");
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
      mcp: Record<string, Record<string, unknown>>;
    };
    expect(parsed.$schema).toBe("https://opencode.ai/config.json");
    expect(parsed.permission.external_directory).toBe("allow");

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
      expect(cmd?.[2]).toMatch(/ccrotate next --yes --target codex --accounts a@b\.net,c@d\.net/);
    });

    it("falls through to global ccrotate when providers is undefined", () => {
      const result = buildJobManifest({ ctx: mockCtx, selfPod: mockSelfPod });
      const cmd = result.job.spec?.template?.spec?.containers?.[0]?.command;
      expect(cmd?.[2]).toMatch(/ccrotate next --yes --target codex(?! --accounts)/);
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
});
