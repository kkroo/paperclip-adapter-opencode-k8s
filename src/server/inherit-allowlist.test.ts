import { describe, expect, it } from "vitest";
import {
  AGENT_ENV_ALLOWLIST,
  AGENT_ENV_FROM_ALLOWLIST,
  AGENT_SECRET_VOLUME_ALLOWLIST,
  SERVER_ONLY_ENV_DENY,
  isAgentInheritableEnvFromRef,
  isAgentInheritableEnvName,
  isAgentInheritableSecretVolume,
} from "./inherit-allowlist.js";

describe("opencode inheritance allowlist", () => {
  it("admits the exact Penstock key but not adjacent names", () => {
    expect(isAgentInheritableEnvName("PENSTOCK_API_KEY")).toBe(true);
    expect(isAgentInheritableEnvName("PENSTOCK_RUNTIME_TOKEN")).toBe(false);
    expect(isAgentInheritableEnvName("PENSTOCK_ADMIN_KEY")).toBe(false);
  });

  it.each([
    "PAPERCLIP_AGENT_JWT_SECRET",
    "DATABASE_URL",
    "PAPERCLIP_MASTER_KEY_SEED",
    "GITHUB_APP_PRIVATE_KEY",
  ])("rejects server-only %s", (name) => {
    expect(SERVER_ONLY_ENV_DENY.has(name)).toBe(true);
    expect(isAgentInheritableEnvName(name)).toBe(false);
  });

  it("keeps the provider families and required runtime names", () => {
    for (const name of [
      "PAPERCLIP_API_URL",
      "PAPERCLIP_PUBLIC_URL",
      "PATH",
      "NODE_ENV",
      "OPENAI_BASE_URL",
      "ANTHROPIC_AUTH_TOKEN",
      "AWS_REGION",
    ]) {
      expect(isAgentInheritableEnvName(name)).toBe(true);
    }
  });

  it("defaults unknown names and envFrom sources to deny", () => {
    expect(isAgentInheritableEnvName("MY_SECRET")).toBe(false);
    expect(AGENT_ENV_FROM_ALLOWLIST.size).toBe(0);
    expect(isAgentInheritableEnvFromRef("paperclip-secrets")).toBe(false);
  });

  it("preserves only the two agent-facing Secret volumes", () => {
    expect(isAgentInheritableSecretVolume("authbot-mcp-consumer-service-keys")).toBe(true);
    expect(isAgentInheritableSecretVolume("paperclip-github-mcp-token")).toBe(true);
    expect(isAgentInheritableSecretVolume("paperclip-github-merge-token")).toBe(false);
    expect(isAgentInheritableSecretVolume("tls-secret")).toBe(false);
    expect(AGENT_SECRET_VOLUME_ALLOWLIST.has("PENSTOCK_API_KEY")).toBe(false);
  });

  it("does not accidentally overlap the explicit deny set", () => {
    for (const name of SERVER_ONLY_ENV_DENY) {
      expect(AGENT_ENV_ALLOWLIST.has(name)).toBe(false);
      expect(isAgentInheritableEnvName(name)).toBe(false);
    }
  });
});
