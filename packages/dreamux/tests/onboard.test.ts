import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import { parse as parsePlist } from 'plist';

import { runOnboard } from '../src/onboard/run.js';
import {
  answersFromOptions,
  type OnboardCliOptions,
} from '../src/onboard/wizard.js';
import type { CommandRunner, OnboardAnswers } from '../src/onboard/types.js';
import type { ServiceNodeProbe } from '../src/onboard/service.js';
import {
  dispatcherCodexHome,
  dispatcherWorkspaceSkillDirs,
  dispatcherWorkspaceSkillDir,
  dispatcherWorkspaceSkillPath,
  logsRoot,
  resetRuntimeConfig,
} from '../src/runtime/paths.js';

class FakeRunner implements CommandRunner {
  launchdLoaded = false;
  nodeVersion = 'v22.7.0';
  lingerEnableOk = true;
  readonly failedHelpCommands = new Set<string>();
  readonly calls: Array<{
    command: string;
    args: string[];
    cwd?: string;
    env?: NodeJS.ProcessEnv;
  }> = [];

  async run(
    command: string,
    args: string[],
    options: {
      cwd?: string;
      env?: NodeJS.ProcessEnv;
      dryRun?: boolean;
    } = {},
  ): Promise<void> {
    this.calls.push({
      command,
      args,
      cwd: options.cwd,
      env: options.env,
    });
    if (options.dryRun) return;

    if (command === 'launchctl' && args[0] === 'bootstrap') {
      this.launchdLoaded = true;
      return;
    }
    if (command === 'launchctl' && args[0] === 'bootout') {
      this.launchdLoaded = false;
      return;
    }
  }

  async check(
    command: string,
    args: string[],
    options: {
      cwd?: string;
      env?: NodeJS.ProcessEnv;
      dryRun?: boolean;
    } = {},
  ): Promise<boolean> {
    void options;
    if (args[0] === '--help') {
      return !this.failedHelpCommands.has(command);
    }
    if (command === 'loginctl' && args[0] === 'enable-linger') {
      return this.lingerEnableOk;
    }
    return command === 'launchctl' &&
      args[0] === 'print' &&
      this.launchdLoaded;
  }

  async capture(
    command: string,
    args: string[],
    options: {
      cwd?: string;
      env?: NodeJS.ProcessEnv;
      dryRun?: boolean;
    } = {},
  ): Promise<string> {
    void options;
    if (args[0] === '--version') return this.nodeVersion;
    throw new Error(`unexpected capture: ${command} ${args.join(' ')}`);
  }
}

// No stable system Node exists: every candidate is skipped, so onboarding
// falls back to the current Node (process.execPath). Keeps the assertions on
// DREAMUX_NODE_BIN hermetic regardless of what the test host has installed.
const noSystemNodeProbe: ServiceNodeProbe = {
  realpath: async (path) => path,
  isExecutable: () => false,
};

function writeGlobalCodexAuth(answers: OnboardAnswers): void {
  const authPath = join(dispatcherCodexHome(answers.dispatcherId), 'auth.json');
  mkdirSync(dirname(authPath), { recursive: true });
  writeFileSync(authPath, '{}', { mode: 0o600 });
}

function countCalls(
  runner: FakeRunner,
  command: string,
  argsPrefix: string[],
): number {
  return runner.calls.filter((call) =>
    call.command === command &&
    argsPrefix.every((arg, index) => call.args[index] === arg),
  ).length;
}

describe('dreamux onboard', () => {
  let root: string;
  let previousHome: string | undefined;

  beforeEach(() => {
    root = mkdtempSync(join(homedir(), '.dreamux-onboard-'));
    previousHome = process.env['HOME'];
    process.env['HOME'] = join(root, 'home');
  });

  afterEach(() => {
    if (previousHome === undefined) delete process.env['HOME'];
    else process.env['HOME'] = previousHome;
    resetRuntimeConfig();
    rmSync(root, { recursive: true, force: true });
  });

  it('writes dispatcher state, records subprocess files, and passes the serve doctor', async () => {
    const runner = new FakeRunner();
    const answers = testAnswers({
      configDir: join(root, 'config'),
      runtimeDir: join(root, 'runtime'),
      dreamuxBin: '/usr/local/bin/dreamux',
      botAppId: 'app-test',
      botAppSecret: 'secret-test',
    });
    writeGlobalCodexAuth(answers);

    const result = await runOnboard({
      answers,
      runner,
      platform: 'linux',
      homeDir: join(root, 'home'),
      env: { CODEX_ACCESS_TOKEN: 'interactive-token-test' },
      nodeProbe: noSystemNodeProbe,
    });

    expect(result.doctor.ok).toBe(true);
    expect(result.service).toMatchObject({
      platform: 'systemd',
      registered: true,
      started: true,
      lingerEnabled: true,
      warnings: [],
    });
    expect(runner.calls.map((call) => [call.command, call.args])).toEqual([
      ['systemctl', ['--user', 'daemon-reload']],
      ['systemctl', ['--user', 'enable', '--now', 'dreamux.service']],
    ]);

    const dreamuxConfig = JSON.parse(
      readFileSync(join(root, 'config', 'config.json'), 'utf8'),
    ) as Record<string, any>;
    expect(dreamuxConfig['dispatchers']).toEqual([{
      id: 'flow',
      cwd: join(root, 'dispatcher-cwd'),
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
    }]);
    expect(dreamuxConfig).not.toHaveProperty('feishu');
    expect(dreamuxConfig).not.toHaveProperty('runtime_dir');
    expect(dreamuxConfig).not.toHaveProperty('admin_socket');
    expect(dreamuxConfig).not.toHaveProperty('outbound');
    expect(
      existsSync(dispatcherWorkspaceSkillPath(answers.dispatcherCwd)),
    ).toBe(true);
    for (const skillDir of dispatcherWorkspaceSkillDirs(answers.dispatcherCwd)) {
      expect(lstatSync(skillDir).isSymbolicLink()).toBe(true);
    }
    expect(
      existsSync(
        join(dispatcherCodexHome('flow'), 'skills', 'dispatcher', 'SKILL.md'),
      ),
    ).toBe(false);
    const ledger = new Map(result.files.map((entry) => [entry.path, entry]));
    expect(ledger.get(join(root, 'config', 'config.json'))?.status).toBe(
      'created',
    );
    for (const skillDir of dispatcherWorkspaceSkillDirs(answers.dispatcherCwd)) {
      expect(ledger.get(skillDir)?.status).toBe('created');
    }
    expect(
      ledger.get(
        join(root, 'home', '.config', 'systemd', 'user', 'dreamux.service'),
      )?.status,
    ).toBe('created');
    const serviceUnit = readFileSync(
      join(root, 'home', '.config', 'systemd', 'user', 'dreamux.service'),
      'utf8',
    );
    expect(serviceUnit).toContain(`Environment=DREAMUX_NODE_BIN=${process.execPath}`);
    expect(serviceUnit).toContain(`Environment=CODEX_HOST_CODEX_BIN=${process.execPath}`);
    expect(serviceUnit).toContain(`Environment=HOME=${join(root, 'home')}`);
    expect(serviceUnit).toContain(`Environment=PATH=${dirname(process.execPath)}`);
    expect(
      ledger.get(join(logsRoot(), 'daemon.stdout.log'))?.status,
    ).toBe('created');
    expect(result.files.map((entry) => entry.reason)).not.toContain(
      'dispatcher database',
    );
  });

  it('reports skipped bundled skill conflicts during onboard', async () => {
    const runner = new FakeRunner();
    const answers = testAnswers({
      configDir: join(root, 'config'),
      runtimeDir: join(root, 'runtime'),
      registerService: false,
      startService: false,
    });
    writeGlobalCodexAuth(answers);
    const conflictDir = dispatcherWorkspaceSkillDir(
      answers.dispatcherCwd,
      'dreamux-maintenance',
    );
    mkdirSync(conflictDir, { recursive: true });
    writeFileSync(join(conflictDir, 'SKILL.md'), '# user maintenance skill\n');

    const result = await runOnboard({
      answers,
      runner,
      platform: 'linux',
      homeDir: join(root, 'home'),
      env: {},
      nodeProbe: noSystemNodeProbe,
    });

    const ledger = new Map(result.files.map((entry) => [entry.path, entry]));
    expect(ledger.get(conflictDir)?.status).toBe('skipped');
    expect(ledger.get(conflictDir)?.reason).toContain('left untouched');
    expect(readFileSync(join(conflictDir, 'SKILL.md'), 'utf8')).toBe(
      '# user maintenance skill\n',
    );
  });

  it('pins the service to a stable system Node and leads PATH with its directory', async () => {
    const runner = new FakeRunner();
    const answers = testAnswers({
      configDir: join(root, 'config'),
      runtimeDir: join(root, 'runtime'),
      dreamuxBin: '/usr/local/bin/dreamux',
    });
    writeGlobalCodexAuth(answers);
    // /usr/local/bin/node exists, is not version-manager-bound, satisfies the
    // minimum version, so it wins over process.execPath.
    const stableNodeProbe: ServiceNodeProbe = {
      realpath: async (path) => path,
      isExecutable: (path) => path === '/usr/local/bin/node',
    };

    await runOnboard({
      answers,
      runner,
      platform: 'linux',
      homeDir: join(root, 'home'),
      env: { CODEX_ACCESS_TOKEN: 'interactive-token-test' },
      nodeProbe: stableNodeProbe,
    });

    const serviceUnit = readFileSync(
      join(root, 'home', '.config', 'systemd', 'user', 'dreamux.service'),
      'utf8',
    );
    expect(serviceUnit).toContain('Environment=DREAMUX_NODE_BIN=/usr/local/bin/node');
    expect(serviceUnit).toContain('Environment=PATH=/usr/local/bin');
    expect(serviceUnit).not.toContain(
      `Environment=DREAMUX_NODE_BIN=${process.execPath}`,
    );
  });

  it('excludes a version-manager-bound candidate and falls back to the current Node', async () => {
    const runner = new FakeRunner();
    const answers = testAnswers({
      configDir: join(root, 'config'),
      runtimeDir: join(root, 'runtime'),
      dreamuxBin: '/usr/local/bin/dreamux',
    });
    writeGlobalCodexAuth(answers);
    // /usr/local/bin/node is executable but realpaths into an nvm install, so
    // it must be skipped and onboarding falls back to process.execPath.
    const vmShimProbe: ServiceNodeProbe = {
      realpath: async (path) =>
        path === '/usr/local/bin/node'
          ? `${join(root, 'home')}/.nvm/versions/node/v22.7.0/bin/node`
          : path,
      isExecutable: (path) => path === '/usr/local/bin/node',
    };

    await runOnboard({
      answers,
      runner,
      platform: 'linux',
      homeDir: join(root, 'home'),
      env: { CODEX_ACCESS_TOKEN: 'interactive-token-test' },
      nodeProbe: vmShimProbe,
    });

    const serviceUnit = readFileSync(
      join(root, 'home', '.config', 'systemd', 'user', 'dreamux.service'),
      'utf8',
    );
    expect(serviceUnit).toContain(
      `Environment=DREAMUX_NODE_BIN=${process.execPath}`,
    );
    expect(serviceUnit).not.toContain(
      'Environment=DREAMUX_NODE_BIN=/usr/local/bin/node',
    );
  });

  it('degrades (does not fail) when systemd lingering cannot be enabled', async () => {
    const runner = new FakeRunner();
    runner.lingerEnableOk = false;
    const answers = testAnswers({
      configDir: join(root, 'config'),
      runtimeDir: join(root, 'runtime'),
      registerService: true,
    });
    writeGlobalCodexAuth(answers);

    const result = await runOnboard({
      answers,
      runner,
      platform: 'linux',
      homeDir: join(root, 'home'),
      env: { CODEX_ACCESS_TOKEN: 'interactive-token-test' },
      nodeProbe: noSystemNodeProbe,
    });

    expect(result.service).toMatchObject({
      platform: 'systemd',
      registered: true,
      lingerEnabled: false,
    });
    expect(result.service?.warnings.join(' ')).toContain('enable-linger');
    // daemon-reload + enable still ran; linger failure is non-fatal.
    expect(runner.calls.map((call) => [call.command, call.args])).toEqual([
      ['systemctl', ['--user', 'daemon-reload']],
      ['systemctl', ['--user', 'enable', '--now', 'dreamux.service']],
    ]);
  });

  it('does not let an interactive shell token satisfy the managed service doctor', async () => {
    const runner = new FakeRunner();
    const answers = testAnswers({
      configDir: join(root, 'config'),
      runtimeDir: join(root, 'runtime'),
      registerService: true,
    });

    await expect(
      runOnboard({
        answers,
        runner,
        platform: 'linux',
        homeDir: join(root, 'home'),
        env: { CODEX_ACCESS_TOKEN: 'interactive-token-test' },
      }),
    ).rejects.toThrow(
      'managed service environments do not inherit your interactive shell auth token',
    );
  });

  it('fails before systemd registration when the service cannot execute the launcher', async () => {
    const runner = new FakeRunner();
    const answers = testAnswers({
      configDir: join(root, 'config'),
      runtimeDir: join(root, 'runtime'),
      registerService: true,
      dreamuxBin: '/usr/local/bin/dreamux',
    });
    writeGlobalCodexAuth(answers);
    runner.failedHelpCommands.add(answers.dreamuxBin);

    await expect(
      runOnboard({
        answers,
        runner,
        platform: 'linux',
        homeDir: join(root, 'home'),
        env: {},
      }),
    ).rejects.toThrow('managed service cannot execute dreamux launcher');

    expect(countCalls(runner, 'systemctl', ['--user', 'daemon-reload'])).toBe(0);
    expect(countCalls(runner, 'systemctl', ['--user', 'enable'])).toBe(0);
  });

  it('rewrites workspace dispatcher skills and skips already-loaded launchd services on rerun', async () => {
    const runner = new FakeRunner();
    const answers = testAnswers({
      configDir: join(root, 'config'),
      runtimeDir: join(root, 'runtime'),
      registerService: true,
      startService: true,
    });
    writeGlobalCodexAuth(answers);

    await runOnboard({
      answers,
      runner,
      platform: 'darwin',
      homeDir: join(root, 'home'),
      uid: 501,
      env: {},
      nodeProbe: noSystemNodeProbe,
    });
    await runOnboard({
      answers,
      runner,
      platform: 'darwin',
      homeDir: join(root, 'home'),
      uid: 501,
      env: {},
      nodeProbe: noSystemNodeProbe,
    });

    expect(countCalls(runner, 'codex', ['plugin'])).toBe(0);
    expect(countCalls(runner, 'claude', ['plugin'])).toBe(0);
    expect(countCalls(runner, 'launchctl', ['bootstrap'])).toBe(1);
    expect(countCalls(runner, 'launchctl', ['bootout'])).toBe(0);
    expect(countCalls(runner, 'launchctl', ['kickstart'])).toBe(2);

    const launchdPlist = parsePlist(
      readFileSync(
        join(root, 'home', 'Library', 'LaunchAgents', 'dev.excited.dreamux.plist'),
        'utf8',
      ),
    ) as Record<string, any>;
    expect(launchdPlist['EnvironmentVariables']).toMatchObject({
      DREAMUX_NODE_BIN: process.execPath,
      CODEX_HOST_CODEX_BIN: process.execPath,
      HOME: join(root, 'home'),
    });
    expect(launchdPlist['EnvironmentVariables']['PATH']).toContain(
      dirname(process.execPath),
    );
  });

  it('preserves existing codex globals and other dispatchers on rerun', async () => {
    const runner = new FakeRunner();
    const ignoredRuntimeDir = join(root, 'ignored-runtime');
    const configDir = join(root, 'config');
    mkdirSync(configDir, { recursive: true });
    writeFileSync(
      join(configDir, 'config.json'),
      JSON.stringify({
        codex: {
          approval_policy: 'on-failure',
          sandbox_mode: 'danger-full-access',
          extra_args: ['--model', 'local-default'],
          initialize_timeout_ms: 12345,
        },
        dispatchers: [
          {
            id: 'flow',
            cwd: join(root, 'flow-cwd'),
            enabled: true,
            feishu: {
              app_id: 'app-flow',
              app_secret: 'secret-flow',
            },
            codex: {
              approval_policy: null,
              sandbox_mode: null,
              extra_args: [],
            },
          },
        ],
      }),
      { mode: 0o600 },
    );
    const answers = testAnswers({
      configDir,
      runtimeDir: ignoredRuntimeDir,
      dispatcherId: 'docs',
      dispatcherCwd: join(root, 'docs-cwd'),
      registerService: false,
      botAppId: 'app-docs',
      botAppSecret: 'secret-docs',
    });

    await runOnboard({
      answers,
      runner,
      platform: 'linux',
      homeDir: join(root, 'home'),
      env: { CODEX_ACCESS_TOKEN: 'interactive-token-test' },
    });

    const saved = JSON.parse(
      readFileSync(join(configDir, 'config.json'), 'utf8'),
    ) as Record<string, any>;
    expect(saved).not.toHaveProperty('runtime_dir');
    expect(saved).not.toHaveProperty('admin_socket');
    expect(saved['codex']).toMatchObject({
      approval_policy: 'on-failure',
      sandbox_mode: 'danger-full-access',
      extra_args: ['--model', 'local-default'],
      initialize_timeout_ms: 12345,
    });
    expect(saved).not.toHaveProperty('outbound');
    expect(saved).not.toHaveProperty('feishu');
    expect(saved['dispatchers']).toEqual([
      {
        id: 'flow',
        cwd: join(root, 'flow-cwd'),
        enabled: true,
        feishu: {
          app_id: 'app-flow',
          app_secret: 'secret-flow',
        },
        codex: {
          approval_policy: null,
          sandbox_mode: null,
          extra_args: [],
          extra_env: {},
        },
      },
      {
        id: 'docs',
        cwd: join(root, 'docs-cwd'),
        enabled: true,
        feishu: {
          app_id: 'app-docs',
          app_secret: 'secret-docs',
        },
        codex: {
          approval_policy: 'never',
          sandbox_mode: 'workspace-write',
          extra_args: [],
          extra_env: {},
        },
      },
    ]);
    expect(existsSync(ignoredRuntimeDir)).toBe(false);
  });

  it('rejects a new dispatcher that reuses an existing Feishu app_id', async () => {
    const runner = new FakeRunner();
    const configDir = join(root, 'config');
    const existingConfig = JSON.stringify({
      codex: {
        bin: 'codex',
        approval_policy: 'never',
        sandbox_mode: 'workspace-write',
        extra_args: [],
        initialize_timeout_ms: 10000,
      },
      dispatchers: [
        {
          id: 'flow',
          cwd: join(root, 'flow-cwd'),
          enabled: false,
          feishu: {
            app_id: 'app-shared',
            app_secret: 'secret-flow',
          },
          codex: {
            approval_policy: null,
            sandbox_mode: null,
            extra_args: [],
          },
        },
      ],
    });
    mkdirSync(configDir, { recursive: true });
    writeFileSync(join(configDir, 'config.json'), existingConfig, {
      mode: 0o600,
    });

    await expect(
      runOnboard({
        answers: testAnswers({
          configDir,
          dispatcherId: 'docs',
          botAppId: 'app-shared',
          botAppSecret: 'secret-docs',
          registerService: false,
        }),
        runner,
        platform: 'linux',
        homeDir: join(root, 'home'),
        env: {},
      }),
    ).rejects.toThrow(/duplicates dispatcher 'flow'/);

    expect(readFileSync(join(configDir, 'config.json'), 'utf8')).toBe(
      existingConfig,
    );
  });

  it('fails non-interactive setup when required channel inputs are missing', () => {
    const options: OnboardCliOptions = {
      yes: true,
      configDir: join(root, 'config'),
      runtimeDir: join(root, 'runtime'),
    };

    expect(() => answersFromOptions(options, false)).toThrow(
      'non-interactive onboard requires --bot-app-id',
    );
  });

  it('defaults non-interactive dispatcher cwd to the current working directory', () => {
    const answers = answersFromOptions(
      {
        yes: true,
        configDir: join(root, 'config'),
        runtimeDir: join(root, 'runtime'),
        botAppId: 'app-test',
        botAppSecret: 'secret-test',
      },
      false,
    );

    expect(answers.dispatcherCwd).toBe(process.cwd());
  });
});

function testAnswers(overrides: Partial<OnboardAnswers>): OnboardAnswers {
  return {
    configDir: join(rootForTest(overrides), 'config'),
    runtimeDir: join(rootForTest(overrides), 'runtime'),
    dispatcherId: 'flow',
    dispatcherCwd: join(rootForTest(overrides), 'dispatcher-cwd'),
    codexBin: process.execPath,
    botAppId: 'app-test',
    botAppSecret: 'secret-test',
    registerService: true,
    startService: true,
    dreamuxBin: '/usr/local/bin/dreamux',
    dryRun: false,
    ...overrides,
  };
}

function rootForTest(overrides: Partial<OnboardAnswers>): string {
  const fromConfig = overrides.configDir;
  if (fromConfig !== undefined) return join(fromConfig, '..');
  return homedir();
}
