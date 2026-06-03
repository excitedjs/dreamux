import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import { DispatcherRepo } from '../src/db/repository.js';
import { openDatabase } from '../src/db/schema.js';
import { runUninstall } from '../src/onboard/uninstall.js';
import type { CommandRunner } from '../src/onboard/types.js';
import {
  databasePath,
  dispatcherWorkspaceSkillPath,
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
    const workspaceSkillPath = dispatcherWorkspaceSkillPath(dispatcherCwd);
    mkdirSync(configDir, { recursive: true });
    mkdirSync(stateRoot(), { recursive: true });
    mkdirSync(logsRoot(), { recursive: true });
    mkdirSync(dirname(servicePath), { recursive: true });
    mkdirSync(dirname(workspaceSkillPath), { recursive: true });
    writeFileSync(join(configDir, 'config.json'), JSON.stringify({
      feishu: {
        bots: {
          flow: {
            app_id: 'app-test',
            app_secret: 'secret-test',
          },
        },
      },
    }), { mode: 0o600 });
    writeFileSync(join(logsRoot(), 'dreamux-server.log'), '');
    writeFileSync(workspaceSkillPath, '# workspace skill\n');
    writeDispatcher('flow', dispatcherCwd);
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
    expect(existsSync(workspaceSkillPath)).toBe(true);
    expect(result.entries).toEqual(
      expect.arrayContaining([
        { status: 'removed', path: configDir, reason: 'dreamux config directory' },
        { status: 'removed', path: servicePath, reason: 'systemd unit' },
        { status: 'removed', path: stateRoot(), reason: 'dreamux state directory' },
        { status: 'removed', path: logsRoot(), reason: 'dreamux logs directory' },
        {
          status: 'skipped',
          path: workspaceSkillPath,
          reason: 'workspace-local dispatcher skill (not removed)',
        },
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

  it('fails fast on legacy or invalid config instead of falling back to the default runtime', async () => {
    const cases: Array<{
      name: string;
      file: string;
      content: string;
      error: RegExp;
    }> = [
      {
        name: 'legacy TOML only',
        file: 'config.toml',
        content: 'runtime_dir = "/tmp/old-runtime"\n',
        error: /legacy dreamux config/,
      },
      {
        name: 'invalid JSON syntax',
        file: 'config.json',
        content: '{"runtime_dir": ',
        error: /dreamux config parse error/,
      },
      {
        name: 'invalid JSON value',
        file: 'config.json',
        content: JSON.stringify({ runtime_dir: 42 }),
        error: /runtime_dir must be a string/,
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
        writeFileSync(join(configDir, testCase.file), testCase.content, {
          mode: 0o600,
        });
      } else {
        writeFileSync(join(configDir, testCase.file), testCase.content);
      }
      writeFileSync(join(stateRoot(), 'state.db'), '');
      writeFileSync(join(logsRoot(), 'dreamux-server.log'), '');
      writeFileSync(servicePath, '[Service]\nExecStart=dreamux serve\n');

      const runner = new FakeRunner();
      try {
        await expect(
          runUninstall({
            configDir,
            runner,
            platform: 'linux',
            homeDir,
          }),
        ).rejects.toThrow(testCase.error);

        expect(existsSync(configDir)).toBe(true);
        expect(existsSync(stateRoot())).toBe(true);
        expect(existsSync(logsRoot())).toBe(true);
        expect(existsSync(servicePath)).toBe(true);
        expect(runner.calls).toEqual([]);
      } finally {
        process.env['HOME'] = previousCaseHome;
      }
    }
  });
});

function writeDispatcher(dispatcherId: string, dispatcherCwd: string): void {
  const db = openDatabase({ path: databasePath() });
  try {
    new DispatcherRepo(db).create({
      dispatcher_id: dispatcherId,
      bot_app_id: 'app-test',
      bot_secret_ref: `config:${dispatcherId}`,
      codex_cwd: dispatcherCwd,
    });
  } finally {
    db.close();
  }

  expect(existsSync(databasePath())).toBe(true);
}
