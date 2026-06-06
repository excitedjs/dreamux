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
import {
  dispatcherWorkspaceSkillDirs,
  logsRoot,
  resetRuntimeConfig,
  stateRoot,
} from '../src/runtime/paths.js';

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

describe('dreamux uninstall', () => {
  let root: string;
  let previousHome: string | undefined;

  beforeEach(() => {
    root = mkdtempSync(join(homedir(), '.dreamux-uninstall-'));
    previousHome = process.env['HOME'];
    process.env['HOME'] = join(root, 'home');
  });

  afterEach(() => {
    if (previousHome === undefined) delete process.env['HOME'];
    else process.env['HOME'] = previousHome;
    resetRuntimeConfig();
    rmSync(root, { recursive: true, force: true });
  });

  it('removes onboard-owned config, state, logs, and user service files', async () => {
    const configDir = join(root, 'config');
    const homeDir = join(root, 'home');
    const servicePath = join(homeDir, '.config', 'systemd', 'user', 'dreamux.service');
    const dispatcherCwd = join(root, 'workspace');
    const workspaceSkillDirs = dispatcherWorkspaceSkillDirs(dispatcherCwd);
    mkdirSync(configDir, { recursive: true });
    mkdirSync(stateRoot(), { recursive: true });
    mkdirSync(logsRoot(), { recursive: true });
    mkdirSync(dirname(servicePath), { recursive: true });
    for (const skillDir of workspaceSkillDirs) {
      mkdirSync(skillDir, { recursive: true });
    }
    writeFileSync(join(configDir, 'config.json'), JSON.stringify({
      dispatchers: [
        {
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
        },
      ],
    }), { mode: 0o600 });
    writeFileSync(join(logsRoot(), 'dreamux-server.log'), '');
    for (const skillDir of workspaceSkillDirs) {
      writeFileSync(join(skillDir, 'SKILL.md'), '# workspace skill\n');
    }
    writeFileSync(servicePath, '[Service]\nExecStart=dreamux serve\n');

    const runner = new FakeRunner();
    const result = await runUninstall({
      configDir,
      runner,
      platform: 'linux',
      homeDir,
    });

    expect(existsSync(configDir)).toBe(false);
    expect(existsSync(stateRoot())).toBe(false);
    expect(existsSync(logsRoot())).toBe(false);
    expect(existsSync(servicePath)).toBe(false);
    for (const skillDir of workspaceSkillDirs) {
      expect(existsSync(skillDir)).toBe(true);
    }
    expect(result.entries).toEqual(
      expect.arrayContaining([
        { status: 'removed', path: configDir, reason: 'dreamux config directory' },
        { status: 'removed', path: servicePath, reason: 'systemd unit' },
        { status: 'removed', path: stateRoot(), reason: 'dreamux state directory' },
        { status: 'removed', path: logsRoot(), reason: 'dreamux logs directory' },
        ...workspaceSkillDirs.map((skillDir) => ({
          status: 'skipped' as const,
          path: skillDir,
          reason: 'workspace-local bundled skill (not removed)',
        })),
      ]),
    );
    expect(runner.calls.map((call) => [call.command, call.args])).toEqual([
      ['systemctl', ['--user', 'disable', '--now', 'dreamux.service']],
      ['systemctl', ['--user', 'daemon-reload']],
    ]);
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
        content: JSON.stringify({
          dispatchers: [
            {
              id: 'flow',
              feishu: {
                app_id: 'app-test',
                app_secret: 'secret-test',
              },
            },
          ],
        }),
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
});
