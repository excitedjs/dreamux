import {
  describeType,
  isPlainObject,
  readOptionalString,
  readProviderConfigObject,
  rejectUnknownKeys,
  requireNonEmptyString,
} from '@excitedjs/dreamux-utils';
import { parseProviderRef } from '../registry/index.js';
import { validateDispatcherId } from '../state/dispatcher-id.js';
import {
  readChannelCollaborationSpace,
  stringifyChannelCollaborationSpace,
  type DispatcherChannelCollaborationSpaceConfig,
} from './collaboration-space-config.js';
import { readOptionalBoolean } from './config-helpers.js';
import type { DispatcherProviderConfig, DreamuxWorkspaceConfig } from './config.js';
import { validateConfigRawEnvelope } from './raw-envelope.js';
const AGENT_KEYS = new Set(['id', 'provider', 'config']);
const DISPATCHER_KEYS = new Set(['id', 'cwd', 'enabled', 'workspace', 'channels', 'agentRuntime']);
const CHANNEL_KEYS = new Set(['id', 'provider', 'config', 'collaborationSpace']);
const WORKSPACE_KEYS = new Set(['enabled']);
export interface HostConfig {
  agents: HostAgentConfig[];
  dispatchers: HostDispatcherConfig[];
}
export interface HostAgentConfig {
  id: string;
  provider: string;
  rawConfig: DispatcherProviderConfig;
}
export interface HostDispatcherConfig {
  id: string;
  cwd: string | null;
  enabled: boolean;
  workspace: DreamuxWorkspaceConfig;
  channels: HostChannelConfig[];
  agentRuntime: string;
}
export interface HostChannelConfig {
  id: string;
  provider: string;
  rawConfig: DispatcherProviderConfig;
  collaborationSpace?: DispatcherChannelCollaborationSpaceConfig;
}
export function validateHostConfig(raw: unknown, file: string): HostConfig {
  const envelope = validateConfigRawEnvelope(raw, file);
  const agents = validateHostAgents(envelope.agents, file);
  const dispatchers = validateHostDispatchers(
    envelope.dispatchers,
    file,
    new Set(agents.map((agent) => agent.id)),
  );
  return { agents, dispatchers };
}
export function hostAgentRefs(host: HostConfig): string[] {
  return host.agents.map((agent) => agent.provider);
}
export function hostChannelRefs(host: HostConfig): string[] {
  return host.dispatchers.flatMap((dispatcher) =>
    dispatcher.channels.map((channel) => channel.provider),
  );
}
export function hostConfigFileShape(host: HostConfig): Record<string, unknown> {
  return {
    agents: host.agents.map((agent) => ({
      id: agent.id,
      provider: agent.provider,
      config: structuredClone(agent.rawConfig),
    })),
    dispatchers: host.dispatchers.map((dispatcher) => ({
      id: dispatcher.id,
      cwd: dispatcher.cwd,
      enabled: dispatcher.enabled,
      workspace: { enabled: dispatcher.workspace.enabled },
      channels: dispatcher.channels.map(channelFileShape),
      agentRuntime: dispatcher.agentRuntime,
    })),
  };
}
function channelFileShape(channel: HostChannelConfig): Record<string, unknown> {
  const collaborationSpace =
    channel.collaborationSpace?.defaultBinding.enabled === true
      ? { collaborationSpace: stringifyChannelCollaborationSpace(channel.collaborationSpace) }
      : {};
  return {
    id: channel.id,
    provider: channel.provider,
    ...collaborationSpace,
    config: structuredClone(channel.rawConfig),
  };
}
function validateHostAgents(rawAgents: unknown[] | undefined, file: string): HostAgentConfig[] {
  if (rawAgents === undefined) return [];
  const out: HostAgentConfig[] = [];
  const ids = new Set<string>();
  for (let index = 0; index < rawAgents.length; index++) {
    const prefix = `agents[${index}].`;
    const raw = requireObject(rawAgents[index], file, `agents[${index}]`);
    rejectUnknownKeys(raw, AGENT_KEYS, file, prefix);
    const id = requireNonEmptyString(raw, 'id', file, prefix);
    if (ids.has(id)) throw configError(file, `agents[${index}].id duplicates agent '${id}'`);
    ids.add(id);
    out.push({
      id,
      provider: canonicalProviderRef(
        requireNonEmptyString(raw, 'provider', file, prefix),
        file,
        `${prefix}provider`,
      ),
      rawConfig: providerConfig(raw, file, `${prefix}config`),
    });
  }
  return out;
}
function validateHostDispatchers(
  rawDispatchers: unknown[] | undefined,
  file: string,
  agentIds: ReadonlySet<string>,
): HostDispatcherConfig[] {
  if (rawDispatchers === undefined) return [];
  const out: HostDispatcherConfig[] = [];
  const ids = new Set<string>();
  for (let index = 0; index < rawDispatchers.length; index++) {
    const prefix = `dispatchers[${index}].`;
    const raw = requireObject(rawDispatchers[index], file, `dispatchers[${index}]`);
    if ('runtime' in raw) {
      throw configError(
        file,
        `${prefix}runtime is no longer supported.\n` +
          'Runtime config moved to a named agents[] entry. Declare the runtime ' +
          'under top-level agents[] (id, provider, config) and reference it here ' +
          `with ${prefix}agentRuntime = "<agent id>", then rebuild ${file}.`,
      );
    }
    rejectUnknownKeys(raw, DISPATCHER_KEYS, file, prefix);
    const id = validateDispatcherId(requireNonEmptyString(raw, 'id', file, prefix), `${prefix}id`);
    if (ids.has(id)) throw configError(file, `dispatchers[${index}].id duplicates dispatcher '${id}'`);
    ids.add(id);
    out.push({
      id,
      cwd: readOptionalString(raw, 'cwd', file, prefix),
      enabled: readOptionalBoolean(raw, 'enabled', true, file, prefix),
      workspace: readWorkspaceConfig(raw['workspace'], file, `${prefix}workspace.`),
      channels: validateHostChannels(raw['channels'], file, prefix),
      agentRuntime: validateHostAgentRuntime(raw, prefix, file, agentIds),
    });
  }
  return out;
}
function validateHostChannels(rawChannels: unknown, file: string, dispatcherPrefix: string): HostChannelConfig[] {
  const prefix = `${dispatcherPrefix}channels`;
  if (!Array.isArray(rawChannels)) {
    throw configError(
      file,
      `${prefix} must be an array (got ${describeType(rawChannels)}).\n` +
        'Use providerized config v2: dispatchers[].channels[] with a channel provider ref and provider-owned config.',
    );
  }
  if (rawChannels.length === 0) throw configError(file, `${prefix} must contain at least one channel.`);
  const out: HostChannelConfig[] = [];
  const channelIds = new Set<string>();
  const providerRefs = new Set<string>();
  for (let index = 0; index < rawChannels.length; index++) {
    const channelPrefix = `${prefix}[${index}].`;
    const raw = requireObject(rawChannels[index], file, channelPrefix.slice(0, -1));
    rejectUnknownKeys(raw, CHANNEL_KEYS, file, channelPrefix);
    const id = requireNonEmptyString(raw, 'id', file, channelPrefix);
    if (channelIds.has(id)) {
      throw configError(file, `${channelPrefix}id='${id}' duplicates another channel in this dispatcher; channel ids must be unique per dispatcher.`);
    }
    channelIds.add(id);
    const provider = canonicalProviderRef(
      requireNonEmptyString(raw, 'provider', file, channelPrefix),
      file,
      `${channelPrefix}provider`,
    );
    if (providerRefs.has(provider)) {
      throw configError(file, `${channelPrefix}provider='${provider}' duplicates another channel in this dispatcher; each provider may appear at most once per dispatcher.`);
    }
    providerRefs.add(provider);
    out.push({
      id,
      provider,
      rawConfig: providerConfig(raw, file, `${channelPrefix}config`),
      collaborationSpace: readChannelCollaborationSpace(
        raw['collaborationSpace'],
        file,
        `${channelPrefix}collaborationSpace.`,
      ),
    });
  }
  return out;
}
function validateHostAgentRuntime(
  raw: Record<string, unknown>,
  prefix: string,
  file: string,
  agentIds: ReadonlySet<string>,
): string {
  if (!('agentRuntime' in raw)) {
    throw configError(
      file,
      `${prefix}agentRuntime is required.\n` +
        'Declare a named runtime under top-level agents[] (id, provider, config) ' +
        `and set ${prefix}agentRuntime to that agent's id, then rebuild ${file}.`,
    );
  }
  const agentRuntimeId = requireNonEmptyString(raw, 'agentRuntime', file, prefix);
  if (!agentIds.has(agentRuntimeId)) {
    const known = [...agentIds];
    const knownHint =
      known.length > 0
        ? `Known agents: ${known.map((id) => `'${id}'`).join(', ')}.`
        : 'No agents[] are declared.';
    throw configError(
      file,
      `${prefix}agentRuntime='${agentRuntimeId}' ` +
        `does not match any agents[].id. ${knownHint}\n` +
        `Add an agents[] entry with id '${agentRuntimeId}' (or fix the reference), then rebuild ${file}.`,
    );
  }
  return agentRuntimeId;
}
function readWorkspaceConfig(
  rawWorkspace: unknown,
  file: string,
  prefix: string,
): DreamuxWorkspaceConfig {
  if (rawWorkspace === undefined) return { enabled: true };
  const raw = requireObject(rawWorkspace, file, prefix.slice(0, -1));
  rejectUnknownKeys(raw, WORKSPACE_KEYS, file, prefix);
  return { enabled: readOptionalBoolean(raw, 'enabled', true, file, prefix) };
}
function providerConfig(
  raw: Record<string, unknown>,
  file: string,
  path: string,
): DispatcherProviderConfig {
  return readProviderConfigObject(raw['config'], file, path, { allowMissing: true });
}
function canonicalProviderRef(raw: string, file: string, path: string): string {
  try {
    return parseProviderRef(raw).raw;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`dreamux config error in ${file}: ${path} is invalid: ${msg}`);
  }
}
function requireObject(raw: unknown, file: string, path: string): Record<string, unknown> {
  if (isPlainObject(raw)) return raw;
  throw configError(file, `${path} must be an object (got ${describeType(raw)})`);
}
function configError(file: string, message: string): Error {
  return new Error(`dreamux config error in ${file}: ${message}`);
}
