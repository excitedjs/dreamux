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
import {
  InvalidProviderRefError,
  ReservedExternalProviderError,
  UnknownBuiltinProviderError,
  createBuiltinRegistry,
  formatProviderRef,
  type ProviderDescriptor,
} from '../registry/index.js';
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
  channels: DispatcherChannelConfig[];
  runtime: DispatcherRuntimeConfig;
}

export interface DispatcherChannelConfig {
  id: string;
  provider: string;
  config: DispatcherProviderConfig | DispatcherFeishuConfig;
}

export interface DispatcherRuntimeConfig {
  provider: string;
  config: DispatcherProviderConfig | DispatcherCodexConfig | DispatcherClaudeCodeConfig;
}

export type DispatcherProviderConfig = Record<string, unknown>;

export interface DispatcherFeishuConfig {
  app_id: string;
  app_secret: string;
}

/**
 * Builtin Codex runtime settings under `dispatchers[].runtime.config`.
 * Every field carries a built-in default, so a dispatcher that omits any
 * runtime config field runs with these constants. There is no top-level
 * `codex` block anymore: runtime config is dispatcher-local.
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
 * Builtin Claude Code runtime settings under `dispatchers[].runtime.config`
 * when `runtime.provider` is `builtin:claude-code` (issue #110 PR6).
 *
 * Deliberately distinct from {@link DispatcherCodexConfig}: Claude Code is a
 * headless per-turn CLI (`claude --print`), so there is no app-server handshake
 * timeout, approval policy, or sandbox mode here. `bin` is the Claude Code
 * binary; `model` / `permission_mode` map to `--model` / `--permission-mode`;
 * `extra_args` / `extra_env` are passed through. `model` and `permission_mode`
 * are `null` when the operator does not pin them (Claude Code's own defaults
 * apply).
 */
export interface DispatcherClaudeCodeConfig {
  bin: string;
  model: string | null;
  permission_mode: string | null;
  extra_args: string[];
  extra_env: Record<string, string>;
}

/**
 * Default `dispatchers[].runtime.config.bin`. The Codex binary path is
 * dispatcher-local; `CODEX_HOST_CODEX_BIN` is a host-level override above it,
 * not the source.
 */
export const DEFAULT_CODEX_BIN = 'codex';

/** Default `dispatchers[].runtime.config.bin` for `builtin:claude-code`. */
export const DEFAULT_CLAUDE_CODE_BIN = 'claude';

/** Permission modes accepted for `builtin:claude-code` (Claude Code `--permission-mode`). */
export const ALLOWED_CLAUDE_CODE_PERMISSION_MODES = new Set([
  'default',
  'acceptEdits',
  'plan',
  'bypassPermissions',
]);

/** Default `dispatchers[].runtime.config.initialize_timeout_ms` (handshake timeout, ms). */
export const DEFAULT_INITIALIZE_TIMEOUT_MS = 10_000;

/** Default `dispatchers[].runtime.config.approval_policy` when omitted. */
export const DEFAULT_APPROVAL_POLICY = 'never';

/** Default `dispatchers[].runtime.config.sandbox_mode` when omitted. */
export const DEFAULT_SANDBOX_MODE = 'workspace-write';

export const BUILT_IN_DEFAULTS: DreamuxConfig = {
  dispatchers: [],
};

export const BUILTIN_FEISHU_PROVIDER_REF = 'builtin:feishu';
export const BUILTIN_CODEX_PROVIDER_REF = 'builtin:codex';
export const BUILTIN_CLAUDE_CODE_PROVIDER_REF = 'builtin:claude-code';
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
 * The top-level `codex` block was removed: runtime settings are per-dispatcher
 * (`dispatchers[].runtime.config`) and the binary path comes from
 * `CODEX_HOST_CODEX_BIN`.
 * A leftover top-level block is rejected loudly with migration guidance rather
 * than silently ignored, so an operator's intent is never dropped.
 */
function rejectTopLevelCodex(raw: Record<string, unknown>, file: string): void {
  if (!('codex' in raw)) return;
  throw new Error(
    `dreamux config error in ${file}: a top-level "codex" block is no longer ` +
      'supported. Move Codex settings under each dispatchers[].runtime.config ' +
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
      new Set(['id', 'cwd', 'enabled', 'channels', 'runtime']),
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

    const channels = readDispatcherChannels(raw['channels'], file, prefix);
    const feishu = feishuConfigFromChannels(channels, id);
    const app_id = feishu.app_id;
    const existing = appIdToDispatcher.get(app_id);
    if (existing !== undefined) {
      throw new Error(
        `dreamux config error in ${file}: dispatchers[${index}].channels[0].config.app_id duplicates dispatcher '${existing}'`,
      );
    }
    appIdToDispatcher.set(app_id, id);

    const cwd = readOptionalString(raw, 'cwd', file, prefix);
    out.push({
      id,
      cwd: cwd === null ? null : expandHome(cwd),
      enabled: readOptionalBoolean(raw, 'enabled', true, file, prefix),
      channels,
      runtime: readDispatcherRuntime(raw['runtime'], file, prefix),
    });
  }
  return out;
}

function readDispatcherChannels(
  rawChannels: unknown,
  file: string,
  dispatcherPrefix: string,
): DispatcherChannelConfig[] {
  const prefix = `${dispatcherPrefix}channels`;
  if (!Array.isArray(rawChannels)) {
    throw new Error(
      `dreamux config error in ${file}: ${prefix} must be an array (got ${describeType(rawChannels)}).\n` +
        'Use providerized config v2: dispatchers[].channels[] with provider "builtin:feishu".',
    );
  }
  if (rawChannels.length !== 1) {
    throw new Error(
      `dreamux config error in ${file}: ${prefix} must contain exactly one channel in this phase (got ${rawChannels.length}).\n` +
        'The config envelope is channels[] for the provider architecture, but Phase 1 still wires one channel per dispatcher. Multi-channel routing is a follow-up.',
    );
  }
  const raw = rawChannels[0];
  const channelPrefix = `${dispatcherPrefix}channels[0].`;
  if (!isPlainObject(raw)) {
    throw new Error(
      `dreamux config error in ${file}: ${channelPrefix.slice(0, -1)} must be an object (got ${describeType(raw)})`,
    );
  }
  rejectUnknownKeys(raw, new Set(['id', 'provider', 'config']), file, channelPrefix);
  const id = requireNonEmptyString(raw, 'id', file, channelPrefix);
  const provider = resolveConfigProvider(
    requireNonEmptyString(raw, 'provider', file, channelPrefix),
    'channel',
    file,
    channelPrefix,
  );
  if (provider.ref !== BUILTIN_FEISHU_PROVIDER_REF) {
    throw new Error(
      `dreamux config error in ${file}: ${channelPrefix}provider='${provider.ref}' is registered but not runnable in this phase.\n` +
        'Only channel provider "builtin:feishu" is wired in Phase 1.',
    );
  }
  const config = readProviderConfigObject(raw['config'], file, `${channelPrefix}config`);
  const feishu = readDispatcherFeishuConfig(config, file, `${channelPrefix}config.`);
  return [
    {
      id,
      provider: provider.ref,
      config: feishu,
    },
  ];
}

function feishuConfigFromChannels(
  channels: DispatcherChannelConfig[],
  dispatcherId: string,
): DispatcherFeishuConfig {
  const channel = channels.find(
    (item) => item.provider === BUILTIN_FEISHU_PROVIDER_REF,
  );
  if (channel === undefined) {
    throw new Error(
      `dispatcher '${dispatcherId}' has no ${BUILTIN_FEISHU_PROVIDER_REF} channel`,
    );
  }
  return channel.config as DispatcherFeishuConfig;
}

function readDispatcherRuntime(
  rawRuntime: unknown,
  file: string,
  dispatcherPrefix: string,
): DispatcherRuntimeConfig {
  const prefix = `${dispatcherPrefix}runtime.`;
  if (!isPlainObject(rawRuntime)) {
    throw new Error(
      `dreamux config error in ${file}: ${dispatcherPrefix}runtime must be an object (got ${describeType(rawRuntime)}).\n` +
        'Use providerized config v2: dispatchers[].runtime.provider and dispatchers[].runtime.config.',
    );
  }
  rejectUnknownKeys(rawRuntime, new Set(['provider', 'config']), file, prefix);
  const provider = resolveConfigProvider(
    requireNonEmptyString(rawRuntime, 'provider', file, prefix),
    'agentRuntime',
    file,
    prefix,
  );
  const config = readProviderConfigObject(rawRuntime['config'], file, `${prefix}config`, {
    allowMissing: true,
  });
  if (provider.ref === BUILTIN_CODEX_PROVIDER_REF) {
    return {
      provider: provider.ref,
      config: readDispatcherCodexConfig(config, file, `${prefix}config.`),
    };
  }
  if (provider.ref === BUILTIN_CLAUDE_CODE_PROVIDER_REF) {
    return {
      provider: provider.ref,
      config: readDispatcherClaudeCodeConfig(config, file, `${prefix}config.`),
    };
  }
  // A registered agentRuntime builtin with no config parser wired yet. Fail
  // loud rather than fall back to another runtime.
  throw new Error(
    `dreamux config error in ${file}: ${prefix}provider='${provider.ref}' is registered but not runnable in this phase.\n` +
      'Wired agent runtimes: "builtin:codex", "builtin:claude-code".',
  );
}

function readDispatcherFeishuConfig(
  rawFeishu: Record<string, unknown>,
  file: string,
  prefix: string,
): DispatcherFeishuConfig {
  rejectUnknownKeys(rawFeishu, new Set(['app_id', 'app_secret']), file, prefix);
  return {
    app_id: requireNonEmptyString(rawFeishu, 'app_id', file, prefix),
    app_secret: requireNonEmptyString(rawFeishu, 'app_secret', file, prefix),
  };
}

export function defaultDispatcherCodexConfig(): DispatcherCodexConfig {
  return {
    bin: DEFAULT_CODEX_BIN,
    approval_policy: DEFAULT_APPROVAL_POLICY,
    sandbox_mode: DEFAULT_SANDBOX_MODE,
    extra_args: [],
    extra_env: {},
    initialize_timeout_ms: DEFAULT_INITIALIZE_TIMEOUT_MS,
  };
}

function readDispatcherCodexConfig(
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
  };
}

export function dispatcherFeishuConfig(
  dispatcher: Pick<DispatcherConfig, 'channels' | 'id'>,
): DispatcherFeishuConfig {
  return feishuConfigFromChannels(dispatcher.channels, dispatcher.id);
}

export function dispatcherCodexConfig(
  dispatcher: Pick<DispatcherConfig, 'runtime' | 'id'>,
): DispatcherCodexConfig {
  if (dispatcher.runtime.provider !== BUILTIN_CODEX_PROVIDER_REF) {
    throw new Error(
      `dispatcher '${dispatcher.id}' runtime provider ${JSON.stringify(dispatcher.runtime.provider)} is not wired to Codex`,
    );
  }
  return dispatcher.runtime.config as DispatcherCodexConfig;
}

export function defaultDispatcherClaudeCodeConfig(): DispatcherClaudeCodeConfig {
  return {
    bin: DEFAULT_CLAUDE_CODE_BIN,
    model: null,
    permission_mode: null,
    extra_args: [],
    extra_env: {},
  };
}

function readDispatcherClaudeCodeConfig(
  rawClaude: Record<string, unknown>,
  file: string,
  prefix: string,
): DispatcherClaudeCodeConfig {
  rejectUnknownKeys(
    rawClaude,
    new Set(['bin', 'model', 'permission_mode', 'extra_args', 'extra_env']),
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
  };
}

export function dispatcherClaudeCodeConfig(
  dispatcher: Pick<DispatcherConfig, 'runtime' | 'id'>,
): DispatcherClaudeCodeConfig {
  if (dispatcher.runtime.provider !== BUILTIN_CLAUDE_CODE_PROVIDER_REF) {
    throw new Error(
      `dispatcher '${dispatcher.id}' runtime provider ${JSON.stringify(dispatcher.runtime.provider)} is not wired to Claude Code`,
    );
  }
  return dispatcher.runtime.config as DispatcherClaudeCodeConfig;
}

function resolveConfigProvider(
  rawProvider: string,
  expectedKind: ProviderDescriptor['kind'],
  file: string,
  prefix: string,
): { ref: string; descriptor: ProviderDescriptor } {
  const registry = createBuiltinRegistry();
  try {
    const descriptor = registry.resolve(rawProvider);
    if (descriptor.kind !== expectedKind) {
      throw new Error(
        `dreamux config error in ${file}: ${prefix}provider='${rawProvider}' is a ${descriptor.kind} provider, expected ${expectedKind}`,
      );
    }
    return { ref: formatProviderRef(descriptor.ref), descriptor };
  } catch (err) {
    if (err instanceof InvalidProviderRefError) {
      throw new Error(
        `dreamux config error in ${file}: ${prefix}provider is invalid: ${err.message}`,
      );
    }
    if (err instanceof ReservedExternalProviderError) {
      throw new Error(
        `dreamux config error in ${file}: ${prefix}provider='${rawProvider}' is reserved for future external providers and is not loadable in this phase.\n` +
          'Use a builtin provider ref such as "builtin:feishu" or "builtin:codex".',
      );
    }
    if (err instanceof UnknownBuiltinProviderError) {
      throw new Error(
        `dreamux config error in ${file}: ${prefix}provider references unknown builtin provider '${err.id}'`,
      );
    }
    throw err;
  }
}

function readProviderConfigObject(
  rawConfig: unknown,
  file: string,
  name: string,
  options: { allowMissing?: boolean } = {},
): Record<string, unknown> {
  if (rawConfig === undefined && options.allowMissing === true) return {};
  if (!isPlainObject(rawConfig)) {
    throw new Error(
      `dreamux config error in ${file}: ${name} must be an object (got ${describeType(rawConfig)})`,
    );
  }
  return rawConfig;
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
    if (/^dispatchers\[\d+\]\.$/.test(prefix) && (key === 'feishu' || key === 'codex')) {
      throw new Error(
        `dreamux config error in ${file}: ${name} is not supported by the providerized config v2 schema.\n` +
          'Dreamux 0.x does not silently migrate operator-owned config. Rebuild this dispatcher with ' +
          'dispatchers[].channels[] and dispatchers[].runtime, then restart.',
      );
    }
    throw new Error(
      `dreamux config error in ${file}: ${name} is not supported by the providerized config v2 schema`,
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
