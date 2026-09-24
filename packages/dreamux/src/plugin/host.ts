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
import { isolatedTaps, loadPhaseTaps, runAsPlugin, tapOwners } from './hooks.js';
import { isThenable, type LoadedPlugin, PluginLoadError } from './loader.js';

export type ServerHooks = ServerHost['hooks'];

/** The public hooks plus core's untyped handle on the same HookMap instance. */
interface HostHooks {
  readonly hooks: ServerHooks;
  readonly pluginHooks: HookMap<SyncHook<[unknown]>>;
}

function buildHostHooks(logger: DreamuxLogger): HostHooks {
  const pluginHooks = new HookMap((name: string) =>
    loadPhaseTaps(new SyncHook<[unknown]>(['api'], `plugin:${name}`), name),
  );
  const hooks: ServerHooks = Object.freeze({
    dispatcher: isolatedTaps(
      new SyncHook<[Dispatcher]>(['dispatcher'], 'dispatcher'),
      logger,
    ),
    // tapable exports no TypedHookMap value; the typed view over the same
    // HookMap instance is declared once, here.
    plugin: pluginHooks as unknown as ServerHooks['plugin'],
  });
  return { hooks, pluginHooks };
}

/** Empty host hooks. Tests and embedded Servers without plugins use this. */
export function createServerHooks(logger: DreamuxLogger): ServerHooks {
  return buildHostHooks(logger).hooks;
}

/** A plugin name, or `null` for a tap registered outside any plugin. */
type TapOwner = string | null;

export interface StartedPlugins {
  readonly hooks: ServerHooks;
  /** Owners of the taps on the top-level hooks, for doctor. */
  tapOwners(): { dispatcher: TapOwner[]; plugin: Record<string, TapOwner[]> };
}

/**
 * Run every plugin's `server`, then publish each plugin's `api` to the taps on
 * `hooks.plugin.for(name)`.
 */
export function startPlugins(
  plugins: readonly LoadedPlugin[],
  logger: DreamuxLogger,
): StartedPlugins {
  const { hooks, pluginHooks } = buildHostHooks(logger);
  for (const loaded of plugins) {
    if (loaded.plugin.server === undefined) continue;
    const server = loaded.plugin.server.bind(loaded.plugin);
    let result: unknown;
    try {
      result = runAsPlugin(loaded.name, () =>
        server({
          config: loaded.config,
          logger: logger.child?.({ plugin: loaded.name }) ?? logger,
          hooks,
        }),
      );
    } catch (err) {
      // An earlier plugin's `server` may have added an interceptor on a
      // `hooks.plugin.for(name)` hook this plugin also taps. tapable runs
      // that interceptor's `register` method synchronously inside this
      // plugin's own `.tap()` call on the same hook, and the guard around it
      // (`guardPluginInterceptors`) already turns a throw there into a
      // PluginLoadError attributed to the earlier plugin. Rethrow it
      // unwrapped instead of re-attributing the failure to `loaded.name`.
      if (err instanceof PluginLoadError) throw err;
      throw new PluginLoadError(loaded.name, 'server', errorMessage(err), {
        cause: err,
      });
    }
    // `server` is typed `=> void`, but TypeScript accepts an `async`
    // implementation too: nothing awaits it, so a tap registered after its
    // first `await` would silently never run, and the api publication loop
    // below would race an in-flight `server`. Its promise would otherwise go
    // unwatched past this load-phase call, so a later rejection would crash
    // the process with no handler; attach one before throwing the load error
    // that already fails the plugin by name.
    if (isThenable(result)) {
      Promise.resolve(result).catch(() => {});
      throw new PluginLoadError(
        loaded.name,
        'server',
        'must be synchronous; register and tap only',
      );
    }
  }
  for (const loaded of plugins) {
    if (loaded.plugin.api === undefined) continue;
    // `get`, not `for`: a plugin nobody tapped needs no hook object.
    const hook = pluginHooks.get(loaded.name);
    if (hook === undefined) continue;
    // `loadPhaseTaps` already turns a throwing tap or a throwing
    // plugin-added interceptor into a `PluginLoadError` attributed to its own
    // owner, so every throw out of `call` here already is one.
    hook.call(loaded.plugin.api);
  }
  return {
    hooks,
    tapOwners: () => ({
      dispatcher: [...tapOwners(hooks.dispatcher)],
      plugin: Object.fromEntries(
        plugins.map((loaded) => {
          const hook = pluginHooks.get(loaded.name);
          return [loaded.name, hook === undefined ? [] : [...tapOwners(hook)]];
        }),
      ),
    }),
  };
}
