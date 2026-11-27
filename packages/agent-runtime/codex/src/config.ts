/**
 * Builtin `builtin:codex` runtime config: schema type, defaults, and reader.
 *
 * Codex runtime config is owned by this package (the `builtin:codex` provider),
 * not by the Dreamux host config module. It depends only on the shared neutral
 * validation primitives (`@excitedjs/dreamux-utils`), never on
 * `@excitedjs/dreamux` core.
 */

import {
  readOptionalString,
  readStringArray,
  readStringRecord,
  RuleViolation,
} from '@excitedjs/dreamux-utils';

/**
 * Builtin Codex runtime settings under a named `agents[].config` entry (provider
 * `builtin:codex`), referenced by a dispatcher via `dispatchers[].agentRuntime`.
 * Every field carries a built-in default, so an agent that omits any config
 * field runs with these constants.
 *
 * `bin` is the dispatcher's Codex binary path; the `CODEX_HOST_CODEX_BIN`
 * environment variable is a host-level override that takes precedence over it
 * (resolved by the codex builtin's `resolveCodexBinPath`).
 * `model` and `effort` map to `-c model=<toml>` and
 * `-c model_reasoning_effort=<toml>` ahead of `extra_args`; `null` leaves them
 * to Codex's own configuration.
 */
export interface DispatcherCodexConfig {
  bin: string;
  model: string | null;
  effort: string | null;
  extra_args: string[];
  extra_env: Record<string, string>;
}

/**
 * Default `agents[].config.bin`. The Codex binary path is
 * dispatcher-local; `CODEX_HOST_CODEX_BIN` is a host-level override above it,
 * not the source.
 */
export const DEFAULT_CODEX_BIN = 'codex';

export function defaultDispatcherCodexConfig(): DispatcherCodexConfig {
  return {
    bin: DEFAULT_CODEX_BIN,
    model: null,
    effort: null,
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

export function readDispatcherCodexConfig(
  rawCodex: Record<string, unknown>,
  file: string,
  prefix: string,
): DispatcherCodexConfig {
  // Unknown fields (including retired 'approval_policy', 'sandbox_mode',
  // 'initialize_timeout_ms', and 'turn_timeout_ms') are tolerated, not
  // rejected — the persisted-shape policy (R21) rejects only a wrong type or
  // an invalid value on a recognized field.
  const defaults = defaultDispatcherCodexConfig();
  const bin = readOptionalString(rawCodex, 'bin', file, prefix) ?? defaults.bin;
  if (bin.trim() === '') {
    throw new RuleViolation(
      `dreamux config error in ${file}: ${prefix}bin must be a non-empty string`,
    );
  }
  return {
    bin,
    model: readOptionalNonEmptyString(rawCodex, 'model', file, prefix),
    effort: readOptionalNonEmptyString(rawCodex, 'effort', file, prefix),
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
  };
}
