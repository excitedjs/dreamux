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
  loadExternalAgentRuntimeProviders,
  type ExternalAgentRuntimeModuleImporter,
} from '../agent-runtime/external-provider.js';
import type { AgentRuntimeProvider } from '../agent-runtime/types.js';
import {
  BUILTIN_CLAUDE_CODE_PROVIDER_REF,
  BUILTIN_CODEX_PROVIDER_REF,
  BUILTIN_FEISHU_PROVIDER_REF,
  InvalidProviderRefError,
  ReservedExternalProviderError,
  UnknownBuiltinProviderError,
  createBuiltinProviderRegistry,
  formatProviderRef,
  parseProviderRef,
  type ProviderDescriptor,
  type ProviderRegistry,
} from '../registry/index.js';
import {
  describeType,
  isPlainObject,
  readOptionalString,
  readProviderConfigObject,
  rejectUnknownKeys,
  requireNonEmptyString,
} from './validate.js';
import {
  readDispatcherCodexConfig,
  type DispatcherCodexConfig,
} from '../agent-runtime/builtin/codex/config.js';
import {
  readDispatcherClaudeCodeConfig,
  type DispatcherClaudeCodeConfig,
} from '../agent-runtime/builtin/claude-code/config.js';
import { validateDispatcherId } from '../state/dispatcher-id.js';

// Re-export the relocated builtin runtime config + provider-ref symbols so the
// non-builtin callers (doctor, daemon, dispatcher-service, onboard,
// feishu-channel, tests) keep their existing `config/config.js` import paths.
// The builtins themselves import these from `registry/` / their own
// `config.ts` directly, never via this re-export, so the cycle stays severed.
export {
  BUILTIN_CLAUDE_CODE_PROVIDER_REF,
  BUILTIN_CODEX_PROVIDER_REF,
  BUILTIN_FEISHU_PROVIDER_REF,
} from '../registry/index.js';
export {
  ALLOWED_APPROVAL_POLICIES,
  ALLOWED_SANDBOX_MODES,
  DEFAULT_APPROVAL_POLICY,
  DEFAULT_CODEX_BIN,
  DEFAULT_CODEX_TURN_TIMEOUT_MS,
  DEFAULT_INITIALIZE_TIMEOUT_MS,
  DEFAULT_SANDBOX_MODE,
  defaultDispatcherCodexConfig,
  dispatcherCodexConfig,
} from '../agent-runtime/builtin/codex/config.js';
export type { DispatcherCodexConfig } from '../agent-runtime/builtin/codex/config.js';
export {
  ALLOWED_CLAUDE_CODE_PERMISSION_MODES,
  DEFAULT_CLAUDE_CODE_BIN,
  DEFAULT_CLAUDE_CODE_TURN_TIMEOUT_MS,
  defaultDispatcherClaudeCodeConfig,
  dispatcherClaudeCodeConfig,
} from '../agent-runtime/builtin/claude-code/config.js';
export type { DispatcherClaudeCodeConfig } from '../agent-runtime/builtin/claude-code/config.js';

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

export const BUILT_IN_DEFAULTS: DreamuxConfig = {
  dispatchers: [],
};

export const DEFAULT_CONFIG_JSON = `${JSON.stringify(BUILT_IN_DEFAULTS, null, 2)}\n`;

type RuntimeConfigReader = (
  rawConfig: Record<string, unknown>,
  file: string,
  prefix: string,
) => DispatcherProviderConfig | DispatcherCodexConfig | DispatcherClaudeCodeConfig;

const WIRED_RUNTIME_CONFIG_READERS = new Map<string, RuntimeConfigReader>([
  [BUILTIN_CODEX_PROVIDER_REF, readDispatcherCodexConfig],
  [BUILTIN_CLAUDE_CODE_PROVIDER_REF, readDispatcherClaudeCodeConfig],
]);

export interface ConfigPathOverrides {
  /** Override the global config dir. Default: ~/.dreamux. */
  configDir?: string;
  /** Provider registry used to validate config provider refs. */
  providerRegistry?: ProviderRegistry;
  /** Test seam for external `npm:` agentRuntime provider loading. */
  externalAgentRuntimeModuleImporter?: ExternalAgentRuntimeModuleImporter;
}

export interface LoadConfigResult {
  config: DreamuxConfig;
  configFile: string;
  providerRegistry: ProviderRegistry;
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
  providerRegistry: ProviderRegistry;
}> {
  const file = globalConfigFile(overrides);
  const providerRegistry = providerRegistryFor(overrides);
  await assertNoLegacyTomlOnly(overrides);
  await mkdir(dirname(file), { recursive: true });

  const createdOnThisBoot = await atomicWriteIfAbsent(file, DEFAULT_CONFIG_JSON);
  const config = await readConfigFile(file, providerRegistry, overrides);
  return { config, configFile: file, createdOnThisBoot, providerRegistry };
}

export async function loadConfig(
  overrides: ConfigPathOverrides = {},
): Promise<LoadConfigResult> {
  const file = globalConfigFile(overrides);
  const providerRegistry = providerRegistryFor(overrides);
  await assertNoLegacyTomlOnly(overrides);
  return {
    config: await readConfigFile(file, providerRegistry, overrides),
    configFile: file,
    providerRegistry,
  };
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

async function readConfigFile(
  file: string,
  providerRegistry: ProviderRegistry,
  overrides: ConfigPathOverrides,
): Promise<DreamuxConfig> {
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
  await loadExternalAgentRuntimeProviders({
    registry: providerRegistry,
    refs: runtimeProviderRefs(parsed),
    importModule: overrides.externalAgentRuntimeModuleImporter,
  });
  return mergeWithDefaults(parsed, file, providerRegistry);
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

function providerRegistryFor(overrides: ConfigPathOverrides): ProviderRegistry {
  return overrides.providerRegistry ?? createBuiltinProviderRegistry();
}

function mergeWithDefaults(
  raw: unknown,
  file: string,
  providerRegistry: ProviderRegistry,
): DreamuxConfig {
  if (!isPlainObject(raw)) {
    throw new Error(`dreamux config error in ${file}: top-level must be an object`);
  }
  rejectTopLevelCodex(raw, file);
  rejectUnknownKeys(raw, new Set(['dispatchers']), file, '');

  return {
    dispatchers: readDispatchers(raw['dispatchers'], file, providerRegistry),
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

function readDispatchers(
  rawDispatchers: unknown,
  file: string,
  providerRegistry: ProviderRegistry,
): DispatcherConfig[] {
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
      runtime: readDispatcherRuntime(
        raw['runtime'],
        file,
        prefix,
        id,
        providerRegistry,
      ),
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
  const provider = requireNonEmptyString(raw, 'provider', file, channelPrefix);
  if (provider !== BUILTIN_FEISHU_PROVIDER_REF) {
    throw new Error(
      `dreamux config error in ${file}: ${channelPrefix}provider='${provider}' is not a built-in Dreamux channel.\n` +
        'Only built-in channel "builtin:feishu" is wired in this phase; subscription channel plugins are interface-only.',
    );
  }
  const config = readProviderConfigObject(raw['config'], file, `${channelPrefix}config`);
  return [
    {
      id,
      provider,
      config: readDispatcherFeishuConfig(config, file, `${channelPrefix}config.`),
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
  dispatcherId: string,
  providerRegistry: ProviderRegistry,
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
    providerRegistry,
  );
  const config = readProviderConfigObject(rawRuntime['config'], file, `${prefix}config`, {
    allowMissing: true,
  });
  const readRuntimeConfig = WIRED_RUNTIME_CONFIG_READERS.get(provider.ref);
  if (readRuntimeConfig !== undefined) {
    return {
      provider: provider.ref,
      config: readRuntimeConfig(config, file, `${prefix}config.`),
    };
  }
  const runtimeProvider = asAgentRuntimeProvider(
    providerRegistry.getImplementation(provider.descriptor.id),
  );
  if (runtimeProvider !== null) {
    return {
      provider: provider.ref,
      config:
        runtimeProvider.readConfig?.(config, {
          providerRef: provider.ref,
          dispatcherId,
          file,
          prefix: `${prefix}config.`,
        }) ?? config,
    };
  }
  throw new Error(
    `dreamux config error in ${file}: ${prefix}provider='${provider.ref}' is registered but not runnable.\n` +
      'Builtin runtimes are wired by dreamux; external runtimes must load and register an agentRuntime provider before config validation.',
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

export function dispatcherFeishuConfig(
  dispatcher: Pick<DispatcherConfig, 'channels' | 'id'>,
): DispatcherFeishuConfig {
  return feishuConfigFromChannels(dispatcher.channels, dispatcher.id);
}

function resolveConfigProvider(
  rawProvider: string,
  expectedKind: ProviderDescriptor['kind'],
  file: string,
  prefix: string,
  providerRegistry: ProviderRegistry,
): { ref: string; descriptor: ProviderDescriptor } {
  try {
    const descriptor = providerRegistry.resolve(rawProvider);
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
        `dreamux config error in ${file}: ${prefix}provider='${rawProvider}' was not loaded as an external agentRuntime provider.\n` +
          err.message,
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

function runtimeProviderRefs(raw: unknown): string[] {
  if (!isPlainObject(raw)) return [];
  const dispatchers = raw['dispatchers'];
  if (!Array.isArray(dispatchers)) return [];
  const out: string[] = [];
  for (const dispatcher of dispatchers) {
    if (!isPlainObject(dispatcher)) continue;
    const runtime = dispatcher['runtime'];
    if (!isPlainObject(runtime)) continue;
    const provider = runtime['provider'];
    if (typeof provider !== 'string') continue;
    try {
      const parsed = parseProviderRef(provider);
      if (parsed.source === 'npm') out.push(parsed.raw);
    } catch {
      // The normal config validation path reports malformed refs with context.
    }
  }
  return out;
}

function asAgentRuntimeProvider(value: unknown): AgentRuntimeProvider | null {
  if (typeof value !== 'object' || value === null) return null;
  const candidate = value as Partial<AgentRuntimeProvider>;
  if (
    typeof candidate.ref !== 'string' ||
    candidate.descriptor === undefined ||
    typeof candidate.getCapabilities !== 'function' ||
    typeof candidate.createRuntime !== 'function'
  ) {
    return null;
  }
  return value as AgentRuntimeProvider;
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
