import type { NpmProviderRef } from '@excitedjs/dreamux-types';

import type { ConfigPathOverrides } from './config.js';
import {
  loadAgentRuntimeProviders,
} from '../agent-runtime/external-provider.js';
import {
  loadChannelProviders,
} from '../channel/external-channel-provider.js';
import {
  agentProviderRefs,
  channelProviderRefs,
} from './config-helpers.js';
import {
  parseProviderRef,
  type ProviderDescriptor,
  type ProviderKind,
  type ProviderRegistry,
} from '../registry/index.js';
import type {
  NpmProviderModuleImporter,
  ProviderModule,
} from '../registry/provider-loader.js';
import type {
  ProviderPluginInspection,
} from '../registry/provider-plugin-store.js';

export interface ProviderPluginAccess {
  materializePackage(packageName: string): Promise<string>;
  inspectPackage(packageName: string): Promise<ProviderPluginInspection>;
  importModule(packageName: string): Promise<ProviderModule>;
}

export interface ProviderPluginPlan {
  packages: string[];
  diagnostics: ProviderPluginInspection[];
  agentRefsToLoad: string[];
  channelRefsToLoad: string[];
  missingAgentDescriptors: ProviderDescriptor[];
  missingChannelDescriptors: ProviderDescriptor[];
  agentImporter?: NpmProviderModuleImporter;
  channelImporter?: NpmProviderModuleImporter;
}

export interface LoadedProviderPlugins {
  packages: string[];
  diagnostics: ProviderPluginInspection[];
  missingPluginRefs: ReadonlySet<string>;
}

export async function loadProviderPluginsForConfig(input: {
  parsed: unknown;
  providerRegistry: ProviderRegistry;
  overrides: ConfigPathOverrides;
}): Promise<LoadedProviderPlugins> {
  const pluginPlan = await prepareProviderPlugins({
    agentRefs: agentProviderRefs(input.parsed),
    channelRefs: channelProviderRefs(input.parsed),
    overrides: input.overrides,
  });
  await loadAgentRuntimeProviders({
    registry: input.providerRegistry,
    refs: pluginPlan.agentRefsToLoad,
    importModule: input.overrides.externalAgentRuntimeModuleImporter,
    importNpmModule: pluginPlan.agentImporter,
  });
  await loadChannelProviders({
    registry: input.providerRegistry,
    refs: pluginPlan.channelRefsToLoad,
    importModule: input.overrides.externalChannelModuleImporter,
    importNpmModule: pluginPlan.channelImporter,
  });
  registerMissingProviderDescriptors(input.providerRegistry, [
    ...pluginPlan.missingAgentDescriptors,
    ...pluginPlan.missingChannelDescriptors,
  ]);
  return {
    packages: pluginPlan.packages,
    diagnostics: pluginPlan.diagnostics,
    missingPluginRefs: new Set(
      [
        ...pluginPlan.missingAgentDescriptors,
        ...pluginPlan.missingChannelDescriptors,
      ].map((descriptor) => descriptor.ref.raw),
    ),
  };
}

export async function prepareProviderPlugins(input: {
  agentRefs: string[];
  channelRefs: string[];
  overrides: ConfigPathOverrides;
}): Promise<ProviderPluginPlan> {
  const agentNpmRefs = npmRefsFromRefs(input.agentRefs);
  const channelNpmRefs = npmRefsFromRefs(input.channelRefs);
  const agentPackages = input.overrides.externalAgentRuntimeModuleImporter === undefined
    ? npmPackagesFromParsedRefs(agentNpmRefs)
    : [];
  const channelPackages = input.overrides.externalChannelModuleImporter === undefined
    ? npmPackagesFromParsedRefs(channelNpmRefs)
    : [];
  const packages = [...new Set([...agentPackages, ...channelPackages])].sort();
  if (packages.length === 0) {
    return {
      packages: [],
      diagnostics: [],
      agentRefsToLoad: input.agentRefs,
      channelRefsToLoad: input.channelRefs,
      missingAgentDescriptors: [],
      missingChannelDescriptors: [],
      agentImporter: injectedImporter(
        input.overrides.externalAgentRuntimeModuleImporter,
      ),
      channelImporter: injectedImporter(
        input.overrides.externalChannelModuleImporter,
      ),
    };
  }

  const store = await providerPluginStoreFor(input.overrides);
  const mode = input.overrides.providerPluginLoadMode ?? 'materialize';
  const refs = [...input.agentRefs, ...input.channelRefs];
  const diagnostics =
    mode === 'materialize'
      ? await materializeProviderPluginPackages(store, packages, refs)
      : await inspectProviderPluginPackages(store, packages);
  const failures = new Map(
    diagnostics
      .filter((entry) => !entry.ok)
      .map((entry) => [entry.packageName, entry]),
  );
  const agentFailures = failuresForPackages(failures, agentPackages);
  const channelFailures = failuresForPackages(failures, channelPackages);
  const packageImporter: NpmProviderModuleImporter = async (
    _ref,
    packageName,
  ): Promise<ProviderModule> => {
    const failure = failures.get(packageName);
    if (failure !== undefined) {
      throw new Error(failure.error ?? `provider plugin ${packageName} is not installed`);
    }
    return await store.importModule(packageName);
  };
  return {
    packages,
    diagnostics,
    agentRefsToLoad: refsToLoad(input.agentRefs, agentFailures),
    channelRefsToLoad: refsToLoad(input.channelRefs, channelFailures),
    missingAgentDescriptors: missingDescriptors(
      agentNpmRefs,
      agentFailures,
      'agentRuntime',
    ),
    missingChannelDescriptors: missingDescriptors(
      channelNpmRefs,
      channelFailures,
      'channel',
    ),
    agentImporter:
      input.overrides.externalAgentRuntimeModuleImporter === undefined
        ? packageImporter
        : injectedImporter(input.overrides.externalAgentRuntimeModuleImporter),
    channelImporter:
      input.overrides.externalChannelModuleImporter === undefined
        ? packageImporter
        : injectedImporter(input.overrides.externalChannelModuleImporter),
  };
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

function failuresForPackages(
  failures: ReadonlyMap<string, ProviderPluginInspection>,
  packages: string[],
): Map<string, ProviderPluginInspection> {
  const out = new Map<string, ProviderPluginInspection>();
  for (const packageName of packages) {
    const failure = failures.get(packageName);
    if (failure !== undefined) out.set(packageName, failure);
  }
  return out;
}

function refsToLoad(
  refs: string[],
  failures: ReadonlyMap<string, ProviderPluginInspection>,
): string[] {
  return refs.filter((raw) => {
    const parsed = parseProviderRef(raw);
    return parsed.source !== 'npm' || !failures.has(parsed.package);
  });
}

function missingDescriptors(
  refs: NpmProviderRef[],
  failures: ReadonlyMap<string, ProviderPluginInspection>,
  kind: ProviderKind,
): ProviderDescriptor[] {
  return refs
    .filter((ref) => failures.has(ref.package))
    .map((ref) => ({
      id: ref.raw,
      kind,
      ref,
    }));
}

function injectedImporter(
  importer: ((packageName: string) => Promise<ProviderModule>) | undefined,
): NpmProviderModuleImporter | undefined {
  if (importer === undefined) return undefined;
  return async (_ref, packageName) => await importer(packageName);
}

function registerMissingProviderDescriptors(
  registry: ProviderRegistry,
  descriptors: ProviderDescriptor[],
): void {
  for (const descriptor of descriptors) {
    if (!registry.hasRef(descriptor.ref)) registry.register(descriptor);
  }
}

async function providerPluginStoreFor(
  overrides: ConfigPathOverrides,
): Promise<ProviderPluginAccess> {
  if (overrides.providerPluginStore !== undefined) return overrides.providerPluginStore;
  const mod = await import('../registry/provider-plugin-store.js');
  return new mod.ProviderPluginStore();
}

async function materializeProviderPluginPackages(
  store: ProviderPluginAccess,
  packages: string[],
  refs: string[],
): Promise<ProviderPluginInspection[]> {
  const diagnostics: ProviderPluginInspection[] = [];
  for (const packageName of packages) {
    try {
      const version = await store.materializePackage(packageName);
      diagnostics.push({ packageName, ok: true, version, error: null });
    } catch (err) {
      const matchingRefs = refsForPackage(refs, packageName);
      throw new Error(
        `failed to materialize provider plugin package ${JSON.stringify(packageName)} for ${matchingRefs.join(', ')}: ${errorMessage(err)}`,
        { cause: err },
      );
    }
  }
  return diagnostics;
}

function refsForPackage(refs: string[], packageName: string): string[] {
  return refs.filter((raw) => {
    const parsed = parseProviderRef(raw);
    return parsed.source === 'npm' && parsed.package === packageName;
  });
}

async function inspectProviderPluginPackages(
  store: ProviderPluginAccess,
  packages: string[],
): Promise<ProviderPluginInspection[]> {
  const diagnostics: ProviderPluginInspection[] = [];
  for (const packageName of packages) {
    diagnostics.push(await store.inspectPackage(packageName));
  }
  return diagnostics;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
