/**
 * Plugin loading: `plugins[]` entry parsing, import + factory, same-name
 * checks, `contribute`, and `config.read`.
 *
 * Runs inside config loading, before provider refs are validated, because a
 * plugin may contribute a provider that config addresses as `builtin:<name>`.
 * `server` and api publication are not config concerns; they live in
 * `./host.ts` and run only where hooks are needed (serve, doctor).
 */

import type {
  AgentRuntimeProvider,
  ChannelProvider,
  ContributeHost,
  DreamuxLogger,
  DreamuxPlugin,
} from '@excitedjs/dreamux-types';
import {
  isPlainObject,
  rejectUnknownKeys,
  requireNonEmptyString,
} from '@excitedjs/dreamux-utils';

import { errorMessage } from '../platform/error-info.js';
import {
  ALWAYS_LOADED_PLUGIN_REFS,
  BUILTIN_PLUGIN_PACKAGES,
  BUILTIN_PROVIDERS,
  parseProviderRef,
  registerBuiltinProvider,
  type ProviderKind,
  type ProviderRef,
  type ProviderRegistry,
} from '../registry/index.js';

/** One `plugins[]` item: a bare ref string is `{ ref }`. */
export interface PluginConfigEntry {
  ref: string;
  config?: unknown;
}

export interface LoadedPlugin {
  readonly name: string;
  /** Human source label: `plugins[2] ("npm:@acme/x")` or `always-loaded "builtin:feishu"`. */
  readonly source: string;
  readonly plugin: DreamuxPlugin;
  /** Its `plugins[]` entry and index; `null` for an always-loaded plugin. */
  readonly entry: { readonly index: number; readonly value: PluginConfigEntry } | null;
  /** `config.read` result; set by {@link readPluginConfigs}. */
  config: unknown;
  readonly providers: readonly { kind: ProviderKind; name: string }[];
}

export type PluginLoadPhase =
  | 'import'
  | 'factory'
  | 'contribute'
  | 'config'
  | 'server'
  | 'api';

export class PluginLoadError extends Error {
  constructor(
    /** The plugin name, or its ref when the name is not known yet. */
    readonly plugin: string,
    readonly phase: PluginLoadPhase,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(`plugin "${plugin}" failed during ${phase}: ${message}`, options);
    this.name = 'PluginLoadError';
  }
}

export type PluginModuleImporter = (
  packageName: string,
) => Promise<Record<string, unknown>>;

/**
 * Validate the raw top-level `plugins` value. Runs before any import: unlike
 * provider refs, a malformed plugin entry has no later validation pass that
 * would report it.
 */
export function readPluginEntries(
  raw: Record<string, unknown>,
  file: string,
): PluginConfigEntry[] | undefined {
  const value = raw['plugins'];
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    throw new Error(`dreamux config error in ${file}: plugins must be an array`);
  }
  return value.map((item: unknown, index) => {
    const prefix = `plugins[${index}]`;
    let entry: PluginConfigEntry;
    if (typeof item === 'string') {
      entry = { ref: item };
    } else if (isPlainObject(item)) {
      rejectUnknownKeys(item, new Set(['ref', 'config']), file, `${prefix}.`);
      entry = { ref: requireNonEmptyString(item, 'ref', file, `${prefix}.`) };
      if ('config' in item) entry.config = item['config'];
    } else {
      throw new Error(
        `dreamux config error in ${file}: ${prefix} must be a plugin ref string or { ref, config }`,
      );
    }
    try {
      parseProviderRef(entry.ref);
    } catch (err) {
      throw new Error(
        `dreamux config error in ${file}: ${prefix}.ref ${errorMessage(err)}`,
      );
    }
    return entry;
  });
}

/**
 * Import, construct, name-check and `contribute` the always-loaded plugins,
 * then `entries` in file order.
 */
export async function loadPlugins(options: {
  registry: ProviderRegistry;
  entries: readonly PluginConfigEntry[];
  logger: DreamuxLogger;
  importModule?: PluginModuleImporter;
}): Promise<LoadedPlugin[]> {
  const importModule = options.importModule ?? defaultImportModule;
  const providerSources = new Map<string, string>(
    BUILTIN_PROVIDERS.map((spec) => [spec.id, 'Dreamux core']),
  );
  const sources = [
    ...ALWAYS_LOADED_PLUGIN_REFS.map((ref) => ({
      ref,
      source: `always-loaded ${JSON.stringify(ref)}`,
      entry: null,
    })),
    ...options.entries.map((value, index) => ({
      ref: value.ref,
      source: `plugins[${index}] (${JSON.stringify(value.ref)})`,
      entry: { index, value },
    })),
  ];
  const loaded: LoadedPlugin[] = [];
  for (const { ref, source, entry } of sources) {
    const plugin = await constructPlugin(parseProviderRef(ref), importModule);
    const clash = loaded.find((other) => other.name === plugin.name);
    if (clash !== undefined) {
      throw new PluginLoadError(
        plugin.name,
        'factory',
        `plugin name "${plugin.name}" is declared by both ${clash.source} and ${source}`,
      );
    }
    const providers = contributePlugin(plugin, {
      registry: options.registry,
      logger: options.logger,
      providerSources,
    });
    loaded.push({ name: plugin.name, source, plugin, entry, config: undefined, providers });
  }
  return loaded;
}

/**
 * Call each plugin's `config.read` with its entry's `config`. A `config` block
 * for a plugin without `config.read` is rejected, matching the config loader's
 * reject-unknown-input policy: dropping it would leave the operator believing a
 * setting is in force.
 */
export function readPluginConfigs(
  plugins: readonly LoadedPlugin[],
  file: string,
): void {
  for (const loaded of plugins) {
    if (loaded.entry === null) continue;
    const { index, value: entry } = loaded.entry;
    const reader = loaded.plugin.config;
    if (reader === undefined) {
      if ('config' in entry) {
        throw new PluginLoadError(
          loaded.name,
          'config',
          `plugin "${loaded.name}" takes no config (${file}: plugins[${index}].config)`,
        );
      }
      continue;
    }
    try {
      loaded.config = reader.read(entry.config);
    } catch (err) {
      throw new PluginLoadError(
        loaded.name,
        'config',
        `${file}: plugins[${index}].config: ${errorMessage(err)}`,
        { cause: err },
      );
    }
  }
}

async function constructPlugin(
  ref: ProviderRef,
  importModule: PluginModuleImporter,
): Promise<DreamuxPlugin> {
  let packageName: string;
  if (ref.source === 'npm') {
    packageName = ref.package;
  } else {
    const builtin = BUILTIN_PLUGIN_PACKAGES[ref.id];
    if (builtin === undefined) {
      throw new PluginLoadError(ref.raw, 'import', 'unknown built-in plugin');
    }
    packageName = builtin;
  }
  let module: Record<string, unknown>;
  try {
    module = await importModule(packageName);
  } catch (err) {
    throw new PluginLoadError(
      ref.raw,
      'import',
      `could not import package ${JSON.stringify(packageName)}: ${errorMessage(err)}`,
      { cause: err },
    );
  }
  const exportName = ref.source === 'npm' ? (ref.export ?? 'default') : 'default';
  const factory = module[exportName];
  if (typeof factory !== 'function') {
    throw new PluginLoadError(
      ref.raw,
      'factory',
      `expected ${exportName} export to be a plugin factory function`,
    );
  }
  let plugin: unknown;
  try {
    plugin = (factory as () => unknown)();
  } catch (err) {
    throw new PluginLoadError(ref.raw, 'factory', `plugin factory threw: ${errorMessage(err)}`, {
      cause: err,
    });
  }
  // `name` keys the same-name rule and every plugin log line.
  if (
    !isPlainObject(plugin) ||
    typeof plugin['name'] !== 'string' ||
    plugin['name'] === ''
  ) {
    throw new PluginLoadError(
      ref.raw,
      'factory',
      'plugin factory must return an object with a non-empty string name',
    );
  }
  return plugin as unknown as DreamuxPlugin;
}

function contributePlugin(
  plugin: DreamuxPlugin,
  context: {
    registry: ProviderRegistry;
    logger: DreamuxLogger;
    providerSources: Map<string, string>;
  },
): { kind: ProviderKind; name: string }[] {
  const providers: { kind: ProviderKind; name: string }[] = [];
  if (plugin.contribute === undefined) return providers;
  const contribute = (kind: ProviderKind, name: string, provider: unknown): void => {
    const other = context.providerSources.get(name);
    if (other !== undefined) {
      throw new PluginLoadError(
        plugin.name,
        'contribute',
        `provider "${name}" is contributed by plugin "${plugin.name}" and by ${other}`,
      );
    }
    registerBuiltinProvider(context.registry, { id: name, kind }, provider);
    context.providerSources.set(name, `plugin "${plugin.name}"`);
    providers.push({ kind, name });
  };
  const host: ContributeHost = {
    logger: context.logger,
    channelProviders: {
      contribute: <TConfig>(name: string, provider: ChannelProvider<TConfig>) =>
        contribute('channel', name, provider),
    },
    agentRuntimeProviders: {
      contribute: <TConfig>(name: string, provider: AgentRuntimeProvider<TConfig>) =>
        contribute('agentRuntime', name, provider),
    },
  };
  try {
    plugin.contribute(host);
  } catch (err) {
    if (err instanceof PluginLoadError) throw err;
    throw new PluginLoadError(plugin.name, 'contribute', errorMessage(err), {
      cause: err,
    });
  }
  return providers;
}

async function defaultImportModule(
  packageName: string,
): Promise<Record<string, unknown>> {
  return (await import(packageName)) as Record<string, unknown>;
}
