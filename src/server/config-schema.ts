import type { AdapterConfigSchema } from "@paperclipai/adapter-utils";

export function getConfigSchema(): AdapterConfigSchema {
  return {
    fields: [
      // Core fields (model, promptTemplate, env, extraArgs are provided by the platform)
      {
        key: "variant",
        label: "Variant",
        type: "text",
        hint: "Provider-specific reasoning/profile variant passed as --variant",
        group: "Core",
      },
      {
        key: "dangerouslySkipPermissions",
        label: "Skip Permission Checks",
        type: "toggle",
        default: true,
        hint: "Inject runtime config with permission.external_directory=allow",
        group: "Core",
      },
      {
        key: "agentDbMode",
        label: "Agent DB Mode",
        type: "select",
        options: [
          { label: "Workspace subPath (shared workspace data PVC, survives restart)", value: "workspace_subpath" },
          { label: "Dedicated PVC (per-agent, persistent RWO)", value: "dedicated_pvc" },
          { label: "Ephemeral (emptyDir, lost on Job exit)", value: "ephemeral" },
        ],
        default: "workspace_subpath",
        hint: "workspace_subpath (default) stores the agent DB under a per-(agent, task) subdir on the shared workspace data PVC (RWX) and survives pod restarts without a single-node-attach volume; dedicated_pvc is explicit opt-in and creates a long-lived RWO PVC named opencode-db-<agentId> mounted at /opencode-db (requires agentDbStorageClass); ephemeral uses a Job-local emptyDir",
        group: "Core",
      },
      {
        key: "agentDbStorageClass",
        label: "Agent DB Storage Class",
        type: "text",
        hint: "Required when agentDbMode is dedicated_pvc — Kubernetes StorageClass name (e.g. standard, gp2, longhorn)",
        group: "Core",
      },
      {
        key: "agentDbStorageCapacity",
        label: "Agent DB Storage Capacity",
        type: "text",
        default: "1Gi",
        hint: "PVC size for the agent DB (e.g. 1Gi, 5Gi); only used when agentDbMode is dedicated_pvc",
        group: "Core",
      },

      // Kubernetes fields
      {
        key: "serviceAccountName",
        label: "Service Account",
        type: "text",
        hint: "Kubernetes ServiceAccount name for the Job pod; defaults to the namespace 'default' SA. Use a dedicated SA (e.g. paperclip-developer) when the Job needs API access.",
        group: "Kubernetes",
      },
      {
        key: "namespace",
        label: "Namespace",
        type: "text",
        hint: "Kubernetes namespace for Jobs; defaults to the Deployment namespace",
        group: "Kubernetes",
      },
      {
        key: "image",
        label: "Container Image",
        type: "text",
        hint: "Override container image; defaults to the running Deployment image",
        group: "Kubernetes",
      },
      {
        key: "imagePullPolicy",
        label: "Image Pull Policy",
        type: "select",
        options: [
          { label: "IfNotPresent", value: "IfNotPresent" },
          { label: "Always", value: "Always" },
          { label: "Never", value: "Never" },
        ],
        default: "IfNotPresent",
        group: "Kubernetes",
      },
      {
        key: "kubeconfig",
        label: "Kubeconfig Path",
        type: "text",
        hint: "Absolute path to a kubeconfig file; defaults to in-cluster service account auth",
        group: "Kubernetes",
      },
      {
        key: "resources.requests.cpu",
        label: "CPU Request",
        type: "text",
        hint: "e.g. '1000m' or '1'",
        group: "Kubernetes",
      },
      {
        key: "resources.requests.memory",
        label: "Memory Request",
        type: "text",
        hint: "e.g. '2Gi' or '2G'",
        group: "Kubernetes",
      },
      {
        key: "resources.limits.cpu",
        label: "CPU Limit",
        type: "text",
        hint: "e.g. '4000m' or '4'",
        group: "Kubernetes",
      },
      {
        key: "resources.limits.memory",
        label: "Memory Limit",
        type: "text",
        hint: "e.g. '8Gi' or '8G'",
        group: "Kubernetes",
      },
      {
        key: "compactThreshold",
        label: "Compact Threshold",
        type: "number",
        hint: "Override the model-aware auto-compact input-token threshold. Leave unset to compact at 50% of the model context window.",
        group: "Kubernetes",
      },
      {
        key: "nodeSelector",
        label: "Node Selector",
        type: "textarea",
        hint: "key=value pairs, one per line",
        group: "Kubernetes",
      },
      {
        key: "tolerations",
        label: "Tolerations",
        type: "textarea",
        hint: "JSON array of toleration objects",
        group: "Kubernetes",
      },
      {
        key: "labels",
        label: "Labels",
        type: "textarea",
        hint: "key=value pairs, one per line. Extra labels added to Job metadata.",
        group: "Kubernetes",
      },
      {
        key: "ttlSecondsAfterFinished",
        label: "TTL After Finished",
        type: "number",
        default: 300,
        hint: "Auto-cleanup delay in seconds after Job completes",
        group: "Kubernetes",
      },
      {
        key: "retainJobs",
        label: "Retain Jobs",
        type: "toggle",
        hint: "Skip cleanup on completion for debugging",
        group: "Kubernetes",
      },
      {
        key: "reattachOrphanedJobs",
        label: "Reattach Orphaned Jobs",
        type: "toggle",
        default: false,
        hint: "When a running Job for the same task is found after a server restart, reattach (stream logs and await completion) instead of blocking",
        group: "Kubernetes",
      },

      // Docker-in-Docker sidecar — opt-in. When enabled, a docker:dind
      // sidecar runs alongside the agent container and exposes
      // /var/run/docker.sock to it. Required for `docker build`,
      // `kind create cluster`, and similar tooling. Pod becomes privileged.
      {
        key: "enableDocker",
        label: "Enable Docker (DinD sidecar)",
        type: "toggle",
        default: false,
        hint: "Add a docker:dind sidecar that exposes /var/run/docker.sock to the agent. Required for `docker build` and `kind create cluster`. Pod becomes privileged.",
        group: "Docker",
      },
      {
        key: "dockerImage",
        label: "DinD Image",
        type: "text",
        hint: "Container image for the DinD sidecar (default docker:28-dind). Only used when Enable Docker is on.",
        group: "Docker",
      },
      {
        key: "dockerCpuLimit",
        label: "DinD CPU Limit",
        type: "text",
        hint: "CPU limit for the DinD sidecar (default '4'). e.g. '4', '4000m'.",
        group: "Docker",
      },
      {
        key: "dockerMemoryLimit",
        label: "DinD Memory Limit",
        type: "text",
        hint: "Memory limit for the DinD sidecar (default '8Gi'). e.g. '4Gi', '8Gi'.",
        group: "Docker",
      },

      // Operational fields (timeoutSec and graceSec are provided by the platform)
    ],
  };
}
