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

  beforeEach(() => {
    root = mkdtempSync(join(homedir(), '.dreamux-uninstall-'));
  });

  afterEach(() => {
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
});
