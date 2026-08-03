import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, dirname, join, sep } from 'node:path';

import { parse as parsePlist } from 'plist';

import { runOnboard } from '../src/onboard/run.js';
import {
  answersFromOptions,
  type OnboardCliOptions,
} from '../src/onboard/wizard.js';
import type {
  CommandRunner,
  OnboardAnswers,
  OnboardChannelConfig,
} from '../src/onboard/types.js';
import type { ServiceNodeProbe } from '../src/onboard/service.js';
import { loadConfig } from '../src/config/config.js';
import {
  logsRoot,
  resetRuntimeConfig,
} from '../src/platform/paths.js';
import { dispatcherCodexHome } from '@excitedjs/agent-runtime-codex';
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
  isExecutable: async () => false,
};
const LINUXBREW_BIN = '/home/linuxbrew/.linuxbrew/bin';

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
    process.env['DREAMUX_ROOT'] = join(root, 'dreamux');
  });

  afterEach(() => {
    if (previousHome === undefined) delete process.env['HOME'];
    else process.env['HOME'] = previousHome;
    delete process.env['DREAMUX_ROOT'];
    resetRuntimeConfig();
    rmSync(root, { recursive: true, force: true });
  });

  it('writes dispatcher state, records subprocess files, and passes the serve doctor', async () => {
    const runner = new FakeRunner();
    const answers = testAnswers({
      configDir: join(root, 'config'),
      dreamuxBin: '/usr/local/bin/dreamux',
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
      workspace: { enabled: true },
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
    const workspaceSkillRoot = join(answers.dispatcherCwd, '.codex', 'skills');
    expect(existsSync(workspaceSkillRoot)).toBe(false);
    const ledger = new Map(result.files.map((entry) => [entry.path, entry]));
    expect(
      result.files.some(
        (entry) =>
          entry.path === workspaceSkillRoot ||
          entry.path.startsWith(`${workspaceSkillRoot}${sep}`),
      ),
    ).toBe(false);
    expect(ledger.get(join(root, 'config', 'config.json'))?.status).toBe(
      'created',
    );
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
    // The service PATH leads with the stable Node dir and includes the user's
    // local standard bin dir ($HOME/.local/bin here) so provider-owned bare
    // binaries installed there (e.g. local-agent) resolve under the service env.
    const servicePath =
      serviceUnit
        .split('\n')
        .find((line) => line.startsWith('Environment=PATH='))
        ?.slice('Environment=PATH='.length) ?? '';
    expect(servicePath).toContain(dirname(process.execPath));
    expect(servicePath).toContain(join(root, 'home', '.local', 'bin'));
    expect(servicePath.split(':')[0]).toBe(dirname(process.execPath));
    expect(
      ledger.get(join(logsRoot(), 'daemon.stdout.log'))?.status,
    ).toBe('created');
    expect(result.files.map((entry) => entry.reason)).not.toContain(
      'dispatcher database',
    );
  });

  it('pins the service to a stable system Node and leads PATH with its directory', async () => {
    const runner = new FakeRunner();
    const answers = testAnswers({
      configDir: join(root, 'config'),
      dreamuxBin: '/usr/local/bin/dreamux',
    });
    writeGlobalCodexAuth(answers);
    // /usr/local/bin/node exists, is not version-manager-bound, satisfies the
    // minimum version, so it wins over process.execPath.
    const stableNodeProbe: ServiceNodeProbe = {
      realpath: async (path) => path,
      isExecutable: async (path) => path === '/usr/local/bin/node',
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
    const servicePath =
      serviceUnit
        .split('\n')
        .find((line) => line.startsWith('Environment=PATH='))
        ?.slice('Environment=PATH='.length) ?? '';
    // The stable Node dir leads the service PATH; the user's local standard bin
    // dir is also included so bare provider binaries installed there resolve.
    expect(servicePath.split(':')[0]).toBe('/usr/local/bin');
    expect(servicePath).toContain(join(root, 'home', '.local', 'bin'));
    expect(serviceUnit).not.toContain(
      `Environment=DREAMUX_NODE_BIN=${process.execPath}`,
    );
  });

  it('captures the interactive session PATH into the service PATH after stable dirs', async () => {
    const runner = new FakeRunner();
    const answers = testAnswers({
      configDir: join(root, 'config'),
      dreamuxBin: '/usr/local/bin/dreamux',
    });
    writeGlobalCodexAuth(answers);
    // No stable system Node so the current process Node is used (its dirname
    // leads the service PATH). The session PATH carries synthetic nvm/pyenv
    // entries that must be preserved in order after the stable dirs.
    const sessionPath = [
      join(root, 'home', '.nvm', 'versions', 'node', 'v22.7.0', 'bin'),
      join(root, 'home', '.pyenv', 'shims'),
      '/usr/bin',
      '/bin',
    ].join(':');
    const probes: string[] = [];

    await runOnboard({
      answers,
      runner,
      platform: 'linux',
      homeDir: join(root, 'home'),
      env: { PATH: sessionPath, CODEX_ACCESS_TOKEN: 'interactive-token-test' },
      nodeProbe: noSystemNodeProbe,
      execDirProbe: async (path) => {
        probes.push(path);
        return false;
      },
    });

    const serviceUnit = readFileSync(
      join(root, 'home', '.config', 'systemd', 'user', 'dreamux.service'),
      'utf8',
    );
    const servicePath =
      serviceUnit
        .split('\n')
        .find((line) => line.startsWith('Environment=PATH='))
        ?.slice('Environment=PATH='.length) ?? '';
    const parts = servicePath.split(':');
    // Stable dirs lead (the current Node bin dir).
    expect(parts[0]).toBe(dirname(process.execPath));
    // Session PATH entries follow in their original order.
    expect(parts).toContain(join(root, 'home', '.nvm', 'versions', 'node', 'v22.7.0', 'bin'));
    expect(parts).toContain(join(root, 'home', '.pyenv', 'shims'));
    // Fallback dirs are present last.
    expect(parts).toContain(join(root, 'home', '.local', 'bin'));
    expect(parts).not.toContain(LINUXBREW_BIN);
    expect(probes).toEqual([LINUXBREW_BIN]);
    // De-duplicated: /usr/bin appears exactly once (from session PATH; fallback
    // does not re-add it).
    expect(parts.filter((p) => p === '/usr/bin')).toHaveLength(1);
  });

  it('preserves Linuxbrew when the operator already supplied it in session PATH', async () => {
    const runner = new FakeRunner();
    const answers = testAnswers({
      configDir: join(root, 'config'),
      dreamuxBin: '/usr/local/bin/dreamux',
    });
    writeGlobalCodexAuth(answers);

    await runOnboard({
      answers,
      runner,
      platform: 'linux',
      homeDir: join(root, 'home'),
      env: {
        PATH: [LINUXBREW_BIN, '/usr/bin', '/bin'].join(':'),
        CODEX_ACCESS_TOKEN: 'interactive-token-test',
      },
      nodeProbe: noSystemNodeProbe,
      execDirProbe: async () => false,
    });

    const serviceUnit = readFileSync(
      join(root, 'home', '.config', 'systemd', 'user', 'dreamux.service'),
      'utf8',
    );
    const servicePath =
      serviceUnit
        .split('\n')
        .find((line) => line.startsWith('Environment=PATH='))
        ?.slice('Environment=PATH='.length) ?? '';
    expect(
      servicePath
        .split(':')
        .filter((entry) => entry === LINUXBREW_BIN),
    ).toHaveLength(1);
  });

  it('captures the ambient process.env PATH when options.env is omitted (normal CLI use)', async () => {
    const runner = new FakeRunner();
    const answers = testAnswers({
      configDir: join(root, 'config'),
      dreamuxBin: '/usr/local/bin/dreamux',
    });
    writeGlobalCodexAuth(answers);
    const home = join(root, 'home');
    // Synthetic nvm/pyenv dirs in the ambient PATH. Not fallback dirs, so they
    // can only come from the captured session PATH.
    const nvmBin = join(home, '.nvm', 'versions', 'node', 'v22.7.0', 'bin');
    const pyenvShims = join(home, '.pyenv', 'shims');
    const oldPath = process.env['PATH'];
    const oldToken = process.env['CODEX_ACCESS_TOKEN'];
    process.env['PATH'] = [nvmBin, pyenvShims, '/usr/bin', '/bin'].join(delimiter);
    process.env['CODEX_ACCESS_TOKEN'] = 'interactive-token-test';

    try {
      // No env option: normal CLI use falls back to process.env.
      await runOnboard({
        answers,
        runner,
        platform: 'linux',
        homeDir: home,
        nodeProbe: noSystemNodeProbe,
      });
    } finally {
      process.env['PATH'] = oldPath;
      if (oldToken === undefined) delete process.env['CODEX_ACCESS_TOKEN'];
      else process.env['CODEX_ACCESS_TOKEN'] = oldToken;
    }

    const serviceUnit = readFileSync(
      join(home, '.config', 'systemd', 'user', 'dreamux.service'),
      'utf8',
    );
    const servicePath =
      serviceUnit
        .split('\n')
        .find((line) => line.startsWith('Environment=PATH='))
        ?.slice('Environment=PATH='.length) ?? '';
    const parts = servicePath.split(delimiter);
    // Stable dirs lead (the current Node bin dir).
    expect(parts[0]).toBe(dirname(process.execPath));
    // Ambient session PATH entries are captured in order.
    expect(parts).toContain(nvmBin);
    expect(parts).toContain(pyenvShims);
    // Fallback dirs are present last.
    expect(parts).toContain(join(home, '.local', 'bin'));
  });

  it('excludes a version-manager-bound candidate and falls back to the current Node', async () => {
    const runner = new FakeRunner();
    const answers = testAnswers({
      configDir: join(root, 'config'),
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
      isExecutable: async (path) => path === '/usr/local/bin/node',
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
    // The user's local standard bin dir is included so bare provider binaries
    // installed there (e.g. local-agent in $HOME/.local/bin) resolve for the service.
    expect(launchdPlist['EnvironmentVariables']['PATH']).toContain(
      join(root, 'home', '.local', 'bin'),
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
      channels: [feishuOnboardChannel('app-docs', 'secret-docs')],
    });
    writeGlobalCodexAuth(answers);

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
        workspace: { enabled: true },
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
        workspace: { enabled: true },
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

    const answers = testAnswers({
      configDir,
      dispatcherId: 'docs',
      dispatcherCwd: join(root, 'docs-cwd'),
      registerService: false,
      channels: [feishuOnboardChannel('app-docs', 'secret-docs')],
    });
    writeGlobalCodexAuth(answers);

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
    const agentIds = (saved['agents'] as Array<{ id: string }>).map((a) => a.id);
    expect(agentIds).toEqual(expect.arrayContaining(['flow', 'docs', 'claude-helper']));
    const claudeHelper = (saved['agents'] as Array<any>).find(
      (a) => a.id === 'claude-helper',
    );
    expect(claudeHelper?.provider).toBe('builtin:claude-code');
  });

  it('allows a new dispatcher that reuses an existing Feishu app_id (#209 Decision #4: cross-dispatcher uniqueness relaxed)', async () => {
    // Decision #4 (issue #209): cross-dispatcher Feishu app_id uniqueness is no
    // longer enforced. Two dispatchers sharing one bot identity is an operator
    // choice, not a config error — onboard adds the second dispatcher and
    // rewrites the config instead of failing loud + rolling back.
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

    const answers = testAnswers({
      configDir,
      dispatcherId: 'docs',
      dispatcherCwd: join(root, 'docs-cwd'),
      channels: [feishuOnboardChannel('app-shared', 'secret-docs')],
      registerService: false,
    });
    writeGlobalCodexAuth(answers);

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
    expect(
      (saved['dispatchers'] as Array<{ id: string }>).map((d) => d.id),
    ).toEqual(expect.arrayContaining(['flow', 'docs']));
    const appIds = (saved['dispatchers'] as Array<any>).map(
      (d) => d.channels[0].config.app_id,
    );
    expect(appIds).toEqual(['app-shared', 'app-shared']);
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
      channels: [feishuOnboardChannel('app-roundtrip', 'secret-roundtrip')],
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
    const { config } = await loadConfig({ configDir });

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

  it('fails non-interactive setup when required channel inputs are missing', async () => {
    const options: OnboardCliOptions = {
      yes: true,
      configDir: join(root, 'config'),
    };

    await expect(answersFromOptions(options, false)).rejects.toThrow(
      "provider onboard prompt 'Feishu bot app id' requires interactive input",
    );
  });

  it('defaults non-interactive dispatcher cwd to the current working directory', async () => {
    const answers = await answersFromOptions(
      {
        yes: true,
        configDir: join(root, 'config'),
        channelConfigJson: JSON.stringify({
          app_id: 'app-test',
          app_secret: 'secret-test',
        }),
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
    agentRuntime: {
      id: overrides.dispatcherId ?? 'flow',
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
    channels: [feishuOnboardChannel('app-test', 'secret-test')],
    registerService: true,
    startService: true,
    dreamuxBin: '/usr/local/bin/dreamux',
    dryRun: false,
    ...overrides,
  };
}

function feishuOnboardChannel(
  appId: string,
  appSecret: string,
): OnboardChannelConfig {
  return {
    id: 'primary',
    provider: 'builtin:feishu',
    config: {
      app_id: appId,
      app_secret: appSecret,
    },
  };
}

function rootForTest(overrides: Partial<OnboardAnswers>): string {
  const fromConfig = overrides.configDir;
  if (fromConfig !== undefined) return join(fromConfig, '..');
  return homedir();
}
