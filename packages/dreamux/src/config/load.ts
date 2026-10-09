import { pathExists } from '../platform/fs-errors.js';

import { readFile } from 'node:fs/promises';
import { loadAgentRuntimeProviders } from '../agent-runtime/external-provider.js';
import { loadChannelProviders } from '../channel/external-channel-provider.js';
import { parseProviderRef } from '../registry/provider-ref.js';
import { ProviderRegistry } from '../registry/registry.js';
import { isPlainObject } from '@excitedjs/dreamux-utils';
import { createLogger } from '../platform/logger.js';
import {
  loadPlugins,
  readPluginConfigs,
  readPluginEntries,
  type LoadedPlugin,
} from '../plugin/loader.js';
import {
  assertConfigFileMode,
  globalConfigFile,
  legacyGlobalConfigFile,
  mergeWithDefaults,
  type ConfigPathOverrides,
  type DreamuxConfig,
} from './config.js';

export interface LoadConfigResult {
  config: DreamuxConfig;
  configFile: string;
  providerRegistry: ProviderRegistry;
  /** Loaded and contributed, with configs read; `server` has not run. */
  plugins: LoadedPlugin[];
}

export async function loadConfig(
  overrides: ConfigPathOverrides = {},
): Promise<LoadConfigResult> {
  const file = globalConfigFile();
  const providerRegistry = overrides.providerRegistry ?? new ProviderRegistry();
  await assertNoLegacyTomlOnly();
  const { config, plugins } = await readConfigFile(file, providerRegistry);
  return { config, configFile: file, providerRegistry, plugins };
}

/**
 * Open, parse, and resolve `config.json`: existence and mode checks, JSON
 * parse, one-time plugin load, then {@link resolveConfig}. Shared by the CLI
 * read path below (`doctor`/`onboard`/`loadConfig`) and `ConfigService`'s own
 * open sequence (`config/service.ts`'s `loadFile`), so "open the file" is
 * written once; `ConfigService` additionally holds `raw` (the parsed object,
 * returned here so it does not re-parse) for its `TransactionalStore`.
 */
export async function readConfigFile(
  file: string,
  providerRegistry: ProviderRegistry,
): Promise<{
  raw: Record<string, unknown>;
  config: DreamuxConfig;
  plugins: LoadedPlugin[];
}> {
  if (!(await pathExists(file))) {
    throw new Error(
      `dreamux config is missing at ${file}.\n` +
        'Run `dreamux onboard` to create it before starting the server.',
    );
  }
  await assertConfigFileMode(file);
  const text = await readFile(file, 'utf8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(
      `dreamux config parse error in ${file}: ${msg}\n` +
        `Fix the JSON syntax in ${file}, then restart. Run \`dreamux onboard\` if you need to recreate the config.`,
    );
  }
  // Plugins contribute providers config may address, so they load before
  // provider refs are loaded and validated. A non-object top level is still
  // reported by resolveConfig's mergeWithDefaults.
  const entries = isPlainObject(parsed)
    ? readPluginEntries(parsed, file)
    : undefined;
  const plugins = await loadPlugins({
    registry: providerRegistry,
    entries: entries ?? [],
    // The serve file logger does not exist yet; contribute only registers.
    logger: createLogger({ name: 'plugins' }),
  });
  const config = await resolveConfig(parsed, file, providerRegistry);
  readPluginConfigs(plugins, file);
  return {
    // resolveConfig's mergeWithDefaults already rejects a non-object top
    // level before returning, so parsed is a plain object whenever this
    // line runs.
    raw: parsed as Record<string, unknown>,
    config: entries === undefined ? config : { ...config, plugins: entries },
    plugins,
  };
}

/**
 * Loads the agent-runtime/channel providers `raw`'s `agents[]`/
 * `dispatchers[].channels[]` entries reference, then validates and shapes
 * `raw` into a `DreamuxConfig`. Deliberately excludes `plugins[]` loading
 * (`loadPlugins`/`readPluginConfigs`): that is a one-time, process-open step
 * — a plugin's `contribute()` registers providers and collides with itself
 * if run twice — so callers that may resolve a config more than once per
 * process (`ConfigService.replaceAgents`, `config/service.ts`) must not
 * route `plugins[]` through here.
 */
export async function resolveConfig(
  raw: unknown,
  file: string,
  providerRegistry: ProviderRegistry,
): Promise<DreamuxConfig> {
  await loadAgentRuntimeProviders({
    registry: providerRegistry,
    refs: agentProviderRefs(raw),
  });
  await loadChannelProviders({
    registry: providerRegistry,
    refs: channelProviderRefs(raw),
  });
  return mergeWithDefaults(raw, file, providerRegistry);
}

export async function assertNoLegacyTomlOnly(): Promise<void> {
  const jsonFile = globalConfigFile();
  const tomlFile = legacyGlobalConfigFile();
  if ((await pathExists(jsonFile)) || !(await pathExists(tomlFile))) return;
  throw new Error(
    `legacy dreamux config detected at ${tomlFile}, but ${jsonFile} does not exist.\n` +
      'dreamux 0.x does not migrate TOML config; it will not read it or write default ' +
      'JSON over an existing install.\n' +
      `Recreate the config as JSON (run \`dreamux onboard\`, or write ${jsonFile} with a ` +
      `dispatchers array), then move ${tomlFile} aside.`,
  );
}

/**
 * Every well-formed `agents[].provider` ref the loader should resolve. Malformed
 * refs are dropped here; normal config validation reports them with context.
 */
function agentProviderRefs(raw: unknown): string[] {
  if (!isPlainObject(raw)) return [];
  return providerRefsFrom(raw['agents'], (agent) => agent['provider']);
}

function channelProviderRefs(raw: unknown): string[] {
  if (!isPlainObject(raw)) return [];
  const dispatchers = raw['dispatchers'];
  if (!Array.isArray(dispatchers)) return [];
  const out: string[] = [];
  for (const dispatcher of dispatchers) {
    if (!isPlainObject(dispatcher)) continue;
    out.push(
      ...providerRefsFrom(
        dispatcher['channels'],
        (channel) => channel['provider'],
      ),
    );
  }
  return out;
}

function providerRefsFrom(
  entries: unknown,
  pick: (entry: Record<string, unknown>) => unknown,
): string[] {
  if (!Array.isArray(entries)) return [];
  const out: string[] = [];
  for (const entry of entries) {
    if (!isPlainObject(entry)) continue;
    const provider = pick(entry);
    if (typeof provider !== 'string') continue;
    try {
      out.push(parseProviderRef(provider).raw);
    } catch {
      // The normal config validation path reports malformed refs with context.
    }
  }
  return out;
}
