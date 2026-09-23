/**
 * The plugin host: builds the frozen top-level hooks, runs every plugin's
 * `server`, then publishes each plugin's `api` through `hooks.plugin.for(name)`.
 *
 * Api publication runs last so plugin order does not matter: tapable hooks do
 * not replay, and a plugin loaded later must still get to tap an earlier
 * plugin's api. The whole of this module is load phase; any throw is a
 * {@link PluginLoadError}.
 */

import type {
  Dispatcher,
  DreamuxLogger,
  ServerHost,
} from '@excitedjs/dreamux-types';
import { HookMap, SyncHook } from 'tapable';

import { errorMessage } from '../platform/error-info.js';
import { type LoadedPlugin, PluginLoadError } from './loader.js';
import { callLoadPhaseTaps } from './taps.js';

export type ServerHooks = ServerHost['hooks'];

/** The public hooks plus core's untyped handle on the same HookMap instance. */
interface HostHooks {
  readonly hooks: ServerHooks;
  readonly pluginHooks: HookMap<SyncHook<[unknown]>>;
}

function buildHostHooks(): HostHooks {
  const pluginHooks = new HookMap(
    (name: string) => new SyncHook<[unknown]>(['api'], `plugin:${name}`),
  );
  const hooks: ServerHooks = Object.freeze({
    dispatcher: new SyncHook<[Dispatcher]>(['dispatcher'], 'dispatcher'),
    // tapable exports no TypedHookMap value; the typed view over the same
    // HookMap instance is declared once, here.
    plugin: pluginHooks as unknown as ServerHooks['plugin'],
  });
  return { hooks, pluginHooks };
}

/** Frozen, empty host hooks. Tests and embedded Servers without plugins use this. */
export function createServerHooks(): ServerHooks {
  return buildHostHooks().hooks;
}

export interface StartedPlugins {
  readonly hooks: ServerHooks;
  /** Tap names on the top-level hooks, for doctor. */
  tapNames(): { dispatcher: string[]; plugin: Record<string, string[]> };
}

/**
 * Run every plugin's `server`, then publish each plugin's `api` to the taps on
 * `hooks.plugin.for(name)`.
 */
export function startPlugins(
  plugins: readonly LoadedPlugin[],
  logger: DreamuxLogger,
): StartedPlugins {
  const { hooks, pluginHooks } = buildHostHooks();
  // Doctor rows and load errors find a plugin's taps by tap name, so a tap on
  // a top-level hook must carry the name of the plugin whose `server` is
  // running. The throw lands in that `server` call's catch below.
  let serving: string | null = null;
  const requireOwnName = {
    register: <T extends { name: string }>(tap: T): T => {
      if (serving === null) {
        throw new Error(`tap "${tap.name}" was added outside a plugin's server`);
      }
      if (tap.name !== serving) {
        throw new Error(`tap "${tap.name}" must be named after its plugin "${serving}"`);
      }
      return tap;
    },
  };
  hooks.dispatcher.intercept(requireOwnName);
  pluginHooks.intercept({
    factory: (_key, hook) => {
      hook.intercept(requireOwnName);
      return hook;
    },
  });
  for (const loaded of plugins) {
    if (loaded.plugin.server === undefined) continue;
    serving = loaded.name;
    try {
      loaded.plugin.server({
        config: loaded.config,
        logger: logger.child?.({ plugin: loaded.name }) ?? logger,
        hooks,
      });
    } catch (err) {
      throw new PluginLoadError(loaded.name, 'server', errorMessage(err), {
        cause: err,
      });
    } finally {
      serving = null;
    }
  }
  for (const loaded of plugins) {
    if (loaded.plugin.api === undefined) continue;
    // `get`, not `for`: a plugin nobody tapped needs no hook object.
    const hook = pluginHooks.get(loaded.name);
    if (hook !== undefined) callLoadPhaseTaps(hook, [loaded.plugin.api], loaded.name);
  }
  return {
    hooks,
    tapNames: () => ({
      dispatcher: hooks.dispatcher.taps.map((tap) => tap.name),
      plugin: Object.fromEntries(
        plugins.map((loaded) => [
          loaded.name,
          (pluginHooks.get(loaded.name)?.taps ?? []).map((tap) => tap.name),
        ]),
      ),
    }),
  };
}
