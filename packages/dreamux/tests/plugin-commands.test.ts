/**
 * `dreamux plugin add | remove | list | run`, and the lookup they share with
 * the daemon: an `npm:` ref's package is found in the plugin directory.
 *
 * Plugin packages are real files written under a temporary Dreamux root's
 * `plugins/node_modules/`, so the real lookup and the real import run. `npm`
 * is a fake runner: on `install` it writes the package, as npm would.
 */
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { loadChannelProviders } from '../src/channel/external-channel-provider.js';
import { forwardPluginRun } from '../src/cli/commands/plugin.js';
import { PluginLoadError, loadPlugins } from '../src/plugin/loader.js';
import { addPlugin, listPlugins, removePlugin } from '../src/plugin/manage.js';
import { runPluginCommand } from '../src/plugin/run.js';
import type { CommandRunner } from '../src/platform/command-runner.js';
import { pluginRoot } from '../src/platform/paths.js';
import { ProviderRegistry } from '../src/registry/registry.js';
import { writeNpmPackage } from './helpers/npm-packages.js';

const CHANNEL = '@acme/chan';
const CHANNEL_SOURCE = `export default () => ({
  name: 'acme',
  contribute(host) {
    host.channelProviders.contribute('acme', { createSession() {} });
  },
});`;
const AGENT = '@acme/runtime';
const AGENT_SOURCE = `export default () => ({
  name: 'acme-runtime',
  contribute(host) {
    host.agentRuntimeProviders.contribute('acme', { createRuntime() {} });
  },
});`;
const NOT_A_PLUGIN = '@acme/not-a-plugin';
const CLI = '@acme/cli';

/** What `npm install <name>` leaves in the plugin directory. */
const INSTALLED: Record<string, string> = {
  [CHANNEL]: CHANNEL_SOURCE,
  [AGENT]: AGENT_SOURCE,
  [NOT_A_PLUGIN]: 'export default () => 42;',
};

const silentLog = {
  error: () => {},
  warn: () => {},
  info: () => {},
  debug: () => {},
  trace: () => {},
  child: () => silentLog,
} as unknown as Parameters<typeof loadPlugins>[0]['logger'];

let root: string;
let configFile: string;
let npm: FakeNpm;

/** Stands in for `npm`: records each call and what the config held then. */
class FakeNpm implements CommandRunner {
  readonly calls: { args: string[]; config: string }[] = [];
  fail = false;
  constructor(private readonly root: string) {}
  async run(command: string, args: string[]): Promise<void> {
    expect(command).toBe('npm');
    this.calls.push({ args, config: await readConfig() });
    if (this.fail) throw new Error('npm failed');
    if (args[0] === 'install') {
      const source = INSTALLED[args[1]!];
      if (source === undefined) throw new Error(`no package ${args[1]}`);
      await writeNpmPackage(this.root, args[1]!, source);
    }
  }
  async check(): Promise<boolean> {
    return true;
  }
  async capture(): Promise<string> {
    return '';
  }
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'dreamux-plugins-'));
  vi.stubEnv('DREAMUX_ROOT', root);
  configFile = join(root, 'config.json');
  npm = new FakeNpm(root);
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});

async function writeConfig(config: Record<string, unknown>): Promise<void> {
  await writeFile(configFile, `${JSON.stringify(config, null, 2)}\n`, {
    mode: 0o600,
  });
}

async function readConfig(): Promise<string> {
  return readFile(configFile, 'utf8');
}

async function readConfigObject(): Promise<Record<string, unknown>> {
  return JSON.parse(await readConfig()) as Record<string, unknown>;
}

const NO_USE = { agents: [], dispatchers: [] };

const CHANNEL_IN_USE = {
  agents: [],
  dispatchers: [
    {
      id: 'personal',
      cwd: '~/work',
      channels: [{ id: 'weixin', provider: 'builtin:acme', config: {} }],
    },
  ],
};

const AGENT_IN_USE = {
  agents: [{ id: 'main', provider: 'builtin:acme', config: {} }],
  dispatchers: [],
};

describe('the plugin directory lookup', () => {
  it('imports an npm plugin from the plugin directory', async () => {
    await writeNpmPackage(root, CHANNEL, CHANNEL_SOURCE);
    const registry = new ProviderRegistry();
    const loaded = await loadPlugins({
      registry,
      entries: [{ ref: `npm:${CHANNEL}` }],
      logger: silentLog,
    });
    // The always-loaded built-ins come first; the entry is what was asked for.
    expect(
      loaded
        .filter((plugin) => plugin.entry !== null)
        .map((plugin) => [plugin.name, plugin.providers]),
    ).toEqual([['acme', [{ kind: 'channel', name: 'acme' }]]]);
    expect(registry.hasRef('builtin:acme')).toBe(true);
  });

  it('imports an npm channel provider from the plugin directory', async () => {
    // A provider package's default export is a provider factory.
    await writeNpmPackage(
      root,
      CHANNEL,
      'export default () => ({ createSession() {} });',
    );
    const registry = new ProviderRegistry();
    await loadChannelProviders({ registry, refs: [`npm:${CHANNEL}`] });
    expect(registry.hasRef(`npm:${CHANNEL}`)).toBe(true);
  });

  it('fails a missing package at phase import, naming plugin add', async () => {
    const failure = await loadPlugins({
      registry: new ProviderRegistry(),
      entries: [{ ref: 'npm:@acme/nope' }],
      logger: silentLog,
    }).catch((err: unknown) => err);
    expect(failure).toBeInstanceOf(PluginLoadError);
    expect(failure).toMatchObject({
      plugin: 'npm:@acme/nope',
      phase: 'import',
      message: expect.stringContaining('run: dreamux plugin add @acme/nope'),
    });
  });
});

describe('plugin add', () => {
  it('installs, proves, and registers, and leaves every other key as it was', async () => {
    const before = {
      ...NO_USE,
      plugins: [
        'builtin:bootstrap',
        { ref: 'npm:@acme/other', config: { a: 1 } },
      ],
      x_handwritten: { note: 'keep me', path: '~/keep' },
    };
    await writeFile(configFile, `${JSON.stringify(before, null, 2)}\n`, {
      mode: 0o600,
    });

    const result = await addPlugin(CHANNEL, npm);

    expect(result).toEqual({
      ref: `npm:${CHANNEL}`,
      installed: true,
      registered: true,
    });
    expect(npm.calls.map((call) => call.args)).toEqual([
      ['install', CHANNEL, '--prefix', pluginRoot()],
    ]);
    const after = await readConfigObject();
    expect(after).toEqual({
      ...before,
      plugins: [...before.plugins, `npm:${CHANNEL}`],
    });
    expect(Object.keys(after)).toEqual(Object.keys(before));
    expect(await readConfig()).toBe(`${JSON.stringify(after, null, 2)}\n`);
    if (process.platform !== 'win32') {
      expect((await stat(configFile)).mode & 0o777).toBe(0o600);
    }
  });

  it('adds plugins[] when the file has none', async () => {
    await writeConfig(NO_USE);
    await addPlugin(CHANNEL, npm);
    expect(await readConfigObject()).toEqual({
      ...NO_USE,
      plugins: [`npm:${CHANNEL}`],
    });
  });

  it('leaves a package already in the plugin directory alone', async () => {
    await writeConfig(NO_USE);
    await writeNpmPackage(root, CHANNEL, CHANNEL_SOURCE);
    expect(await addPlugin(CHANNEL, npm)).toEqual({
      ref: `npm:${CHANNEL}`,
      installed: false,
      registered: true,
    });
    expect(npm.calls).toEqual([]);
  });

  it('repairs a registered plugin whose package is gone', async () => {
    await writeConfig({ ...NO_USE, plugins: [`npm:${CHANNEL}`] });
    const before = await readConfig();
    expect(await addPlugin(CHANNEL, npm)).toMatchObject({
      installed: true,
      registered: false,
    });
    expect(await readConfig()).toBe(before);
  });

  it('changes nothing for a plugin that is registered and installed', async () => {
    await writeConfig({ ...NO_USE, plugins: [`npm:${CHANNEL}`] });
    await writeNpmPackage(root, CHANNEL, CHANNEL_SOURCE);
    const before = await readConfig();
    expect(await addPlugin(CHANNEL, npm)).toEqual({
      ref: `npm:${CHANNEL}`,
      installed: false,
      registered: false,
    });
    expect(npm.calls).toEqual([]);
    expect(await readConfig()).toBe(before);
  });

  it('registers nothing when the package is not a plugin', async () => {
    await writeConfig(NO_USE);
    const before = await readConfig();
    await expect(addPlugin(NOT_A_PLUGIN, npm)).rejects.toThrow(PluginLoadError);
    expect(await readConfig()).toBe(before);
  });

  it('writes nothing when npm fails', async () => {
    await writeConfig(NO_USE);
    const before = await readConfig();
    npm.fail = true;
    await expect(addPlugin(CHANNEL, npm)).rejects.toThrow('npm failed');
    expect(await readConfig()).toBe(before);
  });

  it('refuses an argument that is not an npm package name', async () => {
    await writeConfig(NO_USE);
    for (const input of [
      'acme#export',
      'file:../acme',
      'acme@1.0.0',
      'Acme/Chan',
    ]) {
      await expect(addPlugin(input, npm)).rejects.toThrow(
        /expected an npm package name/,
      );
    }
    expect(npm.calls).toEqual([]);
  });

  it('names the command that creates a missing config', async () => {
    await expect(addPlugin(CHANNEL, npm)).rejects.toThrow(
      /dreamux config is missing[\s\S]*dreamux onboard/,
    );
    expect(npm.calls).toEqual([]);
  });
  it('refuses a malformed plugins[] as the daemon does, and rewrites nothing', async () => {
    await writeConfig({ ...NO_USE, plugins: [`npm:${CHANNEL}`, 42] });
    const before = await readConfig();
    await expect(addPlugin(AGENT, npm)).rejects.toThrow(
      /config error in .*plugins\[1\] must be a plugin ref string or \{ ref, config \}/,
    );
    await expect(removePlugin(CHANNEL, npm)).rejects.toThrow(/plugins\[1\]/);
    expect(await readConfig()).toBe(before);
    expect(npm.calls).toEqual([]);
  });
});

describe('plugin remove', () => {
  it('refuses while a Dispatcher uses a channel the plugin contributes', async () => {
    await writeConfig({
      ...CHANNEL_IN_USE,
      plugins: [`npm:${CHANNEL}`],
    });
    await writeNpmPackage(root, CHANNEL, CHANNEL_SOURCE);
    const before = await readConfig();
    await expect(removePlugin(CHANNEL, npm)).rejects.toThrow(
      `plugin npm:${CHANNEL} contributes a provider that dispatcher "personal" uses; take that out of ${configFile} first`,
    );
    expect(npm.calls).toEqual([]);
    expect(await readConfig()).toBe(before);
  });

  it('refuses while an agent uses a runtime the plugin contributes', async () => {
    await writeConfig({ ...AGENT_IN_USE, plugins: [`npm:${AGENT}`] });
    await writeNpmPackage(root, AGENT, AGENT_SOURCE);
    await expect(removePlugin(AGENT, npm)).rejects.toThrow('agent "main" uses');
    expect(npm.calls).toEqual([]);
  });

  it('unregisters the entry and leaves the others as spelled, then uninstalls', async () => {
    const plugins: unknown[] = [
      'builtin:bootstrap',
      { ref: `npm:${CHANNEL}`, config: { a: 1 } },
      `npm:${AGENT}`,
    ];
    await writeConfig({ ...CHANNEL_IN_USE, plugins });
    await writeNpmPackage(root, CHANNEL, CHANNEL_SOURCE);
    await writeNpmPackage(root, AGENT, AGENT_SOURCE);

    expect(await removePlugin(AGENT, npm)).toEqual({ ref: `npm:${AGENT}` });

    expect(await readConfigObject()).toEqual({
      ...CHANNEL_IN_USE,
      plugins: [plugins[0], plugins[1]],
    });
    // The entry leaves the file before the package leaves the directory.
    expect(npm.calls).toEqual([
      {
        args: ['uninstall', AGENT, '--prefix', pluginRoot()],
        config: await readConfig(),
      },
    ]);
  });

  it('removes a plugin that does not load', async () => {
    await writeConfig({ ...CHANNEL_IN_USE, plugins: [`npm:${CHANNEL}`] });
    await removePlugin(CHANNEL, npm);
    expect(await readConfigObject()).toEqual({
      ...CHANNEL_IN_USE,
      plugins: [],
    });
    expect(npm.calls.map((call) => call.args[0])).toEqual(['uninstall']);
  });

  it('refuses a plugin that is not registered', async () => {
    await writeConfig(NO_USE);
    await expect(removePlugin(CHANNEL, npm)).rejects.toThrow(
      `plugin npm:${CHANNEL} is not registered in ${configFile}`,
    );
    expect(npm.calls).toEqual([]);
  });

  it('leaves the entry removed when the uninstall fails', async () => {
    await writeConfig({ ...NO_USE, plugins: [`npm:${CHANNEL}`] });
    npm.fail = true;
    await expect(removePlugin(CHANNEL, npm)).rejects.toThrow('npm failed');
    expect(await readConfigObject()).toEqual({ ...NO_USE, plugins: [] });
  });
});

describe('plugin list', () => {
  it('names each entry, what it contributes, or why it does not load', async () => {
    await writeConfig({
      ...NO_USE,
      plugins: [`npm:${CHANNEL}`, `npm:${AGENT}`, 'npm:@acme/nope'],
    });
    await writeNpmPackage(root, CHANNEL, CHANNEL_SOURCE);
    await writeNpmPackage(root, AGENT, AGENT_SOURCE);
    expect(await listPlugins()).toEqual([
      { ref: `npm:${CHANNEL}`, name: 'acme', providers: ['channel:acme'] },
      {
        ref: `npm:${AGENT}`,
        name: 'acme-runtime',
        providers: ['agentRuntime:acme'],
      },
      {
        ref: 'npm:@acme/nope',
        providers: [],
        error: expect.stringContaining('run: dreamux plugin add @acme/nope'),
      },
    ]);
  });
});

describe('plugin run', () => {
  const OUT = (): string => join(root, 'argv.json');

  /** A command line that records its argv, cwd, and env, then exits 7. */
  function cliSource(): string {
    return `import { writeFileSync } from 'node:fs';
writeFileSync(${JSON.stringify(OUT())}, JSON.stringify({
  argv: process.argv.slice(2),
  cwd: process.cwd(),
  probe: process.env.DREAMUX_RUN_PROBE ?? null,
}));
process.exit(7);
`;
  }

  async function writeCli(bin: unknown): Promise<void> {
    await writeNpmPackage(root, CLI, cliSource(), { bin });
  }

  async function recorded(): Promise<unknown> {
    return JSON.parse(await readFile(OUT(), 'utf8'));
  }

  it('runs a string bin with the arguments and returns its exit code', async () => {
    vi.stubEnv('DREAMUX_RUN_PROBE', 'kept');
    await writeCli('./index.js');
    const code = await runPluginCommand(CLI, [
      'login',
      '--qr',
      '-n5',
      'a/b',
      '1.5',
    ]);
    expect(code).toBe(7);
    expect(await recorded()).toEqual({
      argv: ['login', '--qr', '-n5', 'a/b', '1.5'],
      cwd: process.cwd(),
      probe: 'kept',
    });
  });

  it('runs a one-entry bin', async () => {
    await writeCli({ 'acme-cli': './index.js' });
    expect(await runPluginCommand(CLI, [])).toBe(7);
  });

  it('refuses a bin that is not one command line, and starts nothing', async () => {
    await writeCli({ one: './index.js', two: './index.js' });
    await expect(runPluginCommand(CLI, [])).rejects.toThrow(
      /does not declare one command line/,
    );
    await writeCli(undefined);
    await expect(runPluginCommand(CLI, [])).rejects.toThrow(
      /does not declare one command line/,
    );
  });

  it('needs the package installed, not registered', async () => {
    await expect(runPluginCommand(CLI, [])).rejects.toThrow(
      'run: dreamux plugin add @acme/cli',
    );
    await writeCli('./index.js');
    expect(await runPluginCommand(CLI, [])).toBe(7);
  });

  it('is forwarded with its options unread', async () => {
    await writeCli('./index.js');
    expect(await forwardPluginRun([CLI, 'login', '--qr'])).toBe(7);
    expect(await recorded()).toMatchObject({ argv: ['login', '--qr'] });
    await expect(forwardPluginRun([])).rejects.toThrow(
      /usage: dreamux plugin run/,
    );
  });
});
