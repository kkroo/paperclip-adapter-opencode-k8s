import { createHash } from "node:crypto";
import os from "node:os";
import type { AdapterModel } from "@paperclipai/adapter-utils";
import { asString, ensurePathInEnv, runChildProcess } from "@paperclipai/adapter-utils/server-utils";

export const STATIC_MODELS: AdapterModel[] = [
  { id: "anthropic/claude-opus-5", label: "anthropic/claude-opus-5" },
  { id: "anthropic/claude-opus-4-7", label: "anthropic/claude-opus-4-7" },
  { id: "anthropic/claude-sonnet-4-6", label: "anthropic/claude-sonnet-4-6" },
  { id: "anthropic/claude-haiku-4-5", label: "anthropic/claude-haiku-4-5" },
  { id: "openai/gpt-4o", label: "openai/gpt-4o" },
  { id: "google/gemini-2.5-pro", label: "google/gemini-2.5-pro" },
  { id: "google/gemini-2.5-flash", label: "google/gemini-2.5-flash" },
];

const MODELS_CACHE_TTL_MS = 60_000;
const MODELS_DISCOVERY_TIMEOUT_MS = 20_000;

const discoveryCache = new Map<string, { expiresAt: number; models: AdapterModel[] }>();
const VOLATILE_ENV_KEY_PREFIXES = ["PAPERCLIP_", "npm_", "NPM_"] as const;
const VOLATILE_ENV_KEY_EXACT = new Set(["PWD", "OLDPWD", "SHLVL", "_", "TERM_SESSION_ID", "HOME"]);

function dedupeModels(models: AdapterModel[]): AdapterModel[] {
  const seen = new Set<string>();
  const deduped: AdapterModel[] = [];
  for (const model of models) {
    const id = model.id.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    deduped.push({ id, label: model.label.trim() || id });
  }
  return deduped;
}

function sortModels(models: AdapterModel[]): AdapterModel[] {
  return [...models].sort((a, b) =>
    a.id.localeCompare(b.id, "en", { numeric: true, sensitivity: "base" }),
  );
}

function firstNonEmptyLine(text: string): string {
  return (
    text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean) ?? ""
  );
}

function parseModelsOutput(stdout: string): AdapterModel[] {
  const parsed: AdapterModel[] = [];
  for (const raw of stdout.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const firstToken = line.split(/\s+/)[0]?.trim() ?? "";
    if (!firstToken.includes("/")) continue;
    const provider = firstToken.slice(0, firstToken.indexOf("/")).trim();
    const model = firstToken.slice(firstToken.indexOf("/") + 1).trim();
    if (!provider || !model) continue;
    parsed.push({ id: `${provider}/${model}`, label: `${provider}/${model}` });
  }
  return dedupeModels(parsed);
}

function normalizeEnv(input: unknown): Record<string, string> {
  const envInput =
    typeof input === "object" && input !== null && !Array.isArray(input)
      ? (input as Record<string, unknown>)
      : {};
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(envInput)) {
    if (typeof value === "string") env[key] = value;
  }
  return env;
}

function isVolatileEnvKey(key: string): boolean {
  if (VOLATILE_ENV_KEY_EXACT.has(key)) return true;
  return VOLATILE_ENV_KEY_PREFIXES.some((prefix) => key.startsWith(prefix));
}

function hashValue(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function discoveryCacheKey(command: string, cwd: string, env: Record<string, string>) {
  const envKey = Object.entries(env)
    .filter(([key]) => !isVolatileEnvKey(key))
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${hashValue(value)}`)
    .join("\n");
  return `${command}\n${cwd}\n${envKey}`;
}

function pruneExpiredDiscoveryCache(now: number) {
  for (const [key, value] of discoveryCache.entries()) {
    if (value.expiresAt <= now) discoveryCache.delete(key);
  }
}

export async function discoverK8sModels(input: {
  command?: unknown;
  cwd?: unknown;
  env?: unknown;
} = {}): Promise<AdapterModel[]> {
  const command = asString(input.command, "opencode");
  const cwd = asString(input.cwd, process.cwd());
  const env = normalizeEnv(input.env);

  let resolvedHome: string | undefined;
  try {
    resolvedHome = os.userInfo().homedir || undefined;
  } catch {
    // os.userInfo() throws when the UID has no /etc/passwd entry (e.g. distroless images)
  }

  const runtimeEnv = normalizeEnv(
    ensurePathInEnv({
      ...process.env,
      ...env,
      ...(resolvedHome ? { HOME: resolvedHome } : {}),
      OPENCODE_DISABLE_PROJECT_CONFIG: "true",
    }),
  );

  const result = await runChildProcess(
    `opencode-models-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    command,
    ["models"],
    {
      cwd,
      env: runtimeEnv,
      timeoutSec: MODELS_DISCOVERY_TIMEOUT_MS / 1000,
      graceSec: 3,
      onLog: async () => {},
    },
  );

  if (result.timedOut) {
    throw new Error(`\`opencode models\` timed out after ${MODELS_DISCOVERY_TIMEOUT_MS / 1000}s.`);
  }
  if ((result.exitCode ?? 1) !== 0) {
    const detail = firstNonEmptyLine(result.stderr) || firstNonEmptyLine(result.stdout);
    throw new Error(detail ? `\`opencode models\` failed: ${detail}` : "`opencode models` failed.");
  }

  return sortModels(parseModelsOutput(result.stdout));
}

export async function discoverK8sModelsCached(input: {
  command?: unknown;
  cwd?: unknown;
  env?: unknown;
} = {}): Promise<AdapterModel[]> {
  const command = asString(input.command, "opencode");
  const cwd = asString(input.cwd, process.cwd());
  const env = normalizeEnv(input.env);
  const key = discoveryCacheKey(command, cwd, env);
  const now = Date.now();
  pruneExpiredDiscoveryCache(now);
  const cached = discoveryCache.get(key);
  if (cached && cached.expiresAt > now) return cached.models;

  const models = await discoverK8sModels({ command, cwd, env });
  discoveryCache.set(key, { expiresAt: now + MODELS_CACHE_TTL_MS, models });
  return models;
}

export async function listK8sModels(): Promise<AdapterModel[]> {
  try {
    return await discoverK8sModelsCached();
  } catch {
    return [];
  }
}

export function resetK8sModelsCacheForTests() {
  discoveryCache.clear();
}
