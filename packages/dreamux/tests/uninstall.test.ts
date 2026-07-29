import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import { runUninstall } from '../src/onboard/uninstall.js';
import type { CommandRunner } from '../src/onboard/types.js';
import type { ProviderPluginStore } from '../src/registry/provider-plugin-store.js';
import {
  dreamuxRoot,
  logsRoot,
  cacheRoot,
  pluginRoot,
  runRoot,
  resetRuntimeConfig,
  stateRoot,
} from '../src/platform/paths.js';
import { testSingleDispatcherFileObject } from './helpers/config.js';

class FakeRunner implements CommandRunner {
  launchdLoaded = false;
  readonly calls: Array<{ command: string; args: string[] }> = [];

  async run(command: string, args: string[]): Promise<void> {
    this.calls.push({ command, args });
  }

  async check(command: string, args: string[]): Promise<boolean> {
    return command === 'launchctl' &&
      args[0] === 'print' &&
      this.launchdLoaded;
  }

  async capture(): Promise<string> {
    return '';
  }
}

class FakeProviderPluginStore implements Partial<ProviderPluginStore> {
  readonly inspected: string[] = [];
  readonly materialized: string[] = [];
  readonly imported: string[] = [];

  async inspectPackage(packageName: string) {
    this.inspected.push(packageName);
    return {
      packageName,
      ok: false,
      version: null,
      error: `provider plugin ${packageName} has no selected generation`,
    };
  }

  async materializePackage(packageName: string): Promise<string> {
    this.materialized.push(packageName);
    return '1.0.0';
  }

  async importModule(packageName: string): Promise<Record<string, unknown>> {
    this.imported.push(packageName);
    return {};
  }
}

describe('dreamux uninstall', () => {
  let root: string;
  let previousConfigDir: string | undefined;
  let previousHome: string | undefined;

  beforeEach(() => {
    root = mkdtempSync(join(homedir(), '.dreamux-uninstall-'));
    previousConfigDir = process.env['DREAMUX_CONFIG_DIR'];
    previousHome = process.env['HOME'];
    process.env['HOME'] = join(root, 'home');
    process.env['DREAMUX_CONFIG_DIR'] = dreamuxRoot();
  });

  afterEach(() => {
    if (previousConfigDir === undefined) delete process.env['DREAMUX_CONFIG_DIR'];
    else process.env['DREAMUX_CONFIG_DIR'] = previousConfigDir;
    if (previousHome === undefined) delete process.env['HOME'];
    else process.env['HOME'] = previousHome;
    resetRuntimeConfig();
    rmSync(root, { recursive: true, force: true });
  });

  it('removes onboard-owned config, Dreamux home, and user service files', async () => {
    const configDir = join(root, 'config');
    const homeDir = join(root, 'home');
    const servicePath = join(homeDir, '.config', 'systemd', 'user', 'dreamux.service');
    const dispatcherCwd = join(root, 'workspace');
    const legacyWorkspaceSkillDir = join(
      dispatcherCwd,
      '.codex',
      'skills',
      'dispatcher',
    );
    mkdirSync(configDir, { recursive: true });
    mkdirSync(stateRoot(), { recursive: true });
    mkdirSync(join(runRoot(), 'sockets'), { recursive: true });
    mkdirSync(join(cacheRoot(), 'flow', 'spill'), { recursive: true });
    mkdirSync(join(pluginRoot(), 'ZXhhbXBsZQ', 'versions', '1.0.0'), {
      recursive: true,
    });
    mkdirSync(logsRoot(), { recursive: true });
    mkdirSync(dirname(servicePath), { recursive: true });
    mkdirSync(legacyWorkspaceSkillDir, { recursive: true });
    writeFileSync(join(configDir, 'config.json'), JSON.stringify(
      testSingleDispatcherFileObject({
        id: 'flow',
        cwd: dispatcherCwd,
        enabled: true,
        feishu: {
          app_id: 'app-test',
          app_secret: 'secret-test',
        },
        codex: {
          approval_policy: 'never',
          sandbox_mode: 'workspace-write',
          extra_args: [],
          extra_env: {},
        },
      }),
    ), { mode: 0o600 });
    writeFileSync(join(logsRoot(), 'dreamux-server.log'), '');
    writeFileSync(join(legacyWorkspaceSkillDir, 'SKILL.md'), '# legacy skill\n');
    writeFileSync(servicePath, '[Service]\nExecStart=dreamux serve\n');

    const runner = new FakeRunner();
    const result = await runUninstall({
      configDir,
      runner,
      platform: 'linux',
      homeDir,
    });

    expect(existsSync(configDir)).toBe(false);
    expect(existsSync(dreamuxRoot())).toBe(false);
    expect(existsSync(stateRoot())).toBe(false);
    expect(existsSync(runRoot())).toBe(false);
    expect(existsSync(cacheRoot())).toBe(false);
    expect(existsSync(pluginRoot())).toBe(false);
    expect(existsSync(logsRoot())).toBe(false);
    expect(existsSync(servicePath)).toBe(false);
    expect(existsSync(legacyWorkspaceSkillDir)).toBe(true);
    expect(
      result.entries.some((entry) =>
        entry.path.startsWith(join(dispatcherCwd, '.codex', 'skills')),
      ),
    ).toBe(false);
    expect(result.entries).toEqual(
      expect.arrayContaining([
        { status: 'removed', path: configDir, reason: 'dreamux config directory' },
        { status: 'removed', path: servicePath, reason: 'systemd unit' },
        { status: 'removed', path: dreamuxRoot(), reason: 'dreamux home directory' },
      ]),
    );
    expect(runner.calls.map((call) => [call.command, call.args])).toEqual([
      ['systemctl', ['--user', 'disable', '--now', 'dreamux.service']],
      ['systemctl', ['--user', 'daemon-reload']],
    ]);
  });

  it('removes the default Dreamux root as one containment-aware target', async () => {
    const configDir = dreamuxRoot();
    const homeDir = join(root, 'home');
    const servicePath = join(homeDir, '.config', 'systemd', 'user', 'dreamux.service');
    mkdirSync(configDir, { recursive: true });
    mkdirSync(stateRoot(), { recursive: true });
    mkdirSync(join(runRoot(), 'sockets'), { recursive: true });
    mkdirSync(join(cacheRoot(), 'flow', 'spill'), { recursive: true });
    mkdirSync(pluginRoot(), { recursive: true });
    mkdirSync(logsRoot(), { recursive: true });
    mkdirSync(dirname(servicePath), { recursive: true });
    writeFileSync(join(configDir, 'config.json'), JSON.stringify({}), {
      mode: 0o600,
    });
    writeFileSync(servicePath, '[Service]\nExecStart=dreamux serve\n');

    const result = await runUninstall({
      runner: new FakeRunner(),
      platform: 'linux',
      homeDir,
    });

    expect(existsSync(dreamuxRoot())).toBe(false);
    expect(result.entries).toEqual(
      expect.arrayContaining([
        { status: 'removed', path: dreamuxRoot(), reason: 'dreamux home directory' },
        { status: 'removed', path: servicePath, reason: 'systemd unit' },
      ]),
    );
    expect(
      result.entries.filter((entry) => entry.path === dreamuxRoot()),
    ).toHaveLength(1);
    expect(
      result.entries.some(
        (entry) =>
          entry.path !== dreamuxRoot() &&
          entry.path.startsWith(`${dreamuxRoot()}/`),
      ),
    ).toBe(false);
  });

  it('unregisters launchd services and removes the plist', async () => {
    const configDir = join(root, 'config');
    const homeDir = join(root, 'home');
    const servicePath = join(
      homeDir,
      'Library',
      'LaunchAgents',
      'dev.excited.dreamux.plist',
    );
    mkdirSync(configDir, { recursive: true });
    mkdirSync(stateRoot(), { recursive: true });
    mkdirSync(logsRoot(), { recursive: true });
    mkdirSync(dirname(servicePath), { recursive: true });
    writeFileSync(join(configDir, 'config.json'), JSON.stringify({}), {
      mode: 0o600,
    });
    writeFileSync(servicePath, '<plist />\n');

    const runner = new FakeRunner();
    runner.launchdLoaded = true;
    const result = await runUninstall({
      configDir,
      runner,
      platform: 'darwin',
      homeDir,
      uid: 501,
    });

    expect(existsSync(servicePath)).toBe(false);
    expect(result.entries).toEqual(
      expect.arrayContaining([
        { status: 'removed', path: servicePath, reason: 'launchd unit' },
      ]),
    );
    expect(runner.calls.map((call) => [call.command, call.args])).toEqual([
      ['launchctl', ['bootout', 'gui/501/dev.excited.dreamux']],
    ]);
  });

  it('refuses to remove operator Codex or Claude state paths', async () => {
    const runner = new FakeRunner();
    const homeDir = join(root, 'home');

    for (const unsafeConfigDir of [join(homedir(), '.codex'), join(homedir(), '.claude')]) {
      await expect(
        runUninstall({
          configDir: unsafeConfigDir,
          runner,
          platform: 'linux',
          homeDir,
        }),
      ).rejects.toThrow(/operator Codex\/Claude state/);
    }

    await expect(
      runUninstall({
        configDir: join(homedir(), '.claude'),
        runner,
        platform: 'linux',
        homeDir,
      }),
    ).rejects.toThrow(/operator Codex\/Claude state/);
    expect(runner.calls).toEqual([]);
  });

  it('warns on legacy, invalid, or non-owner-only config and still uninstalls', async () => {
    const cases: Array<{
      name: string;
      file: string;
      content: string;
      warning: RegExp;
      mode?: number;
    }> = [
      {
        name: 'legacy TOML only',
        file: 'config.toml',
        content: 'dispatchers = []\n',
        warning: /legacy dreamux config/,
      },
      {
        name: 'invalid JSON syntax',
        file: 'config.json',
        content: '{"dispatchers": ',
        warning: /dreamux config parse error/,
      },
      {
        name: 'invalid JSON value',
        file: 'config.json',
        content: JSON.stringify({ dispatchers: 42 }),
        warning: /dispatchers must be an array/,
      },
      {
        name: 'world-readable JSON config',
        file: 'config.json',
        content: JSON.stringify(
          testSingleDispatcherFileObject({
            id: 'flow',
            feishu: {
              app_id: 'app-test',
              app_secret: 'secret-test',
            },
          }),
        ),
        warning: /must be mode 0600/,
        mode: 0o644,
      },
    ];

    for (const testCase of cases) {
      const caseRoot = join(root, testCase.name.replaceAll(' ', '-'));
      const configDir = join(caseRoot, 'config');
      const homeDir = join(caseRoot, 'home');
      const previousCaseHome = process.env['HOME'];
      process.env['HOME'] = homeDir;
      const servicePath = join(
        homeDir,
        '.config',
        'systemd',
        'user',
        'dreamux.service',
      );
      mkdirSync(configDir, { recursive: true });
      mkdirSync(stateRoot(), { recursive: true });
      mkdirSync(logsRoot(), { recursive: true });
      mkdirSync(dirname(servicePath), { recursive: true });
      if (testCase.file === 'config.json') {
        const configPath = join(configDir, testCase.file);
        writeFileSync(configPath, testCase.content, {
          mode: 0o600,
        });
        if (testCase.mode !== undefined) chmodSync(configPath, testCase.mode);
      } else {
        writeFileSync(join(configDir, testCase.file), testCase.content);
      }
      writeFileSync(join(logsRoot(), 'dreamux-server.log'), '');
      writeFileSync(servicePath, '[Service]\nExecStart=dreamux serve\n');

      const runner = new FakeRunner();
      try {
        const result = await runUninstall({
          configDir,
          runner,
          platform: 'linux',
          homeDir,
        });

        expect(result.warnings).toHaveLength(1);
        expect(result.warnings[0]).toMatch(testCase.warning);
        expect(existsSync(configDir)).toBe(false);
        expect(existsSync(stateRoot())).toBe(false);
        expect(existsSync(logsRoot())).toBe(false);
        expect(existsSync(servicePath)).toBe(false);
        expect(runner.calls.map((call) => [call.command, call.args])).toEqual([
          ['systemctl', ['--user', 'disable', '--now', 'dreamux.service']],
          ['systemctl', ['--user', 'daemon-reload']],
        ]);
      } finally {
        process.env['HOME'] = previousCaseHome;
      }
    }
  });

  it('preflights missing npm plugins without materializing before uninstall', async () => {
    const configDir = join(root, 'config');
    const homeDir = join(root, 'home');
    const servicePath = join(homeDir, '.config', 'systemd', 'user', 'dreamux.service');
    mkdirSync(configDir, { recursive: true });
    mkdirSync(dreamuxRoot(), { recursive: true });
    mkdirSync(dirname(servicePath), { recursive: true });
    writeFileSync(
      join(configDir, 'config.json'),
      JSON.stringify({
        agents: [
          {
            id: 'flow',
            provider: 'npm:@example/missing-runtime#provider',
            config: {},
          },
        ],
        dispatchers: [
          {
            id: 'flow',
            cwd: join(root, 'workspace'),
            channels: [
              {
                id: 'primary',
                provider: 'builtin:feishu',
                config: { app_id: 'app-test', app_secret: 'secret-test' },
              },
            ],
            agentRuntime: 'flow',
          },
        ],
      }),
      { mode: 0o600 },
    );
    writeFileSync(servicePath, '[Service]\nExecStart=dreamux serve\n');
    const pluginStore = new FakeProviderPluginStore();

    const result = await runUninstall({
      configDir,
      runner: new FakeRunner(),
      platform: 'linux',
      homeDir,
      providerPluginStore: pluginStore as unknown as ProviderPluginStore,
    });

    expect(pluginStore.inspected).toEqual(['@example/missing-runtime']);
    expect(pluginStore.materialized).toEqual([]);
    expect(pluginStore.imported).toEqual([]);
    expect(result.warnings).toEqual([]);
    expect(existsSync(configDir)).toBe(false);
    expect(existsSync(dreamuxRoot())).toBe(false);
  });
});
