/**
 * Doctor's plugin rows: what each loaded plugin contributed and which
 * top-level hooks it tapped, or one failed row when `server` or api
 * publication throws.
 */
import type { DreamuxLogger, DreamuxPlugin, ServerHost } from '@excitedjs/dreamux-types';
import type { HookMap, SyncHook } from 'tapable';
import { describe, expect, it } from 'vitest';

import { pluginDoctorChecks } from '../src/cli/doctor-plugins.js';
import type { LoadedPlugin } from '../src/plugin/loader.js';

const silentLog = {
  error: () => {},
  warn: () => {},
  info: () => {},
  debug: () => {},
  trace: () => {},
  child: () => silentLog,
} as unknown as DreamuxLogger;

/**
 * `for(name)` for an api no package in this test augments
 * `DreamuxPluginApis` with; the typed map only accepts declared names.
 */
function forPlugin(host: ServerHost, name: string): SyncHook<[unknown]> {
  return (host.hooks.plugin as unknown as HookMap<SyncHook<[unknown]>>).for(name);
}

function loaded(
  plugin: DreamuxPlugin,
  source: string,
  providers: LoadedPlugin['providers'] = [],
): LoadedPlugin {
  return { name: plugin.name, source, plugin, entry: null, config: undefined, providers };
}

describe('pluginDoctorChecks', () => {
  it('lists each plugin with its source, providers, and top-level taps', () => {
    const plugins = [
      loaded({ name: 'feishu', api: {} }, 'always-loaded "builtin:feishu"', [
        { kind: 'channel', name: 'feishu' },
      ]),
      loaded(
        {
          name: 'acme',
          server(host) {
            host.hooks.dispatcher.tap('profile', () => {});
            forPlugin(host, 'feishu').tap('register tools', () => {});
          },
        },
        'plugins[0] ("npm:@acme/a")',
        [{ kind: 'agentRuntime', name: 'acme-runtime' }],
      ),
    ];

    expect(pluginDoctorChecks(plugins, silentLog)).toEqual([
      {
        name: 'plugin feishu',
        ok: true,
        detail: 'always-loaded "builtin:feishu"; providers: channel:feishu; taps: none',
      },
      {
        name: 'plugin acme',
        ok: true,
        detail:
          'plugins[0] ("npm:@acme/a"); providers: agentRuntime:acme-runtime; ' +
          'taps: dispatcher, plugin:feishu',
      },
    ]);
  });

  it('reports a failing api tap as one failed row for the tapping plugin', () => {
    const plugins = [
      loaded({ name: 'feishu', api: {} }, 'always-loaded "builtin:feishu"'),
      loaded(
        {
          name: 'acme',
          server(host) {
            forPlugin(host, 'feishu').tap('register tools', () => {
              throw new Error('tool name taken');
            });
          },
        },
        'plugins[0] ("npm:@acme/a")',
      ),
    ];

    const checks = pluginDoctorChecks(plugins, silentLog);

    expect(checks).toHaveLength(1);
    expect(checks[0]).toMatchObject({ name: 'plugin acme', ok: false });
    expect(checks[0]?.detail).toContain('tool name taken');
  });
});
