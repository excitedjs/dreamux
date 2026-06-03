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

import { runUninstall } from '../src/onboard/uninstall.js';
import type { CommandRunner } from '../src/onboard/types.js';

class FakeRunner implements CommandRunner {
  readonly calls: Array<{ command: string; args: string[] }> = [];

  async run(command: string, args: string[]): Promise<void> {
    this.calls.push({ command, args });
  }

  async check(): Promise<boolean> {
    return false;
  }

  async capture(): Promise<string> {
    return '';
  }
}

describe('dreamux uninstall', () => {
  let root: string;
  let previousCodexHome: string | undefined;
  let previousClaudeConfigDir: string | undefined;

  beforeEach(() => {
    root = mkdtempSync(join(homedir(), '.dreamux-uninstall-'));
    previousCodexHome = process.env['CODEX_HOME'];
    previousClaudeConfigDir = process.env['CLAUDE_CONFIG_DIR'];
  });

  afterEach(() => {
    restoreEnv('CODEX_HOME', previousCodexHome);
    restoreEnv('CLAUDE_CONFIG_DIR', previousClaudeConfigDir);
    rmSync(root, { recursive: true, force: true });
  });

  it('removes onboard-owned config, runtime, and user service files', async () => {
    const configDir = join(root, 'config');
    const runtimeDir = join(root, 'runtime');
    const homeDir = join(root, 'home');
    const servicePath = join(homeDir, '.config', 'systemd', 'user', 'dreamux.service');
    mkdirSync(configDir, { recursive: true });
    mkdirSync(runtimeDir, { recursive: true });
    mkdirSync(dirname(servicePath), { recursive: true });
    writeFileSync(join(configDir, 'config.json'), JSON.stringify({
      runtime_dir: runtimeDir,
    }));
    writeFileSync(join(runtimeDir, 'state.db'), '');
    writeFileSync(servicePath, '[Service]\nExecStart=dreamux serve\n');

    const runner = new FakeRunner();
    const result = await runUninstall({
      configDir,
      runner,
      platform: 'linux',
      homeDir,
    });

    expect(existsSync(configDir)).toBe(false);
    expect(existsSync(runtimeDir)).toBe(false);
    expect(existsSync(servicePath)).toBe(false);
    expect(result.entries.map((entry) => [entry.status, entry.path])).toEqual([
      ['removed', configDir],
      ['removed', servicePath],
      ['removed', runtimeDir],
    ]);
    expect(runner.calls.map((call) => [call.command, call.args])).toEqual([
      ['systemctl', ['--user', 'disable', '--now', 'dreamux.service']],
      ['systemctl', ['--user', 'daemon-reload']],
    ]);
  });

  it('refuses to remove operator Codex or Claude state paths', async () => {
    const runner = new FakeRunner();
    const configDir = join(root, 'config');
    const homeDir = join(root, 'home');
    process.env['CODEX_HOME'] = join(root, 'operator-codex');
    process.env['CLAUDE_CONFIG_DIR'] = join(root, 'operator-claude');

    for (const unsafeRuntimeDir of [
      join(homedir(), '.codex'),
      join(process.env['CODEX_HOME'], 'nested'),
      join(homedir(), '.claude'),
      process.env['CLAUDE_CONFIG_DIR'],
    ]) {
      await expect(
        runUninstall({
          configDir,
          runtimeDir: unsafeRuntimeDir,
          runner,
          platform: 'linux',
          homeDir,
        }),
      ).rejects.toThrow(/operator Codex\/Claude state/);
    }

    await expect(
      runUninstall({
        configDir: join(homedir(), '.claude'),
        runtimeDir: join(root, 'runtime'),
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
      const runtimeDir = join(caseRoot, 'runtime');
      const homeDir = join(caseRoot, 'home');
      const servicePath = join(
        homeDir,
        '.config',
        'systemd',
        'user',
        'dreamux.service',
      );
      mkdirSync(configDir, { recursive: true });
      mkdirSync(runtimeDir, { recursive: true });
      mkdirSync(dirname(servicePath), { recursive: true });
      writeFileSync(join(configDir, testCase.file), testCase.content);
      writeFileSync(join(runtimeDir, 'state.db'), '');
      writeFileSync(servicePath, '[Service]\nExecStart=dreamux serve\n');

      const runner = new FakeRunner();
      await expect(
        runUninstall({
          configDir,
          runner,
          platform: 'linux',
          homeDir,
        }),
      ).rejects.toThrow(testCase.error);

      expect(existsSync(configDir)).toBe(true);
      expect(existsSync(runtimeDir)).toBe(true);
      expect(existsSync(servicePath)).toBe(true);
      expect(runner.calls).toEqual([]);
    }
  });
});

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
