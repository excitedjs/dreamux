import {
  readOptionalString,
  rejectUnknownKeys,
  requirePositiveInt,
  requireStringArray,
  requireStringRecord,
} from '@excitedjs/dreamux-utils';

export interface DispatcherKimiCodeConfig {
  /** Kimi Code CLI binary. */
  bin: string;
  home_dir: string | null;
  extra_args: string[];
  extra_env: Record<string, string>;
  turn_timeout_ms: number;
}

export const DEFAULT_KIMI_CODE_TURN_TIMEOUT_MS = 600_000;
export const DEFAULT_KIMI_CODE_BIN = 'kimi';

export function defaultDispatcherKimiCodeConfig(): DispatcherKimiCodeConfig {
  return {
    bin: DEFAULT_KIMI_CODE_BIN,
    home_dir: null,
    extra_args: [],
    extra_env: {},
    turn_timeout_ms: DEFAULT_KIMI_CODE_TURN_TIMEOUT_MS,
  };
}

export function readDispatcherKimiCodeConfig(
  rawKimi: Record<string, unknown>,
  file: string,
  prefix: string,
): DispatcherKimiCodeConfig {
  rejectUnknownKeys(
    rawKimi,
    new Set(['bin', 'home_dir', 'extra_args', 'extra_env', 'turn_timeout_ms']),
    file,
    prefix,
  );
  const defaults = defaultDispatcherKimiCodeConfig();
  const bin = readOptionalString(rawKimi, 'bin', file, prefix) ?? defaults.bin;
  if (bin.trim() === '') {
    throw new Error(
      `dreamux config error in ${file}: ${prefix}bin must be a non-empty string`,
    );
  }
  const homeDir = readOptionalString(rawKimi, 'home_dir', file, prefix);
  if (homeDir !== null && homeDir.trim() === '') {
    throw new Error(
      `dreamux config error in ${file}: ${prefix}home_dir must be a non-empty string`,
    );
  }
  return {
    bin,
    home_dir: homeDir,
    extra_args: requireStringArray(
      rawKimi,
      'extra_args',
      defaults.extra_args,
      file,
      prefix,
    ),
    extra_env: requireStringRecord(
      rawKimi,
      'extra_env',
      defaults.extra_env,
      file,
      prefix,
    ),
    turn_timeout_ms: requirePositiveInt(
      rawKimi,
      'turn_timeout_ms',
      defaults.turn_timeout_ms,
      file,
      prefix,
    ),
  };
}
