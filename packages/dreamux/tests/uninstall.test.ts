import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  lstatSync,
  linkSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, relative } from 'node:path';

import { runUninstall } from '../src/onboard/uninstall.js';
import type { CommandRunner } from '../src/platform/command-runner.js';
import {
  logsRoot,
  cacheRoot,
  runRoot,
  stateRoot,
} from '../src/platform/paths.js';
import { testSingleDispatcherFileObject } from './helpers/config.js';

class FakeRunner implements CommandRunner {
  launchdLoaded = false;
  readonly calls: Array<{ command: string; args: string[] }> = [];

  readonly dryRuns: boolean[] = [];
  async run(
    command: string,
    args: string[],
    options: { dryRun?: boolean } = {},
  ): Promise<void> {
    this.calls.push({ command, args });
    this.dryRuns.push(options.dryRun === true);
  }

  async check(command: string, args: string[]): Promise<boolean> {
    return command === 'launchctl' && args[0] === 'print' && this.launchdLoaded;
  }

  async capture(): Promise<string> {
    return '';
  }
}

describe('dreamux uninstall', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(homedir(), '.dreamux-uninstall-'));
    vi.stubEnv('HOME', join(root, 'home'));
    vi.stubEnv('DREAMUX_ROOT', join(root, 'dreamux'));
    vi.stubEnv('CODEX_HOME', undefined);
    vi.stubEnv('CLAUDE_CONFIG_DIR', undefined);
  });

  afterEach(() => {
    try {
      rmSync(root, { recursive: true, force: true });
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('removes onboard-owned config, state, logs, and user service files', async () => {
    const configDir = join(root, 'dreamux');
    const homeDir = join(root, 'home');
    const servicePath = join(
      homeDir,
      '.config',
      'systemd',
      'user',
      'dreamux.service',
    );
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
    mkdirSync(logsRoot(), { recursive: true });
    mkdirSync(dirname(servicePath), { recursive: true });
    mkdirSync(legacyWorkspaceSkillDir, { recursive: true });
    writeFileSync(
      join(configDir, 'config.json'),
      JSON.stringify(
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
      ),
      { mode: 0o600 },
    );
    writeFileSync(join(logsRoot(), 'dreamux-server.log'), '');
    writeFileSync(
      join(legacyWorkspaceSkillDir, 'SKILL.md'),
      '# legacy skill\n',
    );
    writeFileSync(servicePath, '[Service]\nExecStart=dreamux serve\n');

    const runner = new FakeRunner();
    const result = await runUninstall({
      runner,
      platform: 'linux',
      homeDir,
    });

    expect(existsSync(configDir)).toBe(false);
    expect(existsSync(stateRoot())).toBe(false);
    expect(existsSync(runRoot())).toBe(false);
    expect(existsSync(cacheRoot())).toBe(false);
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
        {
          status: 'removed',
          path: configDir,
          reason: 'dreamux config directory',
        },
        { status: 'removed', path: servicePath, reason: 'systemd unit' },
        {
          status: 'removed',
          path: stateRoot(),
          reason: 'dreamux state directory',
        },
        { status: 'removed', path: runRoot(), reason: 'dreamux run directory' },
        {
          status: 'removed',
          path: cacheRoot(),
          reason: 'dreamux cache directory',
        },
        {
          status: 'removed',
          path: logsRoot(),
          reason: 'dreamux logs directory',
        },
      ]),
    );
    expect(runner.calls.map((call) => [call.command, call.args])).toEqual([
      ['systemctl', ['--user', 'disable', '--now', 'dreamux.service']],
      ['systemctl', ['--user', 'daemon-reload']],
    ]);
  });

  it('unregisters launchd services and removes the plist', async () => {
    const configDir = join(root, 'dreamux');
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

    for (const unsafeConfigDir of [
      join(homedir(), '.codex'),
      join(homedir(), '.claude'),
    ]) {
      process.env['DREAMUX_ROOT'] = unsafeConfigDir;
      await expect(
        runUninstall({
          runner,
          platform: 'linux',
          homeDir,
        }),
      ).rejects.toThrow(/operator agent runtime state/);
    }

    process.env['DREAMUX_ROOT'] = join(homedir(), '.claude');
    await expect(
      runUninstall({
        runner,
        platform: 'linux',
        homeDir,
      }),
    ).rejects.toThrow(/operator agent runtime state/);
    expect(runner.calls).toEqual([]);
  });

  it.each(['CODEX_HOME', 'CLAUDE_CONFIG_DIR'])(
    'protects the provider-derived %s directory and its descendants before service removal',
    async (variable) => {
      const previous = process.env[variable];
      const protectedDir = join(root, 'operator-runtime');
      mkdirSync(protectedDir);
      writeFileSync(join(protectedDir, 'keep.txt'), 'operator state');
      process.env[variable] = protectedDir;
      const runner = new FakeRunner();
      try {
        for (const path of [protectedDir, join(protectedDir, 'child')]) {
          process.env['DREAMUX_ROOT'] = path;
          for (const dryRun of [true, false]) {
            await expect(
              runUninstall({
                runner,
                dryRun,
                platform: 'linux',
                homeDir: join(root, 'home'),
              }),
            ).rejects.toThrow(/operator agent runtime state/);
          }
        }
        expect(runner.calls).toEqual([]);
        expect(readFileSync(join(protectedDir, 'keep.txt'), 'utf8')).toBe(
          'operator state',
        );
      } finally {
        if (previous === undefined) delete process.env[variable];
        else process.env[variable] = previous;
      }
    },
  );

  it.each(['CODEX_HOME', 'CLAUDE_CONFIG_DIR'])(
    'protects %s nested beneath a removal root before any service mutation',
    async (variable) => {
      const previous = process.env[variable];
      const configDir = join(root, 'dreamux');
      const homeDir = join(root, 'home');
      const servicePath = join(
        homeDir,
        '.config',
        'systemd',
        'user',
        'dreamux.service',
      );
      const configPath = join(configDir, 'config.json');
      const runner = new FakeRunner();
      mkdirSync(configDir);
      mkdirSync(dirname(servicePath), { recursive: true });
      writeFileSync(servicePath, '[Service]\nExecStart=dreamux serve\n');
      writeFileSync(configPath, '{}');
      try {
        // Both whole-root and ordinary owned-subdirectory containment are unsafe.
        for (const parent of [
          configDir,
          stateRoot(),
          runRoot(),
          cacheRoot(),
          logsRoot(),
        ]) {
          const protectedDir = join(parent, 'operator-runtime');
          mkdirSync(protectedDir, { recursive: true });
          const marker = join(protectedDir, 'keep.txt');
          writeFileSync(marker, 'private provider state');
          process.env[variable] = protectedDir;
          for (const dryRun of [true, false]) {
            await expect(
              runUninstall({ runner, dryRun, platform: 'linux', homeDir }),
            ).rejects.toThrow(/operator agent runtime state/);
            expect(readFileSync(marker, 'utf8')).toBe('private provider state');
            expect(readFileSync(servicePath, 'utf8')).toBe(
              '[Service]\nExecStart=dreamux serve\n',
            );
            expect(readFileSync(configPath, 'utf8')).toBe('{}');
            expect(runner.calls).toEqual([]);
          }
        }
      } finally {
        if (previous === undefined) delete process.env[variable];
        else process.env[variable] = previous;
      }
    },
  );

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
      process.env['DREAMUX_ROOT'] = configDir;
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
  it.each(['file', 'directory', 'none'] as const)(
    'previews without writes and recursively removes the root with %s foreign content',
    async (kind) => {
      const configDir = join(root, 'dreamux');
      mkdirSync(stateRoot(), { recursive: true });
      mkdirSync(runRoot(), { recursive: true });
      mkdirSync(cacheRoot(), { recursive: true });
      mkdirSync(logsRoot(), { recursive: true });
      const configFile = join(configDir, 'config.json');
      writeFileSync(configFile, JSON.stringify({ dispatchers: [] }), {
        mode: 0o600,
      });
      writeFileSync(join(configDir, 'config.toml'), '# legacy companion');
      const foreign = join(configDir, 'operator-content');
      if (kind === 'file') writeFileSync(foreign, 'keep');
      if (kind === 'directory') {
        mkdirSync(foreign);
        writeFileSync(join(foreign, 'keep.txt'), 'keep');
      }
      const before = readdirSync(configDir).sort();
      const runner = new FakeRunner();
      const options = {
        runner,
        platform: 'linux' as const,
        homeDir: join(root, 'home'),
      };
      const preview = await runUninstall({ ...options, dryRun: true });
      expect(readdirSync(configDir).sort()).toEqual(before);
      expect(readFileSync(configFile, 'utf8')).toBe(
        JSON.stringify({ dispatchers: [] }),
      );
      expect(runner.dryRuns.every((dryRun) => dryRun)).toBe(true);
      if (kind !== 'none')
        expect(
          readFileSync(
            kind === 'file' ? foreign : join(foreign, 'keep.txt'),
            'utf8',
          ),
        ).toBe('keep');
      const actual = await runUninstall(options);
      expect(preview.entries).toEqual(actual.entries);
      expect(actual.entries.find((entry) => entry.path === configDir)).toEqual({
        path: configDir,
        status: 'removed',
        reason: 'dreamux config directory',
      });
      expect(existsSync(configDir)).toBe(false);
    },
  );
  it.each([
    ['config.json', false],
    ['config.toml', false],
    ['config.json', true],
    ['config.toml', true],
  ] as const)(
    'recursively removes a dangling %s config link with the root (target removed first: %s)',
    async (name, targetRemovedFirst) => {
      const configDir = join(root, 'dreamux');
      mkdirSync(stateRoot(), { recursive: true });
      const configFile = join(configDir, name);
      const missingTarget = targetRemovedFirst
        ? join(stateRoot(), 'settings.json')
        : join(root, 'absent-config');
      if (targetRemovedFirst)
        writeFileSync(missingTarget, JSON.stringify({ dispatchers: [] }), {
          mode: 0o600,
        });
      symlinkSync(missingTarget, configFile);
      const options = {
        runner: new FakeRunner(),
        platform: 'linux' as const,
        homeDir: join(root, 'home'),
      };
      const before = readdirSync(configDir).sort();
      const preview = await runUninstall({ ...options, dryRun: true });
      expect(readdirSync(configDir).sort()).toEqual(before);
      expect(lstatSync(configFile).isSymbolicLink()).toBe(true);
      expect(readlinkSync(configFile)).toBe(missingTarget);
      expect(existsSync(missingTarget)).toBe(targetRemovedFirst);
      const actual = await runUninstall(options);
      expect(preview.entries).toEqual(actual.entries);
      expect(actual.entries.find((entry) => entry.path === configDir)).toEqual({
        path: configDir,
        status: 'removed',
        reason: 'dreamux config directory',
      });
      expect(existsSync(configDir)).toBe(false);
      expect(existsSync(missingTarget)).toBe(false);
    },
  );
  it.each([
    ['file', true],
    ['symlink', true],
    ['symlink', false],
  ] as const)(
    'removes linked configs with the root without following external targets (JSON %s, TOML through JSON: %s)',
    async (kind, throughJson) => {
      const configDir = join(root, 'dreamux');
      mkdirSync(stateRoot(), { recursive: true });
      const jsonPath = join(configDir, 'config.json');
      const tomlPath = join(configDir, 'config.toml');
      const dataPath = kind === 'file' ? jsonPath : join(root, 'operator.json');
      const content = JSON.stringify(testSingleDispatcherFileObject());
      writeFileSync(dataPath, content, { mode: 0o600 });
      if (kind === 'symlink') symlinkSync(dataPath, jsonPath);
      const tomlTarget = throughJson ? 'config.json' : dataPath;
      symlinkSync(tomlTarget, tomlPath);
      const options = {
        runner: new FakeRunner(),
        platform: 'linux' as const,
        homeDir: join(root, 'home'),
      };
      const before = readdirSync(configDir).sort();
      const preview = await runUninstall({ ...options, dryRun: true });
      expect(readdirSync(configDir).sort()).toEqual(before);
      expect(readFileSync(jsonPath, 'utf8')).toBe(content);
      expect(readFileSync(tomlPath, 'utf8')).toBe(content);
      expect(lstatSync(jsonPath).isSymbolicLink()).toBe(kind === 'symlink');
      expect(readlinkSync(tomlPath)).toBe(tomlTarget);
      const actual = await runUninstall(options);
      expect(preview.entries).toEqual(actual.entries);
      expect(actual.entries.find((entry) => entry.path === configDir)).toEqual({
        path: configDir,
        status: 'removed',
        reason: 'dreamux config directory',
      });
      expect(existsSync(configDir)).toBe(false);
      if (kind === 'symlink')
        expect(readFileSync(dataPath, 'utf8')).toBe(content);
    },
  );
  it('removes root links without following a config target containing link-before-parent traversal', async () => {
    const configDir = join(root, 'dreamux');
    const profile = join(root, 'external', 'profiles', 'v1');
    mkdirSync(join(profile, 'subdir'), { recursive: true });
    mkdirSync(configDir);
    const content = JSON.stringify(testSingleDispatcherFileObject());
    const target = join(profile, 'config.json');
    writeFileSync(target, content, { mode: 0o600 });
    symlinkSync(join(profile, 'subdir'), join(configDir, 'current'));
    const configFile = join(configDir, 'config.json');
    symlinkSync('current/../config.json', configFile);
    const options = {
      runner: new FakeRunner(),
      platform: 'linux' as const,
      homeDir: join(root, 'home'),
    };
    const preview = await runUninstall({ ...options, dryRun: true });
    expect(readdirSync(configDir).sort()).toEqual(['config.json', 'current']);
    expect(readlinkSync(configFile)).toBe('current/../config.json');
    expect(readFileSync(configFile, 'utf8')).toBe(content);
    const actual = await runUninstall(options);
    expect(preview.entries).toEqual(actual.entries);
    expect(
      actual.entries.find((entry) => entry.path === configDir),
    ).toMatchObject({ status: 'removed' });
    expect(existsSync(configDir)).toBe(false);
    expect(readFileSync(target, 'utf8')).toBe(content);
  });

  it.each([false, true])(
    'previews current run-link existence but actual removal observes state removed first (state is a link: %s)',
    async (stateIsLink) => {
      const configDir = join(root, 'dreamux');
      const dataDir = stateIsLink ? join(root, 'external-state') : stateRoot();
      mkdirSync(join(dataDir, 'runtime'), { recursive: true });
      if (stateIsLink) {
        mkdirSync(configDir);
        symlinkSync(dataDir, stateRoot());
      }
      const dataFile = join(dataDir, 'runtime', 'keep.txt');
      writeFileSync(dataFile, 'runtime data');
      symlinkSync('state/runtime', runRoot());
      const options = {
        runner: new FakeRunner(),
        platform: 'linux' as const,
        homeDir: join(root, 'home'),
      };
      const before = readdirSync(configDir).sort();
      const preview = await runUninstall({ ...options, dryRun: true });
      expect(readdirSync(configDir).sort()).toEqual(before);
      expect(readFileSync(join(runRoot(), 'keep.txt'), 'utf8')).toBe(
        'runtime data',
      );
      expect(readlinkSync(runRoot())).toBe('state/runtime');
      const actual = await runUninstall(options);
      expect(preview.entries).toEqual(
        actual.entries.map((entry) =>
          entry.path === runRoot() ? { ...entry, status: 'removed' } : entry,
        ),
      );
      expect(actual.entries).toEqual(
        expect.arrayContaining([
          {
            path: stateRoot(),
            status: 'removed',
            reason: 'dreamux state directory',
          },
          {
            path: runRoot(),
            status: 'missing',
            reason: 'dreamux run directory',
          },
          {
            path: configDir,
            status: 'removed',
            reason: 'dreamux config directory',
          },
        ]),
      );
      expect(existsSync(configDir)).toBe(false);
      if (stateIsLink)
        expect(readFileSync(dataFile, 'utf8')).toBe('runtime data');
    },
  );

  it('removes root hard links while preserving an external hard link', async () => {
    const configDir = join(root, 'dreamux');
    mkdirSync(configDir);
    const configFile = join(configDir, 'config.json');
    const foreign = join(configDir, 'operator.json');
    const content = JSON.stringify(testSingleDispatcherFileObject());
    writeFileSync(configFile, content, { mode: 0o600 });
    linkSync(configFile, foreign);
    const external = join(root, 'external-config.json');
    linkSync(configFile, external);
    const options = {
      runner: new FakeRunner(),
      platform: 'linux' as const,
      homeDir: join(root, 'home'),
    };
    const preview = await runUninstall({ ...options, dryRun: true });
    expect(lstatSync(configFile).ino).toBe(lstatSync(foreign).ino);
    expect(readFileSync(foreign, 'utf8')).toBe(content);
    const actual = await runUninstall(options);
    expect(preview.entries).toEqual(actual.entries);
    expect(existsSync(configDir)).toBe(false);
    expect(readFileSync(external, 'utf8')).toBe(content);
  });

  it('previews without writes and recursively removes a relative DREAMUX_ROOT', async () => {
    const configDir = join(root, 'dreamux');
    process.env['DREAMUX_ROOT'] = `./${relative(process.cwd(), configDir)}`;
    mkdirSync(configDir);
    const config = JSON.stringify(testSingleDispatcherFileObject());
    writeFileSync(join(configDir, 'config.json'), config, { mode: 0o600 });
    writeFileSync(join(configDir, 'config.toml'), 'legacy config');
    const owned = [stateRoot(), runRoot(), cacheRoot(), logsRoot()];
    for (const path of owned) {
      mkdirSync(path);
      writeFileSync(join(path, 'owned.txt'), path);
    }
    writeFileSync(join(configDir, 'operator.txt'), 'keep foreign content');
    const runner = new FakeRunner();
    const options = {
      runner,
      platform: 'linux' as const,
      homeDir: join(root, 'home'),
    };
    const before = readdirSync(configDir).sort();
    const preview = await runUninstall({ ...options, dryRun: true });
    expect(readdirSync(configDir).sort()).toEqual(before);
    expect(readFileSync(join(configDir, 'config.json'), 'utf8')).toBe(config);
    expect(readFileSync(join(configDir, 'config.toml'), 'utf8')).toBe(
      'legacy config',
    );
    for (const path of owned)
      expect(readFileSync(join(path, 'owned.txt'), 'utf8')).toBe(path);
    expect(readFileSync(join(configDir, 'operator.txt'), 'utf8')).toBe(
      'keep foreign content',
    );
    expect(runner.dryRuns.every((dryRun) => dryRun)).toBe(true);
    const actual = await runUninstall(options);
    expect(preview.entries).toEqual(actual.entries);
    expect(
      actual.entries.find((entry) => entry.path === configDir),
    ).toMatchObject({ status: 'removed' });
    expect(existsSync(configDir)).toBe(false);
  });

  it.skipIf(process.getuid === undefined || process.getuid() === 0)(
    'removes a known systemd unit beneath a write-search-only parent and its dangling config link with the root',
    async () => {
      const homeDir = join(root, 'home');
      const unitParent = join(homeDir, '.config', 'systemd', 'user');
      const unitPath = join(unitParent, 'dreamux.service');
      mkdirSync(unitParent, { recursive: true });
      const unit = '[Unit]\nDescription=uninstall fixture\n';
      writeFileSync(unitPath, unit, { mode: 0o600 });
      const foreignSibling = join(unitParent, 'operator.service');
      writeFileSync(foreignSibling, 'keep foreign unit');
      const configDir = join(root, 'dreamux');
      mkdirSync(stateRoot(), { recursive: true });
      writeFileSync(join(stateRoot(), 'owned.txt'), 'owned state');
      const config = JSON.stringify(testSingleDispatcherFileObject());
      writeFileSync(join(configDir, 'config.json'), config, { mode: 0o600 });
      symlinkSync(unitPath, join(configDir, 'config.toml'));
      const runner = new FakeRunner();
      const options = { runner, platform: 'linux' as const, homeDir };
      const originalMode = lstatSync(unitParent).mode & 0o777;
      try {
        chmodSync(unitParent, 0o300);
        expect(() => readdirSync(unitParent)).toThrow(
          expect.objectContaining({ code: 'EACCES' }),
        );
        console.info(
          `[uninstall filesystem] uid=${process.getuid?.()}: systemd unit parent mode 0300 denies readdir`,
        );
        const before = readdirSync(configDir).sort();
        const preview = await runUninstall({ ...options, dryRun: true });
        expect(readdirSync(configDir).sort()).toEqual(before);
        expect(readFileSync(unitPath, 'utf8')).toBe(unit);
        expect(readFileSync(join(configDir, 'config.json'), 'utf8')).toBe(
          config,
        );
        expect(readFileSync(join(configDir, 'config.toml'), 'utf8')).toBe(unit);
        expect(readFileSync(join(stateRoot(), 'owned.txt'), 'utf8')).toBe(
          'owned state',
        );
        expect(readFileSync(foreignSibling, 'utf8')).toBe('keep foreign unit');
        expect(lstatSync(unitParent).mode & 0o777).toBe(0o300);
        expect(runner.dryRuns.every((dryRun) => dryRun)).toBe(true);
        const actual = await runUninstall(options);
        expect(preview.entries).toEqual(actual.entries);
        expect(actual.entries).toHaveLength(6);
        expect(
          actual.entries.find((entry) => entry.path === unitPath),
        ).toMatchObject({ status: 'removed' });
        expect(
          actual.entries.find((entry) => entry.path === configDir),
        ).toMatchObject({ status: 'removed' });
        expect(existsSync(unitPath)).toBe(false);
        expect(existsSync(configDir)).toBe(false);
        expect(readFileSync(foreignSibling, 'utf8')).toBe('keep foreign unit');
        expect(lstatSync(unitParent).mode & 0o777).toBe(0o300);
        expect(() => readdirSync(unitParent)).toThrow(
          expect.objectContaining({ code: 'EACCES' }),
        );
      } finally {
        chmodSync(unitParent, originalMode);
      }
    },
  );

  // POSIX mode bits must constrain an actual unprivileged user for this case.
  it.skipIf(process.getuid === undefined || process.getuid() === 0)(
    'predicts full uninstall beneath a writable searchable ancestor without read permission',
    async () => {
      const ancestor = join(root, 'searchable-parent');
      const configDir = join(ancestor, 'dreamux');
      process.env['DREAMUX_ROOT'] = configDir;
      mkdirSync(configDir, { recursive: true });
      const config = JSON.stringify(testSingleDispatcherFileObject());
      writeFileSync(join(configDir, 'config.json'), config, { mode: 0o600 });
      writeFileSync(join(configDir, 'config.toml'), 'legacy config');
      const owned = [stateRoot(), runRoot(), cacheRoot(), logsRoot()];
      for (const path of owned) {
        mkdirSync(path);
        writeFileSync(join(path, 'owned.txt'), path);
      }
      const foreignSibling = join(ancestor, 'operator.txt');
      writeFileSync(foreignSibling, 'keep sibling');
      const runner = new FakeRunner();
      const options = {
        runner,
        platform: 'linux' as const,
        homeDir: join(root, 'home'),
      };
      const originalMode = lstatSync(ancestor).mode & 0o777;
      try {
        chmodSync(ancestor, 0o333);
        expect(() => readdirSync(ancestor)).toThrow(
          expect.objectContaining({ code: 'EACCES' }),
        );
        console.info(
          `[uninstall filesystem] uid=${process.getuid?.()}: ancestor mode 0333 denies readdir and allows child lookup`,
        );
        const before = readdirSync(configDir).sort();
        const preview = await runUninstall({ ...options, dryRun: true });
        expect(readdirSync(configDir).sort()).toEqual(before);
        expect(readFileSync(join(configDir, 'config.json'), 'utf8')).toBe(
          config,
        );
        expect(readFileSync(join(configDir, 'config.toml'), 'utf8')).toBe(
          'legacy config',
        );
        for (const path of owned)
          expect(readFileSync(join(path, 'owned.txt'), 'utf8')).toBe(path);
        expect(runner.dryRuns.every((dryRun) => dryRun)).toBe(true);
        expect(lstatSync(ancestor).mode & 0o777).toBe(0o333);
        expect(() => readdirSync(ancestor)).toThrow(
          expect.objectContaining({ code: 'EACCES' }),
        );

        const actual = await runUninstall(options);
        expect(preview.entries).toEqual(actual.entries);
        expect(actual.entries).toHaveLength(6);
        for (const path of [...owned, configDir])
          expect(actual.entries.find((entry) => entry.path === path)).toEqual(
            expect.objectContaining({ status: 'removed' }),
          );
        expect(existsSync(configDir)).toBe(false);
        expect(readFileSync(foreignSibling, 'utf8')).toBe('keep sibling');
        expect(lstatSync(ancestor).mode & 0o777).toBe(0o333);
        expect(() => readdirSync(ancestor)).toThrow(
          expect.objectContaining({ code: 'EACCES' }),
        );
      } finally {
        chmodSync(ancestor, originalMode);
      }
    },
  );

  it.each([
    ['Config.json', 'config.json', 'file'],
    ['State', 'state', 'directory'],
  ] as const)(
    'previews actual filesystem lookup for %s and recursively removes both case variants',
    async (spelling, ownedName, kind) => {
      const configDir = join(root, 'dreamux');
      mkdirSync(configDir, { recursive: true });
      const capitalized = join(configDir, spelling);
      const owned = join(configDir, ownedName);
      const config = JSON.stringify(testSingleDispatcherFileObject());
      const capitalizedContent =
        kind === 'file'
          ? `${config}\n`
          : 'keep distinct capitalized directory\n';
      const capitalizedFile =
        kind === 'file' ? capitalized : join(capitalized, 'keep.txt');
      if (kind === 'directory') mkdirSync(capitalized);
      writeFileSync(capitalizedFile, capitalizedContent, { mode: 0o600 });

      // Only the capitalized entry exists so far. This is the filesystem's
      // actual lookup behavior in this directory, not an operating-system guess.
      const sameEntry = existsSync(owned);
      console.info(
        `[uninstall filesystem] ${spelling}: ${sameEntry ? 'case-insensitive alias' : 'case-sensitive distinct entries'}`,
      );
      if (!sameEntry) {
        if (kind === 'directory') mkdirSync(owned);
        writeFileSync(
          kind === 'file' ? owned : join(owned, 'owned.txt'),
          kind === 'file' ? config : 'owned state\n',
          { mode: 0o600 },
        );
      }
      if (kind === 'directory') {
        writeFileSync(join(configDir, 'config.json'), config, { mode: 0o600 });
      }
      const before = readdirSync(configDir).sort();
      const runner = new FakeRunner();
      const options = {
        runner,
        platform: 'linux' as const,
        homeDir: join(root, 'home'),
      };
      const preview = await runUninstall({ ...options, dryRun: true });
      expect(readdirSync(configDir).sort()).toEqual(before);
      expect(readFileSync(capitalizedFile, 'utf8')).toBe(capitalizedContent);
      expect(existsSync(owned)).toBe(true);
      expect(readFileSync(join(configDir, 'config.json'), 'utf8')).toBe(
        kind === 'file' && sameEntry ? capitalizedContent : config,
      );
      expect(runner.dryRuns.every((dryRun) => dryRun)).toBe(true);

      const actual = await runUninstall(options);
      expect(preview.entries).toEqual(actual.entries);
      expect(actual.entries.find((entry) => entry.path === configDir)).toEqual({
        path: configDir,
        status: 'removed',
        reason: 'dreamux config directory',
      });
      expect(existsSync(configDir)).toBe(false);
    },
  );
  it('dry-run and real uninstall report a missing root consistently', async () => {
    const options = {
      runner: new FakeRunner(),
      platform: 'linux' as const,
      homeDir: join(root, 'home'),
    };
    const preview = await runUninstall({ ...options, dryRun: true });
    const actual = await runUninstall(options);
    expect(preview.entries).toEqual(actual.entries);
    expect(
      actual.entries.find((entry) => entry.path === join(root, 'dreamux'))
        ?.status,
    ).toBe('missing');
  });

  it.each([false, true])(
    'uses access-based root-link existence without recursively following the link (dangling: %s)',
    async (dangling) => {
      const configDir = join(root, 'dreamux');
      const target = join(root, 'root-target');
      const config = JSON.stringify(testSingleDispatcherFileObject());
      if (!dangling) {
        mkdirSync(join(target, 'state'), { recursive: true });
        writeFileSync(join(target, 'state', 'owned.txt'), 'owned state');
        writeFileSync(join(target, 'config.json'), config, { mode: 0o600 });
        writeFileSync(join(target, 'keep.txt'), 'target content');
      }
      symlinkSync(target, configDir);
      const options = {
        runner: new FakeRunner(),
        platform: 'linux' as const,
        homeDir: join(root, 'home'),
      };
      const preview = await runUninstall({ ...options, dryRun: true });
      expect(readlinkSync(configDir)).toBe(target);
      if (!dangling) {
        expect(readFileSync(join(target, 'state', 'owned.txt'), 'utf8')).toBe(
          'owned state',
        );
      }
      const actual = await runUninstall(options);
      expect(preview.entries).toEqual(actual.entries);
      expect(actual.entries.find((entry) => entry.path === configDir)).toEqual({
        path: configDir,
        status: dangling ? 'missing' : 'removed',
        reason: 'dreamux config directory',
      });
      if (dangling) {
        expect(readlinkSync(configDir)).toBe(target);
      } else {
        expect(() => lstatSync(configDir)).toThrow(/ENOENT/);
        expect(existsSync(join(target, 'state'))).toBe(false);
        expect(readFileSync(join(target, 'config.json'), 'utf8')).toBe(config);
        expect(readFileSync(join(target, 'keep.txt'), 'utf8')).toBe(
          'target content',
        );
      }
    },
  );

  it
    .skipIf(process.getuid === undefined || process.getuid() === 0)
    .each([false, true])(
    'previews an unreadable root without writes and propagates actual recursive removal EACCES (foreign content: %s)',
    async (foreign) => {
      const configDir = join(root, 'dreamux');
      mkdirSync(configDir);
      const configFile = join(configDir, 'config.json');
      const config = JSON.stringify(testSingleDispatcherFileObject());
      writeFileSync(configFile, config, { mode: 0o600 });
      const foreignFile = join(configDir, 'keep.txt');
      if (foreign) writeFileSync(foreignFile, 'foreign content');
      const originalMode = lstatSync(configDir).mode & 0o777;
      const runner = new FakeRunner();
      const options = {
        runner,
        platform: 'linux' as const,
        homeDir: join(root, 'home'),
      };
      try {
        chmodSync(configDir, 0o300);
        expect(() => readdirSync(configDir)).toThrow(
          expect.objectContaining({ code: 'EACCES' }),
        );
        const preview = await runUninstall({ ...options, dryRun: true });
        expect(
          preview.entries.find((entry) => entry.path === configDir),
        ).toEqual({
          path: configDir,
          status: 'removed',
          reason: 'dreamux config directory',
        });
        expect(preview.warnings).toEqual([]);
        expect(readFileSync(configFile, 'utf8')).toBe(config);
        if (foreign)
          expect(readFileSync(foreignFile, 'utf8')).toBe('foreign content');
        expect(lstatSync(configDir).mode & 0o777).toBe(0o300);
        expect(runner.dryRuns.every((dryRun) => dryRun)).toBe(true);
        await expect(runUninstall(options)).rejects.toMatchObject({
          code: 'EACCES',
        });
        expect(lstatSync(configDir).mode & 0o777).toBe(0o300);
        console.info(
          `[uninstall filesystem] uid=${process.getuid?.()}: root mode 0300 preview succeeds; recursive removal EACCES (foreign=${foreign})`,
        );
      } finally {
        chmodSync(configDir, originalMode);
      }
    },
  );
});
