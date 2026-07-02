import {
  isPlainObject,
  readOptionalBoolean,
  readOptionalString,
  rejectUnknownKeys,
  requirePositiveInt,
  requireStringRecord,
} from '@excitedjs/dreamux-utils';

export type MimoCodePermissionMode = 'deny';

export interface MimoCodeConfig {
  bin: string;
  model: string | null;
  agent: string | null;
  extra_env: Record<string, string>;
  config_content: string | null;
  config_path: string | null;
  permission_mode: MimoCodePermissionMode;
  startup_timeout_ms: number;
  turn_timeout_ms: number;
  keep_home: boolean;
}

export const DEFAULT_MIMO_CODE_BIN = 'mimo';
export const DEFAULT_MIMO_CODE_STARTUP_TIMEOUT_MS = 30_000;
export const DEFAULT_MIMO_CODE_TURN_TIMEOUT_MS = 600_000;

export function defaultMimoCodeConfig(): MimoCodeConfig {
  return {
    bin: DEFAULT_MIMO_CODE_BIN,
    model: null,
    agent: null,
    extra_env: {},
    config_content: null,
    config_path: null,
    permission_mode: 'deny',
    startup_timeout_ms: DEFAULT_MIMO_CODE_STARTUP_TIMEOUT_MS,
    turn_timeout_ms: DEFAULT_MIMO_CODE_TURN_TIMEOUT_MS,
    keep_home: false,
  };
}

export function readMimoCodeConfig(
  rawConfig: Record<string, unknown>,
  file: string,
  prefix: string,
): MimoCodeConfig {
  rejectUnknownKeys(
    rawConfig,
    new Set([
      'bin',
      'model',
      'agent',
      'extra_env',
      'config_content',
      'config_path',
      'permission_mode',
      'startup_timeout_ms',
      'turn_timeout_ms',
      'keep_home',
    ]),
    file,
    prefix,
  );

  const defaults = defaultMimoCodeConfig();
  const bin = readOptionalString(rawConfig, 'bin', file, prefix) ?? defaults.bin;
  if (bin.trim() === '') {
    throw new Error(
      `dreamux config error in ${file}: ${prefix}bin must be a non-empty string`,
    );
  }
  const permissionMode = readPermissionMode(rawConfig, file, prefix);
  const configContent = readOptionalString(
    rawConfig,
    'config_content',
    file,
    prefix,
  );
  const configPath = readOptionalString(rawConfig, 'config_path', file, prefix);
  if (configContent !== null && configPath !== null) {
    throw new Error(
      `dreamux config error in ${file}: ${prefix}config_content and ${prefix}config_path are mutually exclusive`,
    );
  }

  return {
    bin,
    model: readOptionalString(rawConfig, 'model', file, prefix),
    agent: readOptionalString(rawConfig, 'agent', file, prefix),
    extra_env: requireStringRecord(
      rawConfig,
      'extra_env',
      defaults.extra_env,
      file,
      prefix,
    ),
    config_content: configContent,
    config_path: configPath,
    permission_mode: permissionMode,
    startup_timeout_ms: requirePositiveInt(
      rawConfig,
      'startup_timeout_ms',
      defaults.startup_timeout_ms,
      file,
      prefix,
    ),
    turn_timeout_ms: requirePositiveInt(
      rawConfig,
      'turn_timeout_ms',
      defaults.turn_timeout_ms,
      file,
      prefix,
    ),
    keep_home: readOptionalBoolean(
      rawConfig,
      'keep_home',
      defaults.keep_home,
      file,
      prefix,
    ),
  };
}

function readPermissionMode(
  rawConfig: Record<string, unknown>,
  file: string,
  prefix: string,
): MimoCodePermissionMode {
  const raw = rawConfig.permission_mode;
  if (raw === undefined || raw === null) return 'deny';
  if (typeof raw !== 'string') {
    throw new Error(
      `dreamux config error in ${file}: ${prefix}permission_mode must be a string`,
    );
  }
  if (raw === 'deny') return raw;
  if (raw === 'ask') {
    throw new Error(
      `dreamux config error in ${file}: ${prefix}permission_mode='ask' is not supported until the provider owns a complete permission response loop`,
    );
  }
  if (raw === 'auto-approve') {
    throw new Error(
      `dreamux config error in ${file}: ${prefix}permission_mode='auto-approve' is not supported until the provider owns a complete MiMo permission response loop`,
    );
  }
  throw new Error(
    `dreamux config error in ${file}: ${prefix}permission_mode='${raw}' is not one of deny`,
  );
}

export function assertNoNativeMcpConfig(
  rawConfig: unknown,
  file: string,
  prefix: string,
): void {
  if (!isPlainObject(rawConfig)) return;
  if ('mcp' in rawConfig || 'mcpServers' in rawConfig) {
    throw new Error(
      `dreamux config error in ${file}: ${prefix}native MiMo MCP config is not allowed; Dreamux-supplied mcpServers are authoritative`,
    );
  }
}
