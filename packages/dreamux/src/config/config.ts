import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { stat } from 'node:fs/promises';
import { asAgentRuntimeProvider } from '../agent-runtime/catalog.js';
import type { ExternalAgentRuntimeModuleImporter } from '../agent-runtime/external-provider.js';
import type { ExternalChannelModuleImporter } from '../channel/external-channel-provider.js';
import type { ChannelProvider } from '@excitedjs/dreamux-types';
import {
  InvalidProviderRefError,
  ReservedExternalProviderError,
  UnknownBuiltinProviderError,
  formatProviderRef,
  type ProviderDescriptor,
  type ProviderRegistry,
} from '../registry/index.js';
import {
  describeType,
  isPlainObject,
  readNonEmptyString,
  readProviderConfigObject,
  redactSecretKeyValues,
} from '@excitedjs/dreamux-utils';
import { dreamuxRoot } from '../platform/paths.js';
import { validateDispatcherId } from '../platform/dispatcher-id.js';
import { RuleViolation } from '../platform/errors.js';
import type {
  PluginConfigEntry,
  PluginModuleImporter,
} from '../plugin/loader.js';

export interface DreamuxConfig {
  /**
   * The raw `plugins[]` entries, present iff the file has a `plugins` key.
   * Kept only so `stringifyConfig` round-trips them; the loaded plugins
   * travel in `config/load.ts`'s `LoadConfigResult.plugins`.
   */
  plugins?: PluginConfigEntry[] | undefined;
  agents: Record<string, ResolvedAgentConfig>;
  dispatchers: DispatcherConfig[];
}

export interface DreamuxWorkspaceConfig {
  enabled: boolean;
}

export interface ResolvedAgentConfig {
  provider: string;
  config: DispatcherProviderConfig;
  rawConfig?: DispatcherProviderConfig | undefined;
}

export interface DispatcherConfig {
  id: string;
  cwd: string;
  enabled: boolean;
  workspace: DreamuxWorkspaceConfig;
  channels: DispatcherChannelConfig[];
  agentRuntime: string;
}

export interface DispatcherChannelConfig {
  id: string;
  provider: string;
  config: DispatcherProviderConfig;
  rawConfig?: DispatcherProviderConfig | undefined;
  identity?: string;
}

export type DispatcherProviderConfig = Record<string, unknown>;

/**
 * The agent config a dispatcher references (`agents[dispatcher.agentRuntime]`),
 * looked up on demand rather than carried as a precomputed field on
 * `DispatcherConfig`. `readDispatchers` already validates every parsed
 * dispatcher's `agentRuntime` names a real `agents[]` entry and every
 * dispatcher id is unique, so a `config` this loader produced never fails
 * this lookup; callers must not pass a hand-built `config`/`dispatcherId`
 * pair that skips that validation.
 */
export function dispatcherAgent(
  config: DreamuxConfig,
  dispatcherId: string,
): ResolvedAgentConfig {
  const dispatcher = config.dispatchers.find(
    (entry) => entry.id === dispatcherId,
  )!;
  return config.agents[dispatcher.agentRuntime]!;
}

/**
 * A dispatcher's own `agentRuntime` — the id a spawn launches when it names
 * none — looked up by dispatcher id rather than taken as a precomputed field,
 * so a caller that only holds an id still gets it. Throws when `dispatcherId`
 * names no configured dispatcher, since there is then no `agentRuntime` to
 * default to.
 */
export function defaultAgentRuntime(
  config: DreamuxConfig,
  dispatcherId: string,
): string {
  const dispatcherCfg =
    config.dispatchers.find((entry) => entry.id === dispatcherId) ?? null;
  if (dispatcherCfg === null) {
    throw new Error(
      `cannot spawn a teammate for unknown dispatcher '${dispatcherId}': ` +
        'no dispatcher config to resolve a default agentRuntime from. Pass an ' +
        'explicit agentRuntime (an agents[].id).',
    );
  }
  return dispatcherCfg.agentRuntime;
}

/**
 * Resolve one `agents[]` entry by id, with an error naming every declared
 * agent id when the reference does not match — the caller-facing companion to
 * {@link dispatcherAgent}'s already-validated lookup, used wherever an
 * `agentRuntime` id arrives from outside the loader (a spawn request, a
 * persisted identity) and may not name a currently-declared agent.
 */
export function resolveAgent(
  config: DreamuxConfig,
  dispatcherId: string,
  agentRuntimeId: string,
): ResolvedAgentConfig {
  const agent = config.agents[agentRuntimeId];
  if (agent === undefined) {
    const known = Object.keys(config.agents);
    const knownHint =
      known.length > 0
        ? `Known agents: ${known.map((id) => `'${id}'`).join(', ')}.`
        : 'No agents are declared.';
    throw new Error(
      `teammate for dispatcher '${dispatcherId}' references agentRuntime ` +
        `'${agentRuntimeId}', which matches no agents[].id. ${knownHint} ` +
        'Add the agent to config and rebuild, or respawn the teammate with a ' +
        'known agent id.',
    );
  }
  return agent;
}

export const BUILT_IN_DEFAULTS: DreamuxConfig = {
  agents: {},
  dispatchers: [],
};
export const DEFAULT_CONFIG_JSON = stringifyConfig(BUILT_IN_DEFAULTS);

export interface ConfigPathOverrides {
  providerRegistry?: ProviderRegistry;
  externalAgentRuntimeModuleImporter?: ExternalAgentRuntimeModuleImporter;
  externalChannelModuleImporter?: ExternalChannelModuleImporter;
  pluginModuleImporter?: PluginModuleImporter;
}

export function globalConfigDir(): string {
  return dreamuxRoot();
}

export function globalConfigFile(): string {
  return join(globalConfigDir(), 'config.json');
}

export function legacyGlobalConfigFile(): string {
  return join(globalConfigDir(), 'config.toml');
}

export function stringifyConfig(config: DreamuxConfig): string {
  const fileShape = {
    plugins: config.plugins?.map((entry) =>
      'config' in entry ? { ref: entry.ref, config: entry.config } : entry.ref,
    ),
    agents: Object.entries(config.agents).map(([id, agent]) => ({
      id,
      provider: agent.provider,
      config: agent.rawConfig ?? agent.config,
    })),
    dispatchers: config.dispatchers.map((dispatcher) => ({
      id: dispatcher.id,
      cwd: dispatcher.cwd,
      enabled: dispatcher.enabled,
      workspace: {
        enabled: dispatcher.workspace.enabled,
      },
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
  redactSecretKeyValues(parsed);
  return `${JSON.stringify(parsed, null, 2)}\n`;
}

export async function assertConfigFileMode(file: string): Promise<void> {
  if (process.platform === 'win32') return;
  const mode = (await stat(file)).mode & 0o777;
  if (mode === 0o600) return;
  throw new Error(
    `dreamux config file must be mode 0600: ${file} has mode 0${mode.toString(8)}`,
  );
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
  throw new RuleViolation(
    `dreamux config error in ${file}: ${prefix}${key} must be a boolean (got ${describeType(v)})`,
  );
}

export function expandHome(path: string): string {
  if (path === '~') return homedir();
  if (path.startsWith('~/')) return join(homedir(), path.slice(2));
  if (!isAbsolute(path)) return path;
  return path;
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
      throw new RuleViolation(
        `dreamux config error in ${file}: ${prefix}provider='${rawProvider}' is a ${descriptor.kind} provider, expected ${expectedKind}`,
      );
    }
    return { ref: formatProviderRef(descriptor.ref), descriptor };
  } catch (err) {
    if (err instanceof InvalidProviderRefError) {
      throw new RuleViolation(
        `dreamux config error in ${file}: ${prefix}provider is invalid: ${err.message}`,
      );
    }
    if (err instanceof ReservedExternalProviderError) {
      throw new RuleViolation(
        `dreamux config error in ${file}: ${prefix}provider='${rawProvider}' was not loaded as an external ${expectedKind} provider.\n` +
          err.message,
      );
    }
    if (err instanceof UnknownBuiltinProviderError) {
      throw new RuleViolation(
        `dreamux config error in ${file}: ${prefix}provider references unknown builtin provider '${err.id}'`,
      );
    }
    throw err;
  }
}

/**
 * Structural check for a loaded channel implementation, guarding
 * `mergeWithDefaults`'s config-validation path. `channel/catalog.ts` carries
 * an identical check for its own read path (`asChannelProvider`, guarding
 * `registry.getImplementation()`'s output there too).
 */
function asChannelProvider(value: unknown): ChannelProvider<unknown> | null {
  if (typeof value !== 'object' || value === null) return null;
  const candidate = value as Partial<ChannelProvider<unknown>>;
  if (typeof candidate.createSession !== 'function') return null;
  return value as ChannelProvider<unknown>;
}

/**
 * Validates and shapes a parsed config file (`raw`) into a {@link DreamuxConfig}.
 * Exported for `config/load.ts`'s `resolveConfig`, which loads the
 * agent-runtime/channel providers `raw` references before calling this — this
 * function itself does no loading, only validation, so it never contributes a
 * provider twice no matter how many times a caller re-validates the same raw
 * config within one process (`ConfigService.replaceAgents`).
 */
export async function mergeWithDefaults(
  raw: unknown,
  file: string,
  providerRegistry: ProviderRegistry,
): Promise<DreamuxConfig> {
  if (!isPlainObject(raw)) {
    throw new RuleViolation(
      `dreamux config error in ${file}: top-level must be an object`,
    );
  }
  rejectTopLevelCodex(raw, file);

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

function readWorkspaceConfig(
  rawWorkspace: unknown,
  file: string,
  prefix: string,
): DreamuxWorkspaceConfig {
  if (rawWorkspace === undefined) return { enabled: false };
  if (!isPlainObject(rawWorkspace)) {
    throw new RuleViolation(
      `dreamux config error in ${file}: ${prefix.slice(0, -1)} must be an object (got ${describeType(rawWorkspace)})`,
    );
  }
  return {
    enabled: readOptionalBoolean(rawWorkspace, 'enabled', false, file, prefix),
  };
}

export function defaultWorkspaceEnabled(
  config: DreamuxConfig,
  dispatcherId: string,
): boolean {
  return (
    config.dispatchers.find((dispatcher) => dispatcher.id === dispatcherId)
      ?.workspace.enabled ?? false
  );
}

function rejectTopLevelCodex(raw: Record<string, unknown>, file: string): void {
  if (!('codex' in raw)) return;
  throw new RuleViolation(
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
    throw new RuleViolation(
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
      throw new RuleViolation(
        `dreamux config error in ${file}: agents[${index}] must be an object (got ${describeType(raw)})`,
      );
    }
    const id = readNonEmptyString(raw, 'id', file, prefix);
    if (Object.prototype.hasOwnProperty.call(out, id)) {
      throw new RuleViolation(
        `dreamux config error in ${file}: agents[${index}].id duplicates agent '${id}'`,
      );
    }
    const provider = resolveConfigProvider(
      readNonEmptyString(raw, 'provider', file, prefix),
      'agentRuntime',
      file,
      prefix,
      providerRegistry,
    );
    const rawConfig = readProviderConfigObject(
      raw['config'],
      file,
      `${prefix}config`,
      {
        allowMissing: true,
      },
    );
    const runtimeProvider = asAgentRuntimeProvider(
      providerRegistry.getImplementation(provider.descriptor.id),
    );
    if (runtimeProvider === null) {
      throw new RuleViolation(
        `dreamux config error in ${file}: ${prefix}provider='${provider.ref}' is registered but not runnable.\n` +
          'Its provider package or plugin did not yield a runnable agentRuntime ' +
          'implementation. Register a valid implementation for this ref before ' +
          'config validation runs.',
      );
    }
    const parsedConfig =
      ((await runtimeProvider.config?.read(rawConfig, {
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

function rejectLegacyDispatcherProviderKeys(
  raw: Record<string, unknown>,
  prefix: string,
  file: string,
): void {
  // Named rather than left to generic unknown-key tolerance: these two keys
  // are the pre-v2 config shape's provider blocks, and an operator who still
  // has one needs the rebuild instructions below, not silent tolerance.
  for (const key of ['feishu', 'codex']) {
    if (!(key in raw)) continue;
    const name = `${prefix}${key}`;
    throw new RuleViolation(
      `dreamux config error in ${file}: ${name} is not supported by the providerized config v2 schema.\n` +
        'Dreamux 0.x does not silently migrate operator-owned config. Rebuild this dispatcher with ' +
        'dispatchers[].channels[] for the channel and a named agents[] entry referenced via ' +
        'dispatchers[].agentRuntime for the runtime, then restart.',
    );
  }
}

async function readDispatchers(
  rawDispatchers: unknown,
  file: string,
  agents: Record<string, ResolvedAgentConfig>,
  providerRegistry: ProviderRegistry,
): Promise<DispatcherConfig[]> {
  if (rawDispatchers === undefined) return [];
  if (!Array.isArray(rawDispatchers)) {
    throw new RuleViolation(
      `dreamux config error in ${file}: dispatchers must be an array (got ${describeType(rawDispatchers)})`,
    );
  }
  const out: DispatcherConfig[] = [];
  const ids = new Set<string>();
  for (let index = 0; index < rawDispatchers.length; index++) {
    const raw = rawDispatchers[index];
    const prefix = `dispatchers[${index}].`;
    if (!isPlainObject(raw)) {
      throw new RuleViolation(
        `dreamux config error in ${file}: dispatchers[${index}] must be an object (got ${describeType(raw)})`,
      );
    }
    if ('runtime' in raw) {
      throw new RuleViolation(
        `dreamux config error in ${file}: ${prefix}runtime is no longer supported.\n` +
          'Runtime config moved to a named agents[] entry. Declare the runtime ' +
          'under top-level agents[] (id, provider, config) and reference it here ' +
          `with ${prefix}agentRuntime = "<agent id>", then rebuild ${file}.`,
      );
    }
    rejectLegacyDispatcherProviderKeys(raw, prefix, file);
    const id = validateDispatcherId(
      readNonEmptyString(raw, 'id', file, prefix),
      `${prefix}id`,
    );
    if (ids.has(id)) {
      throw new RuleViolation(
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

    const cwd = raw['cwd'];
    if (typeof cwd !== 'string' || cwd.trim() === '') {
      throw new RuleViolation(
        `dreamux config error in ${file}: ${prefix}cwd is required for dispatcher ` +
          `'${id}': set it to the Dispatcher's workspace directory`,
      );
    }
    const agentRuntimeId = resolveAgentRuntime(raw, prefix, file, agents);
    out.push({
      id,
      cwd: expandHome(cwd),
      enabled: readOptionalBoolean(raw, 'enabled', true, file, prefix),
      workspace: readWorkspaceConfig(
        raw['workspace'],
        file,
        `${prefix}workspace.`,
      ),
      channels,
      agentRuntime: agentRuntimeId,
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
    throw new RuleViolation(
      `dreamux config error in ${file}: ${prefix}agentRuntime is required.\n` +
        'Declare a named runtime under top-level agents[] (id, provider, config) ' +
        `and set ${prefix}agentRuntime to that agent's id, then rebuild ${file}.`,
    );
  }
  const agentRuntimeId = readNonEmptyString(
    raw,
    'agentRuntime',
    file,
    prefix,
  );
  if (!Object.prototype.hasOwnProperty.call(agents, agentRuntimeId)) {
    const known = Object.keys(agents);
    const knownHint =
      known.length > 0
        ? `Known agents: ${known.map((id) => `'${id}'`).join(', ')}.`
        : 'No agents[] are declared.';
    throw new RuleViolation(
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
    throw new RuleViolation(
      `dreamux config error in ${file}: ${prefix} must be an array (got ${describeType(rawChannels)}).\n` +
        'Use providerized config v2: dispatchers[].channels[] with a channel provider ref and provider-owned config.',
    );
  }
  if (rawChannels.length === 0) {
    throw new RuleViolation(
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
      throw new RuleViolation(
        `dreamux config error in ${file}: ${channelPrefix.slice(0, -1)} must be an object (got ${describeType(raw)})`,
      );
    }
    if (raw['collaborationSpace'] !== undefined) {
      // Named rather than silently tolerated like any other unknown key: this
      // key used to configure a real Core capability, and an operator who
      // wrote it needs to be told where that capability went.
      throw new RuleViolation(
        `dreamux config error in ${file}: ${channelPrefix}collaborationSpace ` +
          'was removed. Core no longer owns Collaboration Space policy — the ' +
          'channel that offers the flow owns it now. Configure it there and ' +
          'delete this key.',
      );
    }
    const id = readNonEmptyString(raw, 'id', file, channelPrefix);
    if (channelIds.has(id)) {
      throw new RuleViolation(
        `dreamux config error in ${file}: ${channelPrefix}id='${id}' duplicates another channel in this dispatcher; channel ids must be unique per dispatcher.`,
      );
    }
    channelIds.add(id);
    const provider = resolveConfigProvider(
      readNonEmptyString(raw, 'provider', file, channelPrefix),
      'channel',
      file,
      channelPrefix,
      providerRegistry,
    );
    if (providerRefs.has(provider.ref)) {
      throw new RuleViolation(
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
      throw new RuleViolation(
        `dreamux config error in ${file}: ${channelPrefix}provider='${provider.ref}' is registered but has no channel implementation.\n` +
          'Its provider package or plugin did not yield a usable channel ' +
          'implementation (one exposing createSession). Register a valid ' +
          'implementation for this ref before config validation runs.',
      );
    }
    const parsed =
      ((await channelProvider.config?.read(rawConfig, {
        dispatcher_id: dispatcherId,
        channel_id: id,
        provider: provider.ref,
      })) as DispatcherProviderConfig | undefined) ?? rawConfig;
    let identity = '';
    try {
      identity = channelProvider.identity?.get(parsed) ?? '';
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
