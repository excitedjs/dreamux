/**
 * Global dreamux configuration loaded from `~/.dreamux/config.toml`.
 *
 * Why this exists: pre-config, every dispatcher had to repeat the same
 * `approval_policy=never`, every operator had to remember
 * `CODEX_HOST_CODEX_BIN`, every retry/timeout tuning was buried in
 * source-level constants. This file is the user-editable surface for
 * machine-wide defaults; per-dispatcher settings still override it, and
 * the existing env vars still override everything (escape hatch for CI
 * and one-off debug runs).
 *
 * Layout — separation of concerns:
 *   ~/.dreamux/        user-editable configuration (this module)
 *   ~/.codex-host/     runtime data (SQLite, sockets, dispatcher logs)
 * Mixing them was the original sin; keeping them apart is what makes a
 * `rm -rf ~/.codex-host` recovery safe.
 *
 * Format: TOML (matches codex's own `~/.codex/config.toml`).
 * Parse failures fail-fast with the offending line.
 */

import { homedir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeSync,
} from 'node:fs';
import { parse as parseToml, TomlError } from 'smol-toml';

export interface DreamuxConfig {
  /** Where dreamux stores runtime state. */
  runtime_dir: string;
  /** Admin Unix socket path; null = derive as <runtime_dir>/admin.sock. */
  admin_socket: string | null;
  codex: {
    /** codex CLI binary path; `codex` resolves via $PATH. */
    bin: string;
    /** Default approval policy applied to every dispatcher. */
    approval_policy: string;
    /** Default sandbox mode applied to every dispatcher. */
    sandbox_mode: string;
    /** Default extra args appended to every codex app-server invocation. */
    extra_args: string[];
    /** Handshake timeout (ms). */
    initialize_timeout_ms: number;
  };
  outbound: {
    /** Outbound (Feishu send) retry count. */
    retries: number;
    /** Initial outbound retry delay (ms). */
    retry_delay_ms: number;
  };
}

/**
 * Built-in defaults — identical to what individual modules used before this
 * config existed. Anything you change here is a behavior change for fresh
 * installs (and only fresh installs; existing `~/.dreamux/config.toml`
 * files are not touched on upgrade).
 */
export const BUILT_IN_DEFAULTS: DreamuxConfig = {
  runtime_dir: '~/.codex-host',
  admin_socket: null,
  codex: {
    bin: 'codex',
    approval_policy: 'never',
    sandbox_mode: 'workspace-write',
    extra_args: [],
    initialize_timeout_ms: 10_000,
  },
  outbound: {
    retries: 3,
    retry_delay_ms: 1000,
  },
};

/**
 * Codex 0.134 sandbox modes (from `codex --help`'s `-s, --sandbox` choices).
 * Kept in sync with `codex-args.ts` (same allowlist enforced at the
 * per-dispatcher level).
 */
export const ALLOWED_SANDBOX_MODES = new Set([
  'read-only',
  'workspace-write',
  'danger-full-access',
]);

/**
 * The literal TOML text written on first boot. Comments are part of the
 * UX — they tell an operator opening the file for the first time what
 * each key means and where to read more.
 */
export const DEFAULT_CONFIG_TOML = `# dreamux global configuration (~/.dreamux/config.toml)
#
# Edit this file and restart \`dreamux server start\` to apply changes.
# Runtime data (SQLite, sockets, dispatcher logs) lives separately in
# \`runtime_dir\` below — this file holds only user-editable settings.
# See .agents/decisions/0003-global-config-dir.md for the design rationale.
#
# Precedence (highest wins):
#   1. environment variables (CODEX_HOST_RUNTIME_DIR, CODEX_HOST_ADMIN_SOCKET,
#      CODEX_HOST_CODEX_BIN) — escape hatch for CI and one-off debug runs
#   2. per-dispatcher fields (codex_args_json: approvalPolicy, extraArgs)
#   3. this file
#   4. built-in defaults baked into the binary

# Where dreamux stores runtime state (SQLite database, admin Unix socket,
# per-dispatcher Codex sockets and logs).
#
# \`~/\` is expanded to your home directory. Relative paths are not supported.
runtime_dir = "~/.codex-host"

# Admin Unix socket path. Leave commented to derive as <runtime_dir>/admin.sock.
# admin_socket = "~/.codex-host/admin.sock"

[codex]
# Path to the codex CLI. Bare name (\`codex\`) resolves via $PATH; an
# absolute path (\`/opt/codex/bin/codex\`) skips the lookup.
bin = "codex"

# Default approval policy applied to every dispatcher. A per-dispatcher
# \`codex_args_json\` (set via \`dreamux dispatcher add --codex-args-json ...\`)
# overrides this when present. Must be one of:
#   never | auto | auto-approve | on-failure
# See issue #2 §"信任模型" for the trust-model implications of \`never\`.
approval_policy = "never"

# Default sandbox mode codex executes shell commands under. Per-dispatcher
# \`codex_args_json.sandboxMode\` overrides this when present.
# Must be one of:
#   read-only            — codex cannot write any files
#   workspace-write      — codex can write inside its cwd; recommended
#                          baseline for trusted-local
#   danger-full-access   — no sandbox; pair with approval_policy="never"
#                          only when codex must spawn helpers that chdir
#                          out of its cwd (e.g. tm dispatching into other
#                          worktrees). Trust model becomes equivalent to
#                          giving any allowed bot user shell access.
sandbox_mode = "workspace-write"

# Extra args appended to every codex app-server invocation. Per-dispatcher
# extra_args (in codex_args_json) are appended *after* these.
extra_args = []

# Handshake timeout. Without this, dreamux would hang forever on a codex
# that accepts the WebSocket upgrade but never replies to \`initialize\`
# (PR #5). 0 is not a valid value — set to a positive integer.
initialize_timeout_ms = 10000

[outbound]
# How many times to retry a failed Feishu send before parking the inbound
# row in \`outbound_failed\`. The Codex turn never re-runs on retry — only
# the outbound delivery is retried (PR #3 review #1).
retries = 3

# Initial delay between outbound retries (ms).
retry_delay_ms = 1000
`;

export interface ConfigPathOverrides {
  /** Override the global config dir. Default: ~/.dreamux. */
  configDir?: string;
}

export function globalConfigDir(overrides: ConfigPathOverrides = {}): string {
  if (overrides.configDir !== undefined) return overrides.configDir;
  return process.env['DREAMUX_CONFIG_DIR'] || join(homedir(), '.dreamux');
}

export function globalConfigFile(overrides: ConfigPathOverrides = {}): string {
  return join(globalConfigDir(overrides), 'config.toml');
}

/**
 * Load `<configDir>/config.toml`, creating it with default content on
 * first boot. Throws with a file-line-pointing message when TOML parsing
 * fails so the operator can fix the file without spelunking through
 * libraries.
 *
 * Safe to call from `server start` on every boot — first call ensures
 * the directory and file exist with sensible defaults; subsequent calls
 * just read.
 *
 * PR #8 review #1: create the file with the atomic `wx` (O_CREAT|O_EXCL)
 * flag, not check-then-write. Two server processes booting concurrently
 * against the same `~/.dreamux/` would otherwise both see "file absent"
 * and one would overwrite what the other wrote. Posix guarantees only
 * one `wx` open wins; the loser gets EEXIST and falls through to the
 * read path.
 */
export function loadOrInitConfig(
  overrides: ConfigPathOverrides = {},
): { config: DreamuxConfig; configFile: string; createdOnThisBoot: boolean } {
  const file = globalConfigFile(overrides);

  // Parent dir creation is idempotent under `recursive: true` (no race),
  // but it can still legitimately fail (e.g. parent is unwritable). Let
  // the EACCES propagate — the user needs to see it.
  mkdirSync(dirname(file), { recursive: true });

  const createdOnThisBoot = atomicWriteIfAbsent(file, DEFAULT_CONFIG_TOML);

  const raw = readFileSync(file, 'utf8');
  let parsed: unknown;
  try {
    parsed = parseToml(raw);
  } catch (err) {
    throw formatTomlError(err, file);
  }

  const config = mergeWithDefaults(parsed, file);
  return { config, configFile: file, createdOnThisBoot };
}

/**
 * Atomic create-if-absent. Returns true if this call created the file.
 *
 * Uses Node's `wx` flag, which maps to POSIX `open(O_CREAT | O_EXCL)`.
 * Two processes racing the same path see exactly one EEXIST and exactly
 * one success — no torn writes, no overwriting each other.
 */
function atomicWriteIfAbsent(file: string, content: string): boolean {
  let fd: number;
  try {
    fd = openSync(file, 'wx', 0o600);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw err;
  }
  try {
    writeSync(fd, content);
  } finally {
    closeSync(fd);
  }
  return true;
}

function formatTomlError(err: unknown, file: string): Error {
  if (err instanceof TomlError) {
    const where =
      typeof err.line === 'number' && typeof err.column === 'number'
        ? `${file}:${err.line}:${err.column}`
        : file;
    return new Error(
      `dreamux config parse error at ${where}: ${err.message}\n` +
        `Fix the TOML syntax in ${file} and restart, or delete the file to regenerate defaults.`,
    );
  }
  const msg = err instanceof Error ? err.message : String(err);
  return new Error(
    `dreamux config parse error in ${file}: ${msg}\n` +
      `Fix the TOML syntax in ${file} and restart, or delete the file to regenerate defaults.`,
  );
}

/**
 * Merge user-supplied TOML object with built-in defaults. Unknown top-level
 * keys are tolerated (forward-compat with newer config files); known keys
 * are validated for type and (where relevant) value membership.
 */
function mergeWithDefaults(raw: unknown, file: string): DreamuxConfig {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`dreamux config error in ${file}: top-level must be a table`);
  }
  const obj = raw as Record<string, unknown>;
  const codexIn = isPlainObject(obj['codex']) ? obj['codex'] : {};
  const outboundIn = isPlainObject(obj['outbound']) ? obj['outbound'] : {};

  const runtime_dir = expandHome(
    requireString(obj, 'runtime_dir', BUILT_IN_DEFAULTS.runtime_dir, file),
  );
  const admin_socket_raw = obj['admin_socket'];
  const admin_socket =
    admin_socket_raw === undefined || admin_socket_raw === null
      ? null
      : expandHome(
          ensureString(admin_socket_raw, 'admin_socket', file),
        );

  const approval_policy = requireString(
    codexIn,
    'approval_policy',
    BUILT_IN_DEFAULTS.codex.approval_policy,
    file,
    'codex.',
  );
  // Validate approval_policy against the same allowlist as codex-args.ts.
  // Keep the two in sync — see decision 0001 / issue #2 §"信任模型".
  const ALLOWED_POLICIES = new Set([
    'never',
    'auto',
    'auto-approve',
    'on-failure',
  ]);
  if (!ALLOWED_POLICIES.has(approval_policy)) {
    throw new Error(
      `dreamux config error in ${file}: codex.approval_policy='${approval_policy}' ` +
        `is not one of ${Array.from(ALLOWED_POLICIES).join(' | ')}`,
    );
  }

  const sandbox_mode = requireString(
    codexIn,
    'sandbox_mode',
    BUILT_IN_DEFAULTS.codex.sandbox_mode,
    file,
    'codex.',
  );
  if (!ALLOWED_SANDBOX_MODES.has(sandbox_mode)) {
    throw new Error(
      `dreamux config error in ${file}: codex.sandbox_mode='${sandbox_mode}' ` +
        `is not one of ${Array.from(ALLOWED_SANDBOX_MODES).join(' | ')}`,
    );
  }

  const extra_args = requireStringArray(
    codexIn,
    'extra_args',
    BUILT_IN_DEFAULTS.codex.extra_args,
    file,
    'codex.',
  );

  const initialize_timeout_ms = requirePositiveInt(
    codexIn,
    'initialize_timeout_ms',
    BUILT_IN_DEFAULTS.codex.initialize_timeout_ms,
    file,
    'codex.',
  );

  const retries = requireNonNegativeInt(
    outboundIn,
    'retries',
    BUILT_IN_DEFAULTS.outbound.retries,
    file,
    'outbound.',
  );
  const retry_delay_ms = requireNonNegativeInt(
    outboundIn,
    'retry_delay_ms',
    BUILT_IN_DEFAULTS.outbound.retry_delay_ms,
    file,
    'outbound.',
  );

  return {
    runtime_dir,
    admin_socket,
    codex: {
      bin: requireString(
        codexIn,
        'bin',
        BUILT_IN_DEFAULTS.codex.bin,
        file,
        'codex.',
      ),
      approval_policy,
      sandbox_mode,
      extra_args,
      initialize_timeout_ms,
    },
    outbound: { retries, retry_delay_ms },
  };
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function requireString(
  obj: Record<string, unknown>,
  key: string,
  fallback: string,
  file: string,
  prefix = '',
): string {
  const v = obj[key];
  if (v === undefined) return fallback;
  return ensureString(v, `${prefix}${key}`, file);
}

function ensureString(v: unknown, key: string, file: string): string {
  if (typeof v !== 'string') {
    throw new Error(
      `dreamux config error in ${file}: ${key} must be a string (got ${describeType(v)})`,
    );
  }
  return v;
}

function requireStringArray(
  obj: Record<string, unknown>,
  key: string,
  fallback: string[],
  file: string,
  prefix = '',
): string[] {
  const v = obj[key];
  if (v === undefined) return fallback;
  if (!Array.isArray(v)) {
    throw new Error(
      `dreamux config error in ${file}: ${prefix}${key} must be an array of strings (got ${describeType(v)})`,
    );
  }
  return v.map((item, i) => {
    if (typeof item !== 'string') {
      throw new Error(
        `dreamux config error in ${file}: ${prefix}${key}[${i}] must be a string (got ${describeType(item)})`,
      );
    }
    return item;
  });
}

function requirePositiveInt(
  obj: Record<string, unknown>,
  key: string,
  fallback: number,
  file: string,
  prefix = '',
): number {
  const n = readInt(obj, key, file, prefix);
  if (n === null) return fallback;
  if (n <= 0) {
    throw new Error(
      `dreamux config error in ${file}: ${prefix}${key} must be > 0 (got ${n})`,
    );
  }
  return n;
}

function requireNonNegativeInt(
  obj: Record<string, unknown>,
  key: string,
  fallback: number,
  file: string,
  prefix = '',
): number {
  const n = readInt(obj, key, file, prefix);
  if (n === null) return fallback;
  if (n < 0) {
    throw new Error(
      `dreamux config error in ${file}: ${prefix}${key} must be >= 0 (got ${n})`,
    );
  }
  return n;
}

function readInt(
  obj: Record<string, unknown>,
  key: string,
  file: string,
  prefix: string,
): number | null {
  const v = obj[key];
  if (v === undefined) return null;
  // smol-toml returns BigInt for integers; accept both.
  if (typeof v === 'bigint') {
    if (v < BigInt(Number.MIN_SAFE_INTEGER) || v > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new Error(
        `dreamux config error in ${file}: ${prefix}${key}=${v} is outside safe integer range`,
      );
    }
    return Number(v);
  }
  if (typeof v === 'number') {
    if (!Number.isInteger(v)) {
      throw new Error(
        `dreamux config error in ${file}: ${prefix}${key} must be an integer (got ${v})`,
      );
    }
    return v;
  }
  throw new Error(
    `dreamux config error in ${file}: ${prefix}${key} must be an integer (got ${describeType(v)})`,
  );
}

function describeType(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v;
}

/**
 * Expand a leading `~/` (or bare `~`) to the user's home directory.
 * Absolute paths and other relative paths pass through unchanged; the
 * latter aren't supported by callers but we leave them alone so a typo
 * surfaces as a missing-path error rather than silent expansion.
 */
export function expandHome(path: string): string {
  if (path === '~') return homedir();
  if (path.startsWith('~/')) return join(homedir(), path.slice(2));
  if (!isAbsolute(path)) {
    // Pass through; downstream consumers will error if they need an
    // absolute path. (We considered erroring here, but bash-style configs
    // sometimes use bare names that get resolved later.)
    return path;
  }
  return path;
}
