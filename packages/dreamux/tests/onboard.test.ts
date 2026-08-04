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
  OnboardProviderContext,
} from '../src/onboard/types.js';
import type { ServiceNodeProbe } from '../src/onboard/service.js';
import { loadConfig } from '../src/config/config.js';
import {
  logsRoot,
  pluginRoot,
  resetRuntimeConfig,
} from '../src/platform/paths.js';
import { dispatcherCodexHome } from '@excitedjs/agent-runtime-codex';
import { testSingleDispatcherFileObject } from './helpers/config.js';
import {
  publishProviderPluginGenerationSync,
  providerPluginSource,
  readProviderPluginMetadataSync,
  writeProviderPluginMetadataSync,
} from './helpers/provider-plugin.js';
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
function systemdServiceUnit(root: string): string {
  return readFileSync(
    join(root, 'home', '.config', 'systemd', 'user', 'dreamux.service'),
    'utf8',
  );
}
function systemdServicePath(root: string): string {
  return systemdServiceUnit(root)
    .split('\n')
    .find((line) => line.startsWith('Environment=PATH='))
    ?.slice('Environment=PATH='.length) ?? '';
}
function writeExistingConfig(configDir: string, value: unknown): void {
  mkdirSync(configDir, { recursive: true });
  writeFileSync(join(configDir, 'config.json'), JSON.stringify(value), {
    mode: 0o600,
  });
}
function readSavedConfig(configDir: string): Record<string, any> {
  return JSON.parse(readFileSync(join(configDir, 'config.json'), 'utf8')) as Record<string, any>;
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
  function serviceAnswers(overrides: Partial<OnboardAnswers> = {}): OnboardAnswers {
    const answers = testAnswers({ configDir: join(root, 'config'), ...overrides });
    writeGlobalCodexAuth(answers);
    return answers;
  }
  it('writes dispatcher state, records subprocess files, and passes the serve doctor', async () => {
    const runner = new FakeRunner();
    const answers = serviceAnswers();
    const result = await runOnboardForTest(root, answers, runner, {
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
    const serviceUnit = systemdServiceUnit(root);
    expect(serviceUnit).toContain(`Environment=DREAMUX_NODE_BIN=${process.execPath}`);
    expect(serviceUnit).not.toContain('CODEX_HOST_CODEX_BIN');
    expect(serviceUnit).toContain(`Environment=HOME=${join(root, 'home')}`);
    const servicePath = systemdServicePath(root);
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
    const answers = serviceAnswers();
    const stableNodeProbe: ServiceNodeProbe = {
      realpath: async (path) => path,
      isExecutable: async (path) => path === '/usr/local/bin/node',
    };
    await runOnboardForTest(root, answers, runner, { nodeProbe: stableNodeProbe });
    const serviceUnit = systemdServiceUnit(root);
    expect(serviceUnit).toContain('Environment=DREAMUX_NODE_BIN=/usr/local/bin/node');
    const servicePath = systemdServicePath(root);
    expect(servicePath.split(':')[0]).toBe('/usr/local/bin');
    expect(servicePath).toContain(join(root, 'home', '.local', 'bin'));
    expect(serviceUnit).not.toContain(
      `Environment=DREAMUX_NODE_BIN=${process.execPath}`,
    );
  });
  it('captures the interactive session PATH into the service PATH after stable dirs', async () => {
    const runner = new FakeRunner();
    const answers = serviceAnswers();
    const sessionPath = [
      join(root, 'home', '.nvm', 'versions', 'node', 'v22.7.0', 'bin'),
      join(root, 'home', '.pyenv', 'shims'),
      '/usr/bin',
      '/bin',
    ].join(':');
    const probes: string[] = [];
    await runOnboardForTest(root, answers, runner, {
      env: { PATH: sessionPath, CODEX_ACCESS_TOKEN: 'interactive-token-test' },
      nodeProbe: noSystemNodeProbe,
      execDirProbe: async (path) => {
        probes.push(path);
        return false;
      },
    });
    const servicePath = systemdServicePath(root);
    const parts = servicePath.split(':');
    expect(parts[0]).toBe(dirname(process.execPath));
    expect(parts).toContain(join(root, 'home', '.nvm', 'versions', 'node', 'v22.7.0', 'bin'));
    expect(parts).toContain(join(root, 'home', '.pyenv', 'shims'));
    expect(parts).toContain(join(root, 'home', '.local', 'bin'));
    expect(parts).not.toContain(LINUXBREW_BIN);
    expect(probes).toEqual([LINUXBREW_BIN]);
    expect(parts.filter((p) => p === '/usr/bin')).toHaveLength(1);
  });
  it('preserves Linuxbrew when the operator already supplied it in session PATH', async () => {
    const runner = new FakeRunner();
    const answers = serviceAnswers();
    await runOnboardForTest(root, answers, runner, {
      env: {
        PATH: [LINUXBREW_BIN, '/usr/bin', '/bin'].join(':'),
        CODEX_ACCESS_TOKEN: 'interactive-token-test',
      },
      nodeProbe: noSystemNodeProbe,
      execDirProbe: async () => false,
    });
    const servicePath = systemdServicePath(root);
    expect(
      servicePath
        .split(':')
        .filter((entry) => entry === LINUXBREW_BIN),
    ).toHaveLength(1);
  });
  it('captures the ambient process.env PATH when options.env is omitted (normal CLI use)', async () => {
    const runner = new FakeRunner();
    const answers = serviceAnswers();
    const home = join(root, 'home');
    const nvmBin = join(home, '.nvm', 'versions', 'node', 'v22.7.0', 'bin');
    const pyenvShims = join(home, '.pyenv', 'shims');
    const oldPath = process.env['PATH'];
    const oldToken = process.env['CODEX_ACCESS_TOKEN'];
    process.env['PATH'] = [nvmBin, pyenvShims, '/usr/bin', '/bin'].join(delimiter);
    process.env['CODEX_ACCESS_TOKEN'] = 'interactive-token-test';
    try {
      await runOnboardForTest(root, answers, runner, {
        homeDir: home,
        env: undefined,
        nodeProbe: noSystemNodeProbe,
      });
    } finally {
      process.env['PATH'] = oldPath;
      if (oldToken === undefined) delete process.env['CODEX_ACCESS_TOKEN'];
      else process.env['CODEX_ACCESS_TOKEN'] = oldToken;
    }
    const servicePath = systemdServicePath(root);
    const parts = servicePath.split(delimiter);
    expect(parts[0]).toBe(dirname(process.execPath));
    expect(parts).toContain(nvmBin);
    expect(parts).toContain(pyenvShims);
    expect(parts).toContain(join(home, '.local', 'bin'));
  });
  it('excludes a version-manager-bound candidate and falls back to the current Node', async () => {
    const runner = new FakeRunner();
    const answers = serviceAnswers();
    const vmShimProbe: ServiceNodeProbe = {
      realpath: async (path) =>
        path === '/usr/local/bin/node'
          ? `${join(root, 'home')}/.nvm/versions/node/v22.7.0/bin/node`
          : path,
      isExecutable: async (path) => path === '/usr/local/bin/node',
    };
    await runOnboardForTest(root, answers, runner, { nodeProbe: vmShimProbe });
    const serviceUnit = systemdServiceUnit(root);
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
    const answers = serviceAnswers({ registerService: true });
    const result = await runOnboardForTest(root, answers, runner, {
      nodeProbe: noSystemNodeProbe,
    });
    expect(result.service).toMatchObject({
      platform: 'systemd',
      registered: true,
      lingerEnabled: false,
    });
    expect(result.service?.warnings.join(' ')).toContain('enable-linger');
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
      runOnboardForTest(root, answers, runner),
    ).rejects.toThrow(
      'managed service environments do not inherit your interactive shell auth token',
    );
  });
  it('fails before systemd registration when the service cannot execute the launcher', async () => {
    const runner = new FakeRunner();
    const answers = serviceAnswers({ registerService: true });
    runner.failedHelpCommands.add(answers.dreamuxBin);
    await expect(
      runOnboardForTest(root, answers, runner, { env: {} }),
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
    expect(launchdPlist['EnvironmentVariables']).not.toHaveProperty(
      'CODEX_HOST_CODEX_BIN',
    );
    expect(launchdPlist['EnvironmentVariables']['PATH']).toContain(
      dirname(process.execPath),
    );
    expect(launchdPlist['EnvironmentVariables']['PATH']).toContain(
      join(root, 'home', '.local', 'bin'),
    );
  });
  it('preserves existing dispatchers and their codex settings on rerun', async () => {
    const runner = new FakeRunner();
    const configDir = join(root, 'config');
    writeExistingConfig(configDir, testSingleDispatcherFileObject({
      id: 'flow',
      cwd: join(root, 'flow-cwd'),
      enabled: true,
      feishu: { app_id: 'app-flow', app_secret: 'secret-flow' },
      codex: {
        bin: '/custom/codex-flow',
        approval_policy: 'on-failure',
        sandbox_mode: 'danger-full-access',
        extra_args: ['--model', 'local-default'],
        extra_env: {},
        initialize_timeout_ms: 25000,
      },
    }));
    const answers = testAnswers({
      configDir,
      dispatcherId: 'docs',
      dispatcherCwd: join(root, 'docs-cwd'),
      registerService: false,
      channels: [feishuOnboardChannel('app-docs', 'secret-docs')],
    });
    writeGlobalCodexAuth(answers);
    await runOnboardForTest(root, answers, runner);
    const saved = readSavedConfig(configDir);
    expect(saved).not.toHaveProperty('runtime_dir');
    expect(saved).not.toHaveProperty('admin_socket');
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
  it('dry-run rerun over a missing npm provider does not materialize old plugins', async () => {
    const runner = new FakeRunner();
    const configDir = join(root, 'config');
    const existing = {
      agents: [
        {
          id: 'old-runtime',
          provider: 'npm:@example/missing-runtime#provider',
          config: { old_option: true },
        },
      ],
      dispatchers: [
        {
          id: 'old',
          cwd: join(root, 'old-cwd'),
          enabled: true,
          workspace: { enabled: false },
          channels: [
            {
              id: 'primary',
              provider: 'builtin:feishu',
              config: { app_id: 'app-old', app_secret: 'secret-old' },
            },
          ],
          agentRuntime: 'old-runtime',
        },
      ],
    };
    const configPath = join(configDir, 'config.json');
    writeExistingConfig(configDir, existing);
    const before = readFileSync(configPath, 'utf8');
    const answers = testAnswers({
      configDir,
      dispatcherId: 'docs',
      dispatcherCwd: join(root, 'docs-cwd'),
      registerService: false,
      dryRun: true,
      channels: [feishuOnboardChannel('app-docs', 'secret-docs')],
    });
    await expectDryRunMissingPlugin(runOnboardForTest(root, answers, runner));
    expect(readFileSync(configPath, 'utf8')).toBe(before);
  });
  it('dry-run with a newly selected missing npm provider reports no-write diagnostics', async () => {
    const configDir = join(root, 'config');
    const answers = testAnswers({
      configDir,
      dispatcherId: 'docs',
      dispatcherCwd: join(root, 'docs-cwd'),
      agentRuntime: {
        id: 'docs',
        provider: 'npm:@example/missing-runtime#provider',
        config: {},
      },
      registerService: false,
      dryRun: true,
      channels: [feishuOnboardChannel('app-docs', 'secret-docs')],
    });
    await expectDryRunMissingPlugin(runOnboardForTest(root, answers));
    expect(existsSync(join(configDir, 'config.json'))).toBe(false);
  });
  it('dry-run provider selection does not materialize a newly selected npm provider', async () => {
    await expectDryRunMissingPlugin(answersFromOptions({
      yes: true,
      dryRun: true,
      configDir: join(root, 'config'),
      agent: 'npm:@example/missing-runtime#provider',
      channelConfigJson: JSON.stringify({
        app_id: 'app-test',
        app_secret: 'secret-test',
      }),
    }, false));
  });
  it('preserves a teammate-only agent (unreferenced by any dispatcher) on rerun', async () => {
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
    writeExistingConfig(configDir, existing);
    const answers = testAnswers({
      configDir,
      dispatcherId: 'docs',
      dispatcherCwd: join(root, 'docs-cwd'),
      registerService: false,
      channels: [feishuOnboardChannel('app-docs', 'secret-docs')],
    });
    writeGlobalCodexAuth(answers);
    await runOnboardForTest(root, answers, runner);
    const saved = readSavedConfig(configDir);
    const agentIds = (saved['agents'] as Array<{ id: string }>).map((a) => a.id);
    expect(agentIds).toEqual(expect.arrayContaining(['flow', 'docs', 'claude-helper']));
    const claudeHelper = (saved['agents'] as Array<any>).find(
      (a) => a.id === 'claude-helper',
    );
    expect(claudeHelper?.provider).toBe('builtin:claude-code');
  });
  it('allows a new dispatcher that reuses an existing Feishu app_id (#209 Decision #4: cross-dispatcher uniqueness relaxed)', async () => {
    const runner = new FakeRunner();
    const configDir = join(root, 'config');
    writeExistingConfig(configDir, testSingleDispatcherFileObject({
      id: 'flow',
      cwd: join(root, 'flow-cwd'),
      enabled: false,
      feishu: { app_id: 'app-shared', app_secret: 'secret-flow' },
      codex: {
        approval_policy: 'never',
        sandbox_mode: 'workspace-write',
        extra_args: [],
        extra_env: {},
      },
    }));
    const answers = testAnswers({
      configDir,
      dispatcherId: 'docs',
      dispatcherCwd: join(root, 'docs-cwd'),
      channels: [feishuOnboardChannel('app-shared', 'secret-docs')],
      registerService: false,
    });
    writeGlobalCodexAuth(answers);
    await runOnboardForTest(root, answers, runner);
    const saved = readSavedConfig(configDir);
    expect(
      (saved['dispatchers'] as Array<{ id: string }>).map((d) => d.id),
    ).toEqual(expect.arrayContaining(['flow', 'docs']));
    const appIds = (saved['dispatchers'] as Array<any>).map(
      (d) => d.channels[0].config.app_id,
    );
    expect(appIds).toEqual(['app-shared', 'app-shared']);
  });
  it('onboard output round-trips through loadConfig (#148)', async () => {
    const runner = new FakeRunner();
    const configDir = join(root, 'config');
    const answers = testAnswers({
      configDir,
      dispatcherId: 'flow',
      registerService: false,
      channels: [feishuOnboardChannel('app-roundtrip', 'secret-roundtrip')],
    });
    writeGlobalCodexAuth(answers);
    await runOnboardForTest(root, answers, runner, { env: {} });
    const { config } = await loadConfig({ configDir });
    expect(Object.keys(config.agents)).toEqual(['flow']);
    expect(config.agents['flow']?.provider).toBe('builtin:codex');
    expect(config.agents['flow']?.config).toBeDefined();
    expect(config.dispatchers).toHaveLength(1);
    expect(config.dispatchers[0]).toMatchObject({
      id: 'flow',
      agentRuntime: 'flow',
      runtime: {
        provider: 'builtin:codex',
        config: expect.objectContaining({ approval_policy: 'never' }),
      },
    });
    expect(config.dispatchers[0]?.runtime).toEqual(config.agents['flow']);
  });
  it('uses one provider plugin session for collect and final strict commit', async () => {
    const packageName = '@example/onboard-runtime';
    const providerRef = `npm:${packageName}#provider`;
    prepareOnboardCandidate({ packageName, checkedAt: 3000 });
    const { answers, providerContext } = await onboardPluginAnswers(root, packageName);
    const result = await runOnboardWithProviderContext(root, answers, providerContext);
    expect(result.doctor.ok).toBe(true);
    expect(readProviderPluginMetadataSync(packageName)).toMatchObject({
      selected_version: '1.0.0',
      candidate_version: null,
      last_check_completed_at: 3000,
    });
    const saved = JSON.parse(
      readFileSync(join(root, 'config', 'config.json'), 'utf8'),
    ) as Record<string, any>;
    expect(saved['agents'][0]).toMatchObject({
      id: 'flow',
      provider: providerRef,
      config: { collected: true },
    });
  });
  it('rejects onboarding candidates when final provider validation fails', async () => {
    const packageName = '@example/onboard-runtime-fail';
    prepareOnboardCandidate({ packageName, checkedAt: 4000 });
    const { answers, providerContext } = await onboardPluginAnswers(
      root,
      packageName,
      { agentConfigJson: 'flow={"reject":true}' },
    );
    await expect(
      runOnboardWithProviderContext(root, answers, providerContext),
    ).rejects.toThrow(/provider rejected onboard config/);
    expect(readProviderPluginMetadataSync(packageName)).toMatchObject({
      selected_version: null,
      candidate_version: null,
      last_check_completed_at: 4000,
    });
  });
  it('rejects onboarding candidates when provider collection fails', async () => {
    const packageName = '@example/onboard-runtime-collect-fail';
    prepareOnboardCandidate({
      packageName,
      checkedAt: 5000,
      source: onboardRuntimeProviderSource({
        collectBody: 'throw new Error("provider collect failed");',
      }),
    });
    await expect(
      onboardPluginAnswers(root, packageName),
    ).rejects.toThrow(/provider collect failed/);
    expect(readProviderPluginMetadataSync(packageName)).toMatchObject({
      selected_version: null,
      candidate_version: null,
      last_check_completed_at: 5000,
    });
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
    const { answers } = await answersFromOptions(
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
async function runOnboardWithProviderContext(
  root: string,
  answers: OnboardAnswers,
  providerContext: OnboardProviderContext,
) {
  return await runOnboardForTest(root, answers, new FakeRunner(), { providerContext });
}
async function onboardPluginAnswers(
  root: string,
  packageName: string,
  overrides: Partial<OnboardCliOptions> = {},
) {
  return await answersFromOptions(
    {
      yes: true,
      configDir: join(root, 'config'),
      agent: `flow=npm:${packageName}#provider`,
      channelConfigJson: 'primary={"app_id":"app-test","app_secret":"secret-test"}',
      registerService: false,
      ...overrides,
    },
    false,
  );
}
async function runOnboardForTest(
  root: string,
  answers: OnboardAnswers,
  runner = new FakeRunner(),
  options: Partial<Parameters<typeof runOnboard>[0]> = {},
) {
  return await runOnboard({
    answers,
    runner,
    platform: 'linux',
    homeDir: join(root, 'home'),
    env: { CODEX_ACCESS_TOKEN: 'interactive-token-test' },
    ...options,
  });
}
async function expectDryRunMissingPlugin(promise: Promise<unknown>): Promise<void> {
  await expect(promise).rejects.toThrow(
    /dreamux onboard --dry-run cannot install npm provider plugins/,
  );
  expect(existsSync(pluginRoot())).toBe(false);
}
function prepareOnboardCandidate(input: {
  packageName: string;
  checkedAt: number;
  source?: string;
}): void {
  publishProviderPluginGenerationSync({
    packageName: input.packageName,
    version: '1.0.0',
    source: input.source ?? onboardRuntimeProviderSource(),
  });
  writeProviderPluginMetadataSync({
    packageName: input.packageName,
    version: null,
    candidateVersion: '1.0.0',
    checkedAt: input.checkedAt,
  });
}
function onboardRuntimeProviderSource(options: { collectBody?: string } = {}): string {
  return providerPluginSource({
    readConfigBody: "if (rawConfig.reject === true) throw new Error('provider rejected onboard config'); return { ...rawConfig, parsed_by_onboard_provider: true };",
    collectBody: options.collectBody ?? 'return { collected: true };',
  });
}
