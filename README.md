# OpenCode (Kubernetes) Paperclip Adapter Plugin

Paperclip adapter plugin that runs OpenCode agents as isolated Kubernetes Jobs instead of inside the main Paperclip process.

## Features

- Spawns agent runs as K8s Jobs with full pod isolation
- Inherits container image, secrets, DNS, and PVC from the Paperclip Deployment automatically
- Real-time log streaming from Job pods back to the Paperclip UI with automatic reconnect and replay deduplication
- Session resume via shared RWX PVC
- Per-agent concurrency guard
- Skills bundle injection — skill markdown content prepended to each run prompt at execution time
- Optional per-agent database PVC (`agentDbMode: dedicated_pvc`) for persistent agent state across runs
- Optional external launcher support for Caveman/Penstock routing
- Optional Ponytail plugin wiring with explicit mode selection
- Configurable resources, namespace, kubeconfig, node selectors, and tolerations
- Runtime config injection for permission bypass

## Prerequisites

Before installing this adapter, ensure the following requirements are met.

### 1. Shared ReadWriteMany (RWX) PersistentVolumeClaim

**This is the most critical requirement.** The Paperclip Deployment and every agent Job pod must share the same filesystem at `/paperclip`. This requires a PVC with `ReadWriteMany` access mode.

The adapter discovers the PVC by introspecting the running Paperclip pod — it finds the volume mounted at `/paperclip` and reuses the same claim name for all spawned Jobs. There is no config field for the PVC name; it is always auto-detected.

**Why RWX?** The Paperclip Deployment pod and multiple concurrent agent Job pods all need simultaneous read/write access to the same volume. A `ReadWriteOnce` PVC will cause Job pods to fail to schedule.

Example PVC:

```yaml
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: paperclip-data
  namespace: paperclip
spec:
  accessModes:
    - ReadWriteMany
  storageClassName: your-rwx-storage-class   # e.g. efs-sc, nfs-csi, azurefile-csi
  resources:
    requests:
      storage: 50Gi
```

The Paperclip Deployment must mount this PVC at `/paperclip`:

```yaml
# Excerpt from the Paperclip Deployment spec
volumes:
  - name: data
    persistentVolumeClaim:
      claimName: paperclip-data
containers:
  - name: paperclip
    volumeMounts:
      - name: data
        mountPath: /paperclip
```

> **Note:** Your cluster must have a StorageClass that supports RWX volumes. Common options include Longhorn, Rook Ceph, AWS EFS, Azure Files, NFS-based provisioners, or GCP Filestore. Standard block storage (gp3, Azure Disk, GCE PD) does **not** support RWX.

### 2. Kubernetes RBAC

The Paperclip Deployment's service account needs permissions to create and manage Jobs, list Pods, and stream Pod logs. Apply the following Role and RoleBinding in the namespace where agent Jobs will run.

```yaml
apiVersion: v1
kind: ServiceAccount
metadata:
  name: paperclip
  namespace: paperclip
---
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  name: paperclip-adapter
  namespace: paperclip
rules:
  # Create, inspect, and clean up agent Jobs
  - apiGroups: ["batch"]
    resources: ["jobs"]
    verbs: ["create", "get", "delete"]

  # List pods spawned by Jobs (label selector: job-name=<name>)
  - apiGroups: [""]
    resources: ["pods"]
    verbs: ["list"]

  # Stream and read logs from agent pods
  - apiGroups: [""]
    resources: ["pods/log"]
    verbs: ["get"]

  # Verify the target namespace exists (optional — only needed
  # when targeting a namespace other than the Deployment's own)
  - apiGroups: [""]
    resources: ["namespaces"]
    verbs: ["get"]

  # Verify the RWX PVC; create/delete per-agent DB PVCs (agentDbMode: dedicated_pvc)
  - apiGroups: [""]
    resources: ["persistentvolumeclaims"]
    verbs: ["get", "create", "delete"]

  # Create/delete per-run prompt, environment, and MCP Secrets; patch owner references
  - apiGroups: [""]
    resources: ["secrets"]
    verbs: ["create", "delete", "get", "patch"]

  # RBAC self-test during adapter validation
  - apiGroups: ["authorization.k8s.io"]
    resources: ["selfsubjectaccessreviews"]
    verbs: ["create"]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: paperclip-adapter
  namespace: paperclip
subjects:
  - kind: ServiceAccount
    name: paperclip
    namespace: paperclip
roleRef:
  kind: Role
  name: paperclip-adapter
  apiGroup: rbac.authorization.k8s.io
```

Then reference the service account in your Paperclip Deployment:

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: paperclip
  namespace: paperclip
spec:
  template:
    spec:
      serviceAccountName: paperclip
      # ... containers, volumes, etc.
```

> **Scoping note:** If agent Jobs run in the same namespace as the Paperclip Deployment (the default), a namespace-scoped `Role` + `RoleBinding` is sufficient. If you configure Jobs to run in a different namespace, use a `ClusterRole` + `ClusterRoleBinding` or create the Role in the target namespace with a cross-namespace RoleBinding.

### 3. Additional Cluster Requirements

- **Kubernetes 1.25+** — the adapter uses `batch/v1` Jobs with `ttlSecondsAfterFinished` for automatic cleanup.
- **In-cluster authentication** — the Deployment pod must have a mounted service account token (default for all pods). Alternatively, set the `kubeconfig` config field for out-of-cluster access.
- **Image pull secrets** — if your container images are in a private registry, configure `imagePullSecrets` on the Paperclip Deployment. The adapter automatically forwards these to all spawned Job pods.
- **DNS config** — custom DNS settings on the Paperclip Deployment are automatically inherited by Job pods.

## Installation

### Via Paperclip Adapter Manager

```bash
curl -X POST http://localhost:3100/api/adapters \
  -H "Content-Type: application/json" \
  -d '{"packageName": "@farhoodliquor/paperclip-adapter-opencode-k8s"}'
```

### Local Development

```bash
curl -X POST http://localhost:3100/api/adapters \
  -H "Content-Type: application/json" \
  -d '{"localPath": "/path/to/paperclip-adapter-opencode-k8s"}'
```

## Configuration

Agent-level configuration fields:

**Core**

| Field | Required | Default | Description |
|-------|----------|---------|-------------|
| `model` | **yes** | — | OpenCode model in `provider/model` format |
| `variant` | no | — | Reasoning profile variant |
| `agentCommand` | no | `opencode` | One executable used to launch OpenCode; set to the reviewed Caveman/Penstock launcher to route through Penstock |
| `ponytailPluginPath` | no | — | Absolute path to the installed Ponytail `.mjs` plugin file |
| `ponytailDefaultMode` | no | — | `off`, `lite`, `full`, or `ultra`; explicit `PONYTAIL_DEFAULT_MODE` takes precedence |
| `instructionsFilePath` | no | — | Absolute path to a markdown file prepended to every run prompt (e.g. `/paperclip/.claude/projects/COMPANY/agents/AGENT/AGENTS.md`) |
| `dangerouslySkipPermissions` | no | `true` | Inject runtime config granting `permission.external_directory=allow` |
| `agentDbMode` | no | `ephemeral` | `ephemeral` (emptyDir, lost on exit) or `dedicated_pvc` (per-agent RWX PVC at `/opencode-db`) |
| `agentDbStorageClass` | no | Cluster default | StorageClass for dedicated agent DB PVC |
| `agentDbStorageCapacity` | no | `10Gi` | Storage size for dedicated agent DB PVC |

**Kubernetes**

| Field | Required | Default | Description |
|-------|----------|---------|-------------|
| `namespace` | no | Deployment namespace | K8s namespace for agent Jobs |
| `image` | no | Deployment image | Override container image for Jobs |
| `opencodeVersion` | no | `1.18.35` | Exact `opencode-ai` version Job pods install once onto the data PVC and run (`"image"` = use the binary bundled in the container image) |
| `imagePullPolicy` | no | — | Image pull policy for Job pods |
| `kubeconfig` | no | In-cluster | Path to kubeconfig file |
| `serviceAccountName` | no | Default SA | Service account for Job pods |
| `resources` | no | See below | CPU/memory requests and limits |
| `nodeSelector` | no | — | Node selector key=value pairs (one per line) |
| `tolerations` | no | — | Pod tolerations in YAML format |
| `ttlSecondsAfterFinished` | no | `300` | Seconds before completed Jobs are auto-deleted |
| `retainJobs` | no | `false` | Keep completed Jobs for debugging (disables TTL) |
| `reattachOrphanedJobs` | no | `false` | Resume streaming if a matching Job is already running after adapter restart |

**Operational**

| Field | Required | Default | Description |
|-------|----------|---------|-------------|
| `timeoutSec` | no | `0` (none) | Run timeout in seconds |
| `graceSec` | no | `30` | Grace period after timeout before forceful termination |
| `env` | no | — | Additional environment variables for Jobs |

Credential-shaped literal environment values are placed in a per-run Kubernetes
Secret and referenced from the Job with `secretKeyRef`. Keep provider and
Penstock credentials in Paperclip/Kubernetes secret bindings rather than source,
adapter metadata, or comments. External launcher mode leaves OpenCode's own
auth files untouched because the configured launcher owns authentication.

### Default Resource Requests and Limits

If not overridden, agent Job pods use:

```yaml
resources:
  requests:
    cpu: "1000m"
    memory: "2Gi"
  limits:
    cpu: "4000m"
    memory: "8Gi"
```

## How It Works

1. **Self-introspection** — on first run, the adapter reads the Paperclip Deployment pod's own spec to discover the PVC claim name, mounted secrets, image pull secrets, DNS config, and environment variables. This is cached for all subsequent runs in the same process.
2. **Concurrency guard** — only one Job per agent is allowed at a time, enforced via K8s label selectors before Job creation.
3. **Prompt assembly** — instructions file, skills markdown bundle, bootstrap prompt, session handoff, and heartbeat are concatenated in order. Prompts under 256 KiB are delivered via environment variable; larger prompts are written to a K8s Secret and copied into the pod by a busybox init container.
4. **Agent DB PVC** — if `agentDbMode: dedicated_pvc`, a per-agent RWX PVC named `opencode-db-{agentId}` is created if it does not exist, then mounted at `/opencode-db` with `OPENCODE_DB=/opencode-db`.
5. **Job creation** — a Kubernetes Job is created in the target namespace. The Job pod mounts the shared RWX PVC at `/paperclip`, inherits all secrets and env vars, and runs the OpenCode agent.
6. **Log streaming** — the adapter streams stdout/stderr from the Job pod back to the Paperclip UI in real time, with automatic reconnect on K8s API drops and replay deduplication to avoid duplicate output.
7. **Cleanup** — completed Jobs are automatically deleted after `ttlSecondsAfterFinished` seconds (default 300), or retained if `retainJobs` is enabled.

### Caveman and Ponytail

Set `agentCommand` to the absolute path of the reviewed Penstock runtime (for
example `/opt/penstock/bin/penstock-agent-runtime.mjs`). The adapter passes
native
OpenCode arguments after that executable, sets `PENSTOCK_AGENT_COMMAND=opencode`,
and defaults `PENSTOCK_PROVIDER=openai`; an explicit provider environment value
wins. `ponytailPluginPath` must point at the packaged Ponytail module (for
example `/opt/penstock/ponytail/.opencode/plugins/ponytail.mjs`) and is written
into both the normal XDG OpenCode config and the `OPENCODE_CONFIG` override used
when MCP configuration is present.

This wiring does not install either asset or claim that a Paperclip image ships
them. Verify the runtime and plugin paths in the exact Job image, then run one
non-production smoke task before enabling heartbeats.

### Security Context

All Job pods run with a locked-down security context:

- `runAsUser: 1000`, `runAsGroup: 1000`, `fsGroup: 1000`
- `runAsNonRoot: true`
- `allowPrivilegeEscalation: false`
- All Linux capabilities dropped
- `fsGroupChangePolicy: OnRootMismatch` for volume permission handling

## Dependencies

- `@kubernetes/client-node` ^1.0.0
- `@paperclipai/adapter-utils` >=2026.415.0-canary.7 (peer dependency)

## License

MIT
