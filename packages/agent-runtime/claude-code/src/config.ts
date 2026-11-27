/**
 * Builtin `builtin:claude-code` runtime config: schema type, defaults, and
 * reader.
 *
 * Owned by the `@excitedjs/agent-runtime-claude-code` package (issue #209). It
 * depends only on the shared neutral validation primitives
 * (`@excitedjs/dreamux-utils`); it never imports `@excitedjs/dreamux` core.
 * The package's `./config` export subpath (see `package.json`) resolves to
 * this module directly, kept open for a future config-only consumer that
 * wants to avoid pulling in the runtime engine through the package's main
 * `./index.js`/`plugin.js` chain; no such consumer exists yet.
 */

import {
  readOptionalBoolean,
  readOptionalString,
  readStringArray,
  readStringRecord,
  RuleViolation,
} from '@excitedjs/dreamux-utils';

/**
 * Builtin Claude Code runtime settings under a named `agents[].config` entry
 * whose `provider` is `builtin:claude-code` (issue #110 PR6), referenced by a
 * dispatcher via `dispatchers[].agentRuntime`.
 *
 * `bin` is the Claude Code binary; `model` / `effort` map to `--model` /
 * `--effort` ahead of `extra_args` (`null` leaves selection to Claude Code's
 * own defaults); `remote_control` enables Claude Code Remote Control at
 * resident-session startup; `extra_args` / `extra_env` are passed through.
 */
export interface DispatcherClaudeCodeConfig {
  bin: string;
  model: string | null;
  effort: string | null;
  remote_control: boolean;
  extra_args: string[];
  extra_env: Record<string, string>;
}

/** Default `agents[].config.bin` for `builtin:claude-code`. */
export const DEFAULT_CLAUDE_CODE_BIN = 'claude';

export function defaultDispatcherClaudeCodeConfig(): DispatcherClaudeCodeConfig {
  return {
    bin: DEFAULT_CLAUDE_CODE_BIN,
    model: null,
    effort: null,
    remote_control: false,
    extra_args: [],
    extra_env: {},
  };
}

function readOptionalNonEmptyString(
  raw: Record<string, unknown>,
  key: string,
  file: string,
  prefix: string,
): string | null {
  const value = readOptionalString(raw, key, file, prefix);
  if (value !== null && value.trim() === '') {
    throw new RuleViolation(
      `dreamux config error in ${file}: ${prefix}${key} must be a non-empty string`,
    );
  }
  return value;
}

export function readDispatcherClaudeCodeConfig(
  rawClaude: Record<string, unknown>,
  file: string,
  prefix: string,
): DispatcherClaudeCodeConfig {
  // Unknown fields (including retired 'permission_mode' and 'turn_timeout_ms')
  // are tolerated and ignored under the persisted-shape policy (R21).
  const defaults = defaultDispatcherClaudeCodeConfig();
  const bin =
    readOptionalString(rawClaude, 'bin', file, prefix) ?? defaults.bin;
  if (bin.trim() === '') {
    throw new RuleViolation(
      `dreamux config error in ${file}: ${prefix}bin must be a non-empty string`,
    );
  }
  return {
    bin,
    model: readOptionalNonEmptyString(rawClaude, 'model', file, prefix),
    effort: readOptionalNonEmptyString(rawClaude, 'effort', file, prefix),
    remote_control: readOptionalBoolean(
      rawClaude,
      'remote_control',
      defaults.remote_control,
      file,
      prefix,
    ),
    extra_args: readStringArray(
      rawClaude,
      'extra_args',
      defaults.extra_args,
      file,
      prefix,
    ),
    extra_env: readStringRecord(
      rawClaude,
      'extra_env',
      defaults.extra_env,
      file,
      prefix,
    ),
  };
}
