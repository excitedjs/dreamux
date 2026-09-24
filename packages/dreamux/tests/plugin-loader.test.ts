/**
 * Plugin loading and the host: `plugins[]` parsing, the load order, the
 * same-name rules, and api publication after every `server`.
 *
 * Plugin modules come from a fake importer keyed by package name, so no real
 * plugin package is imported; the always-loaded Feishu plugin is answered by a
 * fake whose provider is the channel the configs below address.
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type {
  AgentRuntimeProvider,
  ChannelProvider,
  ContributeHost,
  DreamuxLogger,
  DreamuxPlugin,
  ServerHost,
} from '@excitedjs/dreamux-types';
import type { HookMap, SyncHook } from 'tapable';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { loadConfig, stringifyConfig } from '../src/config/config.js';
import { startPlugins } from '../src/plugin/host.js';
import {
  loadPlugins,
  PluginLoadError,
  readPluginConfigs,
  readPluginEntries,
  type PluginModuleImporter,
} from '../src/plugin/loader.js';
import {
  BUILTIN_CODEX_PROVIDER_REF,
  BUILTIN_FEISHU_PROVIDER_REF,
  BUILTIN_PROVIDER_PACKAGES,
  createBuiltinProviderRegistry,
  resolveBuiltinProviderPackage,
  UnknownBuiltinProviderPackageError,
  type ProviderRegistry,
} from '../src/registry/index.js';

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

const FEISHU_PACKAGE = '@excitedjs/feishu-channel';

const fakeChannelProvider = {
  createSession: () => {
    throw new Error('fake channel provider: createSession not implemented');
  },
} as unknown as ChannelProvider<unknown>;

const fakeRuntimeProvider = {
  getCapabilities: () => ({ verbs: [], agent_runtimes: [] }),
  readRecentActivity: async () => [],
  createRuntime: () => {
    throw new Error('fake agent runtime provider: createRuntime not implemented');
  },
} as unknown as AgentRuntimeProvider<unknown>;

function fakeFeishu(extra: Partial<DreamuxPlugin> = {}): () => DreamuxPlugin {
  return () => ({
    name: 'feishu',
    contribute(host) {
      host.channelProviders.contribute('feishu', fakeChannelProvider);
    },
    ...extra,
  });
}

/** Resolve each package name to a module whose default export is `factory`. */
function importer(
  modules: Record<string, Record<string, unknown>>,
): PluginModuleImporter {
  return async (packageName) => {
    const module = modules[packageName];
    if (module === undefined) throw new Error(`no fake module for ${packageName}`);
    return module;
  };
}

function codexRegistry(): ProviderRegistry {
  const registry = createBuiltinProviderRegistry();
  registry.registerImplementation('codex', fakeRuntimeProvider);
  return registry;
}

async function load(
  entries: Parameters<typeof loadPlugins>[0]['entries'],
  modules: Record<string, Record<string, unknown>>,
  registry: ProviderRegistry = createBuiltinProviderRegistry(),
) {
  return loadPlugins({
    registry,
    entries,
    logger: silentLog,
    importModule: importer({ [FEISHU_PACKAGE]: { default: fakeFeishu() }, ...modules }),
  });
}

async function loadError(promise: Promise<unknown>): Promise<PluginLoadError> {
  try {
    await promise;
  } catch (err) {
    expect(err).toBeInstanceOf(PluginLoadError);
    return err as PluginLoadError;
  }
  throw new Error('expected a PluginLoadError');
}

describe('readPluginEntries', () => {
  it('reads ref strings and { ref, config } objects, and absence as undefined', () => {
    expect(readPluginEntries({}, 'config.json')).toBeUndefined();
    expect(
      readPluginEntries(
        { plugins: ['builtin:bootstrap', { ref: 'npm:@acme/x#make', config: { a: 1 } }] },
        'config.json',
      ),
    ).toEqual([
      { ref: 'builtin:bootstrap' },
      { ref: 'npm:@acme/x#make', config: { a: 1 } },
    ]);
  });

  it.each([
    [{ plugins: 'builtin:bootstrap' }, /plugins must be an array/],
    [{ plugins: [42] }, /plugins\[0\] must be a plugin ref string or \{ ref, config \}/],
    [{ plugins: [{ ref: 'builtin:bootstrap', extra: true }] }, /plugins\[0\]\.extra/],
    [{ plugins: [{ config: {} }] }, /plugins\[0\]\.ref/],
    [{ plugins: ['file:./local'] }, /plugins\[0\]\.ref/],
  ])('rejects a malformed plugins value %j', (raw, message) => {
    expect(() => readPluginEntries(raw, 'config.json')).toThrow(message);
  });
});

describe('loadPlugins', () => {
  it('loads the always-loaded Feishu plugin first, then entries in file order', async () => {
    const loaded = await load(
      [{ ref: 'builtin:bootstrap' }, { ref: 'npm:@acme/x#make' }],
      {
        '@excitedjs/dreamux-plugin-bootstrap': { default: () => ({ name: 'bootstrap' }) },
        '@acme/x': { make: () => ({ name: 'acme' }), default: 'not a factory' },
      },
    );
    expect(loaded.map((p) => [p.name, p.source])).toEqual([
      ['feishu', 'always-loaded "builtin:feishu"'],
      ['bootstrap', 'plugins[0] ("builtin:bootstrap")'],
      ['acme', 'plugins[1] ("npm:@acme/x#make")'],
    ]);
    expect(loaded[0]?.providers).toEqual([{ kind: 'channel', name: 'feishu' }]);
  });

  it('rejects a duplicate plugin name, naming both sources', async () => {
    const err = await loadError(
      load([{ ref: 'npm:@acme/a' }, { ref: 'npm:@acme/b' }], {
        '@acme/a': { default: () => ({ name: 'acme' }) },
        '@acme/b': { default: () => ({ name: 'acme' }) },
      }),
    );
    expect(err.message).toContain(
      'plugin name "acme" is declared by both plugins[0] ("npm:@acme/a") and plugins[1] ("npm:@acme/b")',
    );
  });

  it('rejects a plugins[] entry whose name clashes with the always-loaded Feishu plugin, naming the always-loaded source', async () => {
    const err = await loadError(
      load([{ ref: 'npm:@acme/a' }], {
        '@acme/a': { default: (): DreamuxPlugin => ({ name: 'feishu' }) },
      }),
    );
    expect(err.message).toContain(
      'plugin name "feishu" is declared by both always-loaded "builtin:feishu" and plugins[0] ("npm:@acme/a")',
    );
  });

  it('rejects a provider name core already ships, naming both sources', async () => {
    const err = await loadError(
      load([{ ref: 'npm:@acme/a' }], {
        '@acme/a': {
          default: (): DreamuxPlugin => ({
            name: 'acme',
            contribute: (host) =>
              host.agentRuntimeProviders.contribute('codex', fakeRuntimeProvider),
          }),
        },
      }),
    );
    expect(err.phase).toBe('contribute');
    expect(err.message).toContain(
      'provider "codex" is contributed by plugin "acme" and by Dreamux core',
    );
  });

  it('rejects a provider name another plugin contributed, naming both plugins', async () => {
    const err = await loadError(
      load([{ ref: 'npm:@acme/a' }], {
        '@acme/a': {
          default: (): DreamuxPlugin => ({
            name: 'acme',
            contribute: (host) => host.channelProviders.contribute('feishu', fakeChannelProvider),
          }),
        },
      }),
    );
    expect(err.message).toContain(
      'provider "feishu" is contributed by plugin "acme" and by plugin "feishu"',
    );
  });

  it.each([
    ['an unknown built-in plugin', 'builtin:nope', {}, 'import', /unknown built-in plugin/],
    ['a failing import', 'npm:@acme/missing', {}, 'import', /could not import package/],
    ['a non-function export', 'npm:@acme/a', { '@acme/a': { default: {} } }, 'factory', /plugin factory function/],
    [
      'a throwing factory',
      'npm:@acme/a',
      { '@acme/a': { default: () => { throw new Error('boom'); } } },
      'factory',
      /plugin factory threw: boom/,
    ],
    [
      'a nameless plugin',
      'npm:@acme/a',
      { '@acme/a': { default: () => ({ name: '' }) } },
      'factory',
      /non-empty string name/,
    ],
    [
      'a throwing contribute',
      'npm:@acme/a',
      { '@acme/a': { default: () => ({ name: 'acme', contribute: () => { throw new Error('boom'); } }) } },
      'contribute',
      /boom/,
    ],
    [
      'a contribute that rejects an invalid provider-name grammar',
      'npm:@acme/a',
      {
        '@acme/a': {
          default: (): DreamuxPlugin => ({
            name: 'acme',
            contribute: (host: ContributeHost) =>
              host.channelProviders.contribute('Not Valid!', fakeChannelProvider),
          }),
        },
      },
      'contribute',
      /builtin id must be/,
    ],
  ])('fails with a PluginLoadError on %s', async (_label, ref, modules, phase, message) => {
    const err = await loadError(load([{ ref }], modules));
    expect(err.phase).toBe(phase);
    expect(err.message).toMatch(message);
  });

  it.each([
    ['an unknown built-in plugin', 'builtin:nope'],
    ['a failing import', 'npm:@acme/missing'],
  ])(
    '.plugin is the ref, not yet a known name, for %s',
    async (_label, ref) => {
      const err = await loadError(load([{ ref }], {}));
      expect(err.plugin).toBe(ref);
    },
  );
});

describe('resolveBuiltinProviderPackage', () => {
  it('resolves a known built-in id to its shipped package', () => {
    expect(resolveBuiltinProviderPackage('codex')).toBe(
      BUILTIN_PROVIDER_PACKAGES['codex'],
    );
  });

  it('throws UnknownBuiltinProviderPackageError, naming the id, for an id no plugin contributes', () => {
    expect(() => resolveBuiltinProviderPackage('nope')).toThrow(
      UnknownBuiltinProviderPackageError,
    );
    try {
      resolveBuiltinProviderPackage('nope');
      throw new Error('expected resolveBuiltinProviderPackage to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(UnknownBuiltinProviderPackageError);
      expect((err as UnknownBuiltinProviderPackageError).id).toBe('nope');
      expect((err as Error).message).toMatch(
        /no loaded plugin contributes provider "builtin:nope" and Dreamux does not ship it/,
      );
    }
  });
});

describe('readPluginConfigs', () => {
  it('gives each plugin its own entry config and rejects config for a plugin without a reader', async () => {
    const loaded = await load(
      [{ ref: 'npm:@acme/a', config: { size: 2 } }, { ref: 'npm:@acme/b' }],
      {
        '@acme/a': {
          default: (): DreamuxPlugin => ({
            name: 'acme',
            config: { read: (raw) => ({ parsed: raw }) },
          }),
        },
        '@acme/b': { default: () => ({ name: 'beta' }) },
      },
    );
    readPluginConfigs(loaded, 'config.json');
    expect(loaded.map((p) => p.config)).toEqual([undefined, { parsed: { size: 2 } }, undefined]);

    const withStrayConfig = await load([{ ref: 'npm:@acme/b', config: {} }], {
      '@acme/b': { default: () => ({ name: 'beta' }) },
    });
    expect(() => readPluginConfigs(withStrayConfig, 'config.json')).toThrow(
      /plugin "beta" takes no config \(config\.json: plugins\[0\]\.config\)/,
    );
  });

  it('calls config.read with undefined when the entry omits a config block', async () => {
    const loaded = await load([{ ref: 'npm:@acme/a' }], {
      '@acme/a': {
        default: (): DreamuxPlugin => ({
          name: 'acme',
          config: { read: (raw) => ({ seen: raw }) },
        }),
      },
    });
    readPluginConfigs(loaded, 'config.json');
    expect(loaded.find((p) => p.name === 'acme')?.config).toEqual({ seen: undefined });
  });

  it('attributes a throwing config.read to the plugin and its entry', async () => {
    const loaded = await load([{ ref: 'npm:@acme/a', config: 1 }], {
      '@acme/a': {
        default: (): DreamuxPlugin => ({
          name: 'acme',
          config: {
            read: () => {
              throw new Error('size must be a number');
            },
          },
        }),
      },
    });
    let caught: unknown;
    try {
      readPluginConfigs(loaded, 'config.json');
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(PluginLoadError);
    expect((caught as PluginLoadError).phase).toBe('config');
    expect((caught as Error).message).toContain('plugins[0].config: size must be a number');
  });
});

describe('startPlugins', () => {
  it('publishes each api after every server ran, so a plugin may tap an api loaded after it', async () => {
    const calls: string[] = [];
    const loaded = await load([{ ref: 'npm:@acme/a' }, { ref: 'npm:@acme/b' }], {
      '@acme/a': {
        default: (): DreamuxPlugin => ({
          name: 'acme',
          server(host) {
            calls.push('acme server');
            forPlugin(host, 'beta').tap('read beta', (api: unknown) => {
              calls.push(`acme got ${String(api)}`);
            });
          },
        }),
      },
      '@acme/b': {
        default: (): DreamuxPlugin => ({
          name: 'beta',
          api: 'beta-api',
          server() {
            calls.push('beta server');
          },
        }),
      },
    });

    const started = startPlugins(loaded, silentLog);

    expect(calls).toEqual(['acme server', 'beta server', 'acme got beta-api']);
    expect(started.tapOwners().plugin).toEqual({ feishu: [], acme: [], beta: ['acme'] });
  });

  it("passes a plugin's own config and a logger bound with plugin: <name> to its server", async () => {
    let seenHost: ServerHost | undefined;
    const loaded = await load([{ ref: 'npm:@acme/a', config: { size: 2 } }], {
      '@acme/a': {
        default: (): DreamuxPlugin => ({
          name: 'acme',
          config: { read: (raw) => ({ parsed: raw }) },
          server(host) {
            seenHost = host;
          },
        }),
      },
    });
    readPluginConfigs(loaded, 'config.json');

    const childLog = { ...silentLog };
    const childCalls: Record<string, unknown>[] = [];
    const log = {
      ...silentLog,
      child: (bindings: Record<string, unknown>) => {
        childCalls.push(bindings);
        return childLog;
      },
    } as unknown as DreamuxLogger;

    startPlugins(loaded, log);

    expect(seenHost?.config).toEqual({ parsed: { size: 2 } });
    expect(seenHost?.logger).toBe(childLog);
    expect(childCalls).toEqual([{ plugin: 'acme' }]);
  });

  it('publishes an api nobody taps without throwing, and records no owners for it', async () => {
    const loaded = await load([{ ref: 'npm:@acme/a' }], {
      '@acme/a': {
        default: (): DreamuxPlugin => ({ name: 'acme', api: 'acme-api' }),
      },
    });

    const started = startPlugins(loaded, silentLog);

    expect(started.tapOwners().plugin['acme']).toEqual([]);
  });

  it('fails startPlugins when a consumer tap on hooks.plugin.for(name) throws, attributed to the tapping plugin', async () => {
    const loaded = await load([{ ref: 'npm:@acme/a' }, { ref: 'npm:@acme/b' }], {
      '@acme/a': {
        default: (): DreamuxPlugin => ({
          name: 'acme',
          server(host) {
            forPlugin(host, 'beta').tap('read beta', () => {
              throw new Error('boom');
            });
          },
        }),
      },
      '@acme/b': {
        default: (): DreamuxPlugin => ({ name: 'beta', api: 'beta-api' }),
      },
    });

    let caught: unknown;
    try {
      startPlugins(loaded, silentLog);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(PluginLoadError);
    expect((caught as PluginLoadError).phase).toBe('api');
    expect((caught as PluginLoadError).plugin).toBe('acme');
  });

  it('attributes a free-form tap name to the plugin whose server registered it', async () => {
    const loaded = await load([{ ref: 'npm:@acme/a' }], {
      '@acme/a': {
        default: (): DreamuxPlugin => ({
          name: 'acme',
          server(host) {
            host.hooks.dispatcher.tap('acme-profile', () => {});
          },
        }),
      },
    });

    const started = startPlugins(loaded, silentLog);

    expect(started.tapOwners().dispatcher).toEqual(['acme']);
  });

  it('wraps a throwing server as that plugin\'s load failure', async () => {
    const loaded = await load([{ ref: 'npm:@acme/a' }], {
      '@acme/a': {
        default: (): DreamuxPlugin => ({
          name: 'acme',
          server() {
            throw new Error('boom');
          },
        }),
      },
    });
    expect(() => startPlugins(loaded, silentLog)).toThrow(
      'plugin "acme" failed during server: boom',
    );
  });
});

describe('plugins[] through loadConfig', () => {
  let configDir: string;

  beforeEach(async () => {
    configDir = await mkdtemp(join(tmpdir(), 'dreamux-plugin-config-'));
  });

  afterEach(async () => {
    await rm(configDir, { recursive: true, force: true });
  });

  function baseConfig(extra: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      ...extra,
      agents: [{ id: 'flow', provider: BUILTIN_CODEX_PROVIDER_REF, config: {} }],
      dispatchers: [
        {
          id: 'flow',
          cwd: '/srv/flow',
          agentRuntime: 'flow',
          channels: [
            {
              id: 'primary',
              provider: BUILTIN_FEISHU_PROVIDER_REF,
              config: { app_id: 'app-flow', app_secret: 'secret-flow' },
            },
          ],
        },
      ],
    };
  }

  async function writeConfig(body: unknown): Promise<void> {
    await writeFile(join(configDir, 'config.json'), JSON.stringify(body), { mode: 0o600 });
  }

  it('runs import, contribute, provider validation, then config.read, and a contributed provider resolves as builtin:<name>', async () => {
    const calls: string[] = [];
    await writeConfig({
      plugins: [{ ref: 'npm:@acme/a', config: { size: 2 } }],
      agents: [{ id: 'flow', provider: 'builtin:acme-runtime', config: {} }],
      dispatchers: baseConfig()['dispatchers'],
    });
    const pluginModuleImporter = importer({
      [FEISHU_PACKAGE]: { default: fakeFeishu() },
      '@acme/a': {
        default: (): DreamuxPlugin => {
          calls.push('factory');
          return {
            name: 'acme',
            contribute(host) {
              calls.push('contribute');
              host.agentRuntimeProviders.contribute('acme-runtime', fakeRuntimeProvider);
            },
            config: {
              read(raw) {
                calls.push('config.read');
                return raw;
              },
            },
          };
        },
      },
    });

    const { config, plugins } = await loadConfig({
      configDir,
      providerRegistry: createBuiltinProviderRegistry(),
      pluginModuleImporter,
    });

    expect(calls).toEqual(['factory', 'contribute', 'config.read']);
    expect(config.agents['flow']?.provider).toBe('builtin:acme-runtime');
    expect(plugins.map((p) => [p.name, p.config])).toEqual([
      ['feishu', undefined],
      ['acme', { size: 2 }],
    ]);
  });

  it('round-trips plugins[] through stringifyConfig in both entry forms', async () => {
    const plugins = ['builtin:bootstrap', { ref: 'npm:@acme/a', config: { size: 2 } }];
    await writeConfig(baseConfig({ plugins }));
    const pluginModuleImporter = importer({
      [FEISHU_PACKAGE]: { default: fakeFeishu() },
      '@excitedjs/dreamux-plugin-bootstrap': { default: () => ({ name: 'bootstrap' }) },
      '@acme/a': {
        default: (): DreamuxPlugin => ({ name: 'acme', config: { read: (raw) => raw } }),
      },
    });

    const { config } = await loadConfig({
      configDir,
      providerRegistry: codexRegistry(),
      pluginModuleImporter,
    });
    const written = JSON.parse(stringifyConfig(config)) as Record<string, unknown>;

    expect(written['plugins']).toEqual(plugins);
    expect(Object.keys(written)[0]).toBe('plugins');
  });

  it('writes no plugins key when the file has none', async () => {
    await writeConfig(baseConfig());
    const { config } = await loadConfig({
      configDir,
      providerRegistry: codexRegistry(),
      pluginModuleImporter: importer({ [FEISHU_PACKAGE]: { default: fakeFeishu() } }),
    });
    expect(JSON.parse(stringifyConfig(config))).not.toHaveProperty('plugins');
  });

  it('round-trips an explicit empty plugins: [] (key present but empty)', async () => {
    await writeConfig(baseConfig({ plugins: [] }));
    const { config } = await loadConfig({
      configDir,
      providerRegistry: codexRegistry(),
      pluginModuleImporter: importer({ [FEISHU_PACKAGE]: { default: fakeFeishu() } }),
    });
    expect(JSON.parse(stringifyConfig(config))).toHaveProperty('plugins', []);
  });

  it('rejects an unrelated unknown top-level key even when plugins is present', async () => {
    await writeConfig(baseConfig({ plugins: [], nonsense: true }));
    await expect(
      loadConfig({
        configDir,
        providerRegistry: codexRegistry(),
        pluginModuleImporter: importer({ [FEISHU_PACKAGE]: { default: fakeFeishu() } }),
      }),
    ).rejects.toThrow(/nonsense/);
  });

  it('rejects a builtin: agentRuntime ref no loaded plugin contributes, with the corrected wording', async () => {
    await writeConfig({
      agents: [{ id: 'flow', provider: 'builtin:acme-runtime', config: {} }],
      dispatchers: baseConfig()['dispatchers'],
    });
    await expect(
      loadConfig({
        configDir,
        providerRegistry: createBuiltinProviderRegistry(),
        pluginModuleImporter: importer({ [FEISHU_PACKAGE]: { default: fakeFeishu() } }),
      }),
    ).rejects.toThrow(
      /no loaded plugin contributes provider "builtin:acme-runtime" and Dreamux does not ship it/,
    );
  });

  it('surfaces a readPluginConfigs failure through the full loadConfig pipeline, after providers and dispatchers validate', async () => {
    await writeConfig({
      ...baseConfig(),
      plugins: [{ ref: 'npm:@acme/b', config: {} }],
    });
    const pluginModuleImporter = importer({
      [FEISHU_PACKAGE]: { default: fakeFeishu() },
      '@acme/b': { default: (): DreamuxPlugin => ({ name: 'beta' }) },
    });

    await expect(
      loadConfig({ configDir, providerRegistry: codexRegistry(), pluginModuleImporter }),
    ).rejects.toThrow(/plugin "beta" takes no config \(.*plugins\[0\]\.config\)/);
  });
});
