import {
  createBuiltinProviderRegistry,
  parseProviderRef,
  type ProviderRegistry,
} from '../registry/index.js';
import { errMessage } from '../registry/provider-loader.js';
import type {
  ProviderPluginInspection,
  ProviderPluginLoadSession,
} from '../registry/provider-plugin-store.js';
import {
  assertNoLegacyTomlOnly,
  globalConfigFile,
  readConfigJson,
  type ConfigPathOverrides,
} from './config.js';
import {
  hostAgentRefs,
  hostChannelRefs,
  validateHostConfig,
  type HostConfig,
} from './host-config.js';
import {
  createProviderPluginSession,
  inspectProviderPluginPackages,
  loadProviderPluginsForConfig,
} from './provider-plugin-loading.js';
import {
  readHostAgentConfig,
  readHostChannelConfig,
} from './provider-readers.js';

export interface ProviderDeclaration {
  id: string;
  provider: string;
  config: Record<string, unknown>;
}
export interface ProviderDispatcherDeclaration {
  id: string;
  runtime: ProviderDeclaration | null;
  channels: ProviderDeclaration[];
}
export interface ProviderDeclarationInspectionFailure {
  kind: 'agentRuntime' | 'channel';
  id: string;
  provider: string;
  dispatcherId?: string;
  reason: string;
}
export interface ConfigProviderInspection {
  configFile: string;
  host: HostConfig;
  providerRegistry: ProviderRegistry;
  pluginDiagnostics: ProviderPluginInspection[];
  agents: ProviderDeclaration[];
  dispatchers: ProviderDispatcherDeclaration[];
  failures: ProviderDeclarationInspectionFailure[];
}

export async function inspectConfigProviderDeclarations(
  overrides: ConfigPathOverrides = {},
): Promise<ConfigProviderInspection> {
  const configFile = globalConfigFile(overrides);
  await assertNoLegacyTomlOnly(overrides);
  const host = validateHostConfig(await readConfigJson(configFile), configFile);
  const agentRefs = hostAgentRefs(host);
  const channelRefs = hostChannelRefs(host);
  const pluginDiagnostics = await inspectProviderPluginPackages({
    agentRefs,
    channelRefs,
    overrides,
  });
  const state = await inspectionState(
    configFile,
    overrides,
    agentRefs,
    channelRefs,
    pluginDiagnostics,
  );
  const agents = new Map<string, ProviderDeclaration>();
  for (const [index, agent] of host.agents.entries()) {
    const read = async (): Promise<ProviderDeclaration> => {
      const parsed = await readHostAgentConfig(
        agent,
        configFile,
        state.providerRegistry,
        `agents[${index}].`,
      );
      return { id: agent.id, provider: parsed.provider, config: parsed.config };
    };
    const declaration = await inspectDeclaration(state, {
      kind: 'agentRuntime',
      id: agent.id,
      provider: agent.provider,
      read,
    });
    if (declaration !== null) agents.set(agent.id, declaration);
  }
  return {
    configFile,
    host,
    providerRegistry: state.providerRegistry,
    pluginDiagnostics,
    agents: [...agents.values()],
    dispatchers: await inspectDispatchers(state, host, agents),
    failures: state.failures,
  };
}

interface InspectionState {
  configFile: string;
  overrides: ConfigPathOverrides;
  providerRegistry: ProviderRegistry;
  availableRefs: ReadonlySet<string>;
  diagnosticsByPackage: ReadonlyMap<string, ProviderPluginInspection>;
  session: ProviderPluginLoadSession | null;
  loads: Map<string, Promise<string | null>>;
  failures: ProviderDeclarationInspectionFailure[];
}
type ProviderKind = ProviderDeclarationInspectionFailure['kind'];
interface DeclarationRead {
  kind: ProviderKind;
  id: string;
  provider: string;
  dispatcherId?: string;
  read(): Promise<ProviderDeclaration>;
}

async function inspectDispatchers(
  state: InspectionState,
  host: HostConfig,
  agents: ReadonlyMap<string, ProviderDeclaration>,
): Promise<ProviderDispatcherDeclaration[]> {
  const out: ProviderDispatcherDeclaration[] = [];
  for (const [dispatcherIndex, dispatcher] of host.dispatchers.entries()) {
    const channels: ProviderDeclaration[] = [];
    for (const [channelIndex, channel] of dispatcher.channels.entries()) {
      const read = async (): Promise<ProviderDeclaration> => {
        const parsed = await readHostChannelConfig(channel, state.configFile, state.providerRegistry, {
          dispatcherId: dispatcher.id,
          dispatcherPrefix: `dispatchers[${dispatcherIndex}].`,
          channelIndex,
        });
        return { id: parsed.id, provider: parsed.provider, config: parsed.config };
      };
      const declaration = await inspectDeclaration(state, {
        kind: 'channel',
        id: channel.id,
        provider: channel.provider,
        dispatcherId: dispatcher.id,
        read,
      });
      if (declaration !== null) channels.push(declaration);
    }
    out.push({
      id: dispatcher.id,
      runtime: agents.get(dispatcher.agentRuntime) ?? null,
      channels,
    });
  }
  return out;
}

async function inspectDeclaration(
  state: InspectionState,
  input: DeclarationRead,
): Promise<ProviderDeclaration | null> {
  const loadError = await loadProvider(state, input.kind, input.provider);
  if (loadError !== null) return addFailure(state, input, loadError);
  try {
    return await input.read();
  } catch (err) {
    return addFailure(state, input, errMessage(err));
  }
}

function addFailure(
  state: InspectionState,
  input: Omit<DeclarationRead, 'read'>,
  reason: string,
): null {
  state.failures.push({
    kind: input.kind,
    id: input.id,
    provider: input.provider,
    ...(input.dispatcherId === undefined ? {} : { dispatcherId: input.dispatcherId }),
    reason,
  });
  return null;
}

async function loadProvider(
  state: InspectionState,
  kind: ProviderKind,
  provider: string,
): Promise<string | null> {
  if (!state.availableRefs.has(provider)) {
    return unavailableProviderReason(provider, state.diagnosticsByPackage);
  }
  const key = `${kind}\0${provider}`;
  let loaded = state.loads.get(key);
  if (loaded === undefined) {
    loaded = loadProviderRefs(
      state,
      kind === 'agentRuntime' ? [provider] : [],
      kind === 'channel' ? [provider] : [],
    );
    state.loads.set(key, loaded);
  }
  return await loaded;
}

async function loadProviderRefs(
  state: InspectionState,
  agentRefs: string[],
  channelRefs: string[],
): Promise<string | null> {
  try {
    await loadProviderPluginsForConfig({
      agentRefs,
      channelRefs,
      providerRegistry: state.providerRegistry,
      overrides: state.overrides,
      session: state.session,
    });
    return null;
  } catch (err) {
    return errMessage(err);
  }
}

async function inspectionState(
  configFile: string,
  overrides: ConfigPathOverrides,
  agentRefs: string[],
  channelRefs: string[],
  diagnostics: ProviderPluginInspection[],
): Promise<InspectionState> {
  const byPackage = new Map(diagnostics.map((entry) => [entry.packageName, entry]));
  const availableAgentRefs = availableProviderRefs(agentRefs, byPackage);
  const availableChannelRefs = availableProviderRefs(channelRefs, byPackage);
  return {
    configFile,
    overrides,
    providerRegistry: (overrides.providerRegistryFactory ?? createBuiltinProviderRegistry)(),
    availableRefs: new Set([...availableAgentRefs, ...availableChannelRefs]),
    diagnosticsByPackage: byPackage,
    session: await createProviderPluginSession({
      agentRefs: availableAgentRefs,
      channelRefs: availableChannelRefs,
      overrides,
      operation: 'installed-only-strict',
    }),
    loads: new Map(),
    failures: [],
  };
}

function availableProviderRefs(
  refs: string[],
  diagnosticsByPackage: ReadonlyMap<string, ProviderPluginInspection>,
): string[] {
  return [...new Set(refs)].filter((raw) => {
    const ref = parseProviderRef(raw);
    return ref.source !== 'npm' || diagnosticsByPackage.get(ref.package)?.ok !== false;
  });
}

function unavailableProviderReason(
  providerRef: string,
  diagnosticsByPackage: ReadonlyMap<string, ProviderPluginInspection>,
): string {
  const parsed = parseProviderRef(providerRef);
  if (parsed.source !== 'npm') return 'provider is not available';
  return diagnosticsByPackage.get(parsed.package)?.error ??
    `provider plugin ${parsed.package} has no selected generation`;
}
