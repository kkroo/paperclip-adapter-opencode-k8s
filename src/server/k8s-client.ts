import * as k8s from "@kubernetes/client-node";
import { readFileSync } from "node:fs";

/**
 * Cached self-pod introspection result. Queried once on first execute(),
 * then reused for all subsequent Job builds so every Job inherits the
 * Deployment's image, imagePullSecrets, DNS config, PVC claim, and scheduling.
 */
export interface SelfPodSecretVolume {
  volumeName: string;
  secretName: string;
  mountPath: string;
  defaultMode: number | undefined;
}

export interface SelfPodInfo {
  namespace: string;
  image: string;
  imagePullSecrets: Array<{ name: string }>;
  dnsConfig: k8s.V1PodDNSConfig | undefined;
  nodeSelector: Record<string, string>;
  tolerations: k8s.V1Toleration[];
  pvcClaimName: string | null;
  secretVolumes: SelfPodSecretVolume[];
  /** Env vars with literal values from the container spec. */
  inheritedEnv: Record<string, string>;
  /** Env vars backed by secretKeyRef/configMapKeyRef/fieldRef (valueFrom). */
  inheritedEnvValueFrom: k8s.V1EnvVar[];
  /** Whole-Secret/ConfigMap env sources (envFrom) from the container spec. */
  inheritedEnvFrom: k8s.V1EnvFromSource[];
}

let cachedSelfPod: SelfPodInfo | null = null;

/**
 * Cache keyed by kubeconfig path (empty string = in-cluster).
 * Supports multiple agents with different kubeconfigs.
 */
const kcCache = new Map<string, k8s.KubeConfig>();

function getKubeConfig(kubeconfigPath?: string): k8s.KubeConfig {
  const key = kubeconfigPath ?? "";
  let kc = kcCache.get(key);
  if (!kc) {
    kc = new k8s.KubeConfig();
    if (kubeconfigPath) {
      kc.loadFromFile(kubeconfigPath);
    } else {
      // Bare loadFromCluster() throws ENOENT on
      // /var/run/secrets/kubernetes.io/serviceaccount/ca.crt when the pod's
      // ServiceAccount token isn't mounted. That message buried the real
      // misconfiguration (Helm serviceAccount.automountToken=false) in
      // adapter logs, so swap it for an actionable error.
      if (!process.env.KUBERNETES_SERVICE_HOST) {
        throw new Error(
          "opencode_k8s: in-cluster auth unavailable — KUBERNETES_SERVICE_HOST is unset (not running in a Kubernetes pod) and no kubeconfig path was provided",
        );
      }
      try {
        kc.loadFromCluster();
      } catch (err) {
        const cause = err instanceof Error ? err.message : String(err);
        throw new Error(
          `opencode_k8s: failed to load in-cluster kubeconfig — the pod's ServiceAccount token is not mounted (set Helm serviceAccount.automountToken=true and rbac.create=true). Underlying error: ${cause}`,
        );
      }
    }
    kcCache.set(key, kc);
  }
  return kc;
}

export function getBatchApi(kubeconfigPath?: string): k8s.BatchV1Api {
  return getKubeConfig(kubeconfigPath).makeApiClient(k8s.BatchV1Api);
}

export function getCoreApi(kubeconfigPath?: string): k8s.CoreV1Api {
  return getKubeConfig(kubeconfigPath).makeApiClient(k8s.CoreV1Api);
}

export function getAuthzApi(kubeconfigPath?: string): k8s.AuthorizationV1Api {
  return getKubeConfig(kubeconfigPath).makeApiClient(k8s.AuthorizationV1Api);
}

export function getLogApi(kubeconfigPath?: string): k8s.Log {
  return new k8s.Log(getKubeConfig(kubeconfigPath));
}

/**
 * Read the current pod's namespace. Checks (in order):
 * 1. PAPERCLIP_NAMESPACE env var (set explicitly in Deployment)
 * 2. Service account namespace file (standard in-cluster path)
 * 3. POD_NAMESPACE env var (Downward API convention)
 * Falls back to "default" only if none of the above are available.
 */
function readInClusterNamespace(): string {
  const fromEnv = process.env.PAPERCLIP_NAMESPACE ?? process.env.POD_NAMESPACE;
  if (fromEnv?.trim()) return fromEnv.trim();
  try {
    return readFileSync("/var/run/secrets/kubernetes.io/serviceaccount/namespace", "utf-8").trim();
  } catch {
    return "default";
  }
}

/**
 * Query the K8s API for our own pod spec and cache the result.
 * Extracts image, imagePullSecrets, dnsConfig, scheduling, PVC claim name,
 * and environment variables to forward to Job pods.
 */
export async function getSelfPodInfo(kubeconfigPath?: string): Promise<SelfPodInfo> {
  if (cachedSelfPod) return cachedSelfPod;

  const hostname = process.env.HOSTNAME;
  if (!hostname) {
    throw new Error("claude_k8s: HOSTNAME env var not set — cannot introspect running pod");
  }

  const namespace = readInClusterNamespace();
  const coreApi = getCoreApi(kubeconfigPath);
  const pod = await coreApi.readNamespacedPod({ name: hostname, namespace });

  const spec = pod.spec;
  if (!spec) {
    throw new Error(`claude_k8s: pod ${hostname} has no spec`);
  }

  const mainContainer =
    spec.containers.find((c) => c.name === "paperclip") ?? spec.containers[0];
  if (!mainContainer?.image) {
    throw new Error(`claude_k8s: pod ${hostname} has no container image`);
  }

  // Find PVC claim name from volumes mounted at /paperclip
  let pvcClaimName: string | null = null;
  const dataMount = mainContainer.volumeMounts?.find(
    (vm) => vm.mountPath === "/paperclip",
  );
  if (dataMount) {
    const volume = spec.volumes?.find((v) => v.name === dataMount.name);
    pvcClaimName = volume?.persistentVolumeClaim?.claimName ?? null;
  }

  // Discover secret volumes mounted on the main container
  const secretVolumes: SelfPodSecretVolume[] = [];
  for (const vm of mainContainer.volumeMounts ?? []) {
    const vol = spec.volumes?.find((v) => v.name === vm.name);
    if (vol?.secret?.secretName) {
      secretVolumes.push({
        volumeName: vm.name,
        secretName: vol.secret.secretName,
        mountPath: vm.mountPath,
        defaultMode: vol.secret.defaultMode,
      });
    }
  }

  // Collect env vars from the pod spec container definition.
  // Literal-value vars go into inheritedEnv (forwarded as plain strings).
  // valueFrom vars (secretKeyRef, configMapKeyRef, fieldRef) are kept as
  // V1EnvVar objects so the Job pod can resolve them at runtime.
  // envFrom entries (whole-Secret/ConfigMap mounts) are forwarded as-is.
  const inheritedEnv: Record<string, string> = {};
  const inheritedEnvValueFrom: k8s.V1EnvVar[] = [];
  for (const envVar of mainContainer.env ?? []) {
    if (envVar.value !== undefined) {
      inheritedEnv[envVar.name] = envVar.value;
    } else if (envVar.valueFrom) {
      inheritedEnvValueFrom.push({ name: envVar.name, valueFrom: envVar.valueFrom });
    }
  }
  const inheritedEnvFrom: k8s.V1EnvFromSource[] = [...(mainContainer.envFrom ?? [])];

  cachedSelfPod = {
    namespace,
    image: mainContainer.image,
    imagePullSecrets: (spec.imagePullSecrets ?? []).map((s) => ({
      name: s.name ?? "",
    })).filter((s) => s.name.length > 0),
    dnsConfig: spec.dnsConfig,
    nodeSelector: { ...(spec.nodeSelector ?? {}) },
    tolerations: [...(spec.tolerations ?? [])],
    pvcClaimName,
    secretVolumes,
    inheritedEnv,
    inheritedEnvValueFrom,
    inheritedEnvFrom,
  };

  return cachedSelfPod;
}

/** Reset cached state — useful for tests. */
export function resetCache(): void {
  kcCache.clear();
  cachedSelfPod = null;
}

function isNotFound(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const asAny = err as unknown as Record<string, unknown>;
  // @kubernetes/client-node v1.x ApiException exposes HTTP status as `code`.
  if (typeof asAny.code === "number" && asAny.code === 404) return true;
  if (typeof asAny.statusCode === "number" && asAny.statusCode === 404) return true;
  const resp = asAny.response as Record<string, unknown> | undefined;
  return typeof resp?.statusCode === "number" && resp.statusCode === 404;
}

/** Returns the PVC if it exists, or null if not found. Throws on other errors. */
export async function getPvc(
  namespace: string,
  name: string,
  kubeconfigPath?: string,
): Promise<k8s.V1PersistentVolumeClaim | null> {
  try {
    return await getCoreApi(kubeconfigPath).readNamespacedPersistentVolumeClaim({ name, namespace });
  } catch (err) {
    if (isNotFound(err)) return null;
    throw err;
  }
}

export async function createPvc(
  namespace: string,
  spec: k8s.V1PersistentVolumeClaim,
  kubeconfigPath?: string,
): Promise<k8s.V1PersistentVolumeClaim> {
  return getCoreApi(kubeconfigPath).createNamespacedPersistentVolumeClaim({ namespace, body: spec });
}

/** Deletes a PVC, ignoring 404 (already gone). */
export async function deletePvc(
  namespace: string,
  name: string,
  kubeconfigPath?: string,
): Promise<void> {
  try {
    await getCoreApi(kubeconfigPath).deleteNamespacedPersistentVolumeClaim({ name, namespace });
  } catch (err) {
    if (!isNotFound(err)) throw err;
  }
}
