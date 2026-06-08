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
 */

import { BUILTIN_CLAUDE_CODE_PROVIDER_REF } from '../../../registry/index.js';
import {
  readOptionalString,
  rejectUnknownKeys,
  requirePositiveInt,
  requireStringArray,
  requireStringRecord,
} from '../../../config/validate.js';

/**
 * Builtin Claude Code runtime settings under `dispatchers[].runtime.config`
 * when `runtime.provider` is `builtin:claude-code` (issue #110 PR6).
 *
 * Deliberately distinct from `DispatcherCodexConfig`: Claude Code runs as a
 * resident headless stream-json process (`claude --print --input-format
 * stream-json …`, issue #120) with no `initialize` handshake, so there is no
 * handshake timeout, approval policy, or sandbox mode here. `bin` is the Claude
 * Code binary; `model` / `permission_mode` map to `--model` / `--permission-mode`;
 * `extra_args` / `extra_env` are passed through. `model` and `permission_mode`
 * are `null` when the operator does not pin them (Claude Code's own defaults
 * apply). `turn_timeout_ms` bounds a single resident turn (issue #120): if the
 * still-alive child never emits a terminal `result` for a turn, the runtime
 * fails that turn and reaps/re-spawns the child rather than wedging the serial
 * turn queue (and, behind it, TeamMate completion delivery) forever.
 */
export interface DispatcherClaudeCodeConfig {
  bin: string;
  model: string | null;
  permission_mode: string | null;
  extra_args: string[];
  extra_env: Record<string, string>;
  turn_timeout_ms: number;
}

/** Default `dispatchers[].runtime.config.bin` for `builtin:claude-code`. */
export const DEFAULT_CLAUDE_CODE_BIN = 'claude';

/**
 * Default per-turn deadline for the resident `builtin:claude-code` child (ms).
 * Generous enough not to interrupt a legitimately long tool-using turn, but
 * finite so a child that stalls without a terminal `result` cannot wedge the
 * dispatcher (issue #120). Operators can override via
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
