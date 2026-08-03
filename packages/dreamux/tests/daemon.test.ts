import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { parse as parsePlist } from 'plist';

import { controlUserService } from '../src/daemon/service-control.js';
import { runDaemonInstall, runDaemonUninstall } from '../src/daemon/install.js';
import {
  managedServiceEnvironment,
  renderLaunchdPlist,
  renderSystemdUnit,
  resolveServiceExecutable,
  withUserLocalBinPath,
  type ServiceNodeProbe,
} from '../src/onboard/service.js';
import type { CommandRunner } from '../src/onboard/types.js';
import {
  buildServicePath,
  probeStandardExecDirs,
  resetRuntimeConfig,
  stateRoot,
  standardExecDirs,
  systemExecDirs,
  userLocalBinDirs,
  withServicePath,
} from '../src/platform/paths.js';
import { testSingleDispatcherFileObject } from './helpers/config.js';

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

class WorkingDirectoryOrderRunner extends InstallRunner {
  readonly registrationChecks: boolean[] = [];

  constructor(private readonly workingDirectory: string) {
    super();
  }

  override async run(
    command: string,
    args: string[],
    options: { dryRun?: boolean } = {},
  ): Promise<void> {
    if (
      !options.dryRun &&
      (command === 'systemctl' ||
        (command === 'launchctl' &&
          (args[0] === 'bootstrap' || args[0] === 'kickstart')))
    ) {
      this.registrationChecks.push(existsSync(this.workingDirectory));
    }
    await super.run(command, args, options);
  }
}

describe('managed service working directory ownership', () => {
  let root: string;
  let oldHome: string | undefined;
  let oldConfigDir: string | undefined;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'dreamux-service-working-dir-'));
    oldHome = process.env['HOME'];
    oldConfigDir = process.env['DREAMUX_CONFIG_DIR'];
    process.env['HOME'] = join(root, 'home');
    process.env['DREAMUX_ROOT'] = join(root, 'dreamux');
    process.env['DREAMUX_CONFIG_DIR'] = join(root, 'config');
    writeInstallConfig(join(root, 'config'));
  });

  afterEach(() => {
    restoreEnv('HOME', oldHome);
    restoreEnv('DREAMUX_CONFIG_DIR', oldConfigDir);
    resetRuntimeConfig();
    rmSync(root, { recursive: true, force: true });
  });

  it.each([
    ['linux', undefined],
    ['darwin', 501],
  ] as const)(
    'creates the state working directory before %s service registration',
    async (platform, uid) => {
      const workingDirectory = stateRoot();
      const runner = new WorkingDirectoryOrderRunner(workingDirectory);
      const nodeProbe: ServiceNodeProbe = {
        realpath: async (path) => path,
        isExecutable: async () => false,
      };

      const result = await runDaemonInstall({
        runner,
        platform,
        homeDir: join(root, 'home'),
        nodeProbe,
        env: {
          ...process.env,
          CODEX_HOST_CODEX_BIN: process.execPath,
        },
        ...(uid === undefined ? {} : { uid }),
      });

      expect(existsSync(workingDirectory)).toBe(true);
      expect(runner.registrationChecks.length).toBeGreaterThan(0);
      expect(runner.registrationChecks.every(Boolean)).toBe(true);
      expect(result.files).toContainEqual({
        path: workingDirectory,
        status: 'created',
        reason: 'managed service working directory',
      });
    },
  );

  it('reports the missing working directory without creating it on dry-run', async () => {
    const workingDirectory = stateRoot();
    const runner = new WorkingDirectoryOrderRunner(workingDirectory);
    const probed: string[] = [];

    const result = await runDaemonInstall({
      runner,
      platform: 'linux',
      homeDir: join(root, 'home'),
      dryRun: true,
      env: { ...process.env },
      execDirProbe: async (path) => {
        probed.push(path);
        return false;
      },
    });

    expect(existsSync(workingDirectory)).toBe(false);
    expect(runner.registrationChecks).toEqual([]);
    expect(probed).toEqual([LINUXBREW_BIN]);
    expect(result.files).toContainEqual({
      path: workingDirectory,
      status: 'created',
      reason: 'managed service working directory',
    });
  });
});

describe('daemon install (stable service Node, issue #83)', () => {
  let root: string;
  let oldHome: string | undefined;
  let oldConfigDir: string | undefined;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'dreamux-daemon-install-'));
    oldHome = process.env['HOME'];
    oldConfigDir = process.env['DREAMUX_CONFIG_DIR'];
    process.env['HOME'] = join(root, 'home');
    process.env['DREAMUX_ROOT'] = join(root, 'dreamux');
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
      isExecutable: async (path) => path === '/usr/local/bin/node',
    };

    await runDaemonInstall({
      runner,
      platform: 'linux',
      homeDir: join(root, 'home'),
      nodeProbe: stableNodeProbe,
      env: { ...process.env, CODEX_HOST_CODEX_BIN: process.execPath },
    });

    expect(readUnitNodeBin()).toBe('/usr/local/bin/node');
    expect(readUnitNodeBin()).not.toBe(process.execPath);
  });

  it('falls back to the current Node when no stable system Node exists', async () => {
    const runner = new InstallRunner();
    const noSystemNodeProbe: ServiceNodeProbe = {
      realpath: async (path) => path,
      isExecutable: async () => false,
    };

    await runDaemonInstall({
      runner,
      platform: 'linux',
      homeDir: join(root, 'home'),
      nodeProbe: noSystemNodeProbe,
      env: { ...process.env, CODEX_HOST_CODEX_BIN: process.execPath },
    });

    expect(readUnitNodeBin()).toBe(process.execPath);
  });
});

// ---------------------------------------------------------------------------
// Focused tests: managed-service PATH with captured session PATH
// ---------------------------------------------------------------------------

const localBin = (home: string) => join(home, '.local', 'bin');
const LINUXBREW_BIN = '/home/linuxbrew/.linuxbrew/bin';

function linuxFallbackDirs(
  home: string,
  includeLinuxbrew = false,
): string[] {
  return [
    ...standardExecDirs({ platform: 'linux', homeDir: home, env: {} }),
    ...(includeLinuxbrew ? [LINUXBREW_BIN] : []),
  ];
}

/** Synthetic session PATH entries that mimic nvm / pyenv / Homebrew layouts. */
const SESSION_PATH_PARTS = [
  '/home/example/.nvm/versions/node/v22.7.0/bin',
  '/home/example/.pyenv/shims',
  '/opt/homebrew/bin',
  '/usr/local/bin',
  '/usr/bin',
  '/bin',
];

const SESSION_PATH = SESSION_PATH_PARTS.join(delimiter);

function writeFakeBinary(dir: string, name: string): string {
  mkdirSync(dir, { recursive: true });
  const binPath = join(dir, name);
  writeFileSync(
    binPath,
    '#!/usr/bin/env node\n' +
      'const a = process.argv.slice(1);\n' +
      "if (a.includes('--version')) { console.log('v1.0.0'); process.exit(0); }\n" +
      'process.exit(0);\n',
    { mode: 0o755 },
  );
  chmodSync(binPath, 0o755);
  return binPath;
}

describe('buildServicePath ordering and deduplication', () => {
  it('stable dirs precede the captured session PATH, which precedes fallbacks', () => {
    const stableDirs = ['/opt/dreamux/bin', '/usr/local/bin'];
    const fallbackDirs = ['/home/example/.local/bin', '/usr/bin', '/bin'];
    const result = buildServicePath({
      stableDirs,
      sessionPath: SESSION_PATH,
      fallbackDirs,
    });
    const parts = result.split(delimiter);

    // Stable dirs lead, in their original order.
    expect(parts[0]).toBe('/opt/dreamux/bin');
    expect(parts[1]).toBe('/usr/local/bin');

    // The session PATH follows, in its original order (minus the already-seen
    // /usr/local/bin which is de-duplicated).
    const afterStable = parts.slice(2);
    expect(afterStable[0]).toBe('/home/example/.nvm/versions/node/v22.7.0/bin');
    expect(afterStable[1]).toBe('/home/example/.pyenv/shims');
    expect(afterStable[2]).toBe('/opt/homebrew/bin');
    // /usr/local/bin was already in stableDirs, so it is de-duplicated here.
    expect(afterStable[3]).toBe('/usr/bin');
    expect(afterStable[4]).toBe('/bin');

    // Fallback dirs come last (de-duplicated against what came before).
    expect(afterStable[5]).toBe('/home/example/.local/bin');
    // /usr/bin and /bin already seen, so they are de-duplicated.
    expect(afterStable.slice(6)).toEqual([]);

    // Total length = 2 stable + 5 unique session + 1 unique fallback.
    expect(parts).toHaveLength(8);
  });

  it('de-duplicates while preserving first occurrence', () => {
    const result = buildServicePath({
      stableDirs: ['/a', '/b'],
      sessionPath: ['/b', '/c', '/a'].join(delimiter),
      fallbackDirs: ['/c', '/d'],
    });
    expect(result.split(delimiter)).toEqual(['/a', '/b', '/c', '/d']);
  });

  it('handles an empty session PATH without empty entries', () => {
    const result = buildServicePath({
      stableDirs: ['/a'],
      sessionPath: '',
      fallbackDirs: ['/b'],
    });
    expect(result.split(delimiter)).toEqual(['/a', '/b']);
  });
});

describe('userLocalBinDirs and systemExecDirs (explicit deterministic fallbacks)', () => {
  it('userLocalBinDirs honors XDG_BIN_HOME then $HOME/.local/bin', () => {
    const home = '/home/example';
    // Without XDG_BIN_HOME: only $HOME/.local/bin.
    expect(userLocalBinDirs({ platform: 'linux', homeDir: home, env: {} })).toEqual([
      localBin(home),
    ]);
    // With XDG_BIN_HOME: it leads, then $HOME/.local/bin.
    expect(
      userLocalBinDirs({ platform: 'linux', homeDir: home, env: { XDG_BIN_HOME: '/opt/userbin' } }),
    ).toEqual(['/opt/userbin', localBin(home)]);
    // Empty XDG_BIN_HOME is treated as unset.
    expect(
      userLocalBinDirs({ platform: 'linux', homeDir: home, env: { XDG_BIN_HOME: '' } }),
    ).toEqual([localBin(home)]);
  });

  it('systemExecDirs are deterministic and exclude optional Homebrew prefixes', () => {
    expect(systemExecDirs('darwin')).toEqual(['/usr/local/bin', '/usr/bin', '/bin']);
    expect(systemExecDirs('linux')).toEqual(['/usr/local/bin', '/usr/bin', '/bin']);
  });

  it('standardExecDirs combines user-local + system in order', () => {
    const home = '/home/example';
    const dirs = standardExecDirs({ platform: 'linux', homeDir: home, env: {} });
    expect(dirs).toEqual([
      localBin(home),
      '/usr/local/bin',
      '/usr/bin',
      '/bin',
    ]);
  });

  it('adds the platform Homebrew candidate only when the async probe finds it', async () => {
    const home = '/home/example';
    const absentProbes: string[] = [];
    await expect(
      probeStandardExecDirs(
        { platform: 'linux', homeDir: home, env: {} },
        async (path) => {
          absentProbes.push(path);
          return false;
        },
      ),
    ).resolves.toEqual(linuxFallbackDirs(home));
    expect(absentProbes).toEqual([LINUXBREW_BIN]);

    const presentProbes: string[] = [];
    await expect(
      probeStandardExecDirs(
        { platform: 'linux', homeDir: home, env: {} },
        async (path) => {
          presentProbes.push(path);
          return true;
        },
      ),
    ).resolves.toEqual(linuxFallbackDirs(home, true));
    expect(presentProbes).toEqual([LINUXBREW_BIN]);

    const darwinHome = '/Users/example';
    const darwinProbes: string[] = [];
    await expect(
      probeStandardExecDirs(
        { platform: 'darwin', homeDir: darwinHome, env: {} },
        async (path) => {
          darwinProbes.push(path);
          return true;
        },
      ),
    ).resolves.toEqual([
      localBin(darwinHome),
      '/usr/local/bin',
      '/usr/bin',
      '/bin',
      '/opt/homebrew/bin',
    ]);
    expect(darwinProbes).toEqual(['/opt/homebrew/bin']);
  });
});

describe('withUserLocalBinPath (resolve-time effective PATH)', () => {
  it('includes the captured session PATH ahead of fallbacks and never mutates process.env', () => {
    const home = '/home/example';
    const before = process.env['PATH'];
    const fallbackDirs = linuxFallbackDirs(home, true);
    const env = withUserLocalBinPath({ PATH: SESSION_PATH }, fallbackDirs);
    // process.env is untouched.
    expect(process.env['PATH']).toBe(before);

    const parts = env['PATH']?.split(delimiter) ?? [];
    // Session PATH entries lead (in order).
    expect(parts.slice(0, 6)).toEqual(SESSION_PATH_PARTS);
    // Fallback dirs follow.
    expect(parts).toContain(localBin(home));
    expect(parts).toContain(LINUXBREW_BIN);
    // De-duplicated: a second call yields the same PATH.
    const again = withUserLocalBinPath(env, fallbackDirs);
    expect(again['PATH']).toBe(env['PATH']);
  });

  it('works with an empty session PATH (fresh install)', () => {
    const home = '/home/example';
    const env = withUserLocalBinPath({ PATH: '' }, linuxFallbackDirs(home));
    const parts = env['PATH']?.split(delimiter) ?? [];
    // Only fallback dirs, no empty entries.
    expect(parts).toContain(localBin(home));
    expect(parts).not.toContain('');
  });
});

describe('withServicePath does not mutate process.env or the input env', () => {
  it('returns a fresh object and leaves process.env and the input env untouched', () => {
    const inputEnv = { PATH: '/usr/bin:/bin', FOO: 'bar' };
    const beforeProcess = process.env['PATH'];
    const result = withServicePath(inputEnv, {
      stableDirs: ['/opt/dreamux/bin'],
      sessionPath: '/home/example/.nvm/versions/node/v22.7.0/bin',
      fallbackDirs: ['/home/example/.local/bin'],
    });

    // Input env is not mutated.
    expect(inputEnv).toEqual({ PATH: '/usr/bin:/bin', FOO: 'bar' });
    // process.env is not mutated.
    expect(process.env['PATH']).toBe(beforeProcess);
    // Result is a fresh object with the merged PATH and other env vars kept.
    expect(result['FOO']).toBe('bar');
    expect(result['PATH']?.split(delimiter)).toEqual([
      '/opt/dreamux/bin',
      '/home/example/.nvm/versions/node/v22.7.0/bin',
      '/home/example/.local/bin',
    ]);
  });
});

describe('provider binary resolution from captured session PATH', () => {
  let root: string;
  let oldHome: string | undefined;
  let oldPath: string | undefined;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'dreamux-session-path-'));
    oldHome = process.env['HOME'];
    oldPath = process.env['PATH'];
    process.env['HOME'] = join(root, 'home');
    process.env['DREAMUX_ROOT'] = join(root, 'dreamux');
  });

  afterEach(() => {
    if (oldHome === undefined) delete process.env['HOME'];
    else process.env['HOME'] = oldHome;
    delete process.env['DREAMUX_ROOT'];
    if (oldPath === undefined) delete process.env['PATH'];
    else process.env['PATH'] = oldPath;
    resetRuntimeConfig();
    rmSync(root, { recursive: true, force: true });
  });

  it('resolves a bare binary only present in the captured session PATH', async () => {
    const home = join(root, 'home');
    // A synthetic nvm-style dir that is NOT a fallback dir.
    const nvmBinDir = join(home, '.nvm', 'versions', 'node', 'v22.7.0', 'bin');
    const binPath = writeFakeBinary(nvmBinDir, 'local-agent');
    const sessionPath = [nvmBinDir, '/usr/bin', '/bin'].join(delimiter);

    // Without the session PATH entry, the bare binary is not resolvable.
    await expect(
      resolveServiceExecutable('local-agent', { PATH: '/usr/bin:/bin' }),
    ).rejects.toThrow();

    // With the session PATH captured via withUserLocalBinPath, it resolves.
    const resolved = await resolveServiceExecutable(
      'local-agent',
      withUserLocalBinPath(
        { PATH: sessionPath },
        linuxFallbackDirs(home),
      ),
    );
    expect(resolved).toBe(binPath);
  });

  it('resolves a bare binary in $HOME/.local/bin (fallback) when session PATH lacks it', async () => {
    const home = join(root, 'home');
    const binPath = writeFakeBinary(localBin(home), 'local-agent');

    // Session PATH does not include .local/bin; the fallback dirs do.
    const resolved = await resolveServiceExecutable(
      'local-agent',
      withUserLocalBinPath(
        { PATH: '/usr/bin:/bin' },
        linuxFallbackDirs(home),
      ),
    );
    expect(resolved).toBe(binPath);
  });
});

describe('captured session PATH appears in systemd and launchd service config', () => {
  const home = '/home/example';

  function baseAnswers(env: NodeJS.ProcessEnv) {
    return {
      configDir: join(home, '.dreamux'),
      dreamuxBin: '/usr/local/bin/dreamux',
      nodeBin: '/usr/local/bin/node',
      providerBinChecks: [],
      startService: true,
      dryRun: false,
      homeDir: home,
      env,
      fallbackDirs: linuxFallbackDirs(home, true),
    };
  }

  it('systemd Environment=PATH includes the captured session PATH entries', () => {
    const unit = renderSystemdUnit(
      baseAnswers({ PATH: SESSION_PATH }),
      '/tmp/stdout.log',
      '/tmp/stderr.log',
    );
    const pathLine = unit
      .split('\n')
      .find((l) => l.startsWith('Environment=PATH='))
      ?.slice('Environment=PATH='.length) ?? '';
    const parts = pathLine.split(delimiter);
    // Stable dirs lead.
    expect(parts[0]).toBe('/usr/local/bin'); // dirname(nodeBin)
    // Session PATH entries are present and in order.
    expect(parts).toContain('/home/example/.nvm/versions/node/v22.7.0/bin');
    expect(parts).toContain('/home/example/.pyenv/shims');
    expect(parts).toContain('/opt/homebrew/bin');
    // Fallback dirs are present.
    expect(parts).toContain(localBin(home));
    expect(parts).toContain(LINUXBREW_BIN);
    // De-duplicated: /usr/local/bin appears exactly once.
    expect(parts.filter((p) => p === '/usr/local/bin')).toHaveLength(1);
  });

  it('launchd EnvironmentVariables PATH includes the captured session PATH entries', () => {
    const plist = renderLaunchdPlist(
      baseAnswers({ PATH: SESSION_PATH }),
      '/tmp/stdout.log',
      '/tmp/stderr.log',
    );
    // The plist build returns a string; extract the PATH from the managed env
    // directly (the same source the plist renders).
    const env = managedServiceEnvironment(baseAnswers({ PATH: SESSION_PATH }));
    const parts = (env['PATH'] ?? '').split(delimiter);
    expect(parts[0]).toBe('/usr/local/bin');
    expect(parts).toContain('/home/example/.nvm/versions/node/v22.7.0/bin');
    expect(parts).toContain('/home/example/.pyenv/shims');
    expect(parts).toContain('/opt/homebrew/bin');
    expect(parts).toContain(localBin(home));
    // Sanity: the plist string itself contains the PATH.
    expect(plist).toContain('PATH');
  });
});

describe('re-running daemon install refreshes the persisted service PATH', () => {
  let root: string;
  let oldHome: string | undefined;
  let oldConfigDir: string | undefined;
  let oldPath: string | undefined;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'dreamux-rerun-path-'));
    oldHome = process.env['HOME'];
    oldConfigDir = process.env['DREAMUX_CONFIG_DIR'];
    oldPath = process.env['PATH'];
    process.env['HOME'] = join(root, 'home');
    process.env['DREAMUX_ROOT'] = join(root, 'dreamux');
    process.env['DREAMUX_CONFIG_DIR'] = join(root, 'config');
    writeInstallConfig(join(root, 'config'));
  });

  afterEach(() => {
    restoreEnv('HOME', oldHome);
    restoreEnv('DREAMUX_CONFIG_DIR', oldConfigDir);
    restoreEnv('PATH', oldPath);
    resetRuntimeConfig();
    rmSync(root, { recursive: true, force: true });
  });

  function readUnitPath(): string {
    const unit = readFileSync(
      join(root, 'home', '.config', 'systemd', 'user', 'dreamux.service'),
      'utf8',
    );
    const line = unit.split('\n').find((l) => l.startsWith('Environment=PATH='));
    return line?.slice('Environment=PATH='.length) ?? '';
  }

  it('regenerates the unit PATH when the supplied session PATH changes', async () => {
    const runner = new InstallRunner();
    const nodeProbe: ServiceNodeProbe = {
      realpath: async (p) => p,
      isExecutable: async () => false,
    };
    const home = join(root, 'home');

    // First install with session PATH A.
    const pathA = [join(home, '.nvm', 'versions', 'node', 'v22.7.0', 'bin'), '/usr/bin'].join(
      delimiter,
    );
    await runDaemonInstall({
      runner,
      platform: 'linux',
      homeDir: home,
      nodeProbe,
      env: { PATH: pathA, HOME: home, CODEX_HOST_CODEX_BIN: process.execPath },
    });
    const unitPathA = readUnitPath();
    expect(unitPathA).toContain(join(home, '.nvm', 'versions', 'node', 'v22.7.0', 'bin'));

    // Second install with session PATH B (different nvm version).
    const pathB = [join(home, '.nvm', 'versions', 'node', 'v24.1.0', 'bin'), '/usr/bin'].join(
      delimiter,
    );
    await runDaemonInstall({
      runner,
      platform: 'linux',
      homeDir: home,
      nodeProbe,
      env: { PATH: pathB, HOME: home, CODEX_HOST_CODEX_BIN: process.execPath },
    });
    const unitPathB = readUnitPath();
    expect(unitPathB).toContain(join(home, '.nvm', 'versions', 'node', 'v24.1.0', 'bin'));
    expect(unitPathB).not.toContain(join(home, '.nvm', 'versions', 'node', 'v22.7.0', 'bin'));
    expect(unitPathB).not.toBe(unitPathA);
  });

  it('probes Linuxbrew once per install and persists it only when present', async () => {
    const runner = new InstallRunner();
    const nodeProbe: ServiceNodeProbe = {
      realpath: async (path) => path,
      isExecutable: async () => false,
    };
    const home = join(root, 'home');
    const env = {
      PATH: '/usr/bin:/bin',
      HOME: home,
      CODEX_HOST_CODEX_BIN: process.execPath,
    };
    const probes: string[] = [];

    await runDaemonInstall({
      runner,
      platform: 'linux',
      homeDir: home,
      nodeProbe,
      env,
      execDirProbe: async (path) => {
        probes.push(path);
        return false;
      },
    });
    expect(probes).toEqual([LINUXBREW_BIN]);
    expect(readUnitPath().split(delimiter)).not.toContain(LINUXBREW_BIN);

    probes.length = 0;
    await runDaemonInstall({
      runner,
      platform: 'linux',
      homeDir: home,
      nodeProbe,
      env,
      execDirProbe: async (path) => {
        probes.push(path);
        return true;
      },
    });
    expect(probes).toEqual([LINUXBREW_BIN]);
    expect(readUnitPath().split(delimiter)).toContain(LINUXBREW_BIN);
  });
});

// Regression: runDaemonInstall must persist the effective resolved env
// (options.env ?? process.env) into the service answers, NOT the raw
// options.env. In normal CLI use options.env is undefined, so the ambient
// process.env PATH must be captured into the generated unit.
describe('normal CLI invocation captures ambient process.env PATH (options.env omitted)', () => {
  let root: string;
  let oldHome: string | undefined;
  let oldConfigDir: string | undefined;
  let oldPath: string | undefined;
  let oldCodexBin: string | undefined;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'dreamux-ambient-path-'));
    oldHome = process.env['HOME'];
    oldConfigDir = process.env['DREAMUX_CONFIG_DIR'];
    oldPath = process.env['PATH'];
    oldCodexBin = process.env['CODEX_HOST_CODEX_BIN'];
    process.env['HOME'] = join(root, 'home');
    process.env['DREAMUX_ROOT'] = join(root, 'dreamux');
    process.env['DREAMUX_CONFIG_DIR'] = join(root, 'config');
    // Normal CLI use: the host codex binary is in the ambient environment.
    process.env['CODEX_HOST_CODEX_BIN'] = process.execPath;
    writeInstallConfig(join(root, 'config'));
  });

  afterEach(() => {
    restoreEnv('HOME', oldHome);
    restoreEnv('DREAMUX_CONFIG_DIR', oldConfigDir);
    restoreEnv('PATH', oldPath);
    restoreEnv('CODEX_HOST_CODEX_BIN', oldCodexBin);
    resetRuntimeConfig();
    rmSync(root, { recursive: true, force: true });
  });

  it('captures the ambient process.env PATH into the systemd unit when options.env is omitted', async () => {
    const runner = new InstallRunner();
    const nodeProbe: ServiceNodeProbe = {
      realpath: async (p) => p,
      isExecutable: async () => false,
    };
    const home = join(root, 'home');
    // Synthetic nvm/pyenv dirs — NOT fallback dirs, so they can only come from
    // the captured session PATH, not from standardExecDirs.
    const nvmBin = join(home, '.nvm', 'versions', 'node', 'v22.7.0', 'bin');
    const pyenvShims = join(home, '.pyenv', 'shims');
    process.env['PATH'] = [nvmBin, pyenvShims, '/usr/bin', '/bin'].join(delimiter);

    // No env option: normal CLI use falls back to process.env.
    await runDaemonInstall({
      runner,
      platform: 'linux',
      homeDir: home,
      nodeProbe,
    });

    const unitPath = readUnitPathFrom(root);
    expect(unitPath).toContain(nvmBin);
    expect(unitPath).toContain(pyenvShims);
    // Stable dirs still lead the PATH.
    expect(unitPath.split(delimiter)[0]).toBe(dirname(process.execPath));
    // Fallback dirs are present last.
    expect(unitPath).toContain(localBin(home));
  });

  it('captures the ambient process.env PATH into the launchd plist when options.env is omitted', async () => {
    const runner = new InstallRunner();
    const nodeProbe: ServiceNodeProbe = {
      realpath: async (p) => p,
      isExecutable: async () => false,
    };
    const home = join(root, 'home');
    const nvmBin = join(home, '.nvm', 'versions', 'node', 'v22.7.0', 'bin');
    const pyenvShims = join(home, '.pyenv', 'shims');
    process.env['PATH'] = [nvmBin, pyenvShims, '/usr/bin', '/bin'].join(delimiter);

    // No env option: normal CLI use falls back to process.env.
    await runDaemonInstall({
      runner,
      platform: 'darwin',
      homeDir: home,
      nodeProbe,
      uid: 501,
    });

    const plistPath = join(home, 'Library', 'LaunchAgents', 'dev.excited.dreamux.plist');
    const plist = parsePlist(readFileSync(plistPath, 'utf8')) as Record<string, any>;
    const servicePath: string = plist['EnvironmentVariables']['PATH'] ?? '';
    const parts = servicePath.split(delimiter);
    expect(parts[0]).toBe(dirname(process.execPath));
    expect(parts).toContain(nvmBin);
    expect(parts).toContain(pyenvShims);
    expect(parts).toContain(localBin(home));
  });

  it('still works with an explicit env (existing behavior preserved)', async () => {
    const runner = new InstallRunner();
    const nodeProbe: ServiceNodeProbe = {
      realpath: async (p) => p,
      isExecutable: async () => false,
    };
    const home = join(root, 'home');
    const explicitNvm = join(home, '.nvm', 'versions', 'node', 'v24.1.0', 'bin');
    const explicitEnv = {
      PATH: [explicitNvm, '/usr/bin', '/bin'].join(delimiter),
      HOME: home,
      CODEX_HOST_CODEX_BIN: process.execPath,
    };

    await runDaemonInstall({
      runner,
      platform: 'linux',
      homeDir: home,
      nodeProbe,
      env: explicitEnv,
    });

    const unitPath = readUnitPathFrom(root);
    // Explicit env PATH is captured.
    expect(unitPath).toContain(explicitNvm);
    // Ambient process.env PATH (set in a different test) is NOT leaked in.
    expect(unitPath).not.toContain(join(home, '.nvm', 'versions', 'node', 'v22.7.0', 'bin'));
  });
});

describe('daemon install resolves bare provider bins and includes them in the service PATH', () => {
  let root: string;
  let oldHome: string | undefined;
  let oldConfigDir: string | undefined;
  let oldPath: string | undefined;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'dreamux-provider-bin-'));
    oldHome = process.env['HOME'];
    oldConfigDir = process.env['DREAMUX_CONFIG_DIR'];
    oldPath = process.env['PATH'];
    process.env['HOME'] = join(root, 'home');
    process.env['DREAMUX_ROOT'] = join(root, 'dreamux');
    process.env['DREAMUX_CONFIG_DIR'] = join(root, 'config');
  });

  afterEach(() => {
    if (oldHome === undefined) delete process.env['HOME'];
    else process.env['HOME'] = oldHome;
    delete process.env['DREAMUX_ROOT'];
    if (oldConfigDir === undefined) delete process.env['DREAMUX_CONFIG_DIR'];
    else process.env['DREAMUX_CONFIG_DIR'] = oldConfigDir;
    if (oldPath === undefined) delete process.env['PATH'];
    else process.env['PATH'] = oldPath;
    resetRuntimeConfig();
    rmSync(root, { recursive: true, force: true });
  });

  it('daemon install resolves a bare local-agent in $HOME/.local/bin and includes it in the service PATH', async () => {
    const home = join(root, 'home');
    const binPath = writeFakeBinary(localBin(home), 'local-agent');
    // Strip any .local/bin from the ambient PATH so resolution must come from
    // the user-local bin dir addition (mirrors a fresh/Docker environment).
    process.env['PATH'] = (oldPath ?? '')
      .split(delimiter)
      .filter((p) => p && !p.endsWith('.local/bin'))
      .join(delimiter);
    writeInstallConfig(join(root, 'config'), { bin: 'local-agent' });

    const runner = new InstallRunner();
    const nodeProbe: ServiceNodeProbe = {
      realpath: async (p) => p,
      isExecutable: async () => false,
    };

    await runDaemonInstall({
      runner,
      platform: 'linux',
      homeDir: home,
      nodeProbe,
      env: { ...process.env, HOME: home },
    });

    const servicePath = readUnitPathFrom(root);
    expect(servicePath).toContain(localBin(home));
    expect(servicePath).toContain(dirname(process.execPath));
    // De-duplicated: the user-local bin dir appears exactly once.
    expect(servicePath.split(delimiter).filter((p) => p === localBin(home))).toHaveLength(1);
    expect(binPath).toBe(join(localBin(home), 'local-agent'));
  });
});

function readUnitPathFrom(root: string): string {
  const unit = readFileSync(
    join(root, 'home', '.config', 'systemd', 'user', 'dreamux.service'),
    'utf8',
  );
  const line = unit.split('\n').find((l) => l.startsWith('Environment=PATH='));
  return line?.slice('Environment=PATH='.length) ?? '';
}

function writeInstallConfig(
  configDir: string,
  codexOverride: { bin?: string } = {},
): void {
  mkdirSync(configDir, { recursive: true });
  writeFileSync(
    join(configDir, 'config.json'),
    // The codex binary path normally comes from each agent's config.bin;
    // CODEX_HOST_CODEX_BIN is only an optional host-level override. These tests
    // set that override to process.execPath so the managed-service launch check
    // resolves to a runnable absolute path, unless a codex override names a
    // different (e.g. bare 'local-agent') binary.
    JSON.stringify(
      testSingleDispatcherFileObject({
        id: 'flow',
        cwd: join(dirname(configDir), 'cwd'),
        enabled: true,
        feishu: { app_id: 'app-test', app_secret: 'secret-test' },
        codex: {
          approval_policy: 'never',
          sandbox_mode: 'workspace-write',
          extra_args: [],
          extra_env: {},
          ...codexOverride,
        },
      }),
    ),
    { mode: 0o600 },
  );
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
