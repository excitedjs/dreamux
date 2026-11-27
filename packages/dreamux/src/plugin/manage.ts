import { isPlainObject } from '@excitedjs/dreamux-utils';

import { globalConfigFile } from '../config/config.js';
import { readConfigJson, writeConfigJson } from '../config/raw-file.js';
import type { CommandRunner } from '../platform/command-runner.js';
import { createLogger } from '../platform/logger.js';
import { pluginRoot } from '../platform/paths.js';
import { ProviderRegistry } from '../registry/registry.js';
import {
  type LoadedPlugin,
  loadPlugins,
  PluginLoadError,
  readPluginEntries,
} from './loader.js';
import { hasNpmPackage, npmPackageName } from './resolve.js';

/**
 * `dreamux plugin add`, `remove`, and `list`: the three things an operator
 * does to a registered plugin. Dreamux states one fact about a plugin here,
 * that it is an npm package in the plugin directory named by a `plugins[]`
 * entry; what the plugin contributes is read by loading it, and what its
 * command line does is the plugin's own (`./run.ts`).
 *
 * None of these asks for the daemon to be stopped. A change is read the
 * next time the daemon starts. While it runs, its own `config.agents.replace`
 * writes back the configuration it has held since its start, so one of these
 * commands followed by that write, before a restart, loses the command's
 * entry; the maintenance reference states it.
 */

/** One `plugins[]` item as written: a ref string, or `{ ref, config }`. */
type PluginItem = string | { ref: string; config?: unknown };

export interface PluginAddResult {
  /** The `npm:` ref now in `plugins[]`. */
  ref: string;
  /** `npm install` ran; a package already in the directory is left alone. */
  installed: boolean;
  /** The entry was added; an entry already there is left alone. */
  registered: boolean;
}

export interface PluginListRow {
  ref: string;
  /** The plugin's name and what it contributes, when it loads alone. */
  name?: string;
  providers: string[];
  /** Why it does not load. */
  error?: string;
}

const logger = createLogger({ name: 'plugin' });

/**
 * Install the package into the plugin directory, prove it loads as a plugin,
 * and list it in `plugins[]`. The proof runs before anything is written, so a
 * package that is not a plugin stays unregistered; a clash with another
 * plugin's name or with a built-in provider is not visible from one entry and
 * is reported at the next start.
 */
export async function addPlugin(
  input: string,
  runner: CommandRunner,
): Promise<PluginAddResult> {
  const name = npmPackageName(input);
  const ref = `npm:${name}`;
  const file = globalConfigFile();
  const raw = await rawConfig(file);
  const installed = hasNpmPackage(name);
  if (!installed) {
    await runner.run('npm', ['install', name, '--prefix', pluginRoot()]);
  }
  await loadAlone(ref);
  const registered = pluginItems(raw).some((item) => itemRef(item) === ref);
  if (!registered) {
    await writeConfigJson(file, {
      ...raw,
      plugins: [...pluginItems(raw), ref],
    });
  }
  return { ref, installed: !installed, registered: !registered };
}

/**
 * Take the entry out of `plugins[]`, then uninstall the package. It refuses
 * while a configured Dispatcher uses a provider the plugin contributes. That
 * is read by loading the entry, because the configuration records the
 * provider as `builtin:<name>` and not the plugin's ref; a plugin that does
 * not load contributes nothing a Dispatcher can use, so it is removed.
 */
export async function removePlugin(
  input: string,
  runner: CommandRunner,
): Promise<{ ref: string }> {
  const name = npmPackageName(input);
  const ref = `npm:${name}`;
  const file = globalConfigFile();
  const raw = await rawConfig(file);
  const items = pluginItems(raw);
  if (!items.some((item) => itemRef(item) === ref)) {
    throw new Error(`plugin ${ref} is not registered in ${file}`);
  }
  const use = await useOf(ref, raw);
  if (use !== null) {
    throw new Error(
      `plugin ${ref} contributes a provider that ${use}; ` +
        `take that out of ${file} first`,
    );
  }
  await writeConfigJson(file, {
    ...raw,
    plugins: items.filter((item) => itemRef(item) !== ref),
  });
  await runner.run('npm', ['uninstall', name, '--prefix', pluginRoot()]);
  return { ref };
}

/** One row per `plugins[]` entry, each loaded alone. */
export async function listPlugins(): Promise<PluginListRow[]> {
  const file = globalConfigFile();
  const raw = await rawConfig(file);
  return Promise.all(
    pluginItems(raw).map(async (item): Promise<PluginListRow> => {
      const ref = itemRef(item);
      try {
        const plugin = await loadAlone(ref);
        return {
          ref,
          name: plugin.name,
          providers: plugin.providers.map(
            (provider) => `${provider.kind}:${provider.name}`,
          ),
        };
      } catch (err) {
        if (!(err instanceof PluginLoadError)) throw err;
        return { ref, providers: [], error: err.message };
      }
    }),
  );
}

async function rawConfig(file: string): Promise<Record<string, unknown>> {
  const parsed = await readConfigJson(file);
  if (!isPlainObject(parsed)) {
    throw new Error(`dreamux config error in ${file}: expected a JSON object`);
  }
  // The same check the daemon's load makes, so a malformed `plugins[]` is
  // refused here as it is there, and never rewritten.
  readPluginEntries(parsed, file);
  return parsed;
}

/** The `plugins[]` items exactly as written, so a rewrite keeps them so. */
function pluginItems(raw: Record<string, unknown>): PluginItem[] {
  return (raw['plugins'] as PluginItem[] | undefined) ?? [];
}

function itemRef(item: PluginItem): string {
  return typeof item === 'string' ? item : String(item.ref);
}

/**
 * The plugin one `plugins[]` entry loads as. The always-loaded built-ins load
 * before it and are left out: what they contribute is not this entry's.
 */
async function loadAlone(ref: string): Promise<LoadedPlugin> {
  const loaded = await loadPlugins({
    registry: new ProviderRegistry(),
    entries: [{ ref }],
    logger,
  });
  return loaded.find((plugin) => plugin.entry !== null)!;
}

/**
 * The first configured use of a provider this plugin contributes, as the
 * sentence that names it, or `null` when none is used.
 */
async function useOf(
  ref: string,
  raw: Record<string, unknown>,
): Promise<string | null> {
  let providers: LoadedPlugin['providers'];
  try {
    providers = (await loadAlone(ref)).providers;
  } catch (err) {
    if (!(err instanceof PluginLoadError)) throw err;
    return null;
  }
  for (const provider of providers) {
    const providerRef = `builtin:${provider.name}`;
    const agent = objects(raw['agents']).find(
      (entry) => entry['provider'] === providerRef,
    );
    if (agent !== undefined) {
      return `agent ${JSON.stringify(agent['id'])} uses`;
    }
    const dispatcher =
      provider.kind === 'channel'
        ? objects(raw['dispatchers']).find((entry) =>
            objects(entry['channels']).some(
              (channel) => channel['provider'] === providerRef,
            ),
          )
        : undefined;
    if (dispatcher !== undefined) {
      return `dispatcher ${JSON.stringify(dispatcher['id'])} uses`;
    }
  }
  return null;
}

function objects(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter(isPlainObject) : [];
}
