/**
 * Builtin `builtin:codex` runtime config: schema type, defaults, reader, and
 * the typed accessor.
 *
 * Lives inside the codex builtin (not the host config module) so codex config
 * specifics close over here and the builtin never imports the host config
 * module — keeping the builtin -> config import cycle severed. It depends only
 * on the neutral validation primitives (config/validate) and the canonical
 * provider ref (registry/). The host config module re-exports these so the
 * non-builtin callers (doctor, daemon, tests) keep their import paths.
 *
 * Load-bearing: because `config/config.ts` re-exports from here, this file must
 * stay a leaf — never import `platform/paths` or `config/config` (only
 * `registry/` + `config/validate`). Adding such an import re-forms the #148
 * cold-start cycle `config -> ... -> platform/paths -> config`. See
 * `.agents/decisions/agents-config-normalization.md` (De-cycle).
 */

import { BUILTIN_CODEX_PROVIDER_REF } from '../../../registry/index.js';
import {
  readOptionalString,
  rejectUnknownKeys,
  requirePositiveInt,
  requireStringArray,
  requireStringRecord,
} from '../../../config/validate.js';

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
 * `initialize_timeout_ms` is that
 * dispatcher's handshake timeout. `turn_timeout_ms` bounds a single TeamMate
 * worker turn (issue #126): if a per-task Codex app-server reaches `running`
 * but its turn never emits `turn/completed` (a stall in turn execution —
 * commonly auth, network, or model quota), the worker fails that task instead
 * of leaving it `running` forever. It does not affect the dispatcher's own
 * long-lived runtime, only per-task workers.
 */
export interface DispatcherCodexConfig {
  bin: string;
  approval_policy: string;
  sandbox_mode: string;
  extra_args: string[];
  extra_env: Record<string, string>;
  initialize_timeout_ms: number;
  turn_timeout_ms: number;
}

/**
 * Default `dispatchers[].runtime.config.bin`. The Codex binary path is
 * dispatcher-local; `CODEX_HOST_CODEX_BIN` is a host-level override above it,
 * not the source.
 */
export const DEFAULT_CODEX_BIN = 'codex';

/** Default `dispatchers[].runtime.config.initialize_timeout_ms` (handshake timeout, ms). */
export const DEFAULT_INITIALIZE_TIMEOUT_MS = 10_000;

/**
 * Default per-turn deadline for a `builtin:codex` TeamMate worker (ms).
 * Generous enough not to interrupt a legitimately long tool-using turn, but
 * finite so a worker whose turn stalls after start cannot sit `running` with no
 * visible outcome (issue #126). Operators override via
 * `dispatchers[].runtime.config.turn_timeout_ms`.
 */
export const DEFAULT_CODEX_TURN_TIMEOUT_MS = 600_000;

/** Default `dispatchers[].runtime.config.approval_policy` when omitted. */
export const DEFAULT_APPROVAL_POLICY = 'never';

/** Default `dispatchers[].runtime.config.sandbox_mode` when omitted. */
export const DEFAULT_SANDBOX_MODE = 'workspace-write';

export const ALLOWED_APPROVAL_POLICIES = new Set([
  'never',
  'auto',
  'auto-approve',
  'on-failure',
]);

export const ALLOWED_SANDBOX_MODES = new Set([
  'read-only',
  'workspace-write',
  'danger-full-access',
]);

export function defaultDispatcherCodexConfig(): DispatcherCodexConfig {
  return {
    bin: DEFAULT_CODEX_BIN,
    approval_policy: DEFAULT_APPROVAL_POLICY,
    sandbox_mode: DEFAULT_SANDBOX_MODE,
    extra_args: [],
    extra_env: {},
    initialize_timeout_ms: DEFAULT_INITIALIZE_TIMEOUT_MS,
    turn_timeout_ms: DEFAULT_CODEX_TURN_TIMEOUT_MS,
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
      'approval_policy',
      'sandbox_mode',
      'extra_args',
      'extra_env',
      'initialize_timeout_ms',
      'turn_timeout_ms',
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
  const approvalPolicy =
    readOptionalString(rawCodex, 'approval_policy', file, prefix) ??
    defaults.approval_policy;
  if (!ALLOWED_APPROVAL_POLICIES.has(approvalPolicy)) {
    throw new Error(
      `dreamux config error in ${file}: ${prefix}approval_policy='${approvalPolicy}' is not one of ${Array.from(ALLOWED_APPROVAL_POLICIES).join(' | ')}`,
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
    approval_policy: approvalPolicy,
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
    turn_timeout_ms: requirePositiveInt(
      rawCodex,
      'turn_timeout_ms',
      defaults.turn_timeout_ms,
      file,
      prefix,
    ),
  };
}

/**
 * Typed accessor for a dispatcher's resolved codex runtime config. Typed
 * structurally (not against `DispatcherConfig`) so this module never imports
 * the host config type — a full `DispatcherConfig` still satisfies it at the
 * call sites.
 */
export function dispatcherCodexConfig(dispatcher: {
  id: string;
  runtime: { provider: string; config: unknown };
}): DispatcherCodexConfig {
  if (dispatcher.runtime.provider !== BUILTIN_CODEX_PROVIDER_REF) {
    throw new Error(
      `dispatcher '${dispatcher.id}' runtime provider ${JSON.stringify(dispatcher.runtime.provider)} is not wired to Codex`,
    );
  }
  return dispatcher.runtime.config as DispatcherCodexConfig;
}
