/**
 * Doctor's plugin rows: one per loaded plugin (source, contributed providers,
 * the top-level hooks it tapped), or one failed row when a plugin's `server`
 * or api publication throws.
 *
 * Doctor runs `server` but never constructs a Server or Dispatcher, so the
 * Dispatcher / Team hooks never fire and only top-level taps are listed. That
 * is safe while a daemon is live because `contribute` and `server` do no IO.
 */

import type { DreamuxLogger } from '@excitedjs/dreamux-types';

import { startPlugins, type StartedPlugins } from '../plugin/host.js';
import { type LoadedPlugin, PluginLoadError } from '../plugin/loader.js';
import type { DoctorCheck } from './doctor.js';

export function pluginDoctorChecks(
  plugins: readonly LoadedPlugin[],
  logger: DreamuxLogger,
): DoctorCheck[] {
  let started: StartedPlugins;
  try {
    started = startPlugins(plugins, logger);
  } catch (err) {
    if (!(err instanceof PluginLoadError)) throw err;
    return [pluginLoadFailureCheck(err)];
  }
  return formatPluginChecks(plugins, started.tapOwners());
}

export function pluginLoadFailureCheck(err: PluginLoadError): DoctorCheck {
  return { name: `plugin ${err.plugin}`, ok: false, detail: err.message };
}

export function formatPluginChecks(
  plugins: readonly LoadedPlugin[],
  owners: ReturnType<StartedPlugins['tapOwners']>,
): DoctorCheck[] {
  return plugins.map((loaded) => {
    const providers = loaded.providers.map(
      (provider) => `${provider.kind}:${provider.name}`,
    );
    const taps = [
      ...(owners.dispatcher.includes(loaded.name) ? ['dispatcher'] : []),
      ...Object.entries(owners.plugin)
        .filter(([, tapOwners]) => tapOwners.includes(loaded.name))
        .map(([target]) => `plugin:${target}`),
    ];
    return {
      name: `plugin ${loaded.name}`,
      ok: true,
      detail:
        `${loaded.source}; providers: ${providers.join(', ') || 'none'}; ` +
        `taps: ${taps.join(', ') || 'none'}`,
    };
  });
}
