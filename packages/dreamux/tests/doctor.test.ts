import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { build as buildPlist } from 'plist';
import {
  runDreamuxDoctor,
  type DreamuxDoctorResult,
} from '../src/cli/doctor.js';
import type { CommandRunner } from '../src/onboard/types.js';
import type { ServiceNodeProbe } from '../src/onboard/service.js';
import type {
  ProviderDiagnosticKind,
  ProviderDiagnosticReport,
} from '../src/provider-diagnostics.js';
import {
  defaultDispatcherCwd,
  dispatcherChannelBindingsPath,
  dispatcherCollaborationSpacesPath,
  dispatcherTeamCronJobsPath,
  dispatcherTeamRecordPath,
  providerPluginMetadataPath,
  resetRuntimeConfig,
  stateRoot,
} from '../src/platform/paths.js';
import { dispatcherCodexHome } from '@excitedjs/agent-runtime-codex';
import {
  testConfigFileObject,
  testSingleDispatcherFileObject,
} from './helpers/config.js';
import {
  publishProviderPluginGenerationSync,
  providerPluginSource,
  writeProviderPluginMetadataSync,
} from './helpers/provider-plugin.js';
class FakeRunner implements CommandRunner {
  systemdEnabled = false;
  systemdActive = false;
  launchdLoaded = false;
  lingerEnabled = false;
  readonly nodeVersions = new Map<string, string>();
  readonly failedHelpCommands = new Set<string>();
  readonly calls: Array<{ command: string; args: string[] }> = [];
  async run(command: string, args: string[]): Promise<void> {
    this.calls.push({ command, args });
  }
  async check(command: string, args: string[]): Promise<boolean> {
    this.calls.push({ command, args });
    if (args[0] === '--help') return !this.failedHelpCommands.has(command);
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
    this.calls.push({ command, args });
    if (args[0] === '--version') {
      return this.nodeVersions.get(command) ?? 'v22.7.0';
    }
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
    if (command === 'loginctl' && args[0] === 'show-user') {
      return `Linger=${this.lingerEnabled ? 'yes' : 'no'}`;
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
  let oldHome: string | undefined;
  beforeEach(() => {
    root = mkdtempSync(join(homedir(), '.dreamux-doctor-'));
    oldConfigDir = process.env['DREAMUX_CONFIG_DIR'];
    oldRuntimeDir = process.env['CODEX_HOST_RUNTIME_DIR'];
    oldAdminSocket = process.env['CODEX_HOST_ADMIN_SOCKET'];
    oldCodexBin = process.env['CODEX_HOST_CODEX_BIN'];
    oldDreamuxBin = process.env['DREAMUX_BIN'];
    oldHome = process.env['HOME'];
    delete process.env['CODEX_HOST_RUNTIME_DIR'];
    delete process.env['CODEX_HOST_ADMIN_SOCKET'];
    delete process.env['CODEX_HOST_CODEX_BIN'];
    process.env['DREAMUX_CONFIG_DIR'] = join(root, 'config');
    process.env['DREAMUX_BIN'] = '/usr/local/bin/dreamux';
    process.env['HOME'] = join(root, 'home');
    process.env['DREAMUX_ROOT'] = join(root, 'dreamux');
  });
  afterEach(() => {
    restoreEnv('DREAMUX_CONFIG_DIR', oldConfigDir);
    restoreEnv('CODEX_HOST_RUNTIME_DIR', oldRuntimeDir);
    restoreEnv('CODEX_HOST_ADMIN_SOCKET', oldAdminSocket);
    restoreEnv('CODEX_HOST_CODEX_BIN', oldCodexBin);
    restoreEnv('DREAMUX_BIN', oldDreamuxBin);
    restoreEnv('HOME', oldHome);
    resetRuntimeConfig();
    rmSync(root, { recursive: true, force: true });
  });
  async function runDoctor(
    runner: FakeRunner,
    options: NonNullable<Parameters<typeof runDreamuxDoctor>[0]> = {},
  ): Promise<DreamuxDoctorResult> {
    return await runDreamuxDoctor({
      runner,
      platform: 'linux',
      homeDir: join(root, 'home'),
      env: {},
      ...options,
    });
  }
  it('reports global Codex home health', async () => {
    const runner = new FakeRunner();
    runner.nodeVersions.set('codex', 'codex-cli 0.137.0');
    writeConfig();
    writeDispatcherHome({ auth: true });
    const result = await runDoctor(runner);
    expect(doctorCheck(result, 'dispatcher flow workspace')).toMatchObject({ ok: true });
    expect(result.ok, JSON.stringify(result, null, 2)).toBe(true);
    expect(doctorCheck(result, 'config')).toMatchObject({ ok: true });
    expect(
      runtimeProviderReport(result, 'flow', 'builtin:codex', 'foreground')
        ?.result.ok,
      JSON.stringify(result, null, 2),
    ).toBe(true);
    expect(
      result.dispatchers[0]?.providers.some(
        (report) => report.scope === 'managedService',
      ),
    ).toBe(false);
  });
  it('fails loud when the Codex binary is below the 0.137 floor', async () => {
    const runner = new FakeRunner();
    runner.nodeVersions.set('codex', 'codex-cli 0.136.0');
    writeConfig();
    writeDispatcherHome({ auth: true });
    const result = await runDoctor(runner);
    expect(result.ok).toBe(false);
    const foreground = runtimeProviderReport(
      result,
      'flow',
      'builtin:codex',
      'foreground',
    );
    expect(foreground?.result.ok).toBe(false);
    expect(foreground?.result.errors.join('\n')).toContain(
      'requires codex >= 0.137.0',
    );
  });
  it('fails loud when a dispatcher declares no workspace cwd (#182 PR-4)', async () => {
    const runner = new FakeRunner();
    runner.nodeVersions.set('codex', 'codex-cli 0.137.0');
    writeConfigObject(testSingleDispatcherFileObject({
      id: 'flow',
      enabled: true,
      feishu: { app_id: 'app-test', app_secret: 'secret-test' },
      codex: { approval_policy: 'never', sandbox_mode: 'workspace-write', extra_args: [], extra_env: {} },
    }));
    writeDispatcherHome({ auth: true });
    const result = await runDoctor(runner);
    const workspaceCheck = doctorCheck(result, 'dispatcher flow workspace');
    expect(workspaceCheck?.ok).toBe(false);
    expect(workspaceCheck?.detail).toMatch(/no configured `cwd`/);
    expect(result.ok).toBe(false);
  });
  it('does not fail the workspace check for a disabled dispatcher with no cwd (#182 PR-4, PR#186 P3)', async () => {
    const runner = new FakeRunner();
    runner.nodeVersions.set('codex', 'codex-cli 0.137.0');
    writeConfigObject(testSingleDispatcherFileObject({
      id: 'flow',
      enabled: false,
      feishu: { app_id: 'app-test', app_secret: 'secret-test' },
      codex: { approval_policy: 'never', sandbox_mode: 'workspace-write', extra_args: [], extra_env: {} },
    }));
    writeDispatcherHome({ auth: true });
    const result = await runDoctor(runner);
    const workspaceCheck = doctorCheck(result, 'dispatcher flow workspace');
    expect(workspaceCheck?.ok).toBe(true);
    expect(workspaceCheck?.detail).toMatch(/disabled/);
  });
  it('still preflights disabled dispatcher channel-binding state', async () => {
    const runner = new FakeRunner();
    runner.nodeVersions.set('codex', 'codex-cli 0.137.0');
    const configPath = join(root, 'config', 'config.json');
    mkdirSync(dirname(configPath), { recursive: true });
    writeFileSync(
      configPath,
      JSON.stringify(
        testSingleDispatcherFileObject({
          id: 'flow',
          enabled: false,
          feishu: { app_id: 'app-test', app_secret: 'secret-test' },
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
    writeDispatcherHome({ auth: true });
    writeJson(dispatcherChannelBindingsPath('flow'), {
      version: 2,
      bindings: [
        {
          channel_id: 'primary',
          provider: 'builtin:feishu',
          target_type: 'group',
          target_key: 'chat-x',
          display: null,
          canonical_url: null,
          meta: { chat_id: 'chat-x', chat_type: 'group' },
          team_name: 'gamma',
          leader_name: 'lead-1',
          active: true,
          created_at: 1,
          updated_at: 1,
          deactivated_at: null,
        },
      ],
    });
    writeJson(dispatcherCollaborationSpacesPath('flow'), {
      version: 1,
      spaces: [],
      targets: [
        {
          version: 1,
          dispatcher_id: 'flow',
          space_name: 'space-a',
          channel_id: 'primary',
          provider: 'builtin:feishu',
          container_key: 'container-a',
          binding_generation: 1,
          target_key: 'chat-x',
          target_type: 'group',
          target_display: null,
          team_name: 'gamma',
          leader_name: 'lead-1',
          worktree_slug: 'space-a-chat-x',
          lifecycle_status: 'active',
          phase: 'bound',
          claim_event_id: null,
          close_event_id: null,
          last_error: null,
          created_at: 1,
          updated_at: 1,
          closed_at: null,
          detached_at: null,
        },
      ],
    });
    const result = await runDoctor(runner);
    expect(result.ok).toBe(false);
    expect(doctorCheck(result, 'dispatcher flow workspace')).toMatchObject({
      ok: true,
      detail: expect.stringContaining('disabled'),
    });
    expect(doctorCheck(result, 'dispatcher flow channel bindings')).toMatchObject({
      ok: false,
      detail: expect.stringMatching(
        /version 2 .*open collaboration target route.*channel-bindings\.json/s,
      ),
    });
  });
  it('does not expose Feishu app secrets in doctor results', async () => {
    const runner = new FakeRunner();
    writeConfig();
    writeDispatcherHome({ auth: true });
    const result = await runDoctor(runner);
    expect(JSON.stringify(result)).not.toContain('secret-test');
  });
  it('continues diagnostics for available declarations when another plugin is missing', async () => {
    const runner = new FakeRunner();
    runner.nodeVersions.set('codex', 'codex-cli 0.137.0');
    writeConfigObject(testConfigFileObject({
      agents: [
        { id: 'flow', provider: 'builtin:codex', config: {} },
        { id: 'missing', provider: 'npm:@example/missing-runtime#provider', config: {} },
      ],
      dispatchers: [
        { id: 'flow', cwd: defaultDispatcherCwd('flow'), agentRuntime: 'flow' },
        { id: 'missing', cwd: defaultDispatcherCwd('missing'), agentRuntime: 'missing' },
      ],
    }));
    writeDispatcherHome({ auth: true });
    const result = await runDoctor(runner);
    expect(doctorCheck(result, 'provider plugin @example/missing-runtime')).toMatchObject({
      ok: false,
      detail: expect.stringContaining('no selected generation'),
    });
    expect(result.dispatchers.map((dispatcher) => dispatcher.id)).toEqual([
      'flow',
      'missing',
    ]);
    expect(
      runtimeProviderReport(result, 'flow', 'builtin:codex', 'foreground')
        ?.result.ok,
    ).toBe(true);
    expect(
      providerReport(
        result,
        'missing',
        'channel',
        'builtin:feishu',
        'foreground',
      )?.result.ok,
    ).toBe(true);
    expect(
      runtimeProviderReport(
        result,
        'missing',
        'npm:@example/missing-runtime#provider',
        'foreground',
      ),
    ).toBeUndefined();
    expect(runner.calls).toContainEqual({ command: 'codex', args: ['--help'] });
  });
  for (const testCase of [
    {
      name: 'available channel when the same dispatcher runtime plugin is missing',
      missingPackage: '@example/missing-runtime',
      missingReport: ['runtime', 'npm:@example/missing-runtime#provider'] as const,
      setup() {
        const channelPackage = '@example/doctor-channel';
        const channelRef = `npm:${channelPackage}#channel`;
        publishDoctorPlugin(channelPackage, diagnosticChannelProviderSource());
        writeConfigObject(testSingleDispatcherFileObject({
          id: 'flow',
          cwd: defaultDispatcherCwd('flow'),
          agentProvider: 'npm:@example/missing-runtime#provider',
          channelProvider: channelRef,
        }));
        return (result: DreamuxDoctorResult, runner: FakeRunner) => {
          expect(doctorCheck(result, 'test channel binary')).toMatchObject({ ok: true, detail: 'codex' });
          expect(providerReport(result, 'flow', 'channel', channelRef, 'foreground')?.result.detail).toBe('channel diagnostic ran');
          expect(runner.calls).toContainEqual({ command: 'codex', args: ['--help'] });
        };
      },
    },
    {
      name: 'available runtime when the same dispatcher sole channel plugin is missing',
      missingPackage: '@example/missing-channel',
      missingReport: ['channel', 'npm:@example/missing-channel#channel'] as const,
      setup(runner: FakeRunner) {
        runner.nodeVersions.set('codex', 'codex-cli 0.137.0');
        writeConfigObject(testSingleDispatcherFileObject({
          id: 'flow',
          cwd: defaultDispatcherCwd('flow'),
          channelProvider: 'npm:@example/missing-channel#channel',
        }));
        writeDispatcherHome({ auth: true });
        return (result: DreamuxDoctorResult, runner: FakeRunner) => {
          expect(runtimeProviderReport(result, 'flow', 'builtin:codex', 'foreground')?.result.ok).toBe(true);
          expect(runner.calls).toContainEqual({ command: 'codex', args: ['--help'] });
        };
      },
    },
  ]) {
    it(`runs ${testCase.name}`, async () => {
      const runner = new FakeRunner();
      const expectAvailable = testCase.setup(runner);
      const result = await runDoctor(runner);
      expectMissingProviderPlugin(result, testCase.missingPackage);
      const [kind, provider] = testCase.missingReport;
      const report = kind === 'runtime'
        ? runtimeProviderReport(result, 'flow', provider, 'foreground')
        : providerReport(result, 'flow', kind, provider, 'foreground');
      expect(report).toBeUndefined();
      expect(runner.calls.some((call) => call.command === 'npm')).toBe(false);
      expectAvailable(result, runner);
    });
  }
  it('continues available diagnostics when another available declaration readConfig fails', async () => {
    const runner = new FakeRunner();
    const runtimePackage = '@example/bad-read-config-runtime';
    const channelPackage = '@example/good-diagnostic-channel';
    const runtimeRef = `npm:${runtimePackage}#provider`;
    const channelRef = `npm:${channelPackage}#channel`;
    publishDoctorPlugin(runtimePackage, providerPluginSource({
      readConfigBody: 'throw new Error("runtime config rejected");',
    }));
    publishDoctorPlugin(channelPackage, diagnosticChannelProviderSource());
    writeConfigObject(testSingleDispatcherFileObject({
      id: 'flow',
      cwd: defaultDispatcherCwd('flow'),
      agentProvider: runtimeRef,
      channelProvider: channelRef,
    }));
    const result = await runDoctor(runner);
    expect(doctorCheck(result, 'agent flow provider config')).toMatchObject({
      ok: false,
      detail: expect.stringContaining('runtime config rejected'),
    });
    expect(doctorCheck(result, 'test channel binary')).toMatchObject({ ok: true, detail: 'codex' });
    expect(
      providerReport(result, 'flow', 'channel', channelRef, 'foreground')
        ?.result.detail,
    ).toBe('channel diagnostic ran');
    expect(
      runtimeProviderReport(result, 'flow', runtimeRef, 'foreground'),
    ).toBeUndefined();
    expect(runner.calls).toContainEqual({ command: 'codex', args: ['--help'] });
  });
  it('reports a selected provider plugin last update error as a warning detail', async () => {
    const runner = new FakeRunner();
    runner.nodeVersions.set('codex', 'codex-cli 0.137.0');
    const packageName = '@example/doctor-runtime';
    const providerRef = `npm:${packageName}#provider`;
    writeRuntimePluginConfig(providerRef);
    publishDoctorPlugin(packageName);
    writeProviderPluginMetadataSync({
      packageName,
      version: '1.0.0',
      checkedAt: 1000,
      lastCheckError: 'registry temporarily unavailable',
    });
    mkdirSync(stateRoot(), { recursive: true });
    writeDispatcherHome({ auth: true });
    const result = await runDoctor(runner);
    expect(result.ok, JSON.stringify(result, null, 2)).toBe(true);
    expect(doctorCheck(result, `provider plugin ${packageName}`)).toMatchObject({
      ok: true,
      detail: expect.stringContaining(
        'last update error: registry temporarily unavailable',
      ),
    });
    expect(runner.calls.some((call) => call.command === 'npm')).toBe(false);
  });
  it('warns and rebuilds malformed plugin metadata on the command path', async () => {
    const runner = new FakeRunner();
    const packageName = '@example/bad-metadata-runtime';
    const providerRef = `npm:${packageName}#provider`;
    writeRuntimePluginConfig(providerRef);
    publishDoctorPlugin(packageName);
    const metadataPath = providerPluginMetadataPath(packageName);
    mkdirSync(dirname(metadataPath), { recursive: true });
    writeFileSync(metadataPath, '{not-json', { mode: 0o600 });
    const warnings: string[] = [];
    const warn = vi.spyOn(console, 'warn').mockImplementation((message: unknown) => {
      warnings.push(String(message));
    });
    try {
      const result = await runDoctor(runner);
      expect(warnings.join('\n')).toContain('Ignoring incompatible JSON document');
      expect(warnings.join('\n')).toContain(metadataPath);
      expect(doctorCheck(result, `provider plugin ${packageName}`)).toMatchObject({
        ok: false,
        detail: expect.stringContaining('no selected generation'),
      });
    } finally {
      warn.mockRestore();
    }
  });
  it('preflights non-closed Team cron stores', async () => {
    const runner = new FakeRunner();
    writeConfig();
    writeDispatcherHome({ auth: true });
    writeTeamRecord('flow', 'alpha', 'running');
    const cronPath = dispatcherTeamCronJobsPath('flow', 'alpha');
    mkdirSync(dirname(cronPath), { recursive: true });
    writeFileSync(cronPath, JSON.stringify({ version: 99, jobs: [] }), {
      mode: 0o600,
    });
    const result = await runDoctor(runner);
    expect(result.ok).toBe(false);
    expect(doctorCheck(result, 'dispatcher flow team alpha cron jobs')).toMatchObject({
      ok: false,
      detail: expect.stringContaining('not version 1'),
    });
  });
  it('checks a Claude Code runtime without requiring Codex home state', async () => {
    const runner = new FakeRunner();
    writeClaudeCodeConfig();
    mkdirSync(stateRoot(), { recursive: true });
    const result = await runDoctor(runner);
    expect(result.ok, JSON.stringify(result, null, 2)).toBe(true);
    expect(doctorCheck(result, 'claude-code binary')).toMatchObject({
      ok: true,
      detail: 'claude',
    });
    expect(doctorCheck(result, 'codex binary')).toBeUndefined();
    expect(result.dispatchers[0]?.id).toBe('flow');
    const foreground = runtimeProviderReport(
      result,
      'flow',
      'builtin:claude-code',
      'foreground',
    );
    expect(foreground?.result).toMatchObject({
      ok: true,
      detail: expect.stringContaining('no host-managed home state'),
    });
    expect(
      result.dispatchers[0]?.providers.some(
        (report) => report.scope === 'managedService',
      ),
    ).toBe(false);
    expect(runner.calls).toContainEqual({ command: 'claude', args: ['--help'] });
    expect(runner.calls).not.toContainEqual({ command: 'codex', args: ['--help'] });
  });
  it('checks managed-service dispatcher auth when a service is installed', async () => {
    const runner = new FakeRunner();
    writeConfig();
    writeDispatcherHome({ auth: false });
    writeSystemdUnit(['ExecStart=/usr/local/bin/dreamux serve']);
    const result = await runDreamuxDoctor({
      runner,
      platform: 'linux',
      homeDir: join(root, 'home'),
      env: { CODEX_ACCESS_TOKEN: 'interactive-token-test' },
    });
    expect(result.ok).toBe(false);
    expect(
      runtimeProviderReport(result, 'flow', 'builtin:codex', 'foreground')
        ?.result.ok,
    ).toBe(true);
    const managed = runtimeProviderReport(
      result,
      'flow',
      'builtin:codex',
      'managedService',
    );
    expect(managed?.result.ok).toBe(false);
    expect(managed?.result.errors.join('\n')).toContain(
      'missing Codex auth state',
    );
  });
  it('checks the installed systemd service environment instead of recomputing it', async () => {
    const runner = new FakeRunner();
    writeConfig();
    writeDispatcherHome({ auth: true });
    writeSystemdUnit([
      'ExecStart=/service/dreamux serve',
      'Environment=DREAMUX_NODE_BIN=/service/node',
      'Environment=CODEX_HOST_CODEX_BIN=/service/codex\\\\x20literal',
      'Environment=PATH=/service/bin:/usr/bin:/bin',
    ]);
    runner.nodeVersions.set('/service/node', 'v18.0.0');
    const result = await runDoctor(runner);
    expect(result.ok).toBe(false);
    expect(doctorCheck(result, 'managed service Node binary')).toMatchObject({
      ok: false,
      detail: expect.stringContaining('/service/node'),
    });
    expect(runner.calls).toContainEqual({
      command: '/service/node',
      args: ['--version'],
    });
    expect(runner.calls).not.toContainEqual({
      command: process.execPath,
      args: ['--version'],
    });
    expect(result.service.environment?.['CODEX_HOST_CODEX_BIN']).toBe(
      '/service/codex\\x20literal',
    );
  });
  it('checks the managed-service Claude Code runtime binary when configured', async () => {
    const runner = new FakeRunner();
    runner.lingerEnabled = true;
    writeClaudeCodeConfig();
    mkdirSync(stateRoot(), { recursive: true });
    writeSystemdUnit([
      'ExecStart=/service/dreamux serve',
      'Environment=DREAMUX_NODE_BIN=/service/node',
      'Environment=PATH=/service/bin:/usr/bin:/bin',
    ]);
    runner.nodeVersions.set('/service/node', 'v22.7.0');
    const result = await runDoctor(runner);
    expect(result.ok, JSON.stringify(result, null, 2)).toBe(true);
    expect(doctorCheck(result, 'managed service Claude Code binary')).toMatchObject({
      ok: true,
      detail: 'claude',
    });
    expect(runner.calls).toContainEqual({ command: 'claude', args: ['--help'] });
    expect(runner.calls).not.toContainEqual({ command: 'codex', args: ['--help'] });
  });
  it('warns (without failing) when the service Node is bound to a version manager', async () => {
    const runner = new FakeRunner();
    runner.lingerEnabled = true;
    writeConfig();
    writeDispatcherHome({ auth: true });
    const nvmNode = join(
      root,
      'home',
      '.nvm',
      'versions',
      'node',
      'v22.7.0',
      'bin',
      'node',
    );
    writeSystemdUnit([
      'ExecStart=/service/dreamux serve',
      `Environment=DREAMUX_NODE_BIN=${nvmNode}`,
      'Environment=CODEX_HOST_CODEX_BIN=/service/codex',
      'Environment=PATH=/service/bin:/usr/bin:/bin',
    ]);
    runner.nodeVersions.set(nvmNode, 'v22.7.0');
    const result = await runDoctor(runner);
    expect(result.ok).toBe(true);
    expect(doctorCheck(result, 'managed service Node binary')).toMatchObject({ ok: true });
    const advisory = doctorCheck(result, 'managed service Node stability');
    expect(advisory).toMatchObject({
      ok: true,
      severity: 'warn',
      detail: expect.stringContaining('nvm'),
    });
  });
  it('flags a system-looking shim that realpaths into a version manager', async () => {
    const runner = new FakeRunner();
    runner.lingerEnabled = true;
    writeConfig();
    writeDispatcherHome({ auth: true });
    writeSystemdUnit([
      'ExecStart=/service/dreamux serve',
      'Environment=DREAMUX_NODE_BIN=/usr/local/bin/node',
      'Environment=CODEX_HOST_CODEX_BIN=/service/codex',
      'Environment=PATH=/service/bin:/usr/bin:/bin',
    ]);
    runner.nodeVersions.set('/usr/local/bin/node', 'v22.7.0');
    const shimProbe: ServiceNodeProbe = {
      isExecutable: async () => true,
      realpath: async (path) =>
        path === '/usr/local/bin/node'
          ? '/Users/u/Library/Application Support/fnm/node-versions/v22/installation/bin/node'
          : path,
    };
    const result = await runDreamuxDoctor({
      runner,
      platform: 'linux',
      homeDir: join(root, 'home'),
      env: {},
      nodeProbe: shimProbe,
    });
    expect(result.ok).toBe(true);
    expect(doctorCheck(result, 'managed service Node stability')).toMatchObject({
      ok: true,
      severity: 'warn',
      detail: expect.stringContaining('fnm'),
    });
  });
  it('does not warn when the service Node is a stable system path', async () => {
    const runner = new FakeRunner();
    writeConfig();
    writeDispatcherHome({ auth: true });
    writeSystemdUnit([
      'ExecStart=/service/dreamux serve',
      'Environment=DREAMUX_NODE_BIN=/usr/local/bin/node',
      'Environment=CODEX_HOST_CODEX_BIN=/service/codex',
      'Environment=PATH=/service/bin:/usr/bin:/bin',
    ]);
    runner.nodeVersions.set('/usr/local/bin/node', 'v22.7.0');
    const stableProbe: ServiceNodeProbe = {
      isExecutable: async () => true,
      realpath: async (path) => path,
    };
    const result = await runDreamuxDoctor({
      runner,
      platform: 'linux',
      homeDir: join(root, 'home'),
      env: {},
      nodeProbe: stableProbe,
    });
    expect(doctorCheck(result, 'managed service Node stability')).toBeUndefined();
  });
  it('checks the installed launchd plist environment instead of failing unconditionally', async () => {
    const runner = new FakeRunner();
    runner.launchdLoaded = true;
    writeConfig();
    writeDispatcherHome({ auth: true });
    const servicePath = join(
      root,
      'home',
      'Library',
      'LaunchAgents',
      'dev.excited.dreamux.plist',
    );
    mkdirSync(dirname(servicePath), { recursive: true });
    writeFileSync(
      servicePath,
      buildPlist({
        Label: 'dev.excited.dreamux',
        ProgramArguments: ['/service/dreamux', 'serve'],
        RunAtLoad: true,
        KeepAlive: true,
        EnvironmentVariables: {
          DREAMUX_CONFIG_DIR: join(root, 'config'),
          HOME: join(root, 'home'),
          DREAMUX_NODE_BIN: '/service/node',
          CODEX_HOST_CODEX_BIN: '/service/codex',
          PATH: '/service/bin:/usr/bin:/bin',
        },
      }),
    );
    runner.nodeVersions.set('/service/node', 'v22.7.0');
    const result = await runDreamuxDoctor({
      runner,
      platform: 'darwin',
      homeDir: join(root, 'home'),
      uid: 501,
      env: {},
    });
    expect(result.ok, JSON.stringify(result, null, 2)).toBe(true);
    expect(result.service.environment).toMatchObject({
      DREAMUX_NODE_BIN: '/service/node',
      CODEX_HOST_CODEX_BIN: '/service/codex',
      PATH: '/service/bin:/usr/bin:/bin',
    });
    expect(result.service.execStart).toEqual(['/service/dreamux', 'serve']);
    expect(runner.calls).toContainEqual({
      command: '/service/node',
      args: ['--version'],
    });
    expect(runner.calls).toContainEqual({
      command: '/service/dreamux',
      args: ['--help'],
    });
    expect(runner.calls).toContainEqual({
      command: '/service/codex',
      args: ['--help'],
    });
  });
  it('flags disabled systemd lingering on an installed service', async () => {
    const runner = new FakeRunner();
    runner.lingerEnabled = false;
    writeConfig();
    writeDispatcherHome({ auth: true });
    writeValidSystemdUnit();
    const result = await runDreamuxDoctor({
      runner,
      platform: 'linux',
      homeDir: join(root, 'home'),
      userName: 'someone',
      env: {},
    });
    const linger = doctorCheck(result, 'systemd linger');
    expect(linger).toMatchObject({ ok: false });
    expect(linger?.detail).toContain('enable-linger');
    expect(result.ok).toBe(false);
  });
  it('passes the linger check when lingering is enabled', async () => {
    const runner = new FakeRunner();
    runner.lingerEnabled = true;
    writeConfig();
    writeDispatcherHome({ auth: true });
    writeValidSystemdUnit();
    const result = await runDreamuxDoctor({
      runner,
      platform: 'linux',
      homeDir: join(root, 'home'),
      userName: 'someone',
      env: {},
    });
    expect(doctorCheck(result, 'systemd linger')).toMatchObject({ ok: true });
  });
  it('skips the linger check when no service is installed', async () => {
    const runner = new FakeRunner();
    writeConfig();
    writeDispatcherHome({ auth: true });
    const result = await runDoctor(runner);
    expect(doctorCheck(result, 'systemd linger')).toBeUndefined();
  });
  it('runs per-agent diagnostics for both codex and claude dispatchers (#148)', async () => {
    const runner = new FakeRunner();
    runner.nodeVersions.set('codex', 'codex-cli 0.137.0');
    const configPath = join(root, 'config', 'config.json');
    mkdirSync(dirname(configPath), { recursive: true });
    writeFileSync(
      configPath,
      JSON.stringify(
        testConfigFileObject({
          agents: [
            {
              id: 'codex-agent',
              provider: 'builtin:codex',
              config: {
                approval_policy: 'never',
                sandbox_mode: 'workspace-write',
                extra_args: [],
                extra_env: {},
              },
            },
            {
              id: 'claude-agent',
              provider: 'builtin:claude-code',
              config: {
                bin: 'claude',
                model: null,
                permission_mode: null,
                extra_args: [],
                extra_env: {},
              },
            },
          ],
          dispatchers: [
            {
              id: 'flow',
              cwd: defaultDispatcherCwd('flow'),
              enabled: true,
              agentRuntime: 'codex-agent',
              feishu: { app_id: 'app-flow', app_secret: 'secret-flow' },
            },
            {
              id: 'docs',
              cwd: defaultDispatcherCwd('docs'),
              enabled: true,
              agentRuntime: 'claude-agent',
              feishu: { app_id: 'app-docs', app_secret: 'secret-docs' },
            },
          ],
        }),
      ),
      { mode: 0o600 },
    );
    writeDispatcherHome({ auth: true });
    mkdirSync(stateRoot(), { recursive: true });
    const result = await runDoctor(runner);
    const codexReport = runtimeProviderReport(
      result,
      'flow',
      'builtin:codex',
      'foreground',
    );
    expect(codexReport).toBeDefined();
    expect(codexReport?.result.ok).toBe(true);
    const claudeReport = runtimeProviderReport(
      result,
      'docs',
      'builtin:claude-code',
      'foreground',
    );
    expect(claudeReport).toBeDefined();
    expect(claudeReport?.result.ok).toBe(true);
    expect(claudeReport?.result.detail).toContain('no host-managed');
    expect(runner.calls).toContainEqual({ command: 'codex', args: ['--help'] });
    expect(runner.calls).toContainEqual({ command: 'claude', args: ['--help'] });
  });
  function writeValidSystemdUnit(): void {
    writeSystemdUnit([
      `ExecStart=${process.env['DREAMUX_BIN']} serve`,
      `Environment=DREAMUX_NODE_BIN=${process.execPath}`,
      'Environment=CODEX_HOST_CODEX_BIN=codex',
      'Environment=PATH=/usr/bin:/bin',
    ]);
  }
  function writeSystemdUnit(lines: string[]): void {
    const servicePath = join(root, 'home', '.config', 'systemd', 'user', 'dreamux.service');
    mkdirSync(dirname(servicePath), { recursive: true });
    writeFileSync(servicePath, ['[Service]', ...lines, ''].join('\n'));
  }
  function writeConfig(): void {
    writeConfigObject(testSingleDispatcherFileObject({
      id: 'flow',
      cwd: defaultDispatcherCwd('flow'),
      enabled: true,
      feishu: { app_id: 'app-test', app_secret: 'secret-test' },
      codex: { approval_policy: 'never', sandbox_mode: 'workspace-write', extra_args: [], extra_env: {} },
    }));
  }
  function writeJson(path: string, value: unknown): void {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  }
  function writeConfigObject(value: unknown): void {
    writeJson(join(root, 'config', 'config.json'), value);
  }
  function writeRuntimePluginConfig(providerRef: string): void {
    writeConfigObject(testConfigFileObject({
      agents: [{ id: 'flow', provider: providerRef, config: {} }],
      dispatchers: [{ id: 'flow', cwd: defaultDispatcherCwd('flow'), agentRuntime: 'flow' }],
    }));
  }
  function publishDoctorPlugin(packageName: string, source?: string): void {
    publishProviderPluginGenerationSync({
      packageName,
      version: '1.0.0',
      ...(source === undefined ? {} : { source }),
    });
    writeProviderPluginMetadataSync({
      packageName,
      version: '1.0.0',
      checkedAt: 1000,
    });
  }
  function writeClaudeCodeConfig(): void {
    writeConfigObject(testConfigFileObject({
      agents: [{
        id: 'flow',
        provider: 'builtin:claude-code',
        config: {
          bin: 'claude',
          model: null,
          permission_mode: null,
          extra_args: [],
          extra_env: {},
        },
      }],
      dispatchers: [{
        id: 'flow',
        cwd: defaultDispatcherCwd('flow'),
        enabled: true,
        agentRuntime: 'flow',
        feishu: { app_id: 'app-test', app_secret: 'secret-test' },
      }],
    }));
  }
  function writeTeamRecord(
    dispatcherId: string,
    teamId: string,
    status: 'starting' | 'running' | 'closed',
  ): void {
    const path = dispatcherTeamRecordPath(dispatcherId, teamId);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(
      path,
      JSON.stringify({
        version: 1,
        dispatcher_id: dispatcherId,
        team_id: teamId,
        name: teamId,
        leader_name: `tl-${teamId}`,
        status,
      }),
      { mode: 0o600 },
    );
  }
  function writeDispatcherHome(options: { auth: boolean }): void {
    mkdirSync(dispatcherCodexHome('flow'), { recursive: true });
    if (options.auth) {
      writeFileSync(join(dispatcherCodexHome('flow'), 'auth.json'), '{}');
    }
    mkdirSync(stateRoot(), { recursive: true });
  }
});
function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}
function runtimeProviderReport(
  result: DreamuxDoctorResult,
  dispatcherId: string,
  provider: string,
  scope: ProviderDiagnosticReport['scope'],
): ProviderDiagnosticReport | undefined {
  return providerReport(result, dispatcherId, 'agentRuntime', provider, scope);
}
function providerReport(
  result: DreamuxDoctorResult,
  dispatcherId: string,
  kind: ProviderDiagnosticKind,
  provider: string,
  scope: ProviderDiagnosticReport['scope'],
): ProviderDiagnosticReport | undefined {
  return result.dispatchers
    .find((dispatcher) => dispatcher.id === dispatcherId)
    ?.providers.find(
      (report) =>
        report.kind === kind &&
        report.provider === provider &&
        report.scope === scope,
    );
}
function doctorCheck(
  result: DreamuxDoctorResult,
  name: string,
): DreamuxDoctorResult['checks'][number] | undefined {
  return result.checks.find((check) => check.name === name);
}
function expectMissingProviderPlugin(
  result: DreamuxDoctorResult,
  packageName: string,
): void {
  expect(doctorCheck(result, `provider plugin ${packageName}`)).toMatchObject({
    ok: false,
    detail: expect.stringContaining('no selected generation'),
  });
}
function diagnosticChannelProviderSource(): string {
  return providerPluginSource({
    channelDiagnostic: `
diagnostic: {
  binChecks() { return [{ name: 'test channel binary', bin: 'codex', args: ['--help'] }]; },
  async runDiagnostic() { return { ok: true, detail: 'channel diagnostic ran', errors: [] }; },
},
`,
  });
}
