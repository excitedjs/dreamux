/**
 * Builtin `builtin:codex` runtime config: schema type, defaults, reader, and
 * the typed accessor.
 *
 * Codex runtime config is owned by this package (the `builtin:codex` provider),
 * not by the Dreamux host config module. It depends only on the shared neutral
 * validation primitives (`@excitedjs/dreamux-utils`) and the package-local
 * provider ref, never on `@excitedjs/dreamux` core. The Dreamux host config
 * module re-exports these so
 * the non-builtin callers (doctor, daemon, tests) keep their import paths.
 */

import { BUILTIN_CODEX_PROVIDER_REF } from './provider-ref.js';
import {
  readOptionalString,
  rejectUnknownKeys,
  requirePositiveInt,
  requireStringArray,
  requireStringRecord,
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
  rejectUnknownKeys(
    rawCodex,
    new Set([
      'bin',
      // 'approval_policy' and 'turn_timeout_ms' are no longer read (Codex
      // approval policy is hard-coded to 'never'; turn_timeout_ms was
      // accepted-and-ignored with no runtime effect) but stay in this
      // allow-list so a config.json written before this change still loads.
      'approval_policy',
      'turn_timeout_ms',
      'sandbox_mode',
      'extra_args',
      'extra_env',
      'initialize_timeout_ms',
    ]),
    file,
    prefix,
  );
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
    extra_args: requireStringArray(
      rawCodex,
      'extra_args',
      defaults.extra_args,
      file,
      prefix,
    ),
    extra_env: requireStringRecord(
      rawCodex,
      'extra_env',
      defaults.extra_env,
      file,
      prefix,
    ),
    initialize_timeout_ms: requirePositiveInt(
      rawCodex,
      'initialize_timeout_ms',
      defaults.initialize_timeout_ms,
      file,
      prefix,
    ),
  };
}

/**
 * Typed accessor for a dispatcher's resolved codex agent config. Typed
 * structurally (not against the host's `ResolvedAgentConfig`) so this module
 * never imports the host config type — the host's `agents[]` entry shape
 * still satisfies it at the call sites.
 */
export function dispatcherCodexConfig(
  agent: { provider: string; config: unknown },
  dispatcherId: string,
): DispatcherCodexConfig {
  if (agent.provider !== BUILTIN_CODEX_PROVIDER_REF) {
    throw new Error(
      `dispatcher '${dispatcherId}' runtime provider ${JSON.stringify(agent.provider)} is not wired to Codex`,
    );
  }
  return agent.config as DispatcherCodexConfig;
}
