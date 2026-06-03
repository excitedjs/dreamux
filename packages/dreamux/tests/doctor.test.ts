import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import { DispatcherRepo } from '../src/db/repository.js';
import { openDatabase } from '../src/db/schema.js';
import { runDreamuxDoctor } from '../src/cli/doctor.js';
import type { CommandRunner } from '../src/onboard/types.js';
import {
  dispatcherCodexConfigPath,
  dispatcherCodexHome,
  dispatcherCodexPluginsDir,
  resetRuntimeConfig,
  setRuntimeConfig,
} from '../src/runtime/paths.js';

class FakeRunner implements CommandRunner {
  systemdEnabled = false;
  systemdActive = false;
  launchdLoaded = false;
  readonly calls: Array<{ command: string; args: string[] }> = [];

  async run(command: string, args: string[]): Promise<void> {
    this.calls.push({ command, args });
  }

  async check(command: string, args: string[]): Promise<boolean> {
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
  let oldCodexHome: string | undefined;

  beforeEach(() => {
    root = mkdtempSync(join(homedir(), '.dreamux-doctor-'));
    oldConfigDir = process.env['DREAMUX_CONFIG_DIR'];
    oldRuntimeDir = process.env['CODEX_HOST_RUNTIME_DIR'];
    oldAdminSocket = process.env['CODEX_HOST_ADMIN_SOCKET'];
    oldCodexBin = process.env['CODEX_HOST_CODEX_BIN'];
    oldDreamuxBin = process.env['DREAMUX_BIN'];
    oldCodexHome = process.env['CODEX_HOME'];
    delete process.env['CODEX_HOST_RUNTIME_DIR'];
    delete process.env['CODEX_HOST_ADMIN_SOCKET'];
    delete process.env['CODEX_HOST_CODEX_BIN'];
    process.env['DREAMUX_CONFIG_DIR'] = join(root, 'config');
    process.env['DREAMUX_BIN'] = '/usr/local/bin/dreamux';
    process.env['CODEX_HOME'] = join(root, 'codex');
  });

  afterEach(() => {
    restoreEnv('DREAMUX_CONFIG_DIR', oldConfigDir);
    restoreEnv('CODEX_HOST_RUNTIME_DIR', oldRuntimeDir);
    restoreEnv('CODEX_HOST_ADMIN_SOCKET', oldAdminSocket);
    restoreEnv('CODEX_HOST_CODEX_BIN', oldCodexBin);
    restoreEnv('DREAMUX_BIN', oldDreamuxBin);
    restoreEnv('CODEX_HOME', oldCodexHome);
    resetRuntimeConfig();
    rmSync(root, { recursive: true, force: true });
  });

  it('reports inherited Codex home health', async () => {
    const runner = new FakeRunner();
    const config = writeConfig();
    writeDispatcher(config.runtimeDir, { auth: true });

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

  it('checks managed-service dispatcher auth when a service is installed', async () => {
    const runner = new FakeRunner();
    const config = writeConfig();
    writeDispatcher(config.runtimeDir, { auth: false });
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

  function writeConfig(): { runtimeDir: string } {
    const runtimeDir = join(root, 'runtime');
    const configPath = join(root, 'config', 'config.json');
    mkdirSync(dirname(configPath), { recursive: true });
    writeFileSync(
      configPath,
      JSON.stringify({
        runtime_dir: runtimeDir,
        admin_socket: null,
        codex: {
          bin: 'codex',
          approval_policy: 'never',
          sandbox_mode: 'workspace-write',
          extra_args: [],
          initialize_timeout_ms: 10000,
        },
        outbound: {
          retries: 3,
          retry_delay_ms: 1000,
        },
        feishu: {
          bots: {
            flow: {
              app_id: 'app-test',
              app_secret: 'secret-test',
            },
          },
        },
      }),
    );
    return { runtimeDir };
  }

  function writeDispatcher(
    runtimeDir: string,
    options: { auth: boolean },
  ): void {
    setRuntimeConfig({
      runtime_dir: runtimeDir,
      admin_socket: null,
      codex: {
        bin: 'codex',
        approval_policy: 'never',
        sandbox_mode: 'workspace-write',
        extra_args: [],
        initialize_timeout_ms: 10000,
      },
      outbound: {
        retries: 3,
        retry_delay_ms: 1000,
      },
      feishu: {
        bots: {
          flow: {
            app_id: 'app-test',
            app_secret: 'secret-test',
          },
        },
      },
    });
    mkdirSync(dispatcherCodexPluginsDir('flow'), { recursive: true });
    mkdirSync(join(dispatcherCodexPluginsDir('flow'), 'cache', 'dreamux', 'codexmux'), {
      recursive: true,
    });
    writeFileSync(
      dispatcherCodexConfigPath('flow'),
      '[marketplaces.dreamux]\nsource = "excitedjs/dreamux"\n',
    );
    if (options.auth) {
      writeFileSync(join(dispatcherCodexHome('flow'), 'auth.json'), '{}');
    }
    mkdirSync(runtimeDir, { recursive: true });
    const db = openDatabase({ path: join(runtimeDir, 'state.db') });
    try {
      new DispatcherRepo(db).create({
        dispatcher_id: 'flow',
        bot_app_id: 'app-test',
        bot_secret_ref: 'env:DREAMUX_TEST_BOT_SECRET',
        codex_args_json: JSON.stringify({
          approvalPolicy: 'never',
          sandboxMode: 'workspace-write',
          extraArgs: [],
        }),
      });
    } finally {
      db.close();
    }
  }
});

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}
