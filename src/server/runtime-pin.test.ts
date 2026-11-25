import { describe, it, expect } from "vitest";
import {
  DEFAULT_OPENCODE_VERSION,
  OPENCODE_PACKAGE,
  buildOpencodeRuntimeShell,
  opencodeRuntimeDir,
  resolveOpencodeVersion,
} from "./runtime-pin.js";

describe("resolveOpencodeVersion", () => {
  it("defaults to the adapter pin when unset or blank", () => {
    expect(resolveOpencodeVersion(undefined)).toBe(DEFAULT_OPENCODE_VERSION);
    expect(resolveOpencodeVersion("")).toBe(DEFAULT_OPENCODE_VERSION);
    expect(resolveOpencodeVersion("  ")).toBe(DEFAULT_OPENCODE_VERSION);
    expect(resolveOpencodeVersion(7)).toBe(DEFAULT_OPENCODE_VERSION);
  });

  it('returns "" for the "image" sentinel (use the bundled binary)', () => {
    expect(resolveOpencodeVersion("image")).toBe("");
    expect(resolveOpencodeVersion(" image ")).toBe("");
  });

  it("accepts exact versions, including prereleases", () => {
    expect(resolveOpencodeVersion("1.18.35")).toBe("1.18.35");
    expect(resolveOpencodeVersion(" 2.0.0-rc.1 ")).toBe("2.0.0-rc.1");
  });

  it("rejects ranges, tags and shell metacharacters — the value is shell-interpolated", () => {
    for (const bad of ["latest", "^1.18.0", "1.18", "1.18.35; rm -rf /", "1.18.35$(id)", "v1.18.35"]) {
      expect(() => resolveOpencodeVersion(bad), bad).toThrow(/opencodeVersion must be an exact version/);
    }
  });
});

describe("opencodeRuntimeDir", () => {
  it("lives under the data mount's shared runtimes root", () => {
    expect(opencodeRuntimeDir("/paperclip", "1.18.35")).toBe("/paperclip/.local/lib/paperclip-k8s-runtimes/opencode/1.18.35");
    expect(opencodeRuntimeDir("/data/", "1.18.35")).toBe("/data/.local/lib/paperclip-k8s-runtimes/opencode/1.18.35");
  });
});

describe("buildOpencodeRuntimeShell", () => {
  const shell = buildOpencodeRuntimeShell({ version: "1.18.35", dataMountPath: "/paperclip" });

  it("installs the exact pinned package into a versioned prefix on the data PVC", () => {
    expect(shell).toContain("__pover='1.18.35'");
    expect(shell).toContain("__poroot='/paperclip/.local/lib/paperclip-k8s-runtimes/opencode'");
    expect(shell).toContain(
      `npm install --prefix "$__potmp" --omit=dev --no-audit --no-fund --no-package-lock --loglevel=error "${OPENCODE_PACKAGE}@$__pover"`,
    );
  });

  it("serializes concurrent installs with an atomic mkdir lock and waits for the winner", () => {
    expect(shell).toContain('if mkdir "$__polock" 2>/dev/null; then');
    expect(shell).toMatch(/while \[ ! -f "\$__podir\/\.complete" \] && \[ -d "\$__polock" \] && \[ "\$__poi" -lt 300 \]; do sleep 1/);
    expect(shell).toContain('find "$__polock" -maxdepth 0 -mmin +20');
  });

  it("only publishes a runtime whose binary answers --version, via rename + marker", () => {
    const verifyIdx = shell.indexOf('"$__potmp/node_modules/.bin/opencode" --version');
    const publishIdx = shell.indexOf('mv "$__potmp" "$__podir" && : > "$__podir/.complete"');
    expect(verifyIdx).toBeGreaterThan(-1);
    expect(publishIdx).toBeGreaterThan(verifyIdx);
    expect(shell).toContain('rm -rf "$__potmp"; fi');
  });

  it("puts the managed binary first on PATH, else falls back to the image binary without exiting", () => {
    expect(shell).toContain('export PATH="$__podir/node_modules/.bin:$PATH"');
    expect(shell).toContain("falling back to the image opencode");
    expect(shell).not.toMatch(/exit \d/);
  });

  it("refuses an unvalidated version", () => {
    expect(() => buildOpencodeRuntimeShell({ version: "latest", dataMountPath: "/paperclip" })).toThrow(/invalid opencode version/);
  });

  it("quotes a data mount path with a single quote safely", () => {
    const quoted = buildOpencodeRuntimeShell({ version: "1.18.35", dataMountPath: "/mnt/it's" });
    expect(quoted).toContain("__poroot='/mnt/it'\\''s/.local/lib/paperclip-k8s-runtimes/opencode'");
  });
});
