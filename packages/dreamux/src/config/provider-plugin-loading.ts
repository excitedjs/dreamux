import type { NpmProviderRef } from '@excitedjs/dreamux-types';
import type { ConfigPathOverrides } from './config.js';
import {
  loadAgentRuntimeProviders,
} from '../agent-runtime/external-provider.js';
import {
  loadChannelProviders,
} from '../channel/external-channel-provider.js';
import {
  parseProviderRef,
  type ProviderRegistry,
} from '../registry/index.js';
import type {
  NpmProviderModuleImporter,
  ProviderModule,
} from '../registry/provider-loader.js';
import { errMessage } from '../registry/provider-loader.js';
import type {
  ProviderPluginAccess,
  ProviderPluginLoadSession,
  ProviderPluginInspection,
} from '../registry/provider-plugin-store.js';
import { hostAgentRefs, hostChannelRefs, validateHostConfig } from './host-config.js';
interface LoadedProviderPlugins {
  packages: string[];
  session: ProviderPluginLoadSession | null;
}
export function formatMissingProviderPluginError(
  heading: string,
  diagnostics: readonly ProviderPluginInspection[],
): Error {
  const missing = diagnostics.filter((diagnostic) => !diagnostic.ok);
  return new Error(
    [
      heading,
      ...missing.map(
        (diagnostic) =>
          `- ${diagnostic.packageName}: ${diagnostic.error ?? 'no selected generation'}`,
      ),
    ].join('\n'),
  );
}
export function throwIfProviderPluginsUnavailable(
  heading: string,
  diagnostics: readonly ProviderPluginInspection[],
): void {
  const missing = diagnostics.filter((diagnostic) => !diagnostic.ok);
  if (missing.length > 0) throw formatMissingProviderPluginError(heading, missing);
}
export async function assertProviderPluginsAvailableForDryRun(input: {
  parsed: unknown;
  overrides: ConfigPathOverrides;
  heading: string;
  checkedPackages?: Set<string>;
}): Promise<void> {
  const host = validateHostConfig(input.parsed, 'dreamux config');
  const diagnostics = await inspectProviderPluginPackages({
    agentRefs: hostAgentRefs(host),
    channelRefs: hostChannelRefs(host),
    overrides: input.overrides,
    skipPackages: input.checkedPackages,
  });
  throwIfProviderPluginsUnavailable(input.heading, diagnostics);
  for (const diagnostic of diagnostics) input.checkedPackages?.add(diagnostic.packageName);
}
export async function inspectProviderPluginPackages(input: {
  agentRefs: string[];
  channelRefs: string[];
  overrides: ConfigPathOverrides;
  skipPackages?: ReadonlySet<string>;
}): Promise<ProviderPluginInspection[]> {
  const packages = pluginPackagesForRefs(input)
    .filter((packageName) => input.skipPackages?.has(packageName) !== true);
  if (packages.length === 0) return [];
  const store = await providerPluginStoreFor(input.overrides);
  return await store.inspectPackages(packages);
}
export async function loadProviderPluginsForConfig(input: {
  agentRefs: string[];
  channelRefs: string[];
  providerRegistry: ProviderRegistry;
  overrides: Pick<
    ConfigPathOverrides,
    | 'externalAgentRuntimeModuleImporter'
    | 'externalChannelModuleImporter'
    | 'providerPluginStore'
  >;
  session: ProviderPluginLoadSession | null;
}): Promise<LoadedProviderPlugins> {
  const pluginPlan = await prepareProviderPluginImporters({
    agentRefs: input.agentRefs,
    channelRefs: input.channelRefs,
    overrides: input.overrides,
    session: input.session,
  });
  await loadAgentRuntimeProviders({
    registry: input.providerRegistry,
    refs: input.agentRefs,
    importModule: input.overrides.externalAgentRuntimeModuleImporter,
    importNpmModule: pluginPlan.agentImporter,
  });
  await loadChannelProviders({
    registry: input.providerRegistry,
    refs: input.channelRefs,
    importModule: input.overrides.externalChannelModuleImporter,
    importNpmModule: pluginPlan.channelImporter,
  });
  return {
    packages: pluginPlan.packages,
    session: pluginPlan.session,
  };
}
export async function rejectProviderPluginCandidatesAfterFailure(
  session: ProviderPluginLoadSession | null,
  cause: unknown,
): Promise<void> {
  if (session === null) return;
  try {
    await session.rejectCandidates();
  } catch (cleanupError) {
    throw new AggregateError(
      [cause, cleanupError],
      `provider plugin candidate load failed, and candidate cleanup failed: ${errMessage(cause)}; cleanup: ${errMessage(cleanupError)}`,
      { cause },
    );
  }
}
async function prepareProviderPluginImporters(input: {
  agentRefs: string[];
  channelRefs: string[];
  overrides: Pick<
    ConfigPathOverrides,
    | 'externalAgentRuntimeModuleImporter'
    | 'externalChannelModuleImporter'
    | 'providerPluginStore'
  >;
  session: ProviderPluginLoadSession | null;
}): Promise<{
  packages: string[];
  agentImporter?: NpmProviderModuleImporter;
  channelImporter?: NpmProviderModuleImporter;
  session: ProviderPluginLoadSession | null;
}> {
  const packages = pluginPackagesForRefs(input);
  if (packages.length === 0) {
    return {
      packages: [],
      agentImporter: injectedImporter(
        input.overrides.externalAgentRuntimeModuleImporter,
      ),
      channelImporter: injectedImporter(
        input.overrides.externalChannelModuleImporter,
      ),
      session: null,
    };
  }
  if (input.session === null) {
    throw new Error(
      `provider plugin load session is required for ${packages.join(', ')}`,
    );
  }
  const session = input.session;
  for (const packageName of packages) {
    try {
      await session.preparePackage(packageName);
    } catch (err) {
      const matchingRefs = refsForPackage(
        [...input.agentRefs, ...input.channelRefs],
        packageName,
      );
      throw new Error(
        `failed to prepare provider plugin package ${JSON.stringify(packageName)} for ${matchingRefs.join(', ')}: ${errMessage(err)}`,
        { cause: err },
      );
    }
  }
  const packageImporter: NpmProviderModuleImporter = async (
    _ref,
    packageName,
  ): Promise<ProviderModule> => {
    return await session.importModule(packageName);
  };
  return {
    packages,
    agentImporter:
      input.overrides.externalAgentRuntimeModuleImporter === undefined
        ? packageImporter
        : injectedImporter(input.overrides.externalAgentRuntimeModuleImporter),
    channelImporter:
      input.overrides.externalChannelModuleImporter === undefined
        ? packageImporter
        : injectedImporter(input.overrides.externalChannelModuleImporter),
    session,
  };
}
export async function createProviderPluginSession(input: {
  agentRefs: string[];
  channelRefs: string[];
  overrides: ConfigPathOverrides;
  operation: 'materializing-strict' | 'installed-only-strict';
  signal?: AbortSignal;
}): Promise<ProviderPluginLoadSession | null> {
  const packages = pluginPackagesForRefs(input);
  if (packages.length === 0) return null;
  const store = await providerPluginStoreFor(input.overrides);
  return input.operation === 'materializing-strict'
    ? store.createMaterializingSession(packages, input.signal)
    : store.createInstalledOnlySession(packages);
}
export function pluginPackagesForRefs(input: {
  agentRefs: string[];
  channelRefs: string[];
  overrides: Pick<
    ConfigPathOverrides,
    | 'externalAgentRuntimeModuleImporter'
    | 'externalChannelModuleImporter'
  >;
}): string[] {
  const agentNpmRefs = npmRefsFromRefs(input.agentRefs);
  const channelNpmRefs = npmRefsFromRefs(input.channelRefs);
  const agentPackages = input.overrides.externalAgentRuntimeModuleImporter === undefined
    ? npmPackagesFromParsedRefs(agentNpmRefs)
    : [];
  const channelPackages = input.overrides.externalChannelModuleImporter === undefined
    ? npmPackagesFromParsedRefs(channelNpmRefs)
    : [];
  return [...new Set([...agentPackages, ...channelPackages])].sort();
}
function npmRefsFromRefs(refs: string[]): NpmProviderRef[] {
  const out = new Map<string, NpmProviderRef>();
  for (const raw of refs) {
    const parsed = parseProviderRef(raw);
    if (parsed.source === 'npm') out.set(parsed.raw, parsed);
  }
  return [...out.values()];
}
function npmPackagesFromParsedRefs(refs: NpmProviderRef[]): string[] {
  return [...new Set(refs.map((ref) => ref.package))];
}
function injectedImporter(
  importer: ((packageName: string) => Promise<ProviderModule>) | undefined,
): NpmProviderModuleImporter | undefined {
  if (importer === undefined) return undefined;
  return async (_ref, packageName) => await importer(packageName);
}
async function providerPluginStoreFor(
  overrides: ConfigPathOverrides,
): Promise<ProviderPluginAccess> {
  if (overrides.providerPluginStore !== undefined) return overrides.providerPluginStore;
  const mod = await import('../registry/provider-plugin-store.js');
  return new mod.ProviderPluginStore();
}
function refsForPackage(refs: string[], packageName: string): string[] {
  return refs.filter((raw) => {
    const parsed = parseProviderRef(raw);
    return parsed.source === 'npm' && parsed.package === packageName;
  });
}
