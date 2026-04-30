import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Regression coverage for FAR-85: the @kubernetes/client-node v1.x ApiException
 * exposes the HTTP status as `code`, not `statusCode`. The previous `isNotFound`
 * predicate only checked `statusCode`/`response.statusCode`, so real 404s were
 * never recognized — `getPvc` re-threw the 404 instead of returning null, and
 * `ensureAgentDbPvc`'s existence check died before the create path ran.
 *
 * These tests mock the underlying k8s SDK and feed `getPvc`/`deletePvc` errors
 * shaped exactly like the real ApiException so the predicate is exercised
 * end-to-end, not in isolation.
 */

vi.mock("@kubernetes/client-node", () => {
  // Reproduces the real @kubernetes/client-node v1.x ApiException shape:
  // HTTP status under `code`, plus `body` and `headers`. Defined inside the
  // factory because vi.mock() is hoisted above any module-level declarations.
  class ApiException<T> extends Error {
    code: number;
    body: T;
    headers: Record<string, string>;
    constructor(code: number, message: string, body: T, headers: Record<string, string> = {}) {
      super(`HTTP-Code: ${code}\nMessage: ${message}\nBody: ${JSON.stringify(body)}`);
      this.code = code;
      this.body = body;
      this.headers = headers;
    }
  }
  class KubeConfig {
    loadFromCluster = mockLoadFromCluster;
    loadFromFile = mockLoadFromFile;
    makeApiClient() {
      return {
        readNamespacedPersistentVolumeClaim: mockReadNamespacedPVC,
        deleteNamespacedPersistentVolumeClaim: mockDeleteNamespacedPVC,
        createNamespacedPersistentVolumeClaim: mockCreateNamespacedPVC,
        readNamespacedPod: mockReadNamespacedPod,
      };
    }
  }
  return {
    KubeConfig,
    CoreV1Api: class {},
    BatchV1Api: class {},
    AuthorizationV1Api: class {},
    Log: class {},
    ApiException,
  };
});

const mockReadNamespacedPVC = vi.fn();
const mockDeleteNamespacedPVC = vi.fn();
const mockCreateNamespacedPVC = vi.fn();
const mockReadNamespacedPod = vi.fn();
const mockLoadFromCluster = vi.fn();
const mockLoadFromFile = vi.fn();
const mockReadFileSync = vi.fn();

vi.mock("node:fs", () => ({
  readFileSync: (...args: unknown[]) => mockReadFileSync(...args),
}));

import * as k8s from "@kubernetes/client-node";
import { getPvc, createPvc, deletePvc, getSelfPodInfo, resetCache } from "./k8s-client.js";

const ApiException = (k8s as unknown as { ApiException: new <T>(code: number, message: string, body: T, headers?: Record<string, string>) => Error & { code: number; body: T } }).ApiException;

beforeEach(() => {
  resetCache();
  vi.resetAllMocks();
});

describe("getPvc — 404 detection (FAR-85 regression)", () => {
  const NAMESPACE = "paperclip";
  const NAME = "opencode-db-test";

  it("returns the PVC on success", async () => {
    const pvc = { metadata: { name: NAME, namespace: NAMESPACE } };
    mockReadNamespacedPVC.mockResolvedValue(pvc);
    const result = await getPvc(NAMESPACE, NAME);
    expect(result).toEqual(pvc);
    expect(mockReadNamespacedPVC).toHaveBeenCalledWith({ name: NAME, namespace: NAMESPACE });
  });

  it("returns null when the SDK throws ApiException with code=404 (v1.x shape)", async () => {
    mockReadNamespacedPVC.mockRejectedValue(
      new ApiException(404, "Unknown API Status Code!", {
        kind: "Status",
        status: "Failure",
        message: `persistentvolumeclaims "${NAME}" not found`,
        reason: "NotFound",
        code: 404,
      }),
    );
    const result = await getPvc(NAMESPACE, NAME);
    expect(result).toBeNull();
  });

  it("returns null for legacy errors with statusCode=404", async () => {
    mockReadNamespacedPVC.mockRejectedValue(Object.assign(new Error("not found"), { statusCode: 404 }));
    expect(await getPvc(NAMESPACE, NAME)).toBeNull();
  });

  it("returns null for legacy errors with response.statusCode=404", async () => {
    mockReadNamespacedPVC.mockRejectedValue(Object.assign(new Error("not found"), { response: { statusCode: 404 } }));
    expect(await getPvc(NAMESPACE, NAME)).toBeNull();
  });

  it("re-throws non-404 ApiException (e.g. 500)", async () => {
    const err = new ApiException(500, "Internal Error", { message: "boom" });
    mockReadNamespacedPVC.mockRejectedValue(err);
    await expect(getPvc(NAMESPACE, NAME)).rejects.toBe(err);
  });

  it("re-throws 403 (Forbidden) — must not be silently masked as missing", async () => {
    const err = new ApiException(403, "Forbidden", { message: "rbac denied" });
    mockReadNamespacedPVC.mockRejectedValue(err);
    await expect(getPvc(NAMESPACE, NAME)).rejects.toBe(err);
  });
});

describe("deletePvc — 404 detection", () => {
  const NAMESPACE = "paperclip";
  const NAME = "opencode-db-test";

  it("swallows ApiException with code=404 (already gone)", async () => {
    mockDeleteNamespacedPVC.mockRejectedValue(
      new ApiException(404, "Unknown API Status Code!", { reason: "NotFound" }),
    );
    await expect(deletePvc(NAMESPACE, NAME)).resolves.toBeUndefined();
  });

  it("re-throws non-404 errors", async () => {
    const err = new ApiException(409, "Conflict", { reason: "Conflict" });
    mockDeleteNamespacedPVC.mockRejectedValue(err);
    await expect(deletePvc(NAMESPACE, NAME)).rejects.toBe(err);
  });
});

describe("createPvc — passes through to SDK", () => {
  it("forwards the spec to createNamespacedPersistentVolumeClaim", async () => {
    const spec = {
      apiVersion: "v1",
      kind: "PersistentVolumeClaim",
      metadata: { name: "opencode-db-x", namespace: "paperclip" },
      spec: { accessModes: ["ReadWriteOnce"], resources: { requests: { storage: "1Gi" } } },
    };
    mockCreateNamespacedPVC.mockResolvedValue(spec);
    const result = await createPvc("paperclip", spec as never);
    expect(result).toEqual(spec);
    expect(mockCreateNamespacedPVC).toHaveBeenCalledWith({ namespace: "paperclip", body: spec });
  });
});

describe("getSelfPodInfo", () => {
  const HOSTNAME = "paperclip-test-pod";
  const NAMESPACE = "paperclip-test";

  beforeEach(() => {
    process.env.HOSTNAME = HOSTNAME;
    delete process.env.PAPERCLIP_NAMESPACE;
    delete process.env.POD_NAMESPACE;
    mockReadFileSync.mockReturnValue(NAMESPACE);
  });

  function basePod(overrides: Record<string, unknown> = {}) {
    return {
      spec: {
        containers: [
          {
            name: "paperclip",
            image: "paperclip:1.0",
            env: [
              { name: "FOO", value: "bar" },
              { name: "SECRET_REF", valueFrom: { secretKeyRef: { name: "s", key: "k" } } },
            ],
            envFrom: [{ configMapRef: { name: "cm" } }],
            volumeMounts: [
              { name: "data", mountPath: "/paperclip" },
              { name: "tls-secret", mountPath: "/etc/tls" },
            ],
          },
        ],
        volumes: [
          { name: "data", persistentVolumeClaim: { claimName: "paperclip-pvc" } },
          { name: "tls-secret", secret: { secretName: "tls", defaultMode: 0o400 } },
        ],
        imagePullSecrets: [{ name: "registry-creds" }, { name: "" }, {}],
        dnsConfig: { nameservers: ["10.0.0.10"] },
        nodeSelector: { workload: "paperclip" },
        tolerations: [{ key: "dedicated", operator: "Equal", value: "paperclip", effect: "NoSchedule" }],
        ...overrides,
      },
    };
  }

  it("introspects the pod and extracts image, env, PVC, secrets, dnsConfig", async () => {
    mockReadNamespacedPod.mockResolvedValue(basePod());
    const info = await getSelfPodInfo();
    expect(info.namespace).toBe(NAMESPACE);
    expect(info.image).toBe("paperclip:1.0");
    expect(info.pvcClaimName).toBe("paperclip-pvc");
    expect(info.inheritedEnv).toEqual({ FOO: "bar" });
    expect(info.inheritedEnvValueFrom).toHaveLength(1);
    expect(info.inheritedEnvValueFrom[0].name).toBe("SECRET_REF");
    expect(info.inheritedEnvFrom).toHaveLength(1);
    expect(info.secretVolumes).toEqual([
      { volumeName: "tls-secret", secretName: "tls", mountPath: "/etc/tls", defaultMode: 0o400 },
    ]);
    // imagePullSecrets with empty name are filtered out
    expect(info.imagePullSecrets).toEqual([{ name: "registry-creds" }]);
    expect(info.dnsConfig).toEqual({ nameservers: ["10.0.0.10"] });
    expect(info.nodeSelector).toEqual({ workload: "paperclip" });
    expect(info.tolerations).toEqual([
      { key: "dedicated", operator: "Equal", value: "paperclip", effect: "NoSchedule" },
    ]);
    expect(mockReadNamespacedPod).toHaveBeenCalledWith({ name: HOSTNAME, namespace: NAMESPACE });
  });

  it("caches the result — second call does not re-query the API", async () => {
    mockReadNamespacedPod.mockResolvedValue(basePod());
    await getSelfPodInfo();
    await getSelfPodInfo();
    expect(mockReadNamespacedPod).toHaveBeenCalledTimes(1);
  });

  it("prefers PAPERCLIP_NAMESPACE env over service-account file", async () => {
    process.env.PAPERCLIP_NAMESPACE = "from-env";
    mockReadNamespacedPod.mockResolvedValue(basePod());
    const info = await getSelfPodInfo();
    expect(info.namespace).toBe("from-env");
    expect(mockReadFileSync).not.toHaveBeenCalled();
  });

  it("falls back to POD_NAMESPACE when PAPERCLIP_NAMESPACE not set", async () => {
    process.env.POD_NAMESPACE = "downward-api";
    mockReadNamespacedPod.mockResolvedValue(basePod());
    const info = await getSelfPodInfo();
    expect(info.namespace).toBe("downward-api");
  });

  it("falls back to 'default' when service-account file read throws", async () => {
    mockReadFileSync.mockImplementation(() => {
      throw new Error("ENOENT");
    });
    mockReadNamespacedPod.mockResolvedValue(basePod());
    const info = await getSelfPodInfo();
    expect(info.namespace).toBe("default");
  });

  it("throws when HOSTNAME is not set", async () => {
    delete process.env.HOSTNAME;
    await expect(getSelfPodInfo()).rejects.toThrow("HOSTNAME env var not set");
  });

  it("throws when pod has no spec", async () => {
    mockReadNamespacedPod.mockResolvedValue({ spec: null });
    await expect(getSelfPodInfo()).rejects.toThrow("has no spec");
  });

  it("throws when main container has no image", async () => {
    mockReadNamespacedPod.mockResolvedValue({
      spec: { containers: [{ name: "paperclip", image: "" }] },
    });
    await expect(getSelfPodInfo()).rejects.toThrow("has no container image");
  });

  it("falls back to first container when no container is named 'paperclip'", async () => {
    mockReadNamespacedPod.mockResolvedValue({
      spec: { containers: [{ name: "other", image: "other:1.0" }] },
    });
    const info = await getSelfPodInfo();
    expect(info.image).toBe("other:1.0");
  });

  it("returns null pvcClaimName when no /paperclip mount exists", async () => {
    mockReadNamespacedPod.mockResolvedValue({
      spec: { containers: [{ name: "paperclip", image: "p:1", volumeMounts: [] }] },
    });
    const info = await getSelfPodInfo();
    expect(info.pvcClaimName).toBeNull();
  });

  it("returns null pvcClaimName when /paperclip mount is not backed by a PVC", async () => {
    mockReadNamespacedPod.mockResolvedValue({
      spec: {
        containers: [{ name: "paperclip", image: "p:1", volumeMounts: [{ name: "data", mountPath: "/paperclip" }] }],
        volumes: [{ name: "data", emptyDir: {} }],
      },
    });
    const info = await getSelfPodInfo();
    expect(info.pvcClaimName).toBeNull();
  });

  it("uses kubeconfig file path when provided (not in-cluster)", async () => {
    mockReadNamespacedPod.mockResolvedValue(basePod());
    await getSelfPodInfo("/tmp/kubeconfig.yaml");
    expect(mockLoadFromFile).toHaveBeenCalledWith("/tmp/kubeconfig.yaml");
    expect(mockLoadFromCluster).not.toHaveBeenCalled();
  });
});
