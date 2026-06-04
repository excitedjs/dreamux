import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { controlUserService } from '../src/daemon/service-control.js';
import { runDaemonInstall, runDaemonUninstall } from '../src/daemon/install.js';
import type { ServiceNodeProbe } from '../src/onboard/service.js';
import type { CommandRunner } from '../src/onboard/types.js';
import { resetRuntimeConfig } from '../src/runtime/paths.js';

interface Call {
  command: string;
  args: string[];
}

class FakeRunner implements CommandRunner {
  launchdLoaded = false;
  readonly calls: Call[] = [];

  async run(command: string, args: string[], options: { dryRun?: boolean } = {}): Promise<void> {
    if (options.dryRun) return;
    this.calls.push({ command, args });
  }

  async check(command: string, args: string[]): Promise<boolean> {
    if (command === 'launchctl' && args[0] === 'print') return this.launchdLoaded;
    return false;
  }

  async capture(): Promise<string> {
    return '';
  }
}

const SYSTEMD_HOME = '/home/example';

describe('daemon service control', () => {
  it.each([
    ['start', ['--user', 'start', 'dreamux.service']],
    ['stop', ['--user', 'stop', 'dreamux.service']],
    ['restart', ['--user', 'restart', 'dreamux.service']],
  ] as const)('maps systemd %s to the right systemctl call', async (verb, args) => {
    const runner = new FakeRunner();
    const result = await controlUserService(verb, {
      runner,
      platform: 'linux',
      homeDir: SYSTEMD_HOME,
    });
    expect(result.platform).toBe('systemd');
    expect(runner.calls).toEqual([{ command: 'systemctl', args }]);
  });

  it('restarts a loaded launchd service with kickstart -k', async () => {
    const runner = new FakeRunner();
    runner.launchdLoaded = true;
    await controlUserService('restart', {
      runner,
      platform: 'darwin',
      homeDir: SYSTEMD_HOME,
      uid: 501,
    });
    expect(runner.calls).toEqual([
      { command: 'launchctl', args: ['kickstart', '-k', 'gui/501/dev.excited.dreamux'] },
    ]);
  });

  it('stops a loaded launchd service with bootout', async () => {
    const runner = new FakeRunner();
    runner.launchdLoaded = true;
    await controlUserService('stop', {
      runner,
      platform: 'darwin',
      homeDir: SYSTEMD_HOME,
      uid: 501,
    });
    expect(runner.calls).toEqual([
      { command: 'launchctl', args: ['bootout', 'gui/501/dev.excited.dreamux'] },
    ]);
  });

  it('bootstraps an unloaded launchd service on start', async () => {
    const runner = new FakeRunner();
    runner.launchdLoaded = false;
    await controlUserService('start', {
      runner,
      platform: 'darwin',
      homeDir: SYSTEMD_HOME,
      uid: 501,
    });
    expect(runner.calls).toEqual([
      {
        command: 'launchctl',
        args: [
          'bootstrap',
          'gui/501',
          join(SYSTEMD_HOME, 'Library', 'LaunchAgents', 'dev.excited.dreamux.plist'),
        ],
      },
    ]);
  });
});

describe('daemon uninstall (service-only)', () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'dreamux-daemon-uninstall-'));
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it('disables and removes an installed systemd unit', async () => {
    const runner = new FakeRunner();
    const unitDir = join(home, '.config', 'systemd', 'user');
    mkdirSync(unitDir, { recursive: true });
    writeFileSync(join(unitDir, 'dreamux.service'), '[Unit]\n');

    const result = await runDaemonUninstall({ runner, platform: 'linux', homeDir: home });

    expect(result).toMatchObject({ platform: 'systemd', removed: true });
    expect(existsSync(join(unitDir, 'dreamux.service'))).toBe(false);
    expect(runner.calls).toEqual([
      { command: 'systemctl', args: ['--user', 'disable', '--now', 'dreamux.service'] },
      { command: 'systemctl', args: ['--user', 'daemon-reload'] },
    ]);
  });

  it('reports a missing unit without failing', async () => {
    const runner = new FakeRunner();
    const result = await runDaemonUninstall({ runner, platform: 'linux', homeDir: home });
    expect(result).toMatchObject({ platform: 'systemd', removed: false });
  });
});

// A runner that satisfies the managed-service launch checks and reports a
// modern Node for every `--version` probe (both the current Node and the
// stable candidate selectServiceNodeBin probes).
class InstallRunner implements CommandRunner {
  readonly calls: Call[] = [];
  lingerEnableOk = true;

  async run(command: string, args: string[], options: { dryRun?: boolean } = {}): Promise<void> {
    if (options.dryRun) return;
    this.calls.push({ command, args });
  }

  async check(command: string, args: string[]): Promise<boolean> {
    if (args[0] === '--help') return true;
    if (command === 'loginctl' && args[0] === 'enable-linger') return this.lingerEnableOk;
    return false;
  }

  async capture(_command: string, args: string[]): Promise<string> {
    if (args[0] === '--version') return 'v22.7.0';
    throw new Error(`unexpected capture: ${args.join(' ')}`);
  }
}

describe('daemon install (stable service Node, issue #83)', () => {
  let root: string;
  let oldHome: string | undefined;
  let oldConfigDir: string | undefined;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'dreamux-daemon-install-'));
    oldHome = process.env['HOME'];
    oldConfigDir = process.env['DREAMUX_CONFIG_DIR'];
    process.env['HOME'] = join(root, 'home');
    process.env['DREAMUX_CONFIG_DIR'] = join(root, 'config');
    writeInstallConfig(join(root, 'config'));
  });

  afterEach(() => {
    restoreEnv('HOME', oldHome);
    restoreEnv('DREAMUX_CONFIG_DIR', oldConfigDir);
    resetRuntimeConfig();
    rmSync(root, { recursive: true, force: true });
  });

  function readUnitNodeBin(): string {
    const unit = readFileSync(
      join(root, 'home', '.config', 'systemd', 'user', 'dreamux.service'),
      'utf8',
    );
    const line = unit
      .split('\n')
      .find((l) => l.startsWith('Environment=DREAMUX_NODE_BIN='));
    return line?.slice('Environment=DREAMUX_NODE_BIN='.length) ?? '';
  }

  it('pins a stable system Node even when invoked from a version-manager Node', async () => {
    const runner = new InstallRunner();
    // The current Node would be a version-manager Node; /usr/local/bin/node is a
    // stable system Node, so it must win and be persisted into the unit.
    const stableNodeProbe: ServiceNodeProbe = {
      realpath: async (path) => path,
      isExecutable: (path) => path === '/usr/local/bin/node',
    };

    await runDaemonInstall({
      runner,
      platform: 'linux',
      homeDir: join(root, 'home'),
      nodeProbe: stableNodeProbe,
    });

    expect(readUnitNodeBin()).toBe('/usr/local/bin/node');
    expect(readUnitNodeBin()).not.toBe(process.execPath);
  });

  it('falls back to the current Node when no stable system Node exists', async () => {
    const runner = new InstallRunner();
    const noSystemNodeProbe: ServiceNodeProbe = {
      realpath: async (path) => path,
      isExecutable: () => false,
    };

    await runDaemonInstall({
      runner,
      platform: 'linux',
      homeDir: join(root, 'home'),
      nodeProbe: noSystemNodeProbe,
    });

    expect(readUnitNodeBin()).toBe(process.execPath);
  });
});

function writeInstallConfig(configDir: string): void {
  mkdirSync(configDir, { recursive: true });
  writeFileSync(
    join(configDir, 'config.json'),
    JSON.stringify({
      // codex.bin must resolve to a runnable absolute path for the managed
      // service launch check; the current Node binary is a convenient one.
      codex: {
        bin: process.execPath,
        approval_policy: 'never',
        sandbox_mode: 'workspace-write',
        extra_args: [],
        initialize_timeout_ms: 10000,
      },
      dispatchers: [
        {
          id: 'flow',
          cwd: join(dirname(configDir), 'cwd'),
          enabled: true,
          feishu: { app_id: 'app-test', app_secret: 'secret-test' },
          codex: { approval_policy: null, sandbox_mode: null, extra_args: [] },
        },
      ],
    }),
    { mode: 0o600 },
  );
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
