import type {
  AgentRuntimeProvider,
  ChannelProvider,
  NpmProviderRef,
} from '@excitedjs/dreamux-types';

import type { ConfigPathOverrides } from './config.js';
import { parseProviderRef } from '../registry/index.js';
import type { ProviderModule } from '../registry/provider-loader.js';
import type {
  ProviderPluginInspection,
  ProviderPluginStore,
} from '../registry/provider-plugin-store.js';

export interface ProviderPluginPlan {
  packages: string[];
  diagnostics: ProviderPluginInspection[];
  agentImporter?: (ref: NpmProviderRef, packageName: string) => Promise<ProviderModule>;
  channelImporter?: (ref: NpmProviderRef, packageName: string) => Promise<ProviderModule>;
}

export async function prepareProviderPlugins(input: {
  agentRefs: string[];
  channelRefs: string[];
  overrides: ConfigPathOverrides;
}): Promise<ProviderPluginPlan> {
  const agentPackages = input.overrides.externalAgentRuntimeModuleImporter === undefined
    ? npmPackagesFromRefs(input.agentRefs)
    : [];
  const channelPackages = input.overrides.externalChannelModuleImporter === undefined
    ? npmPackagesFromRefs(input.channelRefs)
    : [];
  const packages = [...new Set([...agentPackages, ...channelPackages])].sort();
  if (packages.length === 0) return { packages: [], diagnostics: [] };

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
  const importer = async (packageName: string): Promise<ProviderModule> => {
    const failure = failures.get(packageName);
    if (failure !== undefined) {
      throw new Error(failure.error ?? `provider plugin ${packageName} is not installed`);
    }
    return await store.importModule(packageName);
  };
  return {
    packages,
    diagnostics,
    ...(agentPackages.length === 0
      ? {}
      : {
          agentImporter: (ref, packageName) =>
            failures.has(packageName)
              ? Promise.resolve(missingAgentRuntimeModule(ref, failures.get(packageName)!))
              : importer(packageName),
        }),
    ...(channelPackages.length === 0
      ? {}
      : {
          channelImporter: (ref, packageName) =>
            failures.has(packageName)
              ? Promise.resolve(missingChannelModule(ref, failures.get(packageName)!))
              : importer(packageName),
        }),
  };
}

function npmPackagesFromRefs(refs: string[]): string[] {
  const out = new Set<string>();
  for (const raw of refs) {
    const parsed = parseProviderRef(raw);
    if (parsed.source === 'npm') out.add(parsed.package);
  }
  return [...out];
}

async function providerPluginStoreFor(
  overrides: ConfigPathOverrides,
): Promise<ProviderPluginStore> {
  if (overrides.providerPluginStore !== undefined) return overrides.providerPluginStore;
  const mod = await import('../registry/provider-plugin-store.js');
  return new mod.ProviderPluginStore();
}

async function materializeProviderPluginPackages(
  store: ProviderPluginStore,
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
  store: ProviderPluginStore,
  packages: string[],
): Promise<ProviderPluginInspection[]> {
  const diagnostics: ProviderPluginInspection[] = [];
  for (const packageName of packages) {
    diagnostics.push(await store.inspectPackage(packageName));
  }
  return diagnostics;
}

function missingAgentRuntimeModule(
  ref: NpmProviderRef,
  inspection: ProviderPluginInspection,
): ProviderModule {
  return {
    [ref.export ?? 'default']: ({ descriptor }: { descriptor: unknown }) =>
      missingAgentRuntimeProvider(ref.raw, descriptor, inspection),
  };
}

function missingChannelModule(
  ref: NpmProviderRef,
  inspection: ProviderPluginInspection,
): ProviderModule {
  return {
    [ref.export ?? 'default']: ({ descriptor }: { descriptor: unknown }) =>
      missingChannelProvider(ref.raw, descriptor, inspection),
  };
}

function missingAgentRuntimeDiagnostic(
  ref: string,
  inspection: ProviderPluginInspection,
): NonNullable<AgentRuntimeProvider['diagnostic']> {
  return {
    binChecks: () => [],
    runDiagnostic: async () => ({
      ok: false,
      detail: `provider plugin ${inspection.packageName} is not installed or unusable`,
      errors: [
        inspection.error ??
          `provider plugin required by ${ref} is not installed or unusable`,
      ],
    }),
  };
}

function missingChannelDiagnostic(
  ref: string,
  inspection: ProviderPluginInspection,
): NonNullable<ChannelProvider['diagnostic']> {
  return {
    binChecks: () => [],
    runDiagnostic: async () => ({
      ok: false,
      detail: `provider plugin ${inspection.packageName} is not installed or unusable`,
      errors: [
        inspection.error ??
          `provider plugin required by ${ref} is not installed or unusable`,
      ],
    }),
  };
}

function missingAgentRuntimeProvider(
  ref: string,
  descriptor: unknown,
  inspection: ProviderPluginInspection,
): AgentRuntimeProvider {
  return {
    ref,
    descriptor: descriptor as AgentRuntimeProvider['descriptor'],
    getCapabilities: () => ({ resume: { supported: false } }),
    readConfig: (raw) => raw,
    diagnostic: missingAgentRuntimeDiagnostic(ref, inspection),
    createRuntime() {
      throw new Error(`provider plugin for ${ref} is not installed`);
    },
  };
}

function missingChannelProvider(
  ref: string,
  descriptor: unknown,
  inspection: ProviderPluginInspection,
): ChannelProvider {
  return {
    ref,
    descriptor: descriptor as ChannelProvider['descriptor'],
    readConfig: (raw) => raw as Record<string, unknown>,
    diagnostic: missingChannelDiagnostic(ref, inspection),
    createSession() {
      throw new Error(`provider plugin for ${ref} is not installed`);
    },
  };
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
