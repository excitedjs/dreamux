/**
 * Global dreamux configuration loaded from `~/.dreamux/config.json`.
 *
 * Layout:
 *   ~/.dreamux/config.json  dreamux configuration and local channel secrets
 *
 * Format: JSON. dreamux does not write TOML files.
 */

import { homedir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { access, mkdir, open, readFile, stat } from 'node:fs/promises';
import { validateDispatcherId } from './dispatcher-id.js';

/** Async existence probe — the fs/promises replacement for `existsSync`. */
async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export interface DreamuxConfig {
  /** Dispatcher declarations and local channel credentials. */
  dispatchers: DispatcherConfig[];
}

export interface DispatcherConfig {
  id: string;
  cwd: string | null;
  enabled: boolean;
  feishu: {
    app_id: string;
    app_secret: string;
  };
  codex: DispatcherCodexConfig;
}

/**
 * Per-dispatcher Codex settings — the only Codex configuration entry point.
 * Every field carries a built-in default, so a dispatcher that omits `codex`
 * (or any field within it) runs with these constants. There is no top-level
 * `codex` block anymore: Codex config is dispatcher-local.
 *
 * `bin` is the dispatcher's Codex binary path; the `CODEX_HOST_CODEX_BIN`
 * environment variable is a host-level override that takes precedence over it
 * (see `Server.resolveCodexBinPath`). `initialize_timeout_ms` is that
 * dispatcher's handshake timeout.
 */
export interface DispatcherCodexConfig {
  bin: string;
  approval_policy: string;
  sandbox_mode: string;
  extra_args: string[];
  extra_env: Record<string, string>;
  initialize_timeout_ms: number;
}

/**
 * Default `dispatchers[].codex.bin`. The codex binary path is dispatcher-local;
 * `CODEX_HOST_CODEX_BIN` is a host-level override above it, not the source.
 */
export const DEFAULT_CODEX_BIN = 'codex';

/** Default `dispatchers[].codex.initialize_timeout_ms` (handshake timeout, ms). */
export const DEFAULT_INITIALIZE_TIMEOUT_MS = 10_000;

/** Default `dispatchers[].codex.approval_policy` when the field is omitted. */
export const DEFAULT_APPROVAL_POLICY = 'never';

/** Default `dispatchers[].codex.sandbox_mode` when the field is omitted. */
export const DEFAULT_SANDBOX_MODE = 'workspace-write';

export const BUILT_IN_DEFAULTS: DreamuxConfig = {
  dispatchers: [],
};

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

export async function loadOrInitConfig(
  overrides: ConfigPathOverrides = {},
): Promise<{
  config: DreamuxConfig;
  configFile: string;
  createdOnThisBoot: boolean;
}> {
  const file = globalConfigFile(overrides);
  await assertNoLegacyTomlOnly(overrides);
  await mkdir(dirname(file), { recursive: true });

  const createdOnThisBoot = await atomicWriteIfAbsent(file, DEFAULT_CONFIG_JSON);
  const config = await readConfigFile(file);
  return { config, configFile: file, createdOnThisBoot };
}

export async function loadConfig(
  overrides: ConfigPathOverrides = {},
): Promise<{ config: DreamuxConfig; configFile: string }> {
  const file = globalConfigFile(overrides);
  await assertNoLegacyTomlOnly(overrides);
  return { config: await readConfigFile(file), configFile: file };
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
        'Fix the JSON syntax before running `dreamux config show`.',
    );
  }
  redactFeishuSecrets(parsed);
  return `${JSON.stringify(parsed, null, 2)}\n`;
}

async function readConfigFile(file: string): Promise<DreamuxConfig> {
  if (!(await pathExists(file))) {
    throw new Error(
      `dreamux config is missing at ${file}.\n` +
        'Run `dreamux onboard` to create it before starting the server.',
    );
  }
  await assertConfigFileMode(file);
  const raw = await readFile(file, 'utf8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(
      `dreamux config parse error in ${file}: ${msg}\n` +
        `Fix the JSON syntax in ${file}, then restart. Run \`dreamux onboard\` if you need to recreate the config.`,
    );
  }
  return mergeWithDefaults(parsed, file);
}

export async function assertNoLegacyTomlOnly(
  overrides: ConfigPathOverrides = {},
): Promise<void> {
  const jsonFile = globalConfigFile(overrides);
  const tomlFile = legacyGlobalConfigFile(overrides);
  if ((await pathExists(jsonFile)) || !(await pathExists(tomlFile))) return;
  throw new Error(
    `legacy dreamux config detected at ${tomlFile}, but ${jsonFile} does not exist.\n` +
      'dreamux 0.x does not migrate TOML config; it will not read it or write default ' +
      'JSON over an existing install.\n' +
      `Recreate the config as JSON (run \`dreamux onboard\`, or write ${jsonFile} with a ` +
      `dispatchers array), then move ${tomlFile} aside.`,
  );
}

async function atomicWriteIfAbsent(
  file: string,
  content: string,
): Promise<boolean> {
  let handle;
  try {
    handle = await open(file, 'wx', 0o600);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw err;
  }
  try {
    await handle.writeFile(content);
  } finally {
    await handle.close();
  }
  return true;
}

export async function assertConfigFileMode(file: string): Promise<void> {
  if (process.platform === 'win32') return;
  const mode = (await stat(file)).mode & 0o777;
  if (mode === 0o600) return;
  throw new Error(
    `dreamux config file must be mode 0600: ${file} has mode 0${mode.toString(8)}`,
  );
}

function mergeWithDefaults(raw: unknown, file: string): DreamuxConfig {
  if (!isPlainObject(raw)) {
    throw new Error(`dreamux config error in ${file}: top-level must be an object`);
  }
  rejectTopLevelCodex(raw, file);
  rejectUnknownKeys(raw, new Set(['dispatchers']), file, '');

  return {
    dispatchers: readDispatchers(raw['dispatchers'], file),
  };
}

/**
 * The top-level `codex` block was removed: Codex settings are per-dispatcher
 * (`dispatchers[].codex`) and the binary path comes from `CODEX_HOST_CODEX_BIN`.
 * A leftover top-level block is rejected loudly with migration guidance rather
 * than silently ignored, so an operator's intent is never dropped.
 */
function rejectTopLevelCodex(raw: Record<string, unknown>, file: string): void {
  if (!('codex' in raw)) return;
  throw new Error(
    `dreamux config error in ${file}: a top-level "codex" block is no longer ` +
      'supported. Move Codex settings under each dispatchers[].codex ' +
      '(bin, approval_policy, sandbox_mode, extra_args, extra_env, ' +
      'initialize_timeout_ms). For a host-level binary override across all ' +
      'dispatchers, set the CODEX_HOST_CODEX_BIN environment variable.',
  );
}

function readDispatchers(rawDispatchers: unknown, file: string): DispatcherConfig[] {
  if (rawDispatchers === undefined) return [];
  if (!Array.isArray(rawDispatchers)) {
    throw new Error(
      `dreamux config error in ${file}: dispatchers must be an array (got ${describeType(rawDispatchers)})`,
    );
  }
  const out: DispatcherConfig[] = [];
  const ids = new Set<string>();
  const appIdToDispatcher = new Map<string, string>();
  for (let index = 0; index < rawDispatchers.length; index++) {
    const raw = rawDispatchers[index];
    const prefix = `dispatchers[${index}].`;
    if (!isPlainObject(raw)) {
      throw new Error(
        `dreamux config error in ${file}: dispatchers[${index}] must be an object (got ${describeType(raw)})`,
      );
    }
    rejectUnknownKeys(
      raw,
      new Set(['id', 'cwd', 'enabled', 'feishu', 'codex']),
      file,
      prefix,
    );
    const id = validateDispatcherId(
      requireNonEmptyString(raw, 'id', file, prefix),
      `${prefix}id`,
    );
    if (ids.has(id)) {
      throw new Error(
        `dreamux config error in ${file}: dispatchers[${index}].id duplicates dispatcher '${id}'`,
      );
    }
    ids.add(id);

    const feishu = readDispatcherFeishu(raw['feishu'], file, prefix);
    const app_id = feishu.app_id;
    const existing = appIdToDispatcher.get(app_id);
    if (existing !== undefined) {
      throw new Error(
        `dreamux config error in ${file}: dispatchers[${index}].feishu.app_id duplicates dispatcher '${existing}'`,
      );
    }
    appIdToDispatcher.set(app_id, id);

    const cwd = readOptionalString(raw, 'cwd', file, prefix);
    out.push({
      id,
      cwd: cwd === null ? null : expandHome(cwd),
      enabled: readOptionalBoolean(raw, 'enabled', true, file, prefix),
      feishu,
      codex: readDispatcherCodex(raw['codex'], file, prefix),
    });
  }
  return out;
}

function readDispatcherFeishu(
  rawFeishu: unknown,
  file: string,
  dispatcherPrefix: string,
): DispatcherConfig['feishu'] {
  const prefix = `${dispatcherPrefix}feishu.`;
  if (!isPlainObject(rawFeishu)) {
    throw new Error(
      `dreamux config error in ${file}: ${dispatcherPrefix}feishu must be an object (got ${describeType(rawFeishu)})`,
    );
  }
  rejectUnknownKeys(rawFeishu, new Set(['app_id', 'app_secret']), file, prefix);
  return {
    app_id: requireNonEmptyString(rawFeishu, 'app_id', file, prefix),
    app_secret: requireNonEmptyString(rawFeishu, 'app_secret', file, prefix),
  };
}

function readDispatcherCodex(
  rawCodex: unknown,
  file: string,
  dispatcherPrefix: string,
): DispatcherCodexConfig {
  const prefix = `${dispatcherPrefix}codex.`;
  if (rawCodex === undefined) {
    return {
      bin: DEFAULT_CODEX_BIN,
      approval_policy: DEFAULT_APPROVAL_POLICY,
      sandbox_mode: DEFAULT_SANDBOX_MODE,
      extra_args: [],
      extra_env: {},
      initialize_timeout_ms: DEFAULT_INITIALIZE_TIMEOUT_MS,
    };
  }
  if (!isPlainObject(rawCodex)) {
    throw new Error(
      `dreamux config error in ${file}: ${dispatcherPrefix}codex must be an object (got ${describeType(rawCodex)})`,
    );
  }
  rejectUnknownKeys(
    rawCodex,
    new Set([
      'bin',
      'approval_policy',
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
  const bin = readOptionalString(rawCodex, 'bin', file, prefix) ?? DEFAULT_CODEX_BIN;
  if (bin.trim() === '') {
    throw new Error(
      `dreamux config error in ${file}: ${prefix}bin must be a non-empty string`,
    );
  }
  const approvalPolicy =
    readOptionalString(rawCodex, 'approval_policy', file, prefix) ??
    DEFAULT_APPROVAL_POLICY;
  if (!ALLOWED_APPROVAL_POLICIES.has(approvalPolicy)) {
    throw new Error(
      `dreamux config error in ${file}: ${prefix}approval_policy='${approvalPolicy}' is not one of ${Array.from(ALLOWED_APPROVAL_POLICIES).join(' | ')}`,
    );
  }
  const sandboxMode =
    readOptionalString(rawCodex, 'sandbox_mode', file, prefix) ??
    DEFAULT_SANDBOX_MODE;
  if (!ALLOWED_SANDBOX_MODES.has(sandboxMode)) {
    throw new Error(
      `dreamux config error in ${file}: ${prefix}sandbox_mode='${sandboxMode}' is not one of ${Array.from(ALLOWED_SANDBOX_MODES).join(' | ')}`,
    );
  }
  return {
    bin,
    approval_policy: approvalPolicy,
    sandbox_mode: sandboxMode,
    extra_args: requireStringArray(rawCodex, 'extra_args', [], file, prefix),
    extra_env: requireStringRecord(rawCodex, 'extra_env', {}, file, prefix),
    initialize_timeout_ms: requirePositiveInt(
      rawCodex,
      'initialize_timeout_ms',
      DEFAULT_INITIALIZE_TIMEOUT_MS,
      file,
      prefix,
    ),
  };
}

function rejectUnknownKeys(
  obj: Record<string, unknown>,
  allowed: Set<string>,
  file: string,
  prefix: string,
): void {
  for (const key of Object.keys(obj)) {
    if (allowed.has(key)) continue;
    const name = `${prefix}${key}`;
    throw new Error(
      `dreamux config error in ${file}: ${name} is not supported by the MVP config schema`,
    );
  }
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

function requireNonEmptyString(
  obj: Record<string, unknown>,
  key: string,
  file: string,
  prefix = '',
): string {
  const value = requireString(obj, key, '', file, prefix);
  if (value.trim() !== '') return value;
  throw new Error(
    `dreamux config error in ${file}: ${prefix}${key} must be a non-empty string`,
  );
}

function readOptionalString(
  obj: Record<string, unknown>,
  key: string,
  file: string,
  prefix = '',
): string | null {
  const v = obj[key];
  if (v === undefined || v === null) return null;
  return ensureString(v, `${prefix}${key}`, file);
}

function readOptionalBoolean(
  obj: Record<string, unknown>,
  key: string,
  fallback: boolean,
  file: string,
  prefix = '',
): boolean {
  const v = obj[key];
  if (v === undefined) return fallback;
  if (typeof v === 'boolean') return v;
  throw new Error(
    `dreamux config error in ${file}: ${prefix}${key} must be a boolean (got ${describeType(v)})`,
  );
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

function requireStringRecord(
  obj: Record<string, unknown>,
  key: string,
  fallback: Record<string, string>,
  file: string,
  prefix = '',
): Record<string, string> {
  const v = obj[key];
  if (v === undefined) return { ...fallback };
  if (!isPlainObject(v)) {
    throw new Error(
      `dreamux config error in ${file}: ${prefix}${key} must be an object of strings (got ${describeType(v)})`,
    );
  }
  const out: Record<string, string> = {};
  for (const [entryKey, entryValue] of Object.entries(v)) {
    if (typeof entryValue !== 'string') {
      throw new Error(
        `dreamux config error in ${file}: ${prefix}${key}.${entryKey} must be a string (got ${describeType(entryValue)})`,
      );
    }
    out[entryKey] = entryValue;
  }
  return out;
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
  if (Array.isArray(value)) {
    for (const item of value) redactFeishuSecrets(item);
    return;
  }
  if (!isPlainObject(value)) return;
  for (const [key, child] of Object.entries(value)) {
    if (key === 'app_secret' && typeof child === 'string') {
      value[key] = '<redacted>';
      continue;
    }
    redactFeishuSecrets(child);
  }
}

export function expandHome(path: string): string {
  if (path === '~') return homedir();
  if (path.startsWith('~/')) return join(homedir(), path.slice(2));
  if (!isAbsolute(path)) return path;
  return path;
}
