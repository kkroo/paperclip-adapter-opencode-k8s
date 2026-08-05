import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

import {
  ENV_GUARD_PLUGIN_SCRIPT,
  SAFE_ENV_INSPECT_SCRIPT,
  buildEnvGuardPluginCleanupShell,
  buildEnvGuardPluginSetupShell,
  classifyAgentShellCommand,
} from "./env-guard-plugin.js";

// Shared command corpus — keep in lockstep with the claude adapter's
// env-guard.test.ts and the server's agent-shell-guard tests.
const blocked = [
  "env",
  "printenv",
  "set",
  "export -p",
  "declare -x",
  "cat /proc/self/environ",
  "cat /proc/1/environ",
  "/usr/bin/env",
  "command env",
  "env; ls -la",
  "ls && printenv",
  'sh -lc "env"',
  "bash -c 'printenv'",
  "sh -lc env",
  "bash -c printenv",
  "/bin/sh -lc env",
  "paperclip-safe-env && printenv",
  "env; ./scripts/safe-env-inspect.mjs",
];
const allowed = [
  // Legitimate env USE (set-and-run) must not be blocked.
  "env FOO=bar node script.js",
  "printenv PATH",
  // set with flags is ubiquitous in agent shells.
  "set -euo pipefail",
  "set -e",
  // Ordinary commands.
  "ls -la",
  "git status",
  'echo "hello"',
  "grep -r env .",
  // The allowlisted names-only helper.
  "node ~/.claude/safe-env-inspect.mjs",
  "./scripts/safe-env-inspect.mjs",
  "paperclip-safe-env",
  "",
];

describe("classifyAgentShellCommand", () => {
  for (const cmd of blocked) {
    it(`blocks: ${JSON.stringify(cmd)}`, () => {
      const d = classifyAgentShellCommand(cmd);
      expect(d.action).toBe("block");
      expect(d.reason).toBe("full_environment_dump");
    });
  }

  for (const cmd of allowed) {
    it(`allows: ${JSON.stringify(cmd)}`, () => {
      expect(classifyAgentShellCommand(cmd).action).toBe("allow");
    });
  }
});

/**
 * Import the literal embedded plugin artifact as a real ES module and drive
 * its tool.execute.before hook — this validates the exact file the pod loads,
 * not a TS re-implementation.
 */
const scratchDirs: string[] = [];
afterAll(() => {
  for (const dir of scratchDirs) rmSync(dir, { recursive: true, force: true });
});

type Hook = (input: unknown, output: unknown) => Promise<void>;

async function loadPluginHook(): Promise<{ hook: Hook; exports: Record<string, unknown> }> {
  const dir = mkdtempSync(path.join(tmpdir(), "pc-oc-guard-"));
  scratchDirs.push(dir);
  const file = path.join(dir, "paperclip-env-guard.mjs");
  writeFileSync(file, ENV_GUARD_PLUGIN_SCRIPT);
  const mod = (await import(pathToFileURL(file).href)) as Record<string, unknown>;
  const factory = mod.PaperclipEnvGuard as (input: unknown) => Promise<Record<string, Hook>>;
  const hooks = await factory({});
  return { hook: hooks["tool.execute.before"], exports: mod };
}

describe("ENV_GUARD_PLUGIN_SCRIPT artifact", () => {
  it("exports exactly one symbol, a function (opencode legacy-loader contract)", async () => {
    // opencode's getLegacyPlugins throws if ANY module export is not a
    // function — a stray const export would take down plugin loading.
    const { exports } = await loadPluginHook();
    const keys = Object.keys(exports);
    expect(keys).toEqual(["PaperclipEnvGuard"]);
    expect(typeof exports.PaperclipEnvGuard).toBe("function");
  });

  it("returns a hooks object with only tool.execute.before", async () => {
    const { hook } = await loadPluginHook();
    expect(typeof hook).toBe("function");
  });

  for (const cmd of blocked) {
    it(`hook blocks bash: ${JSON.stringify(cmd)}`, async () => {
      const { hook } = await loadPluginHook();
      await expect(
        hook({ tool: "bash", sessionID: "s", callID: "c" }, { args: { command: cmd } }),
      ).rejects.toThrow(/PEN-1305/);
    });
  }

  for (const cmd of allowed) {
    it(`hook allows bash: ${JSON.stringify(cmd)}`, async () => {
      const { hook } = await loadPluginHook();
      await expect(
        hook({ tool: "bash", sessionID: "s", callID: "c" }, { args: { command: cmd } }),
      ).resolves.toBeUndefined();
    });
  }

  it("ignores non-bash tools even with dump-shaped args", async () => {
    const { hook } = await loadPluginHook();
    await expect(hook({ tool: "read", sessionID: "s", callID: "c" }, { args: { command: "env" } })).resolves.toBeUndefined();
    await expect(
      hook({ tool: "mcp_some_tool", sessionID: "s", callID: "c" }, { args: { command: "printenv" } }),
    ).resolves.toBeUndefined();
  });

  it("fails open on malformed hook payloads", async () => {
    const { hook } = await loadPluginHook();
    await expect(hook(undefined, undefined)).resolves.toBeUndefined();
    await expect(hook({ tool: "bash" }, undefined)).resolves.toBeUndefined();
    await expect(hook({ tool: "bash" }, {})).resolves.toBeUndefined();
    await expect(hook({ tool: "bash" }, { args: {} })).resolves.toBeUndefined();
    await expect(hook({ tool: "bash" }, { args: { command: 42 } })).resolves.toBeUndefined();
    // Poisoned args object whose property access throws must degrade to allow.
    const poisoned = new Proxy(
      {},
      {
        get() {
          throw new Error("boom");
        },
      },
    );
    await expect(hook({ tool: "bash" }, { args: poisoned })).resolves.toBeUndefined();
  });

  it("block message points at the runtime-resolved safe helper path", async () => {
    const { hook } = await loadPluginHook();
    const err = await hook({ tool: "bash", sessionID: "s", callID: "c" }, { args: { command: "env" } }).then(
      () => undefined,
      (e: Error) => e,
    );
    expect(err).toBeInstanceOf(Error);
    expect(String(err?.message)).toContain("safe-env-inspect.mjs");
    expect(String(err?.message)).toContain("opencode/safe-env-inspect.mjs");
  });

  it("keeps behavioural parity with classifyAgentShellCommand", async () => {
    const { hook } = await loadPluginHook();
    for (const cmd of [...blocked, ...allowed]) {
      const expected = classifyAgentShellCommand(cmd).action;
      const got = await hook({ tool: "bash", sessionID: "s", callID: "c" }, { args: { command: cmd } }).then(
        () => "allow",
        () => "block",
      );
      expect(got, `parity mismatch for ${JSON.stringify(cmd)}`).toBe(expected);
    }
  });
});

describe("SAFE_ENV_INSPECT_SCRIPT", () => {
  it("mentions names-only and never prints values", () => {
    expect(SAFE_ENV_INSPECT_SCRIPT).toContain("Object.keys(process.env)");
    expect(SAFE_ENV_INSPECT_SCRIPT).not.toContain("process.env[");
    expect(SAFE_ENV_INSPECT_SCRIPT).not.toContain("JSON.stringify(process.env)");
  });
});

describe("buildEnvGuardPluginSetupShell", () => {
  const shell = buildEnvGuardPluginSetupShell();

  it("targets the global opencode config plugin dir with XDG fallback", () => {
    expect(shell).toContain('GUARD_OC_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/opencode"');
    expect(shell).toContain('"$GUARD_OC_DIR/plugin/paperclip-env-guard.js"');
    expect(shell).toContain('"$GUARD_OC_DIR/safe-env-inspect.mjs"');
  });

  it("embeds both artifacts as base64 that round-trips exactly", () => {
    const pluginB64 = Buffer.from(ENV_GUARD_PLUGIN_SCRIPT, "utf8").toString("base64");
    const helperB64 = Buffer.from(SAFE_ENV_INSPECT_SCRIPT, "utf8").toString("base64");
    expect(shell).toContain(pluginB64);
    expect(shell).toContain(helperB64);
    expect(Buffer.from(pluginB64, "base64").toString("utf8")).toBe(ENV_GUARD_PLUGIN_SCRIPT);
  });

  it("fails open so an install error can never block a run", () => {
    expect(shell).toContain('|| echo "[paperclip-env-guard] plugin install skipped" >&2');
  });

  it("contains no raw single quotes inside the base64 payloads (sh -c safety)", () => {
    const pluginB64 = Buffer.from(ENV_GUARD_PLUGIN_SCRIPT, "utf8").toString("base64");
    expect(pluginB64).toMatch(/^[A-Za-z0-9+/=]+$/);
  });
});

describe("buildEnvGuardPluginCleanupShell", () => {
  it("removes stale guard artifacts from a reused config root", () => {
    const root = mkdtempSync(path.join(tmpdir(), "pc-oc-guard-cleanup-"));
    scratchDirs.push(root);
    const opencodeDir = path.join(root, "opencode");
    const pluginDir = path.join(opencodeDir, "plugin");
    mkdirSync(pluginDir, { recursive: true });
    const pluginPath = path.join(pluginDir, "paperclip-env-guard.js");
    const helperPath = path.join(opencodeDir, "safe-env-inspect.mjs");
    writeFileSync(pluginPath, "stale");
    writeFileSync(helperPath, "stale");

    execFileSync("sh", ["-c", buildEnvGuardPluginCleanupShell()], {
      env: { ...process.env, XDG_CONFIG_HOME: root, HOME: root },
    });

    expect(existsSync(pluginPath)).toBe(false);
    expect(existsSync(helperPath)).toBe(false);
  });
});
