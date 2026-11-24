import {
  readOptionalString,
  readStringArray,
  readStringRecord,
  RuleViolation,
} from '@excitedjs/dreamux-utils';

export type AntigravityTransport = 'tmux' | 'acp';

export interface AntigravityConfig {
  transport: AntigravityTransport;
  bin: string;
  model: string | null;
  effort: string | null;
  extra_args: string[];
  extra_env: Record<string, string>;
}

export const DEFAULT_ANTIGRAVITY_BIN = 'agy';
export const DEFAULT_ANTIGRAVITY_TRANSPORT: AntigravityTransport = 'tmux';
export const ANTIGRAVITY_EFFORTS = new Set([
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
]);

export function defaultAntigravityConfig(): AntigravityConfig {
  return {
    transport: DEFAULT_ANTIGRAVITY_TRANSPORT,
    bin: DEFAULT_ANTIGRAVITY_BIN,
    model: null,
    effort: null,
    extra_args: [],
    extra_env: {},
  };
}

export function readAntigravityConfig(
  raw: Record<string, unknown>,
  file: string,
  prefix: string,
): AntigravityConfig {
  const defaults = defaultAntigravityConfig();
  const transport = readOptionalString(raw, 'transport', file, prefix);
  if (transport !== null && transport !== 'tmux' && transport !== 'acp') {
    throw new RuleViolation(
      `dreamux config error in ${file}: ${prefix}transport must be tmux or acp`,
    );
  }
  const bin = readOptionalString(raw, 'bin', file, prefix) ?? defaults.bin;
  if (bin.trim() === '') {
    throw new RuleViolation(
      `dreamux config error in ${file}: ${prefix}bin must be a non-empty string`,
    );
  }
  const effort = readOptionalString(raw, 'effort', file, prefix);
  if (effort !== null && !ANTIGRAVITY_EFFORTS.has(effort)) {
    throw new RuleViolation(
      `dreamux config error in ${file}: ${prefix}effort must be low, medium, high, xhigh, or max`,
    );
  }
  return {
    transport: transport ?? defaults.transport,
    bin,
    model: readOptionalString(raw, 'model', file, prefix),
    effort,
    extra_args: readStringArray(
      raw,
      'extra_args',
      defaults.extra_args,
      file,
      prefix,
    ),
    extra_env: readStringRecord(
      raw,
      'extra_env',
      defaults.extra_env,
      file,
      prefix,
    ),
  };
}
