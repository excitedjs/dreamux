import { pathExists } from '../platform/fs-errors.js';

import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { mkdir, open, readFile, stat } from 'node:fs/promises';
import {
  loadAgentRuntimeProviders,
  type ExternalAgentRuntimeModuleImporter,
} from '../agent-runtime/external-provider.js';
import {
  loadChannelProviders,
  type ExternalChannelModuleImporter,
} from '../channel/external-channel-provider.js';
import {
  createBuiltinProviderRegistry,
  type ProviderRegistry,
} from '../registry/index.js';
import {
  describeType,
  isPlainObject,
  readOptionalString,
  readProviderConfigObject,
  rejectUnknownKeys,
  requireNonEmptyString,
} from '@excitedjs/dreamux-utils';
import { validateDispatcherId } from '../state/dispatcher-id.js';
import {
  agentProviderRefs,
  asAgentRuntimeProvider,
  asChannelProvider,
  channelProviderRefs,
  expandHome,
  readOptionalBoolean,
  redactConfigSecrets,
  resolveConfigProvider,
} from './config-helpers.js';

export { expandHome } from './config-helpers.js';

export interface DreamuxConfig {
    agents: Record<string, ResolvedAgentConfig>;
    dispatchers: DispatcherConfig[];
}

export interface ResolvedAgentConfig {
  provider: string;
    config: DispatcherProviderConfig;
    rawConfig?: DispatcherProviderConfig;
}

export interface DispatcherConfig {
  id: string;
  cwd: string | null;
  enabled: boolean;
  channels: DispatcherChannelConfig[];
    agentRuntime: string;
    runtime: DispatcherRuntimeConfig;
}

export interface DispatcherChannelConfig {
  id: string;
  provider: string;
    config: DispatcherProviderConfig;
    rawConfig?: DispatcherProviderConfig;
    identity?: string;
}

export interface DispatcherRuntimeConfig {
  provider: string;
    config: DispatcherProviderConfig;
    rawConfig?: DispatcherProviderConfig;
}

export type DispatcherProviderConfig = Record<string, unknown>;

export const BUILT_IN_DEFAULTS: DreamuxConfig = {
  agents: {},
  dispatchers: [],
};
export const DEFAULT_CONFIG_JSON = stringifyConfig(BUILT_IN_DEFAULTS);

export interface ConfigPathOverrides {
    configDir?: string;
    providerRegistry?: ProviderRegistry;
    externalAgentRuntimeModuleImporter?: ExternalAgentRuntimeModuleImporter;
    externalChannelModuleImporter?: ExternalChannelModuleImporter;
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
  const fileShape = {
    agents: Object.entries(config.agents).map(([id, agent]) => ({
      id,
      provider: agent.provider,
      config: agent.rawConfig ?? agent.config,
    })),
    dispatchers: config.dispatchers.map((dispatcher) => ({
      id: dispatcher.id,
      cwd: dispatcher.cwd,
      enabled: dispatcher.enabled,
      channels: dispatcher.channels.map((channel) => ({
        id: channel.id,
        provider: channel.provider,
        config: channel.rawConfig ?? channel.config,
      })),
      agentRuntime: dispatcher.agentRuntime,
    })),
  };
  return `${JSON.stringify(fileShape, null, 2)}\n`;
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
  redactConfigSecrets(parsed);
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
  await loadAgentRuntimeProviders({
    registry: providerRegistry,
    refs: agentProviderRefs(parsed),
    importModule: overrides.externalAgentRuntimeModuleImporter,
  });
  await loadChannelProviders({
    registry: providerRegistry,
    refs: channelProviderRefs(parsed),
    importModule: overrides.externalChannelModuleImporter,
  });
  return await mergeWithDefaults(parsed, file, providerRegistry);
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

async function mergeWithDefaults(
  raw: unknown,
  file: string,
  providerRegistry: ProviderRegistry,
): Promise<DreamuxConfig> {
  if (!isPlainObject(raw)) {
    throw new Error(`dreamux config error in ${file}: top-level must be an object`);
  }
  rejectTopLevelCodex(raw, file);
  rejectUnknownKeys(raw, new Set(['agents', 'dispatchers']), file, '');

  const agents = await readAgents(raw['agents'], file, providerRegistry);
  const dispatchers = await readDispatchers(
    raw['dispatchers'],
    file,
    agents,
    providerRegistry,
  );
  return {
    agents,
    dispatchers,
  };
}

function rejectTopLevelCodex(raw: Record<string, unknown>, file: string): void {
  if (!('codex' in raw)) return;
  throw new Error(
    `dreamux config error in ${file}: a top-level "codex" block is no longer ` +
      'supported. Declare a named agent under agents[] with the selected runtime ' +
      'provider and a provider-owned config block, then reference it from each ' +
      'dispatcher via dispatchers[].agentRuntime.',
  );
}

async function readAgents(
  rawAgents: unknown,
  file: string,
  providerRegistry: ProviderRegistry,
): Promise<Record<string, ResolvedAgentConfig>> {
  if (rawAgents === undefined) return {};
  if (!Array.isArray(rawAgents)) {
    throw new Error(
      `dreamux config error in ${file}: agents must be an array (got ${describeType(rawAgents)}).\n` +
        'Declare named runtimes as agents[] entries, each with an id, a provider ' +
        '(for example "builtin:<id>" or "npm:<package>"), and a provider-owned config block.',
    );
  }
  const out: Record<string, ResolvedAgentConfig> = {};
  for (let index = 0; index < rawAgents.length; index++) {
    const raw = rawAgents[index];
    const prefix = `agents[${index}].`;
    if (!isPlainObject(raw)) {
      throw new Error(
        `dreamux config error in ${file}: agents[${index}] must be an object (got ${describeType(raw)})`,
      );
    }
    rejectUnknownKeys(raw, new Set(['id', 'provider', 'config']), file, prefix);
    const id = requireNonEmptyString(raw, 'id', file, prefix);
    if (Object.prototype.hasOwnProperty.call(out, id)) {
      throw new Error(
        `dreamux config error in ${file}: agents[${index}].id duplicates agent '${id}'`,
      );
    }
    const provider = resolveConfigProvider(
      requireNonEmptyString(raw, 'provider', file, prefix),
      'agentRuntime',
      file,
      prefix,
      providerRegistry,
    );
    const rawConfig = readProviderConfigObject(raw['config'], file, `${prefix}config`, {
      allowMissing: true,
    });
    const runtimeProvider = asAgentRuntimeProvider(
      providerRegistry.getImplementation(provider.descriptor.id),
    );
    if (runtimeProvider === null) {
      throw new Error(
        `dreamux config error in ${file}: ${prefix}provider='${provider.ref}' is registered but not runnable.\n` +
          'Its provider package did not yield a runnable agentRuntime ' +
          'implementation. Pass a providerRegistry seeded with the builtin ' +
          'descriptors (the default) so the loader can resolve the package, or ' +
          'register a valid implementation before config validation.',
      );
    }
    const parsedConfig =
      ((await runtimeProvider.readConfig?.(rawConfig, {
        providerRef: provider.ref,
        agentId: id,
        file,
        prefix: `${prefix}config.`,
      })) as DispatcherProviderConfig | undefined) ?? rawConfig;
    out[id] = {
      provider: provider.ref,
      config: parsedConfig,
      rawConfig,
    };
  }
  return out;
}

async function readDispatchers(
  rawDispatchers: unknown,
  file: string,
  agents: Record<string, ResolvedAgentConfig>,
  providerRegistry: ProviderRegistry,
): Promise<DispatcherConfig[]> {
  if (rawDispatchers === undefined) return [];
  if (!Array.isArray(rawDispatchers)) {
    throw new Error(
      `dreamux config error in ${file}: dispatchers must be an array (got ${describeType(rawDispatchers)})`,
    );
  }
  const out: DispatcherConfig[] = [];
  const ids = new Set<string>();
  for (let index = 0; index < rawDispatchers.length; index++) {
    const raw = rawDispatchers[index];
    const prefix = `dispatchers[${index}].`;
    if (!isPlainObject(raw)) {
      throw new Error(
        `dreamux config error in ${file}: dispatchers[${index}] must be an object (got ${describeType(raw)})`,
      );
    }
    if ('runtime' in raw) {
      throw new Error(
        `dreamux config error in ${file}: ${prefix}runtime is no longer supported.\n` +
          'Runtime config moved to a named agents[] entry. Declare the runtime ' +
          'under top-level agents[] (id, provider, config) and reference it here ' +
          `with ${prefix}agentRuntime = "<agent id>", then rebuild ${file}.`,
      );
    }
    rejectUnknownKeys(
      raw,
      new Set(['id', 'cwd', 'enabled', 'channels', 'agentRuntime']),
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

    const channels = await readDispatcherChannels(
      raw['channels'],
      file,
      prefix,
      id,
      providerRegistry,
    );

    const cwd = readOptionalString(raw, 'cwd', file, prefix);
    const agentRuntimeId = resolveAgentRuntime(raw, prefix, file, agents);
    const agent = agents[agentRuntimeId]!;
    out.push({
      id,
      cwd: cwd === null ? null : expandHome(cwd),
      enabled: readOptionalBoolean(raw, 'enabled', true, file, prefix),
      channels,
      agentRuntime: agentRuntimeId,
      runtime: {
        provider: agent.provider,
        config: agent.config,
        ...(agent.rawConfig === undefined ? {} : { rawConfig: agent.rawConfig }),
      },
    });
  }
  return out;
}

function resolveAgentRuntime(
  raw: Record<string, unknown>,
  prefix: string,
  file: string,
  agents: Record<string, ResolvedAgentConfig>,
): string {
  if (!('agentRuntime' in raw)) {
    throw new Error(
      `dreamux config error in ${file}: ${prefix}agentRuntime is required.\n` +
        'Declare a named runtime under top-level agents[] (id, provider, config) ' +
        `and set ${prefix}agentRuntime to that agent's id, then rebuild ${file}.`,
    );
  }
  const agentRuntimeId = requireNonEmptyString(raw, 'agentRuntime', file, prefix);
  if (!Object.prototype.hasOwnProperty.call(agents, agentRuntimeId)) {
    const known = Object.keys(agents);
    const knownHint =
      known.length > 0
        ? `Known agents: ${known.map((id) => `'${id}'`).join(', ')}.`
        : 'No agents[] are declared.';
    throw new Error(
      `dreamux config error in ${file}: ${prefix}agentRuntime='${agentRuntimeId}' ` +
        `does not match any agents[].id. ${knownHint}\n` +
        `Add an agents[] entry with id '${agentRuntimeId}' (or fix the reference), then rebuild ${file}.`,
    );
  }
  return agentRuntimeId;
}

async function readDispatcherChannels(
  rawChannels: unknown,
  file: string,
  dispatcherPrefix: string,
  dispatcherId: string,
  providerRegistry: ProviderRegistry,
): Promise<DispatcherChannelConfig[]> {
  const prefix = `${dispatcherPrefix}channels`;
  if (!Array.isArray(rawChannels)) {
    throw new Error(
      `dreamux config error in ${file}: ${prefix} must be an array (got ${describeType(rawChannels)}).\n` +
        'Use providerized config v2: dispatchers[].channels[] with a channel provider ref and provider-owned config.',
    );
  }
  if (rawChannels.length === 0) {
    throw new Error(
      `dreamux config error in ${file}: ${prefix} must contain at least one channel.`,
    );
  }
  const out: DispatcherChannelConfig[] = [];
  const channelIds = new Set<string>();
  const providerRefs = new Set<string>();
  for (let index = 0; index < rawChannels.length; index++) {
    const raw = rawChannels[index];
    const channelPrefix = `${prefix}[${index}].`;
    if (!isPlainObject(raw)) {
      throw new Error(
        `dreamux config error in ${file}: ${channelPrefix.slice(0, -1)} must be an object (got ${describeType(raw)})`,
      );
    }
    rejectUnknownKeys(raw, new Set(['id', 'provider', 'config']), file, channelPrefix);
    const id = requireNonEmptyString(raw, 'id', file, channelPrefix);
    if (channelIds.has(id)) {
      throw new Error(
        `dreamux config error in ${file}: ${channelPrefix}id='${id}' duplicates another channel in this dispatcher; channel ids must be unique per dispatcher.`,
      );
    }
    channelIds.add(id);
    const provider = resolveConfigProvider(
      requireNonEmptyString(raw, 'provider', file, channelPrefix),
      'channel',
      file,
      channelPrefix,
      providerRegistry,
    );
    if (providerRefs.has(provider.ref)) {
      throw new Error(
        `dreamux config error in ${file}: ${channelPrefix}provider='${provider.ref}' duplicates another channel in this dispatcher; each provider may appear at most once per dispatcher.`,
      );
    }
    providerRefs.add(provider.ref);
    const rawConfig = readProviderConfigObject(
      raw['config'],
      file,
      `${channelPrefix}config`,
      { allowMissing: true },
    );
    const channelProvider = asChannelProvider(
      providerRegistry.getImplementation(provider.descriptor.id),
    );
    if (channelProvider === null) {
      throw new Error(
        `dreamux config error in ${file}: ${channelPrefix}provider='${provider.ref}' is registered but has no channel implementation.\n` +
          'Its provider package did not yield a usable channel implementation. ' +
          'Pass a providerRegistry seeded with the builtin descriptors (the ' +
          'default) so the loader can resolve the package, or register a valid ' +
          'implementation before config validation.',
      );
    }
    const parsed =
      ((await channelProvider.readConfig?.(rawConfig, {
        dispatcher_id: dispatcherId,
        channel_id: id,
        provider: provider.ref,
      })) as DispatcherProviderConfig | undefined) ?? rawConfig;
    let identity = '';
    try {
      identity = channelProvider.getIdentity?.(parsed) ?? '';
    } catch {
      identity = '';
    }
    out.push({
      id,
      provider: provider.ref,
      config: parsed,
      rawConfig,
      identity,
    });
  }
  return out;
}
