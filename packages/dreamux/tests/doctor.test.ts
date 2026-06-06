import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import { build as buildPlist } from 'plist';

import { runDreamuxDoctor } from '../src/cli/doctor.js';
import type { CommandRunner } from '../src/onboard/types.js';
import type { ServiceNodeProbe } from '../src/onboard/service.js';
import {
  dispatcherCodexCwd,
  dispatcherCodexHome,
  dispatcherWorkspaceSkillPath,
  resetRuntimeConfig,
  stateRoot,
} from '../src/runtime/paths.js';

class FakeRunner implements CommandRunner {
  systemdEnabled = false;
  systemdActive = false;
  launchdLoaded = false;
  lingerEnabled = false;
  readonly nodeVersions = new Map<string, string>();
  readonly failedHelpCommands = new Set<string>();
  readonly calls: Array<{ command: string; args: string[] }> = [];

  async run(command: string, args: string[]): Promise<void> {
    this.calls.push({ command, args });
  }

  async check(command: string, args: string[]): Promise<boolean> {
    this.calls.push({ command, args });
    if (args[0] === '--help') return !this.failedHelpCommands.has(command);
    if (command === 'codex' && args.join(' ') === '--help') return true;
    if (command === 'systemctl' && args.join(' ') === '--user is-enabled dreamux.service') {
      return this.systemdEnabled;
    }
    if (command === 'systemctl' && args.join(' ') === '--user is-active dreamux.service') {
      return this.systemdActive;
    }
    if (command === 'launchctl' && args[0] === 'print') {
      return this.launchdLoaded;
    }
    return false;
  }

  async capture(command: string, args: string[]): Promise<string> {
    this.calls.push({ command, args });
    if (args[0] === '--version') {
      return this.nodeVersions.get(command) ?? 'v22.7.0';
    }
    if (command === 'systemctl' && args[0] === '--user' && args[1] === 'show') {
      return [
        'LoadState=loaded',
        `ActiveState=${this.systemdActive ? 'active' : 'inactive'}`,
        `SubState=${this.systemdActive ? 'running' : 'dead'}`,
        `MainPID=${this.systemdActive ? '1234' : '0'}`,
        'Result=success',
      ].join('\n');
    }
    if (command === 'launchctl' && args[0] === 'print' && this.launchdLoaded) {
      return 'state = running\npid = 1234\n';
    }
    if (command === 'loginctl' && args[0] === 'show-user') {
      return `Linger=${this.lingerEnabled ? 'yes' : 'no'}`;
    }
    throw new Error(`unexpected capture: ${command} ${args.join(' ')}`);
  }
}

describe('dreamux doctor command', () => {
  let root: string;
  let oldConfigDir: string | undefined;
  let oldRuntimeDir: string | undefined;
  let oldAdminSocket: string | undefined;
  let oldCodexBin: string | undefined;
  let oldDreamuxBin: string | undefined;
  let oldHome: string | undefined;

  beforeEach(() => {
    root = mkdtempSync(join(homedir(), '.dreamux-doctor-'));
    oldConfigDir = process.env['DREAMUX_CONFIG_DIR'];
    oldRuntimeDir = process.env['CODEX_HOST_RUNTIME_DIR'];
    oldAdminSocket = process.env['CODEX_HOST_ADMIN_SOCKET'];
    oldCodexBin = process.env['CODEX_HOST_CODEX_BIN'];
    oldDreamuxBin = process.env['DREAMUX_BIN'];
    oldHome = process.env['HOME'];
    delete process.env['CODEX_HOST_RUNTIME_DIR'];
    delete process.env['CODEX_HOST_ADMIN_SOCKET'];
    delete process.env['CODEX_HOST_CODEX_BIN'];
    process.env['DREAMUX_CONFIG_DIR'] = join(root, 'config');
    process.env['DREAMUX_BIN'] = '/usr/local/bin/dreamux';
    process.env['HOME'] = join(root, 'home');
  });

  afterEach(() => {
    restoreEnv('DREAMUX_CONFIG_DIR', oldConfigDir);
    restoreEnv('CODEX_HOST_RUNTIME_DIR', oldRuntimeDir);
    restoreEnv('CODEX_HOST_ADMIN_SOCKET', oldAdminSocket);
    restoreEnv('CODEX_HOST_CODEX_BIN', oldCodexBin);
    restoreEnv('DREAMUX_BIN', oldDreamuxBin);
    restoreEnv('HOME', oldHome);
    resetRuntimeConfig();
    rmSync(root, { recursive: true, force: true });
  });

  it('reports global Codex home health', async () => {
    const runner = new FakeRunner();
    writeConfig();
    writeDispatcherHome({ auth: true });

    const result = await runDreamuxDoctor({
      runner,
      platform: 'linux',
      homeDir: join(root, 'home'),
      env: {},
    });

    expect(result.ok, JSON.stringify(result, null, 2)).toBe(true);
    expect(result.checks.find((check) => check.name === 'config')).toMatchObject({
      ok: true,
    });
    expect(
      result.dispatchers[0]?.foreground.ok,
      JSON.stringify(result, null, 2),
    ).toBe(true);
    expect(result.dispatchers[0]?.managedService).toBeNull();
  });

  it('does not expose Feishu app secrets in doctor results', async () => {
    const runner = new FakeRunner();
    writeConfig();
    writeDispatcherHome({ auth: true });

    const result = await runDreamuxDoctor({
      runner,
      platform: 'linux',
      homeDir: join(root, 'home'),
      env: {},
    });

    expect(JSON.stringify(result)).not.toContain('secret-test');
  });

  it('checks managed-service dispatcher auth when a service is installed', async () => {
    const runner = new FakeRunner();
    writeConfig();
    writeDispatcherHome({ auth: false });
    const servicePath = join(root, 'home', '.config', 'systemd', 'user', 'dreamux.service');
    mkdirSync(dirname(servicePath), { recursive: true });
    writeFileSync(servicePath, '[Service]\nExecStart=/usr/local/bin/dreamux serve\n');

    const result = await runDreamuxDoctor({
      runner,
      platform: 'linux',
      homeDir: join(root, 'home'),
      env: { CODEX_ACCESS_TOKEN: 'interactive-token-test' },
    });

    expect(result.ok).toBe(false);
    expect(result.dispatchers[0]?.foreground.ok).toBe(true);
    expect(result.dispatchers[0]?.managedService?.ok).toBe(false);
    expect(result.dispatchers[0]?.managedService?.errors.join('\n')).toContain(
      'missing Codex auth state',
    );
  });

  it('checks the installed systemd service environment instead of recomputing it', async () => {
    const runner = new FakeRunner();
    writeConfig();
    writeDispatcherHome({ auth: true });
    const servicePath = join(root, 'home', '.config', 'systemd', 'user', 'dreamux.service');
    mkdirSync(dirname(servicePath), { recursive: true });
    writeFileSync(
      servicePath,
      [
        '[Service]',
        'ExecStart=/service/dreamux serve',
        'Environment=DREAMUX_NODE_BIN=/service/node',
        'Environment=CODEX_HOST_CODEX_BIN=/service/codex\\\\x20literal',
        'Environment=PATH=/service/bin:/usr/bin:/bin',
        '',
      ].join('\n'),
    );
    runner.nodeVersions.set('/service/node', 'v18.0.0');

    const result = await runDreamuxDoctor({
      runner,
      platform: 'linux',
      homeDir: join(root, 'home'),
      env: {},
    });

    expect(result.ok).toBe(false);
    expect(
      result.checks.find((check) => check.name === 'managed service Node binary'),
    ).toMatchObject({
      ok: false,
      detail: expect.stringContaining('/service/node'),
    });
    expect(runner.calls).toContainEqual({
      command: '/service/node',
      args: ['--version'],
    });
    expect(runner.calls).not.toContainEqual({
      command: process.execPath,
      args: ['--version'],
    });
    expect(result.service.environment?.['CODEX_HOST_CODEX_BIN']).toBe(
      '/service/codex\\x20literal',
    );
  });

  it('warns (without failing) when the service Node is bound to a version manager', async () => {
    const runner = new FakeRunner();
    runner.lingerEnabled = true; // not under test here; keep the linger check green
    writeConfig();
    writeDispatcherHome({ auth: true });
    const nvmNode = join(
      root,
      'home',
      '.nvm',
      'versions',
      'node',
      'v22.7.0',
      'bin',
      'node',
    );
    const servicePath = join(root, 'home', '.config', 'systemd', 'user', 'dreamux.service');
    mkdirSync(dirname(servicePath), { recursive: true });
    writeFileSync(
      servicePath,
      [
        '[Service]',
        'ExecStart=/service/dreamux serve',
        `Environment=DREAMUX_NODE_BIN=${nvmNode}`,
        'Environment=CODEX_HOST_CODEX_BIN=/service/codex',
        'Environment=PATH=/service/bin:/usr/bin:/bin',
        '',
      ].join('\n'),
    );
    runner.nodeVersions.set(nvmNode, 'v22.7.0');

    const result = await runDreamuxDoctor({
      runner,
      platform: 'linux',
      homeDir: join(root, 'home'),
      env: {},
    });

    // The Node runs today, so the binary check stays green and result.ok holds.
    expect(result.ok).toBe(true);
    expect(
      result.checks.find((check) => check.name === 'managed service Node binary'),
    ).toMatchObject({ ok: true });
    const advisory = result.checks.find(
      (check) => check.name === 'managed service Node stability',
    );
    expect(advisory).toMatchObject({
      ok: true,
      severity: 'warn',
      detail: expect.stringContaining('nvm'),
    });
  });

  it('flags a system-looking shim that realpaths into a version manager', async () => {
    const runner = new FakeRunner();
    runner.lingerEnabled = true; // not under test here; keep the linger check green
    writeConfig();
    writeDispatcherHome({ auth: true });
    const servicePath = join(root, 'home', '.config', 'systemd', 'user', 'dreamux.service');
    mkdirSync(dirname(servicePath), { recursive: true });
    writeFileSync(
      servicePath,
      [
        '[Service]',
        'ExecStart=/service/dreamux serve',
        'Environment=DREAMUX_NODE_BIN=/usr/local/bin/node',
        'Environment=CODEX_HOST_CODEX_BIN=/service/codex',
        'Environment=PATH=/service/bin:/usr/bin:/bin',
        '',
      ].join('\n'),
    );
    runner.nodeVersions.set('/usr/local/bin/node', 'v22.7.0');
    const shimProbe: ServiceNodeProbe = {
      isExecutable: () => true,
      realpath: async (path) =>
        path === '/usr/local/bin/node'
          ? '/Users/u/Library/Application Support/fnm/node-versions/v22/installation/bin/node'
          : path,
    };

    const result = await runDreamuxDoctor({
      runner,
      platform: 'linux',
      homeDir: join(root, 'home'),
      env: {},
      nodeProbe: shimProbe,
    });

    expect(result.ok).toBe(true);
    expect(
      result.checks.find(
        (check) => check.name === 'managed service Node stability',
      ),
    ).toMatchObject({ ok: true, severity: 'warn', detail: expect.stringContaining('fnm') });
  });

  it('does not warn when the service Node is a stable system path', async () => {
    const runner = new FakeRunner();
    writeConfig();
    writeDispatcherHome({ auth: true });
    const servicePath = join(root, 'home', '.config', 'systemd', 'user', 'dreamux.service');
    mkdirSync(dirname(servicePath), { recursive: true });
    writeFileSync(
      servicePath,
      [
        '[Service]',
        'ExecStart=/service/dreamux serve',
        'Environment=DREAMUX_NODE_BIN=/usr/local/bin/node',
        'Environment=CODEX_HOST_CODEX_BIN=/service/codex',
        'Environment=PATH=/service/bin:/usr/bin:/bin',
        '',
      ].join('\n'),
    );
    runner.nodeVersions.set('/usr/local/bin/node', 'v22.7.0');
    const stableProbe: ServiceNodeProbe = {
      isExecutable: () => true,
      realpath: async (path) => path,
    };

    const result = await runDreamuxDoctor({
      runner,
      platform: 'linux',
      homeDir: join(root, 'home'),
      env: {},
      nodeProbe: stableProbe,
    });

    expect(
      result.checks.find(
        (check) => check.name === 'managed service Node stability',
      ),
    ).toBeUndefined();
  });

  it('checks the installed launchd plist environment instead of failing unconditionally', async () => {
    const runner = new FakeRunner();
    runner.launchdLoaded = true;
    writeConfig();
    writeDispatcherHome({ auth: true });
    const servicePath = join(
      root,
      'home',
      'Library',
      'LaunchAgents',
      'dev.excited.dreamux.plist',
    );
    mkdirSync(dirname(servicePath), { recursive: true });
    writeFileSync(
      servicePath,
      buildPlist({
        Label: 'dev.excited.dreamux',
        ProgramArguments: ['/service/dreamux', 'serve'],
        RunAtLoad: true,
        KeepAlive: true,
        EnvironmentVariables: {
          DREAMUX_CONFIG_DIR: join(root, 'config'),
          HOME: join(root, 'home'),
          DREAMUX_NODE_BIN: '/service/node',
          CODEX_HOST_CODEX_BIN: '/service/codex',
          PATH: '/service/bin:/usr/bin:/bin',
        },
      }),
    );
    runner.nodeVersions.set('/service/node', 'v22.7.0');

    const result = await runDreamuxDoctor({
      runner,
      platform: 'darwin',
      homeDir: join(root, 'home'),
      uid: 501,
      env: {},
    });

    expect(result.ok, JSON.stringify(result, null, 2)).toBe(true);
    expect(result.service.environment).toMatchObject({
      DREAMUX_NODE_BIN: '/service/node',
      CODEX_HOST_CODEX_BIN: '/service/codex',
      PATH: '/service/bin:/usr/bin:/bin',
    });
    expect(result.service.execStart).toEqual(['/service/dreamux', 'serve']);
    expect(runner.calls).toContainEqual({
      command: '/service/node',
      args: ['--version'],
    });
    expect(runner.calls).toContainEqual({
      command: '/service/dreamux',
      args: ['--help'],
    });
    expect(runner.calls).toContainEqual({
      command: '/service/codex',
      args: ['--help'],
    });
  });

  it('flags disabled systemd lingering on an installed service', async () => {
    const runner = new FakeRunner();
    runner.lingerEnabled = false;
    writeConfig();
    writeDispatcherHome({ auth: true });
    writeValidSystemdUnit();

    const result = await runDreamuxDoctor({
      runner,
      platform: 'linux',
      homeDir: join(root, 'home'),
      userName: 'someone',
      env: {},
    });

    const linger = result.checks.find((check) => check.name === 'systemd linger');
    expect(linger).toMatchObject({ ok: false });
    expect(linger?.detail).toContain('enable-linger');
    expect(result.ok).toBe(false);
  });

  it('passes the linger check when lingering is enabled', async () => {
    const runner = new FakeRunner();
    runner.lingerEnabled = true;
    writeConfig();
    writeDispatcherHome({ auth: true });
    writeValidSystemdUnit();

    const result = await runDreamuxDoctor({
      runner,
      platform: 'linux',
      homeDir: join(root, 'home'),
      userName: 'someone',
      env: {},
    });

    expect(result.checks.find((check) => check.name === 'systemd linger')).toMatchObject({
      ok: true,
    });
  });

  it('skips the linger check when no service is installed', async () => {
    const runner = new FakeRunner();
    writeConfig();
    writeDispatcherHome({ auth: true });

    const result = await runDreamuxDoctor({
      runner,
      platform: 'linux',
      homeDir: join(root, 'home'),
      env: {},
    });

    expect(result.checks.find((check) => check.name === 'systemd linger')).toBeUndefined();
  });

  function writeValidSystemdUnit(): void {
    const servicePath = join(root, 'home', '.config', 'systemd', 'user', 'dreamux.service');
    mkdirSync(dirname(servicePath), { recursive: true });
    writeFileSync(
      servicePath,
      [
        '[Service]',
        `ExecStart=${process.env['DREAMUX_BIN']} serve`,
        `Environment=DREAMUX_NODE_BIN=${process.execPath}`,
        'Environment=CODEX_HOST_CODEX_BIN=codex',
        'Environment=PATH=/usr/bin:/bin',
        '',
      ].join('\n'),
    );
  }

  function writeConfig(): void {
    const configPath = join(root, 'config', 'config.json');
    mkdirSync(dirname(configPath), { recursive: true });
    writeFileSync(
      configPath,
      JSON.stringify({
        dispatchers: [
          {
            id: 'flow',
            cwd: dispatcherCodexCwd('flow'),
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
          },
        ],
      }),
      { mode: 0o600 },
    );
  }

  function writeDispatcherHome(options: { auth: boolean }): void {
    const skillPath = dispatcherWorkspaceSkillPath(dispatcherCodexCwd('flow'));
    mkdirSync(dirname(skillPath), { recursive: true });
    writeFileSync(skillPath, '# test skill\n');
    mkdirSync(dispatcherCodexHome('flow'), { recursive: true });
    if (options.auth) {
      writeFileSync(join(dispatcherCodexHome('flow'), 'auth.json'), '{}');
    }
    mkdirSync(stateRoot(), { recursive: true });
  }
});

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}
