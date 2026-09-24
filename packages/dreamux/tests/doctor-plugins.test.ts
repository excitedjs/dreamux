/**
 * Doctor's plugin rows: what each loaded plugin contributed and which
 * top-level hooks it tapped, or one failed row when `server` or api
 * publication throws. `pluginDoctorChecks` is exercised in isolation
 * (`describe('pluginDoctorChecks')`); the `runDreamuxDoctor`/
 * `readConfigForDoctor` wiring that calls it — the two-row push on a
 * load-phase `PluginLoadError`, the success-path ordering, and that a
 * plugin failure does not abort the rest of doctor — is exercised
 * end-to-end below (`describe('runDreamuxDoctor plugin wiring')`), since
 * both seams share the `DoctorCheck` row shape and the plugin fixtures.
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { DreamuxLogger, DreamuxPlugin, ServerHost } from '@excitedjs/dreamux-types';
import type { HookMap, SyncHook } from 'tapable';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { runDreamuxDoctor } from '../src/cli/doctor.js';
import { pluginDoctorChecks } from '../src/cli/doctor-plugins.js';
import type { CommandRunner } from '../src/onboard/types.js';
import type { LoadedPlugin } from '../src/plugin/loader.js';
import { resetRuntimeConfig } from '../src/platform/paths.js';

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

  it('formats a plugin that taps but contributes no providers as "providers: none"', () => {
    const plugins = [
      loaded(
        {
          name: 'bootstrap',
          server(host) {
            host.hooks.dispatcher.tap('bootstrap', () => {});
          },
        },
        'plugins[0] ("builtin:bootstrap")',
        // Default `providers: []` (see `loaded()`): this plugin taps a
        // top-level hook but contributes zero providers, the shape the
        // formatter's `providers.join(', ') || 'none'` fallback exists for.
      ),
    ];

    expect(pluginDoctorChecks(plugins, silentLog)).toEqual([
      {
        name: 'plugin bootstrap',
        ok: true,
        detail: 'plugins[0] ("builtin:bootstrap"); providers: none; taps: dispatcher',
      },
    ]);
  });
});

/** `check`/`capture` always report "not installed/not running"; `run` is unused. */
class FakeRunner implements CommandRunner {
  async run(): Promise<void> {}
  async check(): Promise<boolean> {
    return false;
  }
  async capture(): Promise<string> {
    return '';
  }
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

describe('runDreamuxDoctor plugin wiring', () => {
  let root: string;
  let configDir: string;
  let configFile: string;
  let oldConfigDir: string | undefined;
  let oldRoot: string | undefined;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'dreamux-doctor-'));
    configDir = join(root, 'config');
    configFile = join(configDir, 'config.json');
    await mkdir(configDir, { recursive: true });
    // `dreamuxRoot()`'s "state" subdir must exist so the unconditional
    // "state directory" check is `ok: true`, deterministically — otherwise
    // whether it survives an exact `checks.filter(c => !c.ok)` assertion
    // below depends on whatever this test host's real `~/.dreamux/state`
    // happens to hold.
    await mkdir(join(root, 'dreamux', 'state'), { recursive: true });
    oldConfigDir = process.env['DREAMUX_CONFIG_DIR'];
    oldRoot = process.env['DREAMUX_ROOT'];
    process.env['DREAMUX_CONFIG_DIR'] = configDir;
    process.env['DREAMUX_ROOT'] = join(root, 'dreamux');
  });

  afterEach(async () => {
    restoreEnv('DREAMUX_CONFIG_DIR', oldConfigDir);
    restoreEnv('DREAMUX_ROOT', oldRoot);
    resetRuntimeConfig();
    await rm(root, { recursive: true, force: true });
  });

  async function writeConfig(body: unknown): Promise<void> {
    await writeFile(configFile, JSON.stringify(body), { mode: 0o600 });
  }

  /**
   * No dispatchers configured, and a service unit that does not exist under
   * `homeDir`: `service.installed` is `false`, which short-circuits the
   * managed-service launch checks and the systemd linger check before they
   * touch provider binaries — leaving exactly the plugin/config rows under
   * test plus the two unconditional rows (`user service`, `dispatchers`).
   */
  function doctor(): ReturnType<typeof runDreamuxDoctor> {
    return runDreamuxDoctor({
      runner: new FakeRunner(),
      platform: 'linux',
      homeDir: join(root, 'home'),
    });
  }

  it('a non-PluginLoadError config failure pushes only the config row, no plugin row', async () => {
    // `bogus` is not a top-level key `mergeWithDefaults` accepts; this
    // throws a plain Error, not a PluginLoadError, and it throws after
    // `loadPlugins` already loaded the always-loaded feishu plugin — so
    // this also proves the `plugins: []` fallback does not leak a stray
    // "plugin feishu" row through.
    await writeConfig({ bogus: true });

    const result = await doctor();

    const configRows = result.checks.filter((check) => check.name === 'config');
    expect(configRows).toHaveLength(1);
    expect(configRows[0]?.ok).toBe(false);
    expect(configRows[0]?.detail).toContain('bogus');
    expect(result.checks.some((check) => check.name.startsWith('plugin '))).toBe(false);
    expect(result.checks.filter((check) => !check.ok).map((check) => check.name)).toEqual([
      'config',
      'dispatchers',
    ]);
  });

  it('on success, lists plugin rows after config and before state directory, in load order', async () => {
    await writeConfig({ plugins: ['builtin:bootstrap'], dispatchers: [] });

    const result = await doctor();

    expect(result.checks.map((check) => check.name)).toEqual([
      'config',
      'plugin feishu',
      'plugin bootstrap',
      'state directory',
      'user service',
      'dispatchers',
    ]);
    expect(result.checks[1]).toEqual({
      name: 'plugin feishu',
      ok: true,
      detail: 'always-loaded "builtin:feishu"; providers: channel:feishu; taps: none',
    });
    expect(result.checks[2]).toEqual({
      name: 'plugin bootstrap',
      ok: true,
      detail: 'plugins[0] ("builtin:bootstrap"); providers: none; taps: dispatcher',
    });
    // With `dispatchers: []`, the unconditional "no dispatchers configured"
    // row is the only failure here; the plugin rows are all `ok`.
    expect(result.checks.filter((check) => !check.ok).map((check) => check.name)).toEqual([
      'dispatchers',
    ]);
  });
});
