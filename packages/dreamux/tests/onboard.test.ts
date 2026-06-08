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
import { loadConfigWithBuiltins } from '../src/agent-runtime/load-config.js';
import {
  logsRoot,
  resetRuntimeConfig,
} from '../src/platform/paths.js';
import {
  dispatcherCodexHome,
  dispatcherWorkspaceSkillDir,
  dispatcherWorkspaceSkillDirs,
  dispatcherWorkspaceSkillPath,
} from '../src/agent-runtime/builtin/codex/paths.js';
import { testSingleDispatcherFileObject } from './helpers/config.js';

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
      configDir: join(root, 'config'),      dreamuxBin: '/usr/local/bin/dreamux',
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
    expect(dreamuxConfig['agents']).toEqual([
      {
        id: 'flow',
        provider: 'builtin:codex',
        config: {
          bin: process.execPath,
          approval_policy: 'never',
          sandbox_mode: 'workspace-write',
          extra_args: [],
          extra_env: {},
          initialize_timeout_ms: 10000,
          turn_timeout_ms: 600000,
        },
      },
    ]);
    expect(dreamuxConfig['dispatchers']).toEqual([{
      id: 'flow',
      cwd: join(root, 'dispatcher-cwd'),
      enabled: true,
      channels: [
        {
          id: 'primary',
          provider: 'builtin:feishu',
          config: {
            app_id: 'app-test',
            app_secret: 'secret-test',
          },
        },
      ],
      agentRuntime: 'flow',
    }]);
    expect(dreamuxConfig).not.toHaveProperty('feishu');
    expect(dreamuxConfig).not.toHaveProperty('codex');
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
    // The unit no longer pins CODEX_HOST_CODEX_BIN; the dispatcher's
    // runtime.config.bin resolves off the unit PATH instead (which includes the
    // codex dir below).
    expect(serviceUnit).not.toContain('CODEX_HOST_CODEX_BIN');
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
      configDir: join(root, 'config'),      registerService: false,
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
      configDir: join(root, 'config'),      dreamuxBin: '/usr/local/bin/dreamux',
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
      configDir: join(root, 'config'),      dreamuxBin: '/usr/local/bin/dreamux',
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
      configDir: join(root, 'config'),      registerService: true,
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
      configDir: join(root, 'config'),      registerService: true,
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
      configDir: join(root, 'config'),      registerService: true,
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
      configDir: join(root, 'config'),      registerService: true,
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
      HOME: join(root, 'home'),
    });
    // The unit no longer pins CODEX_HOST_CODEX_BIN; runtime.config.bin resolves
    // off PATH.
    expect(launchdPlist['EnvironmentVariables']).not.toHaveProperty(
      'CODEX_HOST_CODEX_BIN',
    );
    expect(launchdPlist['EnvironmentVariables']['PATH']).toContain(
      dirname(process.execPath),
    );
  });

  it('preserves existing dispatchers and their codex settings on rerun', async () => {
    const runner = new FakeRunner();
    const configDir = join(root, 'config');
    mkdirSync(configDir, { recursive: true });
    writeFileSync(
      join(configDir, 'config.json'),
      JSON.stringify(
        testSingleDispatcherFileObject({
          id: 'flow',
          cwd: join(root, 'flow-cwd'),
          enabled: true,
          feishu: {
            app_id: 'app-flow',
            app_secret: 'secret-flow',
          },
          codex: {
            bin: '/custom/codex-flow',
            approval_policy: 'on-failure',
            sandbox_mode: 'danger-full-access',
            extra_args: ['--model', 'local-default'],
            extra_env: {},
            initialize_timeout_ms: 25000,
          },
        }),
      ),
      { mode: 0o600 },
    );
    const answers = testAnswers({
      configDir,
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
    // The top-level codex block was removed; rerun never reintroduces it.
    expect(saved).not.toHaveProperty('codex');
    expect(saved).not.toHaveProperty('outbound');
    expect(saved).not.toHaveProperty('feishu');
    expect(saved['agents']).toEqual([
      {
        id: 'flow',
        provider: 'builtin:codex',
        config: {
          bin: '/custom/codex-flow',
          approval_policy: 'on-failure',
          sandbox_mode: 'danger-full-access',
          extra_args: ['--model', 'local-default'],
          extra_env: {},
          initialize_timeout_ms: 25000,
          turn_timeout_ms: 600000,
        },
      },
      {
        id: 'docs',
        provider: 'builtin:codex',
        config: {
          bin: process.execPath,
          approval_policy: 'never',
          sandbox_mode: 'workspace-write',
          extra_args: [],
          extra_env: {},
          initialize_timeout_ms: 10000,
          turn_timeout_ms: 600000,
        },
      },
    ]);
    expect(saved['dispatchers']).toEqual([
      {
        id: 'flow',
        cwd: join(root, 'flow-cwd'),
        enabled: true,
        channels: [
          {
            id: 'primary',
            provider: 'builtin:feishu',
            config: {
              app_id: 'app-flow',
              app_secret: 'secret-flow',
            },
          },
        ],
        agentRuntime: 'flow',
      },
      {
        id: 'docs',
        cwd: join(root, 'docs-cwd'),
        enabled: true,
        channels: [
          {
            id: 'primary',
            provider: 'builtin:feishu',
            config: {
              app_id: 'app-docs',
              app_secret: 'secret-docs',
            },
          },
        ],
        agentRuntime: 'docs',
      },
    ]);
  });

  it('preserves a teammate-only agent (unreferenced by any dispatcher) on rerun', async () => {
    // Regression for #148 P1: agents[] is the global runtime-config map and a
    // TeamMate can resolve an agent that no dispatcher names (e.g. a `claude`
    // agent used only via teammate.spawn under a Codex dispatcher). Re-running
    // onboard must NOT silently delete that entry.
    const runner = new FakeRunner();
    const configDir = join(root, 'config');
    mkdirSync(configDir, { recursive: true });
    const existing = {
      agents: [
        {
          id: 'flow',
          provider: 'builtin:codex',
          config: {
            bin: 'codex',
            approval_policy: 'never',
            sandbox_mode: 'workspace-write',
            extra_args: [],
            extra_env: {},
            initialize_timeout_ms: 10000,
          },
        },
        {
          id: 'claude-helper',
          provider: 'builtin:claude-code',
          config: { permission_mode: 'default' },
        },
      ],
      dispatchers: [
        {
          id: 'flow',
          cwd: join(root, 'flow-cwd'),
          enabled: true,
          channels: [
            {
              id: 'primary',
              provider: 'builtin:feishu',
              config: { app_id: 'app-flow', app_secret: 'secret-flow' },
            },
          ],
          agentRuntime: 'flow',
        },
      ],
    };
    writeFileSync(join(configDir, 'config.json'), JSON.stringify(existing), {
      mode: 0o600,
    });

    await runOnboard({
      answers: testAnswers({
        configDir,
        dispatcherId: 'docs',
        dispatcherCwd: join(root, 'docs-cwd'),
        registerService: false,
        botAppId: 'app-docs',
        botAppSecret: 'secret-docs',
      }),
      runner,
      platform: 'linux',
      homeDir: join(root, 'home'),
      env: { CODEX_ACCESS_TOKEN: 'interactive-token-test' },
    });

    const saved = JSON.parse(
      readFileSync(join(configDir, 'config.json'), 'utf8'),
    ) as Record<string, any>;
    const agentIds = (saved['agents'] as Array<{ id: string }>).map((a) => a.id);
    expect(agentIds).toEqual(expect.arrayContaining(['flow', 'docs', 'claude-helper']));
    const claudeHelper = (saved['agents'] as Array<any>).find(
      (a) => a.id === 'claude-helper',
    );
    expect(claudeHelper?.provider).toBe('builtin:claude-code');
  });

  it('rejects a new dispatcher that reuses an existing Feishu app_id', async () => {
    const runner = new FakeRunner();
    const configDir = join(root, 'config');
    const existingConfig = JSON.stringify(
      testSingleDispatcherFileObject({
        id: 'flow',
        cwd: join(root, 'flow-cwd'),
        enabled: false,
        feishu: {
          app_id: 'app-shared',
          app_secret: 'secret-flow',
        },
        codex: {
          approval_policy: 'never',
          sandbox_mode: 'workspace-write',
          extra_args: [],
          extra_env: {},
        },
      }),
    );
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

  it('onboard output round-trips through loadConfig (#148)', async () => {
    // Existing tests verify the *written JSON shape*. This test verifies that
    // loadConfig accepts that shape and produces a fully-resolved in-memory
    // DreamuxConfig (agents map populated, each dispatcher gets a `.runtime`
    // with the expected provider + config). This is the canonical round-trip
    // gate for the agents[] normalization.
    const runner = new FakeRunner();
    const configDir = join(root, 'config');
    const answers = testAnswers({
      configDir,
      dispatcherId: 'flow',
      registerService: false,
      botAppId: 'app-roundtrip',
      botAppSecret: 'secret-roundtrip',
    });
    writeGlobalCodexAuth(answers);

    await runOnboard({
      answers,
      runner,
      platform: 'linux',
      homeDir: join(root, 'home'),
      env: {},
    });

    // Now load the written config through the same parser.
    const { config } = await loadConfigWithBuiltins({ configDir });

    // agents map must be populated with the 'flow' agent.
    expect(Object.keys(config.agents)).toEqual(['flow']);
    expect(config.agents['flow']?.provider).toBe('builtin:codex');
    expect(config.agents['flow']?.config).toBeDefined();

    // Dispatcher must have its agentRuntime resolved into .runtime.
    expect(config.dispatchers).toHaveLength(1);
    expect(config.dispatchers[0]).toMatchObject({
      id: 'flow',
      agentRuntime: 'flow',
      runtime: {
        provider: 'builtin:codex',
        config: expect.objectContaining({ approval_policy: 'never' }),
      },
    });
    // In-memory runtime deep-equals the resolved agent config.
    expect(config.dispatchers[0]?.runtime).toEqual(config.agents['flow']);
  });

  it('fails non-interactive setup when required channel inputs are missing', () => {
    const options: OnboardCliOptions = {
      yes: true,
      configDir: join(root, 'config'),    };

    expect(() => answersFromOptions(options, false)).toThrow(
      'non-interactive onboard requires --bot-app-id',
    );
  });

  it('defaults non-interactive dispatcher cwd to the current working directory', () => {
    const answers = answersFromOptions(
      {
        yes: true,
        configDir: join(root, 'config'),        botAppId: 'app-test',
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
