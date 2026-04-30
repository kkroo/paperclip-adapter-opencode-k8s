export const type = "opencode_k8s";
export const label = "OpenCode (Kubernetes)";

import type { CLIAdapterModule } from "@paperclipai/adapter-utils";
import { formatEvent } from "./cli/format-event.js";

export const cliAdapter: CLIAdapterModule = {
  type,
  formatStdoutEvent: (line: string, debug: boolean) => {
    const formatted = formatEvent(line, debug);
    if (formatted) {
      console.log(formatted);
    }
  },
};

export const agentConfigurationDoc = `# opencode_k8s agent configuration

Adapter: opencode_k8s

Runs OpenCode inside an isolated Kubernetes Job pod instead of the main
Paperclip process. The Job inherits the container image, imagePullSecrets,
DNS config, and PVC from the running Paperclip Deployment automatically.

Core fields:
- model (string, required): OpenCode model id in provider/model format (e.g. anthropic/claude-sonnet-4-6)
- variant (string, optional): provider-specific reasoning/profile variant passed as --variant
- dangerouslySkipPermissions (boolean, optional): inject runtime config with permission.external_directory=allow; defaults to true
- instructionsFilePath (string, optional): absolute path to a markdown instructions file (e.g. AGENTS.md on the PVC); content is prepended to every run prompt as system instructions
- promptTemplate (string, optional): run prompt template
- extraArgs (string[], optional): additional CLI args appended to the opencode command
- env (object, optional): KEY=VALUE environment variables; overrides inherited vars from the Deployment

Kubernetes fields:
- namespace (string, optional): namespace for Jobs; defaults to the Deployment namespace
- image (string, optional): override container image; defaults to the running Deployment image
- imagePullPolicy (string, optional): image pull policy; default "IfNotPresent"
- kubeconfig (string, optional): absolute path to a kubeconfig file on disk; defaults to in-cluster service account auth
- resources (object, optional): { requests: { cpu, memory }, limits: { cpu, memory } }
- nodeSelector (object, optional): node selector for Job pods
- tolerations (array, optional): tolerations for Job pods
- labels (object, optional): extra labels added to Job metadata
- ttlSecondsAfterFinished (number, optional): auto-cleanup delay; default 300
- retainJobs (boolean, optional): skip cleanup on completion for debugging

Operational fields:
- timeoutSec (number, optional): run timeout in seconds; 0 means no timeout
- graceSec (number, optional): additional grace before adapter gives up after Job deadline

Inherited from Deployment (no config needed):
- ANTHROPIC_API_KEY, OPENAI_API_KEY, and other provider keys
- CLAUDE_CODE_USE_BEDROCK, AWS_REGION, AWS_BEARER_TOKEN_BEDROCK
- PAPERCLIP_API_URL
- Container image, imagePullSecrets, DNS config, PVC mount, security context

Notes:
- Session resume works via the shared /paperclip PVC (HOME=/paperclip)
- Skills configured in Paperclip have their markdown content read from the PVC and prepended to each run prompt
- Desired skills are resolved from config (paperclipSkills / paperclipRuntimeSkills) at execute time
- instructionsFilePath content is prepended before skill content, then before the task prompt
- Prompts are delivered via a busybox init container writing to an emptyDir volume
- Runtime config (permission.external_directory=allow) is written inside the Job container
- OPENCODE_DISABLE_PROJECT_CONFIG=true is always set to prevent config file pollution
`;

export { createServerAdapter } from "./server/index.js";
