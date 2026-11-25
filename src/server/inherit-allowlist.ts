/**
 * Allowlist for values copied from the Paperclip server pod into an agent Job.
 *
 * The server pod contains control-plane credentials. Agent prompts can include
 * attacker-controlled text, so inheritance is an allowlist boundary rather
 * than a denylist. Keep this policy code-reviewed and do not add a config
 * escape hatch: adapter configuration is writable through the control plane.
 */

/** Credentials and direct control-plane access that must never reach a Job. */
export const SERVER_ONLY_ENV_DENY: ReadonlySet<string> = new Set([
  "PAPERCLIP_AGENT_JWT_SECRET",
  "DATABASE_URL",
  "PAPERCLIP_MASTER_KEY_SEED",
  "GITHUB_APP_PRIVATE_KEY",
  "GITHUB_APP_ID",
  "GITHUB_APP_INSTALLATION_ID",
  "GITHUB_WEBHOOK_SECRET",
  "PAPERCLIP_DEX_OIDC_CLIENT_SECRET",
  "PAPERCLIP_ALERTMANAGER_WEBHOOK_TOKEN",
]);

/** Exact names consumed by the Paperclip/OpenCode runtime. */
export const AGENT_ENV_ALLOWLIST: ReadonlySet<string> = new Set([
  "PAPERCLIP_API_URL",
  "PAPERCLIP_PUBLIC_URL",
  "PAPERCLIP_HOME",
  "PAPERCLIP_INSTANCE_ID",
  "PATH",
  "NODE_OPTIONS",
  "PAPERCLIP_GITHUB_TOKEN_FILE",
  "PAPERCLIP_GBRAIN_AUTHBOT_SERVICE_KEY_FILE",
  "PAPERCLIP_GBRAIN_OAUTH_CLIENTS_URL",
  "PAPERCLIP_CODEX_PROVIDERS",
  "PAPERCLIP_CODEX_USE_HOST_HOME",
  "PAPERCLIP_OPENCODE_MODEL_ALLOWLIST",
  // Non-secret runtime mode inherited by the base image.
  "NODE_ENV",
  // The Penstock launcher reads this exact Secret-backed value. Do not widen
  // this to PENSTOCK_*; adjacent names can carry runtime/control-plane data.
  "PENSTOCK_API_KEY",
  "GOCACHE",
  "GOMODCACHE",
  "BUN_INSTALL_CACHE",
  "PIP_CACHE_DIR",
  "PLAYWRIGHT_BROWSERS_PATH",
  "XDG_CACHE_HOME",
  "npm_config_cache",
]);

/** Provider SDK families needed by supported deployments. */
export const AGENT_ENV_ALLOWED_PREFIXES: readonly string[] = [
  "ANTHROPIC_",
  "OPENAI_",
  "AZURE_OPENAI_",
  "AWS_",
  "GOOGLE_",
  "VERTEX_",
  "CLAUDE_CODE_",
];

/** Secret volumes intentionally exposed to agent Jobs. */
export const AGENT_SECRET_VOLUME_ALLOWLIST: ReadonlySet<string> = new Set([
  "authbot-mcp-consumer-service-keys",
  "paperclip-github-mcp-token",
]);

/** Whole-object env injection is denied because its keys are not inspectable. */
export const AGENT_ENV_FROM_ALLOWLIST: ReadonlySet<string> = new Set([]);

export function isAgentInheritableEnvName(name: string): boolean {
  if (SERVER_ONLY_ENV_DENY.has(name)) return false;
  if (AGENT_ENV_ALLOWLIST.has(name)) return true;
  return AGENT_ENV_ALLOWED_PREFIXES.some((prefix) => name.startsWith(prefix));
}

export function isAgentInheritableSecretVolume(secretName: string): boolean {
  return AGENT_SECRET_VOLUME_ALLOWLIST.has(secretName);
}

export function isAgentInheritableEnvFromRef(refName: string): boolean {
  return AGENT_ENV_FROM_ALLOWLIST.has(refName);
}
