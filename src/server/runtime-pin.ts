/**
 * Adapter-managed OpenCode runtime.
 *
 * Why this exists: Job pods inherit the paperclip image, whose Dockerfile
 * installs `opencode-ai` into a root-owned, layer-cached
 * `/usr/local/lib/node_modules`. The fleet therefore runs whatever version
 * that cached layer froze (1.18.11 on 2026-10-06, 24 releases behind) until
 * the image is rebuilt; Job pods run as uid 1000 and cannot upgrade it in
 * place. Model and provider support in OpenCode is version-bound, so a stale
 * bundled binary silently caps which models (and which bug fixes) the fleet
 * gets. This mirrors the claude_k8s adapter's `claudeCodeVersion` pin.
 *
 * The Job's main command installs the pinned `opencode-ai` once into a shared,
 * versioned directory on the data PVC and prepends its bin dir to PATH before
 * anything calls `opencode` (the DB schema guard stamps `opencode --version`,
 * `/compact`, the launchers, the main run). Installs are serialized with a
 * mkdir lock, staged into a temp dir and renamed into place only after the
 * binary answers `--version`, so concurrent Jobs never execute a half-written
 * runtime. If the install cannot be completed the run falls back to the
 * image's bundled binary with a loud stderr line rather than failing outright.
 */

/** npm package that ships the OpenCode CLI. */
export const OPENCODE_PACKAGE = "opencode-ai";

/**
 * Default pinned OpenCode version. Bump deliberately: the db-reset guard in
 * job-manifest.ts resets a persistent opencode.db whenever the binary version
 * changes, so every bump costs each agent its local session DB once.
 */
export const DEFAULT_OPENCODE_VERSION = "1.18.35";

/** Config sentinel: run the binary bundled in the container image, no bootstrap. */
export const OPENCODE_RUNTIME_FROM_IMAGE = "image";

/** Shared runtimes root, relative to the data PVC mount (HOME for Job pods). */
export const RUNTIMES_DIR_RELATIVE = ".local/lib/paperclip-k8s-runtimes";

/** Exact npm versions only — the value is interpolated into a shell command. */
const EXACT_VERSION_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

/**
 * Resolve adapterConfig.opencodeVersion.
 *
 * - unset / blank  → DEFAULT_OPENCODE_VERSION (adapter-managed)
 * - "image"        → "" (use the image's bundled binary, legacy behaviour)
 * - "x.y.z"        → that exact version (adapter-managed)
 *
 * Anything else throws: the value is shell-interpolated, so a range, tag or
 * stray character must never reach the Job command.
 */
export function resolveOpencodeVersion(raw: unknown): string {
  const value = typeof raw === "string" ? raw.trim() : "";
  if (!value) return DEFAULT_OPENCODE_VERSION;
  if (value === OPENCODE_RUNTIME_FROM_IMAGE) return "";
  if (!EXACT_VERSION_RE.test(value)) {
    throw new Error(
      `opencodeVersion must be an exact version such as ${DEFAULT_OPENCODE_VERSION}, or "${OPENCODE_RUNTIME_FROM_IMAGE}" to use the container image's binary; got ${JSON.stringify(value)}`,
    );
  }
  return value;
}

/** Directory holding one installed OpenCode version on the shared data PVC. */
export function opencodeRuntimeDir(dataMountPath: string, version: string): string {
  return `${dataMountPath.replace(/\/+$/, "")}/${RUNTIMES_DIR_RELATIVE}/opencode/${version}`;
}

function shellSingleQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

/**
 * POSIX sh snippet (no trailing separator) that makes the pinned binary the
 * `opencode` on PATH for the rest of the Job command.
 *
 * Layout on the PVC:
 *   <data>/.local/lib/paperclip-k8s-runtimes/opencode/<version>/   installed prefix
 *   .../<version>/.complete                                        written last
 *   .../.lock-<version>                                            mkdir lock
 *   .../.tmp-<version>-<pid>                                       staging dir
 *
 * Properties:
 * - idempotent: a complete install is reused by every later Job, any isolation key;
 * - serialized: `mkdir` of the lock dir is atomic on CephFS/NFS; losers wait
 *   (up to 5 min) for the winner's `.complete` marker instead of installing twice;
 * - crash-safe: a lock older than 20 min is reclaimed, a dir without `.complete`
 *   is rebuilt, and the staging dir is renamed into place only after the fresh
 *   binary answers `--version`;
 * - fail-open: if nothing usable exists afterwards the image binary is used and
 *   the pod log says so.
 */
export function buildOpencodeRuntimeShell(opts: { version: string; dataMountPath: string }): string {
  const { version, dataMountPath } = opts;
  if (!EXACT_VERSION_RE.test(version)) throw new Error(`invalid opencode version: ${JSON.stringify(version)}`);
  const root = `${dataMountPath.replace(/\/+$/, "")}/${RUNTIMES_DIR_RELATIVE}/opencode`;
  const spec = `${OPENCODE_PACKAGE}@$__pover`;
  return [
    `__pover=${shellSingleQuote(version)}`,
    `__poroot=${shellSingleQuote(root)}`,
    '__podir="$__poroot/$__pover"',
    '__pobin="$__podir/node_modules/.bin/opencode"',
    'if [ ! -f "$__podir/.complete" ] || [ ! -x "$__pobin" ]; then ' +
      'mkdir -p "$__poroot" 2>/dev/null; __polock="$__poroot/.lock-$__pover"; ' +
      'if [ -d "$__polock" ] && [ -n "$(find "$__polock" -maxdepth 0 -mmin +20 2>/dev/null)" ]; then ' +
        'echo "[paperclip] reclaiming stale opencode install lock $__polock" >&2; rmdir "$__polock" 2>/dev/null; fi; ' +
      'if mkdir "$__polock" 2>/dev/null; then ' +
        '__potmp="$__poroot/.tmp-$__pover-$$"; rm -rf "$__potmp" "$__podir"; mkdir -p "$__potmp"; ' +
        `echo "[paperclip] installing ${spec} into $__podir" >&2; ` +
        `if npm install --prefix "$__potmp" --omit=dev --no-audit --no-fund --no-package-lock --loglevel=error "${spec}" >&2 ` +
          '&& "$__potmp/node_modules/.bin/opencode" --version >/dev/null 2>&1; then ' +
          'mv "$__potmp" "$__podir" && : > "$__podir/.complete"; ' +
        `else echo "[paperclip] ${spec} install failed" >&2; rm -rf "$__potmp"; fi; ` +
        'rmdir "$__polock" 2>/dev/null; ' +
      'else ' +
        `echo "[paperclip] waiting for a concurrent ${spec} install" >&2; ` +
        '__poi=0; while [ ! -f "$__podir/.complete" ] && [ -d "$__polock" ] && [ "$__poi" -lt 300 ]; do sleep 1; __poi=$((__poi+1)); done; ' +
      'fi; ' +
    'fi',
    'if [ -f "$__podir/.complete" ] && [ -x "$__pobin" ]; then ' +
      'export PATH="$__podir/node_modules/.bin:$PATH"; ' +
      'echo "[paperclip] opencode runtime $(opencode --version 2>/dev/null | head -n1) (adapter-managed, pinned $__pover)" >&2; ' +
    'else ' +
      'echo "[paperclip] opencode $__pover unavailable; falling back to the image opencode $(opencode --version 2>/dev/null | head -n1)" >&2; ' +
    'fi',
  ].join("; ");
}
