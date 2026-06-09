/**
 * Builtin `builtin:claude-code` runtime config: schema type, defaults, reader,
 * and the typed accessor.
 *
 * Lives inside the claude-code builtin (not the host config module) so claude
 * config specifics close over here and the builtin never imports the host
 * config module — keeping the builtin -> config import cycle severed. It
 * depends only on the neutral validation primitives (config/validate) and
 * the canonical provider ref (registry/). The host config module re-exports
 * these so the non-builtin callers (doctor, tests) keep their import paths.
 *
 * Load-bearing: because `config/config.ts` re-exports from here, this file must
 * stay a leaf — never import `platform/paths` or `config/config` (only
 * `registry/` + `config/validate`). Adding such an import re-forms the #148
 * cold-start cycle `config -> ... -> platform/paths -> config`. See
 * `.agents/decisions/agents-config-normalization.md` (De-cycle).
 */

import { BUILTIN_CLAUDE_CODE_PROVIDER_REF } from '../../../registry/index.js';
import {
  readOptionalBoolean,
  readOptionalString,
  rejectUnknownKeys,
  requirePositiveInt,
  requireStringArray,
  requireStringRecord,
} from '../../../config/validate.js';

/**
 * Builtin Claude Code runtime settings under a named `agents[].config` entry
 * whose `provider` is `builtin:claude-code` (issue #110 PR6), referenced by a
 * dispatcher via `dispatchers[].agentRuntime`.
 *
 * Deliberately distinct from `DispatcherCodexConfig`: Claude Code runs as a
 * resident headless stream-json process (`claude --print --input-format
 * stream-json …`, issue #120) with no `initialize` handshake, so there is no
 * handshake timeout, approval policy, or sandbox mode here. `bin` is the Claude
 * Code binary; `model` / `permission_mode` map to `--model` / `--permission-mode`;
 * `remote_control` enables Claude Code Remote Control at resident-session
 * startup; `extra_args` / `extra_env` are passed through. `model` and
 * `permission_mode` are `null` when the operator does not pin them (Claude
 * Code's own defaults apply). `turn_timeout_ms` is a per-turn *idle /
 * inactivity* window (issue #120 anti-hang, made idle-based in issue #156): it
 * is reset on every inbound stream line, so it bounds the max time the
 * still-alive child may emit *no* stream activity — not the total turn duration.
 * A child silent for the whole window is failed and reaped/re-spawned (rather
 * than wedging the serial turn queue and, behind it, TeamMate completion
 * delivery), while a long but actively-streaming turn never trips it.
 */
export interface DispatcherClaudeCodeConfig {
  bin: string;
  model: string | null;
  permission_mode: string | null;
  remote_control: boolean;
  extra_args: string[];
  extra_env: Record<string, string>;
  turn_timeout_ms: number;
}

/** Default `dispatchers[].runtime.config.bin` for `builtin:claude-code`. */
export const DEFAULT_CLAUDE_CODE_BIN = 'claude';

/**
 * Default per-turn *idle* window for the resident `builtin:claude-code` child
 * (ms). This is the max time the child may emit no stream activity before the
 * turn is failed and the child reaped (issue #120 anti-hang, idle-based since
 * issue #156) — it is reset on every stream line, so it does not cap a long but
 * actively-streaming turn. Operators can override via
 * `dispatchers[].runtime.config.turn_timeout_ms`.
 */
export const DEFAULT_CLAUDE_CODE_TURN_TIMEOUT_MS = 600_000;

/** Permission modes accepted for `builtin:claude-code` (Claude Code `--permission-mode`). */
export const ALLOWED_CLAUDE_CODE_PERMISSION_MODES = new Set([
  'default',
  'acceptEdits',
  'plan',
  'bypassPermissions',
]);

export function defaultDispatcherClaudeCodeConfig(): DispatcherClaudeCodeConfig {
  return {
    bin: DEFAULT_CLAUDE_CODE_BIN,
    model: null,
    permission_mode: null,
    remote_control: false,
    extra_args: [],
    extra_env: {},
    turn_timeout_ms: DEFAULT_CLAUDE_CODE_TURN_TIMEOUT_MS,
  };
}

export function readDispatcherClaudeCodeConfig(
  rawClaude: Record<string, unknown>,
  file: string,
  prefix: string,
): DispatcherClaudeCodeConfig {
  rejectUnknownKeys(
    rawClaude,
    new Set([
      'bin',
      'model',
      'permission_mode',
      'remote_control',
      'extra_args',
      'extra_env',
      'turn_timeout_ms',
    ]),
    file,
    prefix,
  );
  const defaults = defaultDispatcherClaudeCodeConfig();
  const bin = readOptionalString(rawClaude, 'bin', file, prefix) ?? defaults.bin;
  if (bin.trim() === '') {
    throw new Error(
      `dreamux config error in ${file}: ${prefix}bin must be a non-empty string`,
    );
  }
  const permissionMode = readOptionalString(rawClaude, 'permission_mode', file, prefix);
  if (
    permissionMode !== null &&
    !ALLOWED_CLAUDE_CODE_PERMISSION_MODES.has(permissionMode)
  ) {
    throw new Error(
      `dreamux config error in ${file}: ${prefix}permission_mode='${permissionMode}' is not one of ${Array.from(ALLOWED_CLAUDE_CODE_PERMISSION_MODES).join(' | ')}`,
    );
  }
  return {
    bin,
    model: readOptionalString(rawClaude, 'model', file, prefix),
    permission_mode: permissionMode,
    remote_control: readOptionalBoolean(
      rawClaude,
      'remote_control',
      defaults.remote_control,
      file,
      prefix,
    ),
    extra_args: requireStringArray(
      rawClaude,
      'extra_args',
      defaults.extra_args,
      file,
      prefix,
    ),
    extra_env: requireStringRecord(
      rawClaude,
      'extra_env',
      defaults.extra_env,
      file,
      prefix,
    ),
    turn_timeout_ms: requirePositiveInt(
      rawClaude,
      'turn_timeout_ms',
      defaults.turn_timeout_ms,
      file,
      prefix,
    ),
  };
}

/**
 * Typed accessor for a dispatcher's resolved claude-code runtime config. Typed
 * structurally (not against `DispatcherConfig`) so this module never imports
 * the host config type — a full `DispatcherConfig` still satisfies it at the
 * call sites.
 */
export function dispatcherClaudeCodeConfig(dispatcher: {
  id: string;
  runtime: { provider: string; config: unknown };
}): DispatcherClaudeCodeConfig {
  if (dispatcher.runtime.provider !== BUILTIN_CLAUDE_CODE_PROVIDER_REF) {
    throw new Error(
      `dispatcher '${dispatcher.id}' runtime provider ${JSON.stringify(dispatcher.runtime.provider)} is not wired to Claude Code`,
    );
  }
  return dispatcher.runtime.config as DispatcherClaudeCodeConfig;
}
