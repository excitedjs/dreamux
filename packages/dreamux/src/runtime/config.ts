/**
 * Global dreamux configuration loaded from `~/.dreamux/config.json`.
 *
 * Layout:
 *   ~/.dreamux/        user-editable dreamux configuration and channel secrets
 *   ~/.codex-host/     runtime data (SQLite, sockets, dispatcher logs)
 *
 * Format: JSON. dreamux does not write TOML files.
 */

import { homedir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeSync,
} from 'node:fs';

export interface DreamuxConfig {
  /** Where dreamux stores runtime state. */
  runtime_dir: string;
  /** Admin Unix socket path; null = derive as <runtime_dir>/admin.sock. */
  admin_socket: string | null;
  codex: {
    /** codex CLI binary path; `codex` resolves via $PATH. */
    bin: string;
    /** Default approval policy applied to every dispatcher. */
    approval_policy: string;
    /** Default sandbox mode applied to every dispatcher. */
    sandbox_mode: string;
    /** Default extra args appended to every codex app-server invocation. */
    extra_args: string[];
    /** Handshake timeout (ms). */
    initialize_timeout_ms: number;
  };
  outbound: {
    /** Outbound (Feishu send) retry count. */
    retries: number;
    /** Initial outbound retry delay (ms). */
    retry_delay_ms: number;
  };
  feishu: {
    bots: Record<string, FeishuBotConfig>;
  };
}

export interface FeishuBotConfig {
  app_id: string;
  app_secret: string;
}

export const BUILT_IN_DEFAULTS: DreamuxConfig = {
  runtime_dir: '~/.codex-host',
  admin_socket: null,
  codex: {
    bin: 'codex',
    approval_policy: 'never',
    sandbox_mode: 'workspace-write',
    extra_args: [],
    initialize_timeout_ms: 10_000,
  },
  outbound: {
    retries: 3,
    retry_delay_ms: 1000,
  },
  feishu: {
    bots: {},
  },
};

export const ALLOWED_SANDBOX_MODES = new Set([
  'read-only',
  'workspace-write',
  'danger-full-access',
]);

export const DEFAULT_CONFIG_JSON = `${JSON.stringify(BUILT_IN_DEFAULTS, null, 2)}\n`;

export interface ConfigPathOverrides {
  /** Override the global config dir. Default: ~/.dreamux. */
  configDir?: string;
}

export function globalConfigDir(overrides: ConfigPathOverrides = {}): string {
  if (overrides.configDir !== undefined) return overrides.configDir;
  return process.env['DREAMUX_CONFIG_DIR'] || join(homedir(), '.dreamux');
}

export function globalConfigFile(overrides: ConfigPathOverrides = {}): string {
  return join(globalConfigDir(overrides), 'config.json');
}

export function legacyGlobalConfigFile(
  overrides: ConfigPathOverrides = {},
): string {
  return join(globalConfigDir(overrides), 'config.toml');
}

export function loadOrInitConfig(
  overrides: ConfigPathOverrides = {},
): { config: DreamuxConfig; configFile: string; createdOnThisBoot: boolean } {
  const file = globalConfigFile(overrides);
  assertNoLegacyTomlOnly(overrides);
  mkdirSync(dirname(file), { recursive: true });

  const createdOnThisBoot = atomicWriteIfAbsent(file, DEFAULT_CONFIG_JSON);
  const config = readConfigFile(file);
  return { config, configFile: file, createdOnThisBoot };
}

export function loadConfig(
  overrides: ConfigPathOverrides = {},
): { config: DreamuxConfig; configFile: string } {
  const file = globalConfigFile(overrides);
  assertNoLegacyTomlOnly(overrides);
  return { config: readConfigFile(file), configFile: file };
}

export function stringifyConfig(config: DreamuxConfig): string {
  return `${JSON.stringify(config, null, 2)}\n`;
}

export function redactConfigForDisplay(raw: string, file: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(
      `dreamux config parse error in ${file}: ${msg}\n` +
        `Use 'dreamux config show --raw' to print the file without redaction.`,
    );
  }
  redactFeishuSecrets(parsed);
  return `${JSON.stringify(parsed, null, 2)}\n`;
}

function readConfigFile(file: string): DreamuxConfig {
  const raw = readFileSync(file, 'utf8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(
      `dreamux config parse error in ${file}: ${msg}\n` +
        `Fix the JSON syntax in ${file} and restart, or delete the file to regenerate defaults.`,
    );
  }
  return mergeWithDefaults(parsed, file);
}

export function assertNoLegacyTomlOnly(
  overrides: ConfigPathOverrides = {},
): void {
  const jsonFile = globalConfigFile(overrides);
  const tomlFile = legacyGlobalConfigFile(overrides);
  if (existsSync(jsonFile) || !existsSync(tomlFile)) return;
  throw new Error(
    `legacy dreamux config detected at ${tomlFile}, but ${jsonFile} does not exist.\n` +
      'dreamux no longer reads TOML config and will not create default JSON over an existing install, because that can hide the old runtime_dir and dispatcher database.\n' +
      `Create ${jsonFile} manually from ${tomlFile}, then move ${tomlFile} aside. Preserve runtime_dir/admin_socket/codex/outbound settings and add feishu.bots entries for configured dispatchers.`,
  );
}

function atomicWriteIfAbsent(file: string, content: string): boolean {
  let fd: number;
  try {
    fd = openSync(file, 'wx', 0o600);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw err;
  }
  try {
    writeSync(fd, content);
  } finally {
    closeSync(fd);
  }
  return true;
}

function mergeWithDefaults(raw: unknown, file: string): DreamuxConfig {
  if (!isPlainObject(raw)) {
    throw new Error(`dreamux config error in ${file}: top-level must be an object`);
  }

  const codexIn = isPlainObject(raw['codex']) ? raw['codex'] : {};
  const outboundIn = isPlainObject(raw['outbound']) ? raw['outbound'] : {};
  const feishuIn = isPlainObject(raw['feishu']) ? raw['feishu'] : {};

  const runtime_dir = expandHome(
    requireString(raw, 'runtime_dir', BUILT_IN_DEFAULTS.runtime_dir, file),
  );
  const admin_socket_raw = raw['admin_socket'];
  const admin_socket =
    admin_socket_raw === undefined || admin_socket_raw === null
      ? null
      : expandHome(ensureString(admin_socket_raw, 'admin_socket', file));

  const approval_policy = requireString(
    codexIn,
    'approval_policy',
    BUILT_IN_DEFAULTS.codex.approval_policy,
    file,
    'codex.',
  );
  const ALLOWED_POLICIES = new Set([
    'never',
    'auto',
    'auto-approve',
    'on-failure',
  ]);
  if (!ALLOWED_POLICIES.has(approval_policy)) {
    throw new Error(
      `dreamux config error in ${file}: codex.approval_policy='${approval_policy}' ` +
        `is not one of ${Array.from(ALLOWED_POLICIES).join(' | ')}`,
    );
  }

  const sandbox_mode = requireString(
    codexIn,
    'sandbox_mode',
    BUILT_IN_DEFAULTS.codex.sandbox_mode,
    file,
    'codex.',
  );
  if (!ALLOWED_SANDBOX_MODES.has(sandbox_mode)) {
    throw new Error(
      `dreamux config error in ${file}: codex.sandbox_mode='${sandbox_mode}' ` +
        `is not one of ${Array.from(ALLOWED_SANDBOX_MODES).join(' | ')}`,
    );
  }

  return {
    runtime_dir,
    admin_socket,
    codex: {
      bin: requireString(codexIn, 'bin', BUILT_IN_DEFAULTS.codex.bin, file, 'codex.'),
      approval_policy,
      sandbox_mode,
      extra_args: requireStringArray(
        codexIn,
        'extra_args',
        BUILT_IN_DEFAULTS.codex.extra_args,
        file,
        'codex.',
      ),
      initialize_timeout_ms: requirePositiveInt(
        codexIn,
        'initialize_timeout_ms',
        BUILT_IN_DEFAULTS.codex.initialize_timeout_ms,
        file,
        'codex.',
      ),
    },
    outbound: {
      retries: requireNonNegativeInt(
        outboundIn,
        'retries',
        BUILT_IN_DEFAULTS.outbound.retries,
        file,
        'outbound.',
      ),
      retry_delay_ms: requireNonNegativeInt(
        outboundIn,
        'retry_delay_ms',
        BUILT_IN_DEFAULTS.outbound.retry_delay_ms,
        file,
        'outbound.',
      ),
    },
    feishu: {
      bots: readFeishuBots(feishuIn, file),
    },
  };
}

function readFeishuBots(
  feishuIn: Record<string, unknown>,
  file: string,
): Record<string, FeishuBotConfig> {
  const rawBots = feishuIn['bots'];
  if (rawBots === undefined) return {};
  if (!isPlainObject(rawBots)) {
    throw new Error(
      `dreamux config error in ${file}: feishu.bots must be an object (got ${describeType(rawBots)})`,
    );
  }
  const bots: Record<string, FeishuBotConfig> = {};
  for (const [id, rawBot] of Object.entries(rawBots)) {
    if (!isPlainObject(rawBot)) {
      throw new Error(
        `dreamux config error in ${file}: feishu.bots.${id} must be an object (got ${describeType(rawBot)})`,
      );
    }
    bots[id] = {
      app_id: requireString(rawBot, 'app_id', '', file, `feishu.bots.${id}.`),
      app_secret: requireString(
        rawBot,
        'app_secret',
        '',
        file,
        `feishu.bots.${id}.`,
      ),
    };
  }
  return bots;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function requireString(
  obj: Record<string, unknown>,
  key: string,
  fallback: string,
  file: string,
  prefix = '',
): string {
  const v = obj[key];
  if (v === undefined) return fallback;
  return ensureString(v, `${prefix}${key}`, file);
}

function ensureString(v: unknown, key: string, file: string): string {
  if (typeof v !== 'string') {
    throw new Error(
      `dreamux config error in ${file}: ${key} must be a string (got ${describeType(v)})`,
    );
  }
  return v;
}

function requireStringArray(
  obj: Record<string, unknown>,
  key: string,
  fallback: string[],
  file: string,
  prefix = '',
): string[] {
  const v = obj[key];
  if (v === undefined) return fallback;
  if (!Array.isArray(v)) {
    throw new Error(
      `dreamux config error in ${file}: ${prefix}${key} must be an array of strings (got ${describeType(v)})`,
    );
  }
  return v.map((item, i) => {
    if (typeof item !== 'string') {
      throw new Error(
        `dreamux config error in ${file}: ${prefix}${key}[${i}] must be a string (got ${describeType(item)})`,
      );
    }
    return item;
  });
}

function requirePositiveInt(
  obj: Record<string, unknown>,
  key: string,
  fallback: number,
  file: string,
  prefix = '',
): number {
  const n = readInt(obj, key, file, prefix);
  if (n === null) return fallback;
  if (n <= 0) {
    throw new Error(
      `dreamux config error in ${file}: ${prefix}${key} must be > 0 (got ${n})`,
    );
  }
  return n;
}

function requireNonNegativeInt(
  obj: Record<string, unknown>,
  key: string,
  fallback: number,
  file: string,
  prefix = '',
): number {
  const n = readInt(obj, key, file, prefix);
  if (n === null) return fallback;
  if (n < 0) {
    throw new Error(
      `dreamux config error in ${file}: ${prefix}${key} must be >= 0 (got ${n})`,
    );
  }
  return n;
}

function readInt(
  obj: Record<string, unknown>,
  key: string,
  file: string,
  prefix: string,
): number | null {
  const v = obj[key];
  if (v === undefined) return null;
  if (typeof v === 'number' && Number.isInteger(v)) return v;
  throw new Error(
    `dreamux config error in ${file}: ${prefix}${key} must be an integer (got ${describeType(v)})`,
  );
}

function describeType(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v;
}

function redactFeishuSecrets(value: unknown): void {
  if (!isPlainObject(value)) return;
  const feishu = value['feishu'];
  if (!isPlainObject(feishu)) return;
  const bots = feishu['bots'];
  if (!isPlainObject(bots)) return;
  for (const bot of Object.values(bots)) {
    if (isPlainObject(bot) && typeof bot['app_secret'] === 'string') {
      bot['app_secret'] = '<redacted>';
    }
  }
}

export function expandHome(path: string): string {
  if (path === '~') return homedir();
  if (path.startsWith('~/')) return join(homedir(), path.slice(2));
  if (!isAbsolute(path)) return path;
  return path;
}
