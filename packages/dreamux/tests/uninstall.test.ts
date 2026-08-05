import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, sep } from 'node:path';
import {
  runUninstall,
  type UninstallRunResult,
} from '../src/onboard/uninstall.js';
import { ensureDirectory, TransparentFileLedger } from '../src/onboard/ledger.js';
import type { CommandRunner } from '../src/onboard/types.js';
import { createUninstallCommand } from '../src/cli/commands/uninstall.js';
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
  onRun: (() => void | Promise<void>) | null = null;
  async run(command: string, args: string[]): Promise<void> {
    this.calls.push({ command, args });
    await this.onRun?.();
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
function expectPathEntryAbsent(path: string): void {
  let code: unknown;
  try {
    lstatSync(path);
  } catch (err) {
    code = (err as { code?: unknown }).code;
  }
  expect(code).toBe('ENOENT');
}
function expectPathEntryExists(path: string): void {
  expect(lstatSync(path)).toBeDefined();
}
function writeEmptyConfig(dir: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'config.json'), JSON.stringify({}), { mode: 0o600 });
}
function writeSystemdService(homeDir: string): string {
  const servicePath = join(homeDir, '.config', 'systemd', 'user', 'dreamux.service');
  mkdirSync(dirname(servicePath), { recursive: true });
  writeFileSync(servicePath, '[Service]\nExecStart=dreamux serve\n');
  return servicePath;
}
function expectRemovedEntry(
  result: UninstallRunResult,
  path: string,
  reason: string,
  targetPath?: string,
): void {
  expect(result.entries).toEqual(expect.arrayContaining([
    expect.objectContaining({
      status: 'removed',
      path,
      reason,
      ...(targetPath === undefined ? {} : { targetPath }),
    }),
  ]));
}
async function expectLedgerCanCreate(path: string): Promise<void> {
  const ledger = new TransparentFileLedger();
  await ensureDirectory(path, ledger, 'dreamux config directory');
  expect(lstatSync(path).isDirectory()).toBe(true);
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
    process.env['DREAMUX_ROOT'] = join(root, 'dreamux');
    process.env['DREAMUX_CONFIG_DIR'] = dreamuxRoot();
  });
  afterEach(() => {
    if (previousConfigDir === undefined) delete process.env['DREAMUX_CONFIG_DIR'];
    else process.env['DREAMUX_CONFIG_DIR'] = previousConfigDir;
    if (previousHome === undefined) delete process.env['HOME'];
    else process.env['HOME'] = previousHome;
    delete process.env['DREAMUX_ROOT'];
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
        expect.objectContaining({
          status: 'removed',
          path: configDir,
          reason: 'dreamux config directory',
        }),
        expect.objectContaining({
          status: 'removed',
          path: servicePath,
          reason: 'systemd unit',
        }),
        expect.objectContaining({
          status: 'removed',
          path: dreamuxRoot(),
          reason: 'dreamux home directory',
        }),
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
        expect.objectContaining({
          status: 'removed',
          path: dreamuxRoot(),
          reason: 'dreamux home directory',
        }),
        expect.objectContaining({
          status: 'removed',
          path: servicePath,
          reason: 'systemd unit',
        }),
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
  it('removes a Dreamux-root leaf symlink and allows ledger mkdir to recreate it', async () => {
    const homeDir = join(root, 'home');
    const externalDreamux = join(root, 'external-dreamux');
    mkdirSync(dirname(dreamuxRoot()), { recursive: true });
    writeEmptyConfig(externalDreamux);
    writeFileSync(join(externalDreamux, 'sentinel'), 'remove me\n');
    writeSystemdService(homeDir);
    symlinkSync(externalDreamux, dreamuxRoot());
    const externalDreamuxTarget = realpathSync(externalDreamux);
    const result = await runUninstall({
      runner: new FakeRunner(),
      platform: 'linux',
      homeDir,
    });
    expect(existsSync(externalDreamux)).toBe(false);
    expectPathEntryAbsent(dreamuxRoot());
    expectRemovedEntry(result, dreamuxRoot(), 'dreamux home directory', externalDreamuxTarget);
    await expectLedgerCanCreate(dreamuxRoot());
  });
  it('removes an already dangling Dreamux-root leaf symlink and allows ledger mkdir', async () => {
    const homeDir = join(root, 'home');
    const missingTarget = join(root, 'missing-dreamux-target');
    mkdirSync(dirname(dreamuxRoot()), { recursive: true });
    symlinkSync(missingTarget, dreamuxRoot());
    const result = await runUninstall({
      runner: new FakeRunner(),
      platform: 'linux',
      homeDir,
    });
    expect(existsSync(missingTarget)).toBe(false);
    expectPathEntryAbsent(dreamuxRoot());
    expectRemovedEntry(result, dreamuxRoot(), 'dreamux home directory');
    await expectLedgerCanCreate(dreamuxRoot());
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
        expect.objectContaining({
          status: 'removed',
          path: servicePath,
          reason: 'launchd unit',
        }),
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
  it('refuses recursive deletion targets that overlap protected roots', async () => {
    const runner = new FakeRunner();
    const homeDir = join(root, 'home');
    const protectedCwdAncestor = process.cwd().split(sep).slice(0, -1).join(sep) || sep;
    const cases = [
      { path: homedir(), match: /refusing to remove unsafe dreamux config directory/ },
      { path: dirname(homedir()), match: /refusing to remove unsafe dreamux config directory/ },
      { path: process.cwd(), match: /refusing to remove unsafe dreamux config directory/ },
      { path: protectedCwdAncestor, match: /refusing to remove unsafe dreamux config directory/ },
      { path: join(homedir(), '.codex'), match: /operator Codex\/Claude state/ },
      { path: join(homedir(), '.codex', 'sessions'), match: /operator Codex\/Claude state/ },
      { path: dirname(join(homedir(), '.codex')), match: /refusing to remove unsafe dreamux config directory/ },
    ];
    for (const testCase of cases) {
      await expect(
        runUninstall({
          configDir: testCase.path,
          runner,
          platform: 'linux',
          homeDir,
        }),
      ).rejects.toThrow(testCase.match);
    }
    expect(runner.calls).toEqual([]);
  });
  it('removes a safe external config directory under HOME', async () => {
    const homeDir = join(root, 'home');
    const configDir = join(homedir(), '.config', 'dreamux');
    mkdirSync(dreamuxRoot(), { recursive: true });
    writeEmptyConfig(configDir);
    writeSystemdService(homeDir);
    const result = await runUninstall({
      configDir,
      runner: new FakeRunner(),
      platform: 'linux',
      homeDir,
    });
    expect(existsSync(configDir)).toBe(false);
    expect(existsSync(dreamuxRoot())).toBe(false);
    expectRemovedEntry(result, configDir, 'dreamux config directory');
    expectRemovedEntry(result, dreamuxRoot(), 'dreamux home directory');
  });
  it('refuses symlink-prefixed targets that physically overlap operator state', async () => {
    const runner = new FakeRunner();
    const homeDir = join(root, 'home');
    const aliasHome = join(root, 'alias-home');
    const sentinel = join(homedir(), '.codex', 'sentinel');
    mkdirSync(join(homedir(), '.codex'), { recursive: true });
    writeFileSync(sentinel, 'keep\n');
    symlinkSync(homeDir, aliasHome);
    await expect(
      runUninstall({
        configDir: join(aliasHome, '.codex'),
        runner,
        platform: 'linux',
        homeDir,
      }),
    ).rejects.toThrow(/operator Codex\/Claude state/);
    expect(existsSync(sentinel)).toBe(true);
    expect(runner.calls).toEqual([]);
  });
  it('refuses outbound leaf symlinks located inside operator state before service changes', async () => {
    const homeDir = join(root, 'home');
    for (const stateDir of ['.codex', '.claude']) {
      const runner = new FakeRunner();
      const externalConfigDir = join(root, `safe-${stateDir.slice(1)}-config`);
      const configAlias = join(homedir(), stateDir, 'dreamux-config');
      mkdirSync(dirname(configAlias), { recursive: true });
      writeEmptyConfig(externalConfigDir);
      symlinkSync(externalConfigDir, configAlias);
      await expect(
        runUninstall({
          configDir: configAlias,
          runner,
          platform: 'linux',
          homeDir,
        }),
      ).rejects.toThrow(/operator Codex\/Claude state/);
      expect(runner.calls).toEqual([]);
      expect(existsSync(externalConfigDir)).toBe(true);
      expectPathEntryExists(configAlias);
      expect(readlinkSync(configAlias)).toBe(externalConfigDir);
    }
  });
  it('unlinks a same-location leaf symlink without inode/readlink identity machinery', async () => {
    const homeDir = join(root, 'home');
    const externalConfigDir = join(root, 'external-config');
    const configAlias = join(root, 'config-link');
    writeEmptyConfig(externalConfigDir);
    symlinkSync(externalConfigDir, configAlias);
    const runner = new FakeRunner();
    let replaced = false;
    runner.onRun = () => {
      if (replaced) return;
      replaced = true;
      unlinkSync(configAlias);
      symlinkSync(externalConfigDir, configAlias);
    };
    const result = await runUninstall({
      configDir: configAlias,
      runner,
      platform: 'linux',
      homeDir,
    });
    expect(existsSync(externalConfigDir)).toBe(false);
    expectPathEntryAbsent(configAlias);
    expectRemovedEntry(result, configAlias, 'dreamux config directory');
  });
  it('does not unlink a logical alias after its prefix is retargeted', async () => {
    const homeDir = join(root, 'home');
    const prefixAlias = join(root, 'config-prefix');
    const initialParent = join(root, 'initial-parent');
    const nextParent = join(root, 'next-parent');
    const externalConfigDir = join(root, 'external-config');
    const nextConfigDir = join(root, 'next-config');
    const configDir = join(prefixAlias, 'dreamux-config');
    const initialLeaf = join(initialParent, 'dreamux-config');
    const nextLeaf = join(nextParent, 'dreamux-config');
    mkdirSync(initialParent, { recursive: true });
    mkdirSync(nextParent, { recursive: true });
    mkdirSync(externalConfigDir, { recursive: true });
    mkdirSync(nextConfigDir, { recursive: true });
    writeFileSync(join(externalConfigDir, 'config.json'), JSON.stringify({}), {
      mode: 0o600,
    });
    symlinkSync(initialParent, prefixAlias);
    symlinkSync(externalConfigDir, initialLeaf);
    const runner = new FakeRunner();
    let retargeted = false;
    runner.onRun = () => {
      if (retargeted) return;
      retargeted = true;
      unlinkSync(prefixAlias);
      symlinkSync(nextParent, prefixAlias);
      symlinkSync(nextConfigDir, nextLeaf);
    };
    await runUninstall({
      configDir,
      runner,
      platform: 'linux',
      homeDir,
    });
    expect(existsSync(externalConfigDir)).toBe(false);
    expectPathEntryAbsent(initialLeaf);
    expectPathEntryExists(prefixAlias);
    expect(readlinkSync(prefixAlias)).toBe(nextParent);
    expectPathEntryExists(nextLeaf);
    expect(readlinkSync(nextLeaf)).toBe(nextConfigDir);
    expect(existsSync(nextConfigDir)).toBe(true);
  });
  it('removes a lexically nested config directory that symlinks outside Dreamux home', async () => {
    const homeDir = join(root, 'home');
    const externalConfigDir = join(root, 'external-config');
    const nestedConfigDir = join(dreamuxRoot(), 'nested-config');
    const sentinel = join(externalConfigDir, 'sentinel');
    mkdirSync(dirname(nestedConfigDir), { recursive: true });
    writeEmptyConfig(externalConfigDir);
    writeFileSync(sentinel, 'remove me\n');
    writeSystemdService(homeDir);
    symlinkSync(externalConfigDir, nestedConfigDir);
    const externalConfigTarget = realpathSync(externalConfigDir);
    const result = await runUninstall({
      configDir: nestedConfigDir,
      runner: new FakeRunner(),
      platform: 'linux',
      homeDir,
    });
    expect(existsSync(externalConfigDir)).toBe(false);
    expect(existsSync(dreamuxRoot())).toBe(false);
    expectRemovedEntry(result, nestedConfigDir, 'dreamux config directory', externalConfigTarget);
    expectRemovedEntry(result, dreamuxRoot(), 'dreamux home directory');
  });
  it('removes an external config leaf symlink after deleting its physical target', async () => {
    const homeDir = join(root, 'home');
    const externalConfigDir = join(root, 'external-config');
    const configAlias = join(root, 'config-link');
    writeEmptyConfig(externalConfigDir);
    writeFileSync(join(externalConfigDir, 'sentinel'), 'remove me\n');
    writeSystemdService(homeDir);
    symlinkSync(externalConfigDir, configAlias);
    const externalConfigTarget = realpathSync(externalConfigDir);
    const result = await runUninstall({
      configDir: configAlias,
      runner: new FakeRunner(),
      platform: 'linux',
      homeDir,
    });
    expect(existsSync(externalConfigDir)).toBe(false);
    expectPathEntryAbsent(configAlias);
    expectRemovedEntry(result, configAlias, 'dreamux config directory', externalConfigTarget);
  });
  it('removes an already dangling external config leaf symlink', async () => {
    const homeDir = join(root, 'home');
    const missingTarget = join(root, 'missing-config-target');
    const configAlias = join(root, 'config-link');
    symlinkSync(missingTarget, configAlias);
    const result = await runUninstall({
      configDir: configAlias,
      runner: new FakeRunner(),
      platform: 'linux',
      homeDir,
    });
    expect(existsSync(missingTarget)).toBe(false);
    expectPathEntryAbsent(configAlias);
    expectRemovedEntry(result, configAlias, 'dreamux config directory');
    await expectLedgerCanCreate(configAlias);
  });
  it('removes all logical leaf symlinks sharing one physical target once', async () => {
    const homeDir = join(root, 'home');
    const physicalRoot = join(root, 'physical-dreamux');
    const configAlias = join(root, 'config-link');
    mkdirSync(dirname(dreamuxRoot()), { recursive: true });
    writeEmptyConfig(physicalRoot);
    writeFileSync(join(physicalRoot, 'sentinel'), 'remove me\n');
    symlinkSync(physicalRoot, dreamuxRoot());
    symlinkSync(physicalRoot, configAlias);
    const physicalTarget = realpathSync(physicalRoot);
    const result = await runUninstall({
      configDir: configAlias,
      runner: new FakeRunner(),
      platform: 'linux',
      homeDir,
    });
    expect(existsSync(physicalRoot)).toBe(false);
    expectPathEntryAbsent(dreamuxRoot());
    expectPathEntryAbsent(configAlias);
    expectRemovedEntry(result, dreamuxRoot(), 'dreamux home directory', physicalTarget);
    expectRemovedEntry(result, configAlias, 'dreamux config directory', physicalTarget);
    expect(
      result.entries.filter((entry) =>
        entry.path === dreamuxRoot() ||
        entry.path === configAlias,
      ),
    ).toHaveLength(2);
  });
  it('refuses a lexically nested config symlink that physically overlaps Codex state', async () => {
    const runner = new FakeRunner();
    const homeDir = join(root, 'home');
    const nestedConfigDir = join(dreamuxRoot(), 'nested-config');
    const sentinel = join(homedir(), '.codex', 'sentinel');
    mkdirSync(join(homedir(), '.codex'), { recursive: true });
    mkdirSync(dirname(nestedConfigDir), { recursive: true });
    writeFileSync(sentinel, 'keep\n');
    symlinkSync(join(homedir(), '.codex'), nestedConfigDir);
    await expect(
      runUninstall({
        configDir: nestedConfigDir,
        runner,
        platform: 'linux',
        homeDir,
      }),
    ).rejects.toThrow(/operator Codex\/Claude state/);
    expect(existsSync(sentinel)).toBe(true);
    expect(runner.calls).toEqual([]);
  });
  it('dry-run ledger exposes the physical recursive removal target', async () => {
    const externalConfigDir = join(root, 'external-config');
    const configAlias = join(root, 'config-link');
    mkdirSync(dreamuxRoot(), { recursive: true });
    writeEmptyConfig(externalConfigDir);
    symlinkSync(externalConfigDir, configAlias);
    const command = createUninstallCommand();
    const lines: string[] = [];
    const log = vi.spyOn(console, 'log').mockImplementation((line = '') => {
      lines.push(String(line));
    });
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      await command.handler({
        dryRun: true,
        configDir: configAlias,
      } as never);
    } finally {
      log.mockRestore();
      error.mockRestore();
    }
    expect(existsSync(externalConfigDir)).toBe(true);
    expect(existsSync(configAlias)).toBe(true);
    expect(lines).toEqual(
      expect.arrayContaining([
        `removed\t${configAlias}\tdreamux config directory\ttarget=${realpathSync(externalConfigDir)}`,
      ]),
    );
    expect(lines.some((line) =>
      line.includes(`removed\t${dreamuxRoot()}\tdreamux home directory`),
    )).toBe(true);
    expect(lines.some((line) => line.includes('dreamux uninstall service:'))).toBe(true);
  });
  it('prints partial ledger and failures before the CLI exits unsuccessfully', async () => {
    const result: UninstallRunResult = {
      entries: [
        {
          path: '/tmp/dreamux-config',
          status: 'removed',
          reason: 'dreamux config directory',
        },
        {
          path: '/tmp/dreamux.service',
          status: 'skipped',
          reason: 'systemd unit',
          detail: 'boom',
        },
      ],
      failures: [
        {
          path: '/tmp/dreamux.service',
          reason: 'systemd unit',
          error: 'boom',
        },
      ],
      warnings: ['preflight warning'],
      service: {
        platform: 'systemd',
        unitPath: '/tmp/dreamux.service',
      },
    };
    const run = vi.fn(async () => result);
    vi.resetModules();
    vi.doMock('../src/onboard/uninstall.js', () => ({
      runUninstall: run,
    }));
    const { createUninstallCommand: createMockedUninstallCommand } = await import(
      '../src/cli/commands/uninstall.js'
    );
    const lines: string[] = [];
    const errors: string[] = [];
    const log = vi.spyOn(console, 'log').mockImplementation((line = '') => {
      lines.push(String(line));
    });
    const error = vi.spyOn(console, 'error').mockImplementation((line = '') => {
      errors.push(String(line));
    });
    try {
      await expect(
        createMockedUninstallCommand().handler({} as never),
      ).rejects.toThrow(/dreamux uninstall failed after 1 operation/);
    } finally {
      log.mockRestore();
      error.mockRestore();
      vi.doUnmock('../src/onboard/uninstall.js');
      vi.resetModules();
    }
    expect(lines).toEqual(
      expect.arrayContaining([
        'dreamux uninstall file ledger:',
        'removed\t/tmp/dreamux-config\tdreamux config directory',
        'skipped\t/tmp/dreamux.service\tsystemd unit\tdetail=boom',
        'dreamux uninstall service: systemd /tmp/dreamux.service',
      ]),
    );
    expect(errors).toEqual(
      expect.arrayContaining([
        'warning: preflight warning',
        'failure: /tmp/dreamux.service: systemd unit: boom',
      ]),
    );
  });
  it('returns the service ledger and filesystem failure when removal probing fails after service removal', async () => {
    const configDir = join(root, 'config');
    const homeDir = join(root, 'home');
    const servicePath = writeSystemdService(homeDir);
    writeEmptyConfig(configDir);
    mkdirSync(dreamuxRoot(), { recursive: true });
    const runner = new FakeRunner();
    let corrupted = false;
    runner.onRun = () => {
      if (corrupted) return;
      corrupted = true;
      rmSync(configDir, { recursive: true, force: true });
      writeFileSync(configDir, 'not a directory\n');
    };
    const result = await runUninstall({
      configDir: join(configDir, 'child'),
      runner,
      platform: 'linux',
      homeDir,
    });
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]).toMatchObject({
      reason: 'dreamux config directory',
    });
    expect(result.failures[0]?.path.endsWith(`${sep}config${sep}child`)).toBe(true);
    expect(result.failures[0]?.error).toMatch(/ENOTDIR/);
    expect(result.entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: servicePath,
          status: 'removed',
          reason: 'systemd unit',
        }),
        expect.objectContaining({
          path: join(configDir, 'child'),
          status: 'skipped',
          reason: 'dreamux config directory',
        }),
      ]),
    );
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
      process.env['DREAMUX_ROOT'] = join(caseRoot, 'dreamux');
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
    const result = await runUninstall({
      configDir,
      runner: new FakeRunner(),
      platform: 'linux',
      homeDir,
    });
    expect(result.warnings).toEqual([]);
    expect(existsSync(configDir)).toBe(false);
    expect(existsSync(dreamuxRoot())).toBe(false);
  });
});
