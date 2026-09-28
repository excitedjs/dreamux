/**
 * Builtin `builtin:codex` runtime config: schema type, defaults, and reader.
 *
 * Codex runtime config is owned by this package (the `builtin:codex` provider),
 * not by the Dreamux host config module. It depends only on the shared neutral
 * validation primitives (`@excitedjs/dreamux-utils`), never on
 * `@excitedjs/dreamux` core. The Dreamux host config module re-exports these so
 * the non-builtin callers (doctor, daemon, tests) keep their import paths.
 */

import {
  readOptionalString,
  readPositiveInt,
  readStringArray,
  readStringRecord,
} from '@excitedjs/dreamux-utils';

/**
 * Builtin Codex runtime settings under a named `agents[].config` entry (provider
 * `builtin:codex`), referenced by a dispatcher via `dispatchers[].agentRuntime`.
 * Every field carries a built-in default, so an agent that omits any config
 * field runs with these constants. There is no top-level `codex` block anymore;
 * runtime config lives in `agents[]`.
 *
 * `bin` is the dispatcher's Codex binary path; the `CODEX_HOST_CODEX_BIN`
 * environment variable is a host-level override that takes precedence over it
 * (resolved by the codex builtin's `resolveCodexBinPath`).
 * `initialize_timeout_ms` is that dispatcher's handshake timeout.
 */
export interface DispatcherCodexConfig {
  bin: string;
  sandbox_mode: string;
  extra_args: string[];
  extra_env: Record<string, string>;
  initialize_timeout_ms: number;
}

/**
 * Default `agents[].config.bin`. The Codex binary path is
 * dispatcher-local; `CODEX_HOST_CODEX_BIN` is a host-level override above it,
 * not the source.
 */
export const DEFAULT_CODEX_BIN = 'codex';

/** Default `agents[].config.initialize_timeout_ms` (handshake timeout, ms). */
export const DEFAULT_INITIALIZE_TIMEOUT_MS = 10_000;

/** Default `agents[].config.sandbox_mode` when omitted. */
export const DEFAULT_SANDBOX_MODE = 'workspace-write';

export const ALLOWED_SANDBOX_MODES = new Set([
  'read-only',
  'workspace-write',
  'danger-full-access',
]);

export function defaultDispatcherCodexConfig(): DispatcherCodexConfig {
  return {
    bin: DEFAULT_CODEX_BIN,
    sandbox_mode: DEFAULT_SANDBOX_MODE,
    extra_args: [],
    extra_env: {},
    initialize_timeout_ms: DEFAULT_INITIALIZE_TIMEOUT_MS,
  };
}

export function readDispatcherCodexConfig(
  rawCodex: Record<string, unknown>,
  file: string,
  prefix: string,
): DispatcherCodexConfig {
  // Unknown fields (including the retired 'approval_policy' and
  // 'turn_timeout_ms': Codex approval policy is hard-coded to 'never', and
  // turn_timeout_ms was accepted-and-ignored with no runtime effect) are
  // tolerated, not rejected — the persisted-shape policy (R21) rejects only
  // a wrong type or a missing required field.
  // An omitted (or explicitly null) field falls back to the dispatcher-local
  // default. Before the top-level block was removed, `null` meant "inherit the
  // global default"; with no global, it simply means "use the built-in".
  const defaults = defaultDispatcherCodexConfig();
  const bin = readOptionalString(rawCodex, 'bin', file, prefix) ?? defaults.bin;
  if (bin.trim() === '') {
    throw new Error(
      `dreamux config error in ${file}: ${prefix}bin must be a non-empty string`,
    );
  }
  const sandboxMode =
    readOptionalString(rawCodex, 'sandbox_mode', file, prefix) ??
    defaults.sandbox_mode;
  if (!ALLOWED_SANDBOX_MODES.has(sandboxMode)) {
    throw new Error(
      `dreamux config error in ${file}: ${prefix}sandbox_mode='${sandboxMode}' is not one of ${Array.from(ALLOWED_SANDBOX_MODES).join(' | ')}`,
    );
  }
  return {
    bin,
    sandbox_mode: sandboxMode,
    extra_args: readStringArray(
      rawCodex,
      'extra_args',
      defaults.extra_args,
      file,
      prefix,
    ),
    extra_env: readStringRecord(
      rawCodex,
      'extra_env',
      defaults.extra_env,
      file,
      prefix,
    ),
    initialize_timeout_ms: readPositiveInt(
      rawCodex,
      'initialize_timeout_ms',
      defaults.initialize_timeout_ms,
      file,
      prefix,
    ),
  };
}
