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
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { stringifyConfig } from '../src/config/config.js';
import { loadConfig as readConfig } from '../src/config/load.js';
import { startPlugins } from '../src/plugin/host.js';
import {
  loadPlugins,
  PluginLoadError,
  readPluginConfigs,
  readPluginEntries,
} from '../src/plugin/loader.js';
import {
  BUILTIN_CODEX_PROVIDER_REF,
  BUILTIN_FEISHU_PROVIDER_REF,
  ProviderRegistry,
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
  return (host.hooks.plugin as unknown as HookMap<SyncHook<[unknown]>>).for(
    name,
  );
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
    throw new Error(
      'fake agent runtime provider: createRuntime not implemented',
    );
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

type PluginModuleImporter = Record<string, Record<string, unknown>>;
function importer(modules: PluginModuleImporter): PluginModuleImporter {
  return modules;
}
const mockedPackages = new Set<string>();
function installModules(modules: PluginModuleImporter) {
  const all: PluginModuleImporter = {
    '@excitedjs/agent-runtime-codex': {
      createCodexPlugin: () => ({
        name: 'codex',
        contribute(host: ContributeHost) {
          host.agentRuntimeProviders.contribute('codex', fakeRuntimeProvider);
        },
      }),
    },
    '@excitedjs/agent-runtime-claude-code': {
      createClaudeCodePlugin: () => ({
        name: 'claude-code',
        contribute(host: ContributeHost) {
          host.agentRuntimeProviders.contribute(
            'claude-code',
            fakeRuntimeProvider,
          );
        },
      }),
    },
    [FEISHU_PACKAGE]: { default: fakeFeishu() },
    ...modules,
  };
  for (const [name, module] of Object.entries(all)) {
    mockedPackages.add(name);
    vi.doMock(name, () =>
      name === FEISHU_PACKAGE
        ? { ...module, createFeishuPlugin: module['default'] }
        : module,
    );
  }
}
afterEach(() => {
  for (const name of mockedPackages) vi.doUnmock(name);
  mockedPackages.clear();
  vi.unstubAllEnvs();
});
function codexRegistry(): ProviderRegistry {
  return new ProviderRegistry();
}
async function load(
  entries: Parameters<typeof loadPlugins>[0]['entries'],
  modules: PluginModuleImporter,
  registry = new ProviderRegistry(),
) {
  installModules(modules);
  return loadPlugins({ registry, entries, logger: silentLog });
}
async function loadConfig(options: {
  configDir: string;
  providerRegistry: ProviderRegistry;
  pluginModuleImporter: PluginModuleImporter;
}) {
  vi.stubEnv('DREAMUX_ROOT', options.configDir);
  installModules(options.pluginModuleImporter);
  return readConfig({ providerRegistry: options.providerRegistry });
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
        {
          plugins: [
            'builtin:bootstrap',
            { ref: 'npm:@acme/x#make', config: { a: 1 } },
          ],
        },
        'config.json',
      ),
    ).toEqual([
      { ref: 'builtin:bootstrap' },
      { ref: 'npm:@acme/x#make', config: { a: 1 } },
    ]);
  });

  it.each([
    [{ plugins: 'builtin:bootstrap' }, /plugins must be an array/],
    [
      { plugins: [42] },
      /plugins\[0\] must be a plugin ref string or \{ ref, config \}/,
    ],
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
        '@excitedjs/dreamux-plugin-bootstrap': {
          default: () => ({ name: 'bootstrap' }),
        },
        '@acme/x': { make: () => ({ name: 'acme' }), default: 'not a factory' },
      },
    );
    expect(loaded.map((p) => [p.name, p.source])).toEqual([
      ['feishu', 'always-loaded "builtin:feishu"'],
      ['codex', 'always-loaded "builtin:codex"'],
      ['claude-code', 'always-loaded "builtin:claude-code"'],
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
              host.agentRuntimeProviders.contribute(
                'codex',
                fakeRuntimeProvider,
              ),
          }),
        },
      }),
    );
    expect(err.phase).toBe('contribute');
    expect(err.message).toContain(
      'provider "codex" is contributed by plugin "acme" and by plugin "codex"',
    );
  });

  it('rejects a provider name another plugin contributed, naming both plugins', async () => {
    const err = await loadError(
      load([{ ref: 'npm:@acme/a' }], {
        '@acme/a': {
          default: (): DreamuxPlugin => ({
            name: 'acme',
            contribute: (host) =>
              host.channelProviders.contribute('feishu', fakeChannelProvider),
          }),
        },
      }),
    );
    expect(err.message).toContain(
      'provider "feishu" is contributed by plugin "acme" and by plugin "feishu"',
    );
  });

  it.each([
    [
      'an unknown built-in plugin',
      'builtin:nope',
      {},
      'import',
      /unknown built-in plugin/,
    ],
    [
      'a failing import',
      'npm:@acme/missing',
      {},
      'import',
      /could not import package/,
    ],
    [
      'a non-function export',
      'npm:@acme/a',
      { '@acme/a': { default: {} } },
      'factory',
      /plugin factory function/,
    ],
    [
      'a throwing factory',
      'npm:@acme/a',
      {
        '@acme/a': {
          default: () => {
            throw new Error('boom');
          },
        },
      },
      'factory',
      /plugin factory threw: boom/,
    ],
    [
      'a nameless plugin',
      'npm:@acme/a',
      { '@acme/a': { default: () => ({ name: '' }) } },
      'factory',
      /name of 1-64 ASCII/,
    ],
    [
      'a throwing contribute',
      'npm:@acme/a',
      {
        '@acme/a': {
          default: () => ({
            name: 'acme',
            contribute: () => {
              throw new Error('boom');
            },
          }),
        },
      },
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
              host.channelProviders.contribute(
                'Not Valid!',
                fakeChannelProvider,
              ),
          }),
        },
      },
      'contribute',
      /builtin id must be/,
    ],
  ])(
    'fails with a PluginLoadError on %s',
    async (_label, ref, modules, phase, message) => {
      const err = await loadError(load([{ ref }], modules));
      expect(err.phase).toBe(phase);
      expect(err.message).toMatch(message);
    },
  );

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

describe('readPluginConfigs', () => {
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
    expect(loaded.find((p) => p.name === 'acme')?.config).toEqual({
      seen: undefined,
    });
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
    expect((caught as Error).message).toContain(
      'plugins[0].config: size must be a number',
    );
  });
});

describe('startPlugins', () => {
  it('publishes each api after every server ran, so a plugin may tap an api loaded after it', async () => {
    const calls: string[] = [];
    const loaded = await load(
      [{ ref: 'npm:@acme/a' }, { ref: 'npm:@acme/b' }],
      {
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
      },
    );

    const started = startPlugins(loaded, silentLog);

    expect(calls).toEqual(['acme server', 'beta server', 'acme got beta-api']);
    expect(started.tapOwners().plugin).toEqual({
      feishu: [],
      codex: [],
      'claude-code': [],
      acme: [],
      beta: ['acme'],
    });
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
    const loaded = await load(
      [{ ref: 'npm:@acme/a' }, { ref: 'npm:@acme/b' }],
      {
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
      },
    );

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

  it("wraps a throwing server as that plugin's load failure", async () => {
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

  function baseConfig(
    extra: Record<string, unknown> = {},
  ): Record<string, unknown> {
    return {
      ...extra,
      agents: [
        { id: 'flow', provider: BUILTIN_CODEX_PROVIDER_REF, config: {} },
      ],
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
    await writeFile(join(configDir, 'config.json'), JSON.stringify(body), {
      mode: 0o600,
    });
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
              host.agentRuntimeProviders.contribute(
                'acme-runtime',
                fakeRuntimeProvider,
              );
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
      providerRegistry: new ProviderRegistry(),
      pluginModuleImporter,
    });

    expect(calls).toEqual(['factory', 'contribute', 'config.read']);
    expect(config.agents['flow']?.provider).toBe('builtin:acme-runtime');
    expect(plugins.map((p) => [p.name, p.config])).toEqual([
      ['feishu', undefined],
      ['codex', undefined],
      ['claude-code', undefined],
      ['acme', { size: 2 }],
    ]);
  });

  it('round-trips plugins[] through stringifyConfig in both entry forms', async () => {
    const plugins = [
      'builtin:bootstrap',
      { ref: 'npm:@acme/a', config: { size: 2 } },
    ];
    await writeConfig(baseConfig({ plugins }));
    const pluginModuleImporter = importer({
      [FEISHU_PACKAGE]: { default: fakeFeishu() },
      '@excitedjs/dreamux-plugin-bootstrap': {
        default: () => ({ name: 'bootstrap' }),
      },
      '@acme/a': {
        default: (): DreamuxPlugin => ({
          name: 'acme',
          config: { read: (raw) => raw },
        }),
      },
    });

    const { config } = await loadConfig({
      configDir,
      providerRegistry: codexRegistry(),
      pluginModuleImporter,
    });
    const written = JSON.parse(stringifyConfig(config)) as Record<
      string,
      unknown
    >;

    expect(written['plugins']).toEqual(plugins);
    expect(Object.keys(written)[0]).toBe('plugins');
  });

  it('surfaces a config.read failure through the full validated loadConfig pipeline', async () => {
    await writeConfig(
      baseConfig({
        plugins: [{ ref: 'npm:@acme/rejecting', config: { size: 'bad' } }],
      }),
    );
    const error = await loadError(
      loadConfig({
        configDir,
        providerRegistry: codexRegistry(),
        pluginModuleImporter: {
          '@acme/rejecting': {
            default: (): DreamuxPlugin => ({
              name: 'rejecting',
              config: {
                read() {
                  throw new Error('size must be a number');
                },
              },
            }),
          },
        },
      }),
    );
    expect(error.phase).toBe('config');
    expect(error.message).toContain('rejecting');
    expect(error.message).toContain('plugins[0].config: size must be a number');
  });

  it('writes no plugins key when the file has none', async () => {
    await writeConfig(baseConfig());
    const { config } = await loadConfig({
      configDir,
      providerRegistry: codexRegistry(),
      pluginModuleImporter: importer({
        [FEISHU_PACKAGE]: { default: fakeFeishu() },
      }),
    });
    expect(JSON.parse(stringifyConfig(config))).not.toHaveProperty('plugins');
  });

  it('round-trips an explicit empty plugins: [] (key present but empty)', async () => {
    await writeConfig(baseConfig({ plugins: [] }));
    const { config } = await loadConfig({
      configDir,
      providerRegistry: codexRegistry(),
      pluginModuleImporter: importer({
        [FEISHU_PACKAGE]: { default: fakeFeishu() },
      }),
    });
    expect(JSON.parse(stringifyConfig(config))).toHaveProperty('plugins', []);
  });

  it('tolerates an unrelated unknown top-level key when plugins is present', async () => {
    await writeConfig(baseConfig({ plugins: [], nonsense: true }));
    await expect(
      loadConfig({
        configDir,
        providerRegistry: codexRegistry(),
        pluginModuleImporter: importer({
          [FEISHU_PACKAGE]: { default: fakeFeishu() },
        }),
      }),
    ).resolves.toBeDefined();
  });

  it('rejects a builtin: agentRuntime ref no loaded plugin contributes, with the corrected wording', async () => {
    await writeConfig({
      agents: [{ id: 'flow', provider: 'builtin:acme-runtime', config: {} }],
      dispatchers: baseConfig()['dispatchers'],
    });
    await expect(
      loadConfig({
        configDir,
        providerRegistry: new ProviderRegistry(),
        pluginModuleImporter: importer({
          [FEISHU_PACKAGE]: { default: fakeFeishu() },
        }),
      }),
    ).rejects.toThrow(
      /no loaded plugin contributes provider "builtin:acme-runtime" and Dreamux does not ship it/,
    );
  });
});
