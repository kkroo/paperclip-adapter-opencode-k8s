import { describe, it, expect, vi, beforeEach } from "vitest";
import type { AdapterEnvironmentTestContext } from "@paperclipai/adapter-utils";
import { testEnvironment } from "./test.js";
import { getSelfPodInfo, getCoreApi, getAuthzApi } from "./k8s-client.js";

vi.mock("./k8s-client.js", () => ({
  getSelfPodInfo: vi.fn(),
  getCoreApi: vi.fn(),
  getAuthzApi: vi.fn(),
}));

const SELF_POD = {
  namespace: "ns-self",
  image: "img:1",
  imagePullSecrets: [],
  pvcClaimName: "paperclip-pvc",
  inheritedEnv: {},
  inheritedEnvValueFrom: [],
  inheritedEnvFrom: [],
  dnsConfig: undefined,
  secretVolumes: [],
} as unknown as Awaited<ReturnType<typeof getSelfPodInfo>>;

function makeCtx(config: Record<string, unknown> = {}): AdapterEnvironmentTestContext {
  return { adapterType: "opencode_k8s", config } as unknown as AdapterEnvironmentTestContext;
}

function makeAuthz(allowedFor: (resource: string, verb: string) => boolean) {
  return {
    createSelfSubjectAccessReview: vi.fn().mockImplementation(async ({ body }: { body: { spec: { resourceAttributes: { resource: string; verb: string } } } }) => {
      const { resource, verb } = body.spec.resourceAttributes;
      return { status: { allowed: allowedFor(resource, verb) } };
    }),
  };
}

function makeCore(overrides: Partial<{ readNamespace: ReturnType<typeof vi.fn>; readNamespacedSecret: ReturnType<typeof vi.fn>; readNamespacedPersistentVolumeClaim: ReturnType<typeof vi.fn> }> = {}) {
  return {
    readNamespace: overrides.readNamespace ?? vi.fn().mockResolvedValue({ metadata: { name: "ns" } }),
    readNamespacedSecret: overrides.readNamespacedSecret ?? vi.fn().mockResolvedValue({ metadata: { name: "paperclip-secrets" } }),
    readNamespacedPersistentVolumeClaim: overrides.readNamespacedPersistentVolumeClaim ?? vi.fn().mockResolvedValue({ spec: { accessModes: ["ReadWriteMany"] } }),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getSelfPodInfo).mockResolvedValue(SELF_POD);
  vi.mocked(getCoreApi).mockReturnValue(makeCore() as unknown as ReturnType<typeof getCoreApi>);
  vi.mocked(getAuthzApi).mockReturnValue(makeAuthz(() => true) as unknown as ReturnType<typeof getAuthzApi>);
});

describe("testEnvironment — happy path", () => {
  it("returns pass when API, namespace, RBAC, secret, and RWX PVC all check out", async () => {
    const result = await testEnvironment(makeCtx());

    expect(result.adapterType).toBe("opencode_k8s");
    expect(result.status).toBe("pass");
    expect(result.checks.find((c) => c.code === "k8s_api_reachable")).toBeDefined();
    expect(result.checks.find((c) => c.code === "k8s_pvc_rwx")).toBeDefined();
    expect(result.checks.find((c) => c.code === "k8s_secret_exists")).toBeDefined();
    expect(typeof result.testedAt).toBe("string");
  });

  it("skips namespace lookup and emits k8s_namespace_exists when target == self pod namespace", async () => {
    const coreApi = makeCore();
    vi.mocked(getCoreApi).mockReturnValue(coreApi as unknown as ReturnType<typeof getCoreApi>);

    const result = await testEnvironment(makeCtx());

    expect(coreApi.readNamespace).not.toHaveBeenCalled();
    expect(result.checks.find((c) => c.code === "k8s_namespace_exists")?.message).toContain("pod namespace");
  });

  it("calls readNamespace when target namespace differs from self pod namespace", async () => {
    const coreApi = makeCore();
    vi.mocked(getCoreApi).mockReturnValue(coreApi as unknown as ReturnType<typeof getCoreApi>);

    const result = await testEnvironment(makeCtx({ namespace: "ns-other" }));

    expect(coreApi.readNamespace).toHaveBeenCalledWith({ name: "ns-other" });
    expect(result.checks.find((c) => c.code === "k8s_namespace_exists")).toBeDefined();
  });
});

describe("testEnvironment — early-return paths", () => {
  it("returns fail and short-circuits when K8s API is unreachable", async () => {
    vi.mocked(getSelfPodInfo).mockRejectedValueOnce(new Error("ECONNREFUSED"));

    const result = await testEnvironment(makeCtx());

    expect(result.status).toBe("fail");
    expect(result.checks.find((c) => c.code === "k8s_api_unreachable")).toBeDefined();
    // RBAC, secret, and PVC checks should be skipped when API is unreachable
    expect(result.checks.some((c) => c.code.startsWith("k8s_rbac_"))).toBe(false);
  });
});

describe("testEnvironment — namespace warning", () => {
  it("emits warn (but proceeds) when readNamespace fails for a different namespace", async () => {
    const coreApi = makeCore({
      readNamespace: vi.fn().mockRejectedValue(new Error("forbidden")),
    });
    vi.mocked(getCoreApi).mockReturnValue(coreApi as unknown as ReturnType<typeof getCoreApi>);

    const result = await testEnvironment(makeCtx({ namespace: "ns-other" }));

    expect(result.checks.find((c) => c.code === "k8s_namespace_check_failed")).toBeDefined();
    // Should still proceed with downstream checks
    expect(result.checks.some((c) => c.code.startsWith("k8s_rbac_"))).toBe(true);
  });
});

describe("testEnvironment — RBAC", () => {
  it("emits error checks for denied verbs and degrades status to fail", async () => {
    vi.mocked(getAuthzApi).mockReturnValue(
      makeAuthz((resource, verb) => !(resource === "jobs" && verb === "create")) as unknown as ReturnType<typeof getAuthzApi>,
    );

    const result = await testEnvironment(makeCtx());

    const denied = result.checks.find((c) => c.code === "k8s_rbac_job_create");
    expect(denied?.level).toBe("error");
    expect(result.status).toBe("fail");
  });

  it("emits warn when SelfSubjectAccessReview itself throws", async () => {
    vi.mocked(getAuthzApi).mockReturnValue({
      createSelfSubjectAccessReview: vi.fn().mockRejectedValue(new Error("SSAR not available")),
    } as unknown as ReturnType<typeof getAuthzApi>);

    const result = await testEnvironment(makeCtx());

    const rbacWarns = result.checks.filter((c) => c.code.startsWith("k8s_rbac_") && c.level === "warn");
    expect(rbacWarns.length).toBeGreaterThan(0);
  });
});

describe("testEnvironment — secrets", () => {
  it("emits warn when the secret is not found", async () => {
    const coreApi = makeCore({
      readNamespacedSecret: vi.fn().mockRejectedValue(new Error("not found")),
    });
    vi.mocked(getCoreApi).mockReturnValue(coreApi as unknown as ReturnType<typeof getCoreApi>);

    const result = await testEnvironment(makeCtx());

    expect(result.checks.find((c) => c.code === "k8s_secret_missing")).toBeDefined();
    expect(result.status).toBe("warn");
  });

  it("uses configured secretRef when provided", async () => {
    const coreApi = makeCore();
    vi.mocked(getCoreApi).mockReturnValue(coreApi as unknown as ReturnType<typeof getCoreApi>);

    await testEnvironment(makeCtx({ secretRef: "custom-secret" }));

    expect(coreApi.readNamespacedSecret).toHaveBeenCalledWith({ name: "custom-secret", namespace: "ns-self" });
  });
});

describe("testEnvironment — PVC", () => {
  it("emits warn when no PVC is mounted on /paperclip", async () => {
    vi.mocked(getSelfPodInfo).mockResolvedValue({ ...SELF_POD, pvcClaimName: null });

    const result = await testEnvironment(makeCtx());

    expect(result.checks.find((c) => c.code === "k8s_pvc_not_detected")).toBeDefined();
    expect(result.status).toBe("warn");
  });

  it("emits warn when PVC access mode is not ReadWriteMany", async () => {
    const coreApi = makeCore({
      readNamespacedPersistentVolumeClaim: vi.fn().mockResolvedValue({ spec: { accessModes: ["ReadWriteOnce"] } }),
    });
    vi.mocked(getCoreApi).mockReturnValue(coreApi as unknown as ReturnType<typeof getCoreApi>);

    const result = await testEnvironment(makeCtx());

    const pvcCheck = result.checks.find((c) => c.code === "k8s_pvc_not_rwx");
    expect(pvcCheck).toBeDefined();
    expect(pvcCheck?.message).toContain("ReadWriteOnce");
    expect(result.status).toBe("warn");
  });

  it("emits warn when reading the PVC fails", async () => {
    const coreApi = makeCore({
      readNamespacedPersistentVolumeClaim: vi.fn().mockRejectedValue(new Error("api error")),
    });
    vi.mocked(getCoreApi).mockReturnValue(coreApi as unknown as ReturnType<typeof getCoreApi>);

    const result = await testEnvironment(makeCtx());

    expect(result.checks.find((c) => c.code === "k8s_pvc_check_failed")).toBeDefined();
  });
});
