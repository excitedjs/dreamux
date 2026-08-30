import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  BUILT_IN_DEFAULTS,
  DEFAULT_CONFIG_JSON,
  createBuiltinProviderRegistry,
  expandHome,
  globalConfigDir,
  globalConfigFile,
  loadConfig,
  loadConfigInstalledOnly,
  loadOrInitConfig,
  redactConfigForDisplay,
  stringifyConfig,
  type ProviderRegistryFactory,
} from '../src/config/config.js';
import { inspectConfigProviderDeclarations } from '../src/config/provider-inspection.js';
import {
  adminSocketPath,
  providerPluginMetadataPath,
  resetRuntimeConfig,
  runRoot,
  setRuntimeConfig,
} from '../src/platform/paths.js';
import {
  DEFAULT_APPROVAL_POLICY,
  DEFAULT_SANDBOX_MODE,
  codexArgsToCli,
  dispatcherCodexConfig,
  parseCodexArgs,
} from '@excitedjs/agent-runtime-codex';
import type { ExternalAgentRuntimeProviderFactory } from '../src/agent-runtime/index.js';
import type { AgentRuntimeCapabilities } from '@excitedjs/dreamux-types';
import {
  testConfigFileObject,
  testSingleDispatcherFileObject,
} from './helpers/config.js';
import { asAgentRuntimeDescriptor, asChannelDescriptor } from './helpers/provider.js';
import {
  ProviderPluginStore,
  type ProviderPluginAccess,
  type ProviderPluginInspection,
  type ProviderPluginLoadSession,
  type ProviderPluginNpmRunner,
} from '../src/registry/provider-plugin-store.js';
import type {
  ChannelProvider,
  ChannelSession,
} from '@excitedjs/dreamux-types';
import type { ExternalChannelProviderFactory } from '../src/channel/external-channel-provider.js';
import {
  publishProviderPluginGenerationRootSync,
  publishProviderPluginGenerationSync,
  providerPluginSource,
  writeProviderPluginMetadataSync,
} from './helpers/provider-plugin.js';
function writeConfigObjectAt(configDir: string, value: unknown): void {
  writeFileSync(globalConfigFile({ configDir }), JSON.stringify(value), {
    mode: 0o600,
  });
}
function runtimePluginConfig(providerRef: string, config: Record<string, unknown> = {}): Record<string, unknown> {
  return testConfigFileObject({
    agents: [{ id: 'flow', provider: providerRef, config }],
    dispatchers: [{ id: 'flow', agentRuntime: 'flow' }],
  });
}
function runtimeChannelPluginConfig(runtimeRef: string, channelRef: string): Record<string, unknown> {
  return testConfigFileObject({
    agents: [{ id: 'flow', provider: runtimeRef, config: {} }],
    dispatchers: [
      {
        id: 'flow',
        agentRuntime: 'flow',
        channelProvider: channelRef,
        feishu: { app_id: 'fixture-app', app_secret: 'fixture-secret' },
      },
    ],
  });
}
function withPluginStore(
  options: Omit<ConstructorParameters<typeof ProviderPluginStore>[0], 'root'> = {},
): { pluginRoot: string; pluginStore: ProviderPluginStore; cleanup(): void } {
  const pluginRoot = mkdtempSync(join(tmpdir(), 'dreamux-plugin-store-'));
  return {
    pluginRoot,
    pluginStore: new ProviderPluginStore({ root: pluginRoot, ...options }),
    cleanup: () => rmSync(pluginRoot, { recursive: true, force: true }),
  };
}
function readPluginMetadata(root: string, packageName: string): Record<string, unknown> {
  return JSON.parse(
    readFileSync(providerPluginMetadataPath(packageName, root), 'utf8'),
  ) as Record<string, unknown>;
}
class FakeProviderPluginStore implements ProviderPluginAccess {
  readonly materialized: string[] = [];
  readonly imported: string[] = [];
  readonly importRequests: Array<{ packageName: string; version?: string }> = [];
  readonly inspected: string[] = [];
  readonly committed: string[] = [];
  readonly rejected: string[] = [];
  readonly installedOnlySessions: string[][] = [];
  readonly modules = new Map<string, Record<string, unknown>>();
  readonly selectedModules = new Map<string, Record<string, unknown>>();
  readonly candidatePackages = new Set<string>();
  readonly selectedPackages = new Set<string>();
  failMaterialize: Error | null = null;
  failCommit: Error | null = null;
  failCommitPackages = new Set<string>();
  failReject: Error | null = null;
  selectedAvailable = true;
  createMaterializingSession(packages: Iterable<string>): ProviderPluginLoadSession {
    return new FakeProviderPluginLoadSession(this, [...new Set(packages)].sort(), true);
  }
  createInstalledOnlySession(packages: Iterable<string>): ProviderPluginLoadSession {
    const uniquePackages = [...new Set(packages)].sort();
    this.installedOnlySessions.push(uniquePackages);
    const version = `${this.installedOnlySessions.length}.0.0`;
    return new FakeProviderPluginLoadSession(this, uniquePackages, false, version);
  }
  async inspectPackages(packages: Iterable<string>): Promise<ProviderPluginInspection[]> {
    return [...new Set(packages)].sort().map((packageName) => {
      this.inspected.push(packageName);
      return { packageName, ok: true, version: '1.0.0', error: null, lastCheckError: null };
    });
  }
  async importPreparedModule(packageName: string, version: string): Promise<Record<string, unknown>> {
    this.imported.push(packageName);
    this.importRequests.push({ packageName, version });
    const module = version === 'selected'
      ? this.selectedModules.get(packageName) ?? this.modules.get(packageName)
      : this.modules.get(packageName);
    if (module === undefined) throw new Error(`missing module ${packageName}`);
    return module;
  }
}
class FakeProviderPluginLoadSession implements ProviderPluginLoadSession {
  readonly prepared = new Map<string, 'candidate' | 'selected'>();
  constructor(
    private readonly store: FakeProviderPluginStore,
    private readonly packages: readonly string[],
    private readonly materializing: boolean,
    private readonly selectedVersion = 'selected',
  ) {}
  get candidatePackages(): readonly string[] {
    return [...this.prepared.entries()]
      .filter(([, source]) => source === 'candidate')
      .map(([packageName]) => packageName)
      .sort();
  }
  async preparePackage(packageName: string): Promise<string> {
    const prepared = this.prepared.get(packageName);
    if (prepared !== undefined) {
      return prepared === 'candidate' ? '1.0.0' : this.selectedVersion;
    }
    if (this.materializing && this.store.candidatePackages.has(packageName)) {
      this.prepared.set(packageName, 'candidate');
      return '1.0.0';
    }
    if (this.store.selectedPackages.has(packageName)) {
      this.prepared.set(packageName, 'selected');
      return this.selectedVersion;
    }
    if (!this.materializing) throw new Error(`provider plugin ${packageName} has no selected generation`);
    this.prepared.set(packageName, 'candidate');
    this.store.materialized.push(packageName);
    if (this.store.failMaterialize !== null) throw this.store.failMaterialize;
    return '1.0.0';
  }
  async importModule(packageName: string): Promise<Record<string, unknown>> {
    const version = await this.preparePackage(packageName);
    return await this.store.importPreparedModule(packageName, version);
  }
  async commit(): Promise<void> {
    for (const packageName of this.candidatePackages) {
      if (this.store.failCommit !== null && (this.store.failCommitPackages.size === 0 || this.store.failCommitPackages.has(packageName))) {
        throw this.store.failCommit;
      }
      this.store.committed.push(packageName);
      this.store.selectedPackages.add(packageName);
      this.store.candidatePackages.delete(packageName);
    }
  }
  async rejectCandidates(): Promise<void> {
    const failures: unknown[] = [];
    for (const packageName of this.candidatePackages) {
      this.store.rejected.push(packageName);
      if (this.store.failReject === null) this.store.candidatePackages.delete(packageName);
      else failures.push(this.store.failReject);
    }
    if (failures.length > 0) {
      throw new AggregateError(failures, 'test candidate cleanup failed');
    }
  }
  async canUseSelectedOnly(): Promise<boolean> {
    return this.store.selectedAvailable && this.packages.every((packageName) => this.store.selectedPackages.has(packageName));
  }
  selectedOnly(): ProviderPluginLoadSession {
    return new FakeProviderPluginLoadSession(this.store, this.packages, false);
  }
}
class FailingInstallRunner implements ProviderPluginNpmRunner {
  readonly latestCalls: string[] = [];
  readonly installCalls: string[] = [];
  async latestVersion(packageName: string): Promise<string> {
    this.latestCalls.push(packageName);
    return '1.0.0';
  }
  async installExact(input: { packageName: string }): Promise<void> {
    this.installCalls.push(input.packageName);
    throw new Error('install failed');
  }
}
class PublishingInstallRunner implements ProviderPluginNpmRunner {
  readonly latestCalls: string[] = [];
  readonly installCalls: string[] = [];
  constructor(
    private readonly version: string,
    private readonly source: string,
  ) {}
  async latestVersion(packageName: string): Promise<string> {
    this.latestCalls.push(packageName);
    return this.version;
  }
  async installExact(input: {
    packageName: string;
    version: string;
    cwd: string;
  }): Promise<void> {
    this.installCalls.push(input.packageName);
    publishProviderPluginGenerationRootSync({
      generationRoot: input.cwd,
      packageName: input.packageName,
      version: input.version,
      source: this.source,
      packageExports: './provider.mjs',
    });
  }
}
function trackingRegistryFactory(attempts: string[]): ProviderRegistryFactory {
  return () => {
    const registry = createBuiltinProviderRegistry();
    attempts.push(`registry-${attempts.length + 1}`);
    return registry;
  };
}
function runtimeFactory(
  readConfig: (rawConfig: Record<string, unknown>) => Record<string, unknown>,
): ExternalAgentRuntimeProviderFactory {
  return ({ ref, descriptor }) => ({
    ref,
    descriptor: asAgentRuntimeDescriptor(descriptor),
    getCapabilities: () => EXTERNAL_RUNTIME_CAPABILITIES,
    readConfig,
    createRuntime() {
      throw new Error('test runtime does not create a runtime');
    },
  });
}
function runtimeModule(
  readConfig: (rawConfig: Record<string, unknown>) => Record<string, unknown>,
): Record<string, unknown> {
  return { runtime: runtimeFactory(readConfig) };
}
function throwingRuntime(message: string): Record<string, unknown> {
  return runtimeModule(() => {
    throw new Error(message);
  });
}
const EXTERNAL_RUNTIME_CAPABILITIES: AgentRuntimeCapabilities = {
  resume: { supported: true },
};
const externalRuntimeFactory: ExternalAgentRuntimeProviderFactory = ({
  ref,
  descriptor,
}) => ({
  ref,
  descriptor: asAgentRuntimeDescriptor(descriptor),
  getCapabilities: () => EXTERNAL_RUNTIME_CAPABILITIES,
  readConfig(rawConfig) {
    return {
      ...rawConfig,
      parsed_by_provider: true,
    };
  },
  async readTranscript() {
    return { turns: [], nextCursor: null, truncated: false };
  },
  createRuntime() {
    throw new Error('external runtime config test does not create a runtime');
  },
});
function externalChannelFactory(): ExternalChannelProviderFactory {
  return ({ ref, descriptor }) => ({
    ref,
    descriptor: asChannelDescriptor(descriptor),
    readConfig(raw) {
      return raw;
    },
    createSession(context) {
      const session: ChannelSession = {
        provider: ref,
        channel_id: context.channel_id,
        async start() {
        },
        async close() {
        },
        async resolveTarget() {
          return { target_type: 'fixture', target_key: 'k', bindable: true };
        },
      };
      return session;
    },
  }) satisfies ChannelProvider;
}
describe('global config (~/.dreamux/config.json)', () => {
  let configDir: string;
  const envSnapshot: Record<string, string | undefined> = {};
  beforeEach(() => {
    configDir = mkdtempSync(join(tmpdir(), 'dreamux-cfg-'));
    for (const k of [
      'CODEX_HOST_RUNTIME_DIR',
      'CODEX_HOST_ADMIN_SOCKET',
      'CODEX_HOST_CODEX_BIN',
      'DREAMUX_CONFIG_DIR',
    ]) {
      envSnapshot[k] = process.env[k];
      delete process.env[k];
    }
  });
  afterEach(() => {
    for (const [k, v] of Object.entries(envSnapshot)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    rmSync(configDir, { recursive: true, force: true });
    resetRuntimeConfig();
  });
  function writeConfigObject(value: unknown): void {
    writeConfigObjectAt(configDir, value);
  }
  function writeConfigText(file: string, content: string, mode = 0o600): void {
    writeFileSync(file, content, { mode });
  }
  it('config round-trips through stringifyConfig idempotently (#148)', async () => {
    writeConfigObject(
      testSingleDispatcherFileObject({
        id: 'flow',
        cwd: join(configDir, 'flow-cwd'),
        enabled: true,
        feishu: { app_id: 'app-flow', app_secret: 'secret-flow' },
      }),
    );
    const c1 = (await loadConfig({ configDir })).config;
    writeConfigText(globalConfigFile({ configDir }), stringifyConfig(c1));
    const c2 = (await loadConfig({ configDir })).config;
    expect(c2).toEqual(c1);
  });
  it('first boot creates the config dir and JSON file', async () => {
    expect(existsSync(join(configDir, 'config.json'))).toBe(false);
    const { config, configFile, createdOnThisBoot } = await loadOrInitConfig({
      configDir,
    });
    expect(createdOnThisBoot).toBe(true);
    expect(configFile).toBe(join(configDir, 'config.json'));
    expect(readFileSync(configFile, 'utf8')).toBe(DEFAULT_CONFIG_JSON);
    expect(config).toEqual({
      agents: {},
      dispatchers: [],
    });
    expect(JSON.parse(readFileSync(configFile, 'utf8'))).not.toHaveProperty(
      'codex',
    );
    expect(JSON.parse(readFileSync(configFile, 'utf8'))).toEqual({
      agents: [],
      dispatchers: [],
    });
  });
  it('defaults workspace.enabled to true when the block is omitted', async () => {
    writeConfigObject(
      testConfigFileObject({
        agents: [{ id: 'flow' }],
        dispatchers: [
          {
            id: 'flow',
            cwd: '/workspace/flow',
            agentRuntime: 'flow',
          },
        ],
      }),
    );
    const { config } = await loadConfig({ configDir });
    expect(config).not.toHaveProperty('workspace');
    expect(config.dispatchers[0]?.workspace.enabled).toBe(true);
  });
  it('parses dispatcher workspace.enabled and channel collaboration-space default binding', async () => {
    writeConfigObject(
      testConfigFileObject({
        agents: [{ id: 'flow' }],
        dispatchers: [
          {
            id: 'flow',
            cwd: '/workspace/flow',
            agentRuntime: 'flow',
            workspace: { enabled: false },
            collaborationSpace: {
              defaultBinding: {
                enabled: true,
                repo: { cwd: '~/repo/main', baseRef: 'origin/next' },
                identity: 'Default topic leader',
              },
            },
          },
        ],
      }),
    );
    const { config } = await loadConfig({ configDir });
    expect(config).not.toHaveProperty('workspace');
    expect(config.dispatchers[0]?.workspace.enabled).toBe(false);
    expect(config.dispatchers[0]?.channels[0]?.collaborationSpace).toEqual({
      defaultBinding: {
        enabled: true,
        repo: {
          cwd: join(homedir(), 'repo/main'),
          baseRef: 'origin/next',
        },
        identity: 'Default topic leader',
      },
    });
  });
  it('rejects legacy top-level workspace.enabled instead of using it as a dispatcher default', async () => {
    writeConfigObject(
      {
        ...testConfigFileObject({
          agents: [{ id: 'flow' }, { id: 'docs' }],
          dispatchers: [
            {
              id: 'flow',
              cwd: '/workspace/flow',
              agentRuntime: 'flow',
            },
            {
              id: 'docs',
              cwd: '/workspace/docs',
              agentRuntime: 'docs',
              workspace: { enabled: true },
            },
          ],
        }),
        workspace: { enabled: false },
      },
    );
    await expect(loadConfig({ configDir })).rejects.toThrow(
      /workspace is not supported/,
    );
  });
  it('second boot reads the existing JSON file and does not overwrite it', async () => {
    const file = globalConfigFile({ configDir });
    const original = `${JSON.stringify(
      testSingleDispatcherFileObject({
        id: 'flow',
        cwd: '/workspace/flow',
        enabled: true,
        feishu: {
          app_id: 'app-test',
          app_secret: 'secret-test',
        },
        codex: {
          approval_policy: 'auto',
          sandbox_mode: 'danger-full-access',
          extra_args: ['--profile', 'flow'],
          extra_env: {},
        },
      }),
      null,
      2,
    )}\n`;
    writeConfigText(file, original);
    const { config, createdOnThisBoot } = await loadOrInitConfig({ configDir });
    expect(createdOnThisBoot).toBe(false);
    expect(config.agents['flow']).toMatchObject({
      provider: 'builtin:codex',
      config: {
        approval_policy: 'auto',
        sandbox_mode: 'danger-full-access',
        extra_args: ['--profile', 'flow'],
        extra_env: {},
      },
    });
    expect(config.dispatchers[0]).toMatchObject({
      id: 'flow',
      cwd: '/workspace/flow',
      enabled: true,
      channels: [
        {
          id: 'primary',
          provider: 'builtin:feishu',
          config: {
            appId: 'app-test',
            appSecret: 'secret-test',
          },
          rawConfig: {
            app_id: 'app-test',
            app_secret: 'secret-test',
          },
        },
      ],
      agentRuntime: 'flow',
      runtime: {
        provider: 'builtin:codex',
        config: {
          approval_policy: 'auto',
          sandbox_mode: 'danger-full-access',
          extra_args: ['--profile', 'flow'],
          extra_env: {},
        },
      },
    });
    expect(readFileSync(file, 'utf8')).toBe(original);
  });
  it('parse error fails fast with the config path', async () => {
    const file = globalConfigFile({ configDir });
    writeConfigText(file, `{"dispatchers": [`);
    await expect(loadOrInitConfig({ configDir })).rejects.toThrow(/config\.json/);
    await expect(loadOrInitConfig({ configDir })).rejects.toThrow(
      /dreamux config parse error/,
    );
  });
  it('fails fast when only the legacy TOML config exists', async () => {
    const jsonFile = globalConfigFile({ configDir });
    const tomlFile = join(configDir, 'config.toml');
    writeFileSync(tomlFile, 'dispatchers = []\n');
    await expect(loadOrInitConfig({ configDir })).rejects.toThrow(
      /legacy dreamux config/,
    );
    await expect(loadConfig({ configDir })).rejects.toThrow(/dispatchers array/);
    expect(existsSync(jsonFile)).toBe(false);
  });
  it('loadConfig loudly fails when config.json is missing', async () => {
    await expect(loadConfig({ configDir })).rejects.toThrow(/dreamux config is missing/);
    await expect(loadConfig({ configDir })).rejects.toThrow(/dreamux onboard/);
    expect(existsSync(globalConfigFile({ configDir }))).toBe(false);
  });
  it('redacts Feishu app secrets for display', async () => {
    const raw = JSON.stringify({
      dispatchers: [
        {
          id: 'flow',
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
        },
        {
          id: 'docs',
          nested: {
            app_secret: 'secret-docs',
          },
        },
      ],
    });
    const displayed = redactConfigForDisplay(raw, globalConfigFile({ configDir }));
    expect(displayed).toContain('<redacted>');
    expect(displayed).not.toContain('secret-flow');
    expect(displayed).not.toContain('secret-docs');
    expect(JSON.parse(displayed)).toMatchObject({
      dispatchers: [
        {
          channels: [
            {
              config: { app_id: 'app-flow', app_secret: '<redacted>' },
            },
          ],
        },
        { nested: { app_secret: '<redacted>' } },
      ],
    });
  });
  it('rejects invalid config values', async () => {
    writeConfigObject({ state_path: '/tmp/custom-state' });
    await expect(loadOrInitConfig({ configDir })).rejects.toThrow(
      /state_path is not supported/,
    );
    const fileObject = testSingleDispatcherFileObject({ id: 'flow' });
    (fileObject['dispatchers'] as Record<string, unknown>[])[0]!['enabled'] =
      'yes';
    writeConfigObject(fileObject);
    await expect(loadOrInitConfig({ configDir })).rejects.toThrow(
      /enabled must be a boolean/,
    );
  });
  for (const testCase of [
    {
      name: 'leftover top-level codex block',
      raw: { codex: { approval_policy: 'never' }, dispatchers: [] },
      loader: loadOrInitConfig,
      errors: [
        /top-level "codex" block is no longer supported/,
        /agents\[\] with the selected runtime provider/,
      ],
    },
    {
      name: 'dispatcher missing agentRuntime',
      raw: {
        agents: [{ id: 'codex', provider: 'builtin:codex', config: {} }],
        dispatchers: [{
          id: 'flow',
          channels: [{
            id: 'primary',
            provider: 'builtin:feishu',
            config: { app_id: 'app-flow', app_secret: 'secret-flow' },
          }],
        }],
      },
      errors: [/dispatchers\[0\]\.agentRuntime is required/],
    },
    {
      name: 'dangling agentRuntime reference',
      raw: testConfigFileObject({
        agents: [{ id: 'codex', provider: 'builtin:codex', config: {} }],
        dispatchers: [{ id: 'flow', agentRuntime: 'does-not-exist' }],
      }),
      errors: [
        /agentRuntime='does-not-exist' does not match any agents\[\]\.id/,
        /Known agents: 'codex'/,
      ],
    },
    {
      name: 'duplicate agents[].id',
      raw: testConfigFileObject({
        agents: [
          { id: 'codex', provider: 'builtin:codex', config: {} },
          { id: 'codex', provider: 'builtin:codex', config: {} },
        ],
        dispatchers: [{ id: 'flow', agentRuntime: 'codex' }],
      }),
      errors: [/agents\[1\]\.id duplicates agent 'codex'/],
    },
    {
      name: 'top-level agents is not an array',
      raw: { agents: { codex: { provider: 'builtin:codex' } }, dispatchers: [] },
      errors: [/agents must be an array \(got object\)/],
    },
  ]) {
    it(`fails loud on ${testCase.name}`, async () => {
      writeConfigObject(testCase.raw);
      for (const error of testCase.errors) {
        await expect((testCase.loader ?? loadConfig)({ configDir })).rejects.toThrow(error);
      }
    });
  }
  for (const testCase of [
    {
      name: 'pre-providerized dispatcher config',
      raw: {
        dispatchers: [{
          id: 'flow',
          feishu: { app_id: 'app-flow', app_secret: 'secret-flow' },
          codex: { approval_policy: 'never' },
        }],
      },
      errors: [
        /feishu is not supported by the providerized config v2 schema/,
        /channels\[\]/,
      ],
    },
    {
      name: 'old inline dispatchers[].runtime shape',
      raw: {
        agents: [],
        dispatchers: [{
          id: 'flow',
          channels: [{
            id: 'primary',
            provider: 'builtin:feishu',
            config: { app_id: 'app-flow', app_secret: 'secret-flow' },
          }],
          runtime: {
            provider: 'builtin:codex',
            config: { approval_policy: 'never' },
          },
        }],
      },
      errors: [/dispatchers\[0\]\.runtime is no longer supported/, /agentRuntime/],
    },
  ]) {
    it(`does not rewrite ${testCase.name}`, async () => {
      const file = globalConfigFile({ configDir });
      const original = JSON.stringify(testCase.raw);
      writeConfigText(file, original);
      for (const error of testCase.errors) {
        await expect(loadConfig({ configDir })).rejects.toThrow(error);
      }
      expect(readFileSync(file, 'utf8')).toBe(original);
    });
  }
  it('resolves an agent shared by two dispatchers (cross-dispatcher reuse)', async () => {
    writeConfigObject(
      testConfigFileObject({
        agents: [
          {
            id: 'shared-codex',
            provider: 'builtin:codex',
            config: { sandbox_mode: 'read-only' },
          },
        ],
        dispatchers: [
          {
            id: 'flow',
            agentRuntime: 'shared-codex',
            feishu: { app_id: 'app-flow', app_secret: 'secret-flow' },
          },
          {
            id: 'docs',
            agentRuntime: 'shared-codex',
            feishu: { app_id: 'app-docs', app_secret: 'secret-docs' },
          },
        ],
      }),
    );
    const { config } = await loadConfig({ configDir });
    expect(Object.keys(config.agents)).toEqual(['shared-codex']);
    expect(dispatcherCodexConfig(config.dispatchers[0]!).sandbox_mode).toBe(
      'read-only',
    );
    expect(dispatcherCodexConfig(config.dispatchers[1]!).sandbox_mode).toBe(
      'read-only',
    );
    expect(config.dispatchers[0]?.runtime).toEqual(config.dispatchers[1]?.runtime);
  });
  it('resolves a claude teammate-style agent alongside a codex dispatcher agent', async () => {
    writeConfigObject(
      testConfigFileObject({
        agents: [
          { id: 'codex', provider: 'builtin:codex', config: {} },
          {
            id: 'claude',
            provider: 'builtin:claude-code',
            config: { permission_mode: 'default' },
          },
        ],
        dispatchers: [{ id: 'flow', agentRuntime: 'codex' }],
      }),
    );
    const { config } = await loadConfig({ configDir });
    expect(config.agents['codex']?.provider).toBe('builtin:codex');
    expect(config.agents['claude']?.provider).toBe('builtin:claude-code');
    expect(config.dispatchers[0]?.runtime.provider).toBe('builtin:codex');
  });
  it('one provider, two named agent configs resolve to different configs (#148)', async () => {
    writeConfigObject(
      testConfigFileObject({
        agents: [
          {
            id: 'codex-safe',
            provider: 'builtin:codex',
            config: { approval_policy: 'on-failure', sandbox_mode: 'read-only' },
          },
          {
            id: 'codex-yolo',
            provider: 'builtin:codex',
            config: { approval_policy: 'never', sandbox_mode: 'danger-full-access' },
          },
        ],
        dispatchers: [
          {
            id: 'safe',
            agentRuntime: 'codex-safe',
            feishu: { app_id: 'app-safe', app_secret: 'secret-safe' },
          },
          {
            id: 'yolo',
            agentRuntime: 'codex-yolo',
            feishu: { app_id: 'app-yolo', app_secret: 'secret-yolo' },
          },
        ],
      }),
    );
    const { config } = await loadConfig({ configDir });
    expect(config.agents['codex-safe']?.provider).toBe('builtin:codex');
    expect(config.agents['codex-yolo']?.provider).toBe('builtin:codex');
    expect(config.agents['codex-safe']?.config).not.toEqual(
      config.agents['codex-yolo']?.config,
    );
    expect(dispatcherCodexConfig(config.dispatchers[0]!).approval_policy).toBe(
      'on-failure',
    );
    expect(dispatcherCodexConfig(config.dispatchers[0]!).sandbox_mode).toBe(
      'read-only',
    );
    expect(dispatcherCodexConfig(config.dispatchers[1]!).approval_policy).toBe(
      'never',
    );
    expect(dispatcherCodexConfig(config.dispatchers[1]!).sandbox_mode).toBe(
      'danger-full-access',
    );
    expect(config.dispatchers[0]?.runtime).toEqual(config.agents['codex-safe']);
    expect(config.dispatchers[1]?.runtime).toEqual(config.agents['codex-yolo']);
  });
  for (const testCase of [
    {
      name: 'invalid agent approval_policy',
      config: { approval_policy: 'ask-every-time' },
      error: /agents\[0\]\.config\.approval_policy='ask-every-time'/,
      loader: loadOrInitConfig,
    },
    {
      name: 'empty agent config.bin',
      config: { bin: '   ' },
      error: /agents\[0\]\.config\.bin must be a non-empty string/,
      loader: loadConfig,
    },
    {
      name: 'non-positive agent config.initialize_timeout_ms',
      config: { initialize_timeout_ms: 0 },
      error: /agents\[0\]\.config\.initialize_timeout_ms must be > 0/,
      loader: loadConfig,
    },
  ]) {
    it(`rejects ${testCase.name}`, async () => {
      writeConfigObject(
        testSingleDispatcherFileObject({ id: 'flow', codex: testCase.config }),
      );
      await expect(testCase.loader({ configDir })).rejects.toThrow(testCase.error);
    });
  }
  it('defaults agent config.bin and initialize_timeout_ms', async () => {
    writeConfigObject(
      testSingleDispatcherFileObject({ id: 'flow', codex: {} }),
    );
    const { config } = await loadConfig({ configDir });
    const codex = dispatcherCodexConfig(config.dispatchers[0]!);
    expect(codex.bin).toBe('codex');
    expect(codex.initialize_timeout_ms).toBe(10000);
  });
  it('accepts agent config.bin and initialize_timeout_ms overrides', async () => {
    writeConfigObject(
      testSingleDispatcherFileObject({
        id: 'flow',
        codex: { bin: '/opt/custom-codex', initialize_timeout_ms: 30000 },
      }),
    );
    const { config } = await loadConfig({ configDir });
    const codex = dispatcherCodexConfig(config.dispatchers[0]!);
    expect(codex.bin).toBe('/opt/custom-codex');
    expect(codex.initialize_timeout_ms).toBe(30000);
  });
  it('accepts the providerized dispatcher config v2 schema', async () => {
    writeConfigObject(
      testConfigFileObject({
        agents: [
          {
            id: 'dispatcher-a',
            provider: 'builtin:codex',
            config: {
              extra_args: ['--model', 'gpt-5'],
              extra_env: {
                EXAMPLE_FLAG: '1',
              },
            },
          },
          { id: 'dispatcher.b', provider: 'builtin:codex', config: {} },
        ],
        dispatchers: [
          {
            id: 'dispatcher-a',
            cwd: '~/workspace-a',
            enabled: true,
            agentRuntime: 'dispatcher-a',
            feishu: { app_id: 'app-a', app_secret: 'secret-a' },
          },
          {
            id: 'dispatcher.b',
            agentRuntime: 'dispatcher.b',
            feishu: { app_id: 'app-b', app_secret: 'secret-b' },
          },
        ],
      }),
    );
    const { config } = await loadConfig({ configDir });
    const firstFeishu = config.dispatchers[0]!.channels[0]!.config;
    const firstCodex = dispatcherCodexConfig(config.dispatchers[0]!);
    expect(config.dispatchers[0]).toMatchObject({
      id: 'dispatcher-a',
      enabled: true,
      channels: [{ provider: 'builtin:feishu' }],
      runtime: { provider: 'builtin:codex' },
    });
    expect(firstFeishu).toEqual({
      appId: 'app-a',
      appSecret: 'secret-a',
    });
    expect(config.dispatchers[0]!.channels[0]!.identity).toBe('app-a');
    expect(firstCodex).toMatchObject({
      approval_policy: DEFAULT_APPROVAL_POLICY,
      sandbox_mode: DEFAULT_SANDBOX_MODE,
      extra_args: ['--model', 'gpt-5'],
      extra_env: {
        EXAMPLE_FLAG: '1',
      },
    });
    expect(config.dispatchers[0]?.cwd).not.toContain('~');
    expect(config.dispatchers[1]).toMatchObject({
      id: 'dispatcher.b',
      cwd: null,
      enabled: true,
      channels: [{ provider: 'builtin:feishu' }],
      runtime: { provider: 'builtin:codex' },
    });
    expect(config.dispatchers[1]!.channels[0]!.config).toEqual({
      appId: 'app-b',
      appSecret: 'secret-b',
    });
  });
  it('rejects runtime provider refs in channel config', async () => {
    writeConfigObject(
      testSingleDispatcherFileObject({
        id: 'flow',
        channelProvider: 'builtin:codex',
      }),
    );
    await expect(loadConfig({ configDir })).rejects.toThrow(
      /is a agentRuntime provider, expected channel/,
    );
  });
  it('loads external npm runtime providers before validating runtime config', async () => {
    const providerRef = 'npm:@example/dreamux-runtime#provider';
    writeConfigObject(runtimePluginConfig(providerRef, { provider_option: 'kept' }));
    const { config, providerRegistry } = await loadConfig({
      configDir,
      externalAgentRuntimeModuleImporter: async (packageName) => {
        expect(packageName).toBe('@example/dreamux-runtime');
        return { provider: externalRuntimeFactory };
      },
    });
    expect(config.agents['flow']).toEqual({
      provider: providerRef,
      config: {
        provider_option: 'kept',
        parsed_by_provider: true,
      },
      rawConfig: {
        provider_option: 'kept',
      },
    });
    expect(config.dispatchers[0]?.runtime).toEqual({
      provider: providerRef,
      config: {
        provider_option: 'kept',
        parsed_by_provider: true,
      },
      rawConfig: {
        provider_option: 'kept',
      },
    });
    expect(providerRegistry.resolve(providerRef).kind).toBe('agentRuntime');
    expect(providerRegistry.getImplementation(providerRef)).not.toBeUndefined();
  });
  it('keeps injected runtime importers from touching the plugin store', async () => {
    const providerRef = 'npm:@example/dreamux-runtime#provider';
    writeConfigObject(runtimePluginConfig(providerRef));
    const pluginStore = new FakeProviderPluginStore();
    await loadConfig({
      configDir,
      providerPluginStore: pluginStore,
      externalAgentRuntimeModuleImporter: async () => ({ provider: externalRuntimeFactory }),
    });
    expect(pluginStore.materialized).toEqual([]);
    expect(pluginStore.imported).toEqual([]);
  });
  it('does not call the plugin store for builtin provider refs', async () => {
    writeConfigObject(
      testSingleDispatcherFileObject({
        id: 'flow',
        feishu: { app_id: 'app-flow', app_secret: 'secret-flow' },
      }),
    );
    const pluginStore = new FakeProviderPluginStore();
    await loadConfig({
      configDir,
      providerPluginStore: pluginStore,
    });
    expect(pluginStore.materialized).toEqual([]);
    expect(pluginStore.imported).toEqual([]);
    expect(pluginStore.inspected).toEqual([]);
  });
  it('fails host-owned cross-reference validation before preparing npm providers', async () => {
    const providerRef = 'npm:@example/dreamux-provider#runtime';
    writeConfigObject(
      testConfigFileObject({
        agents: [{ id: 'flow', provider: providerRef, config: {} }],
        dispatchers: [{ id: 'flow', agentRuntime: 'missing-agent' }],
      }),
    );
    const pluginStore = new FakeProviderPluginStore();
    pluginStore.modules.set('@example/dreamux-provider', {
      runtime: externalRuntimeFactory,
    });
    await expect(
      loadConfig({
        configDir,
        providerPluginStore: pluginStore,
      }),
    ).rejects.toThrow(/agentRuntime='missing-agent'/);
    expect(pluginStore.materialized).toEqual([]);
    expect(pluginStore.imported).toEqual([]);
    expect(pluginStore.committed).toEqual([]);
    expect(pluginStore.rejected).toEqual([]);
  });
  it('materializes one npm package once across runtime and channel refs', async () => {
    const runtimeRef = 'npm:@example/dreamux-provider#runtime';
    const channelRef = 'npm:@example/dreamux-provider#channel';
    writeConfigObject(runtimeChannelPluginConfig(runtimeRef, channelRef));
    const pluginStore = new FakeProviderPluginStore();
    pluginStore.modules.set('@example/dreamux-provider', {
      runtime: externalRuntimeFactory,
      channel: externalChannelFactory(),
    });
    const { providerPluginPackages, providerRegistry } = await loadConfig({
      configDir,
      providerPluginStore: pluginStore,
    });
    expect(providerPluginPackages).toEqual(['@example/dreamux-provider']);
    expect(pluginStore.materialized).toEqual(['@example/dreamux-provider']);
    expect(pluginStore.imported).toEqual([
      '@example/dreamux-provider',
      '@example/dreamux-provider',
    ]);
    expect(pluginStore.importRequests).toEqual([
      { packageName: '@example/dreamux-provider', version: '1.0.0' },
      { packageName: '@example/dreamux-provider', version: '1.0.0' },
    ]);
    expect(providerRegistry.resolve(runtimeRef).kind).toBe('agentRuntime');
    expect(providerRegistry.resolve(channelRef).kind).toBe('channel');
  });
  it('rejects a bad candidate and retries selected-only with fresh registry and raw config', async () => {
    const packageName = '@example/dreamux-provider';
    const runtimeRef = `npm:${packageName}#runtime`;
    writeConfigObject(runtimePluginConfig(runtimeRef, { keep: true }));
    const pluginStore = new FakeProviderPluginStore();
    pluginStore.candidatePackages.add(packageName);
    pluginStore.selectedPackages.add(packageName);
    const registryAttempts: string[] = [];
    const rawSnapshots: Record<string, unknown>[] = [];
    pluginStore.modules.set(packageName, runtimeModule((rawConfig) => {
      rawSnapshots.push(rawConfig);
      rawConfig['candidate_mutation'] = true;
      throw new Error('candidate readConfig failed');
    }));
    pluginStore.selectedModules.set(packageName, runtimeModule((rawConfig) => {
      rawSnapshots.push(rawConfig);
      return { ...rawConfig, selected: true };
    }));
    const loaded = await loadConfig({
      configDir,
      providerPluginStore: pluginStore,
      providerRegistryFactory: trackingRegistryFactory(registryAttempts),
    });
    expect(loaded.providerPluginWarnings.join('\n')).toMatch(
      /rejected provider plugin candidate generation/,
    );
    expect(loaded.config.agents['flow']?.config).toEqual({
      keep: true,
      selected: true,
    });
    expect(pluginStore.rejected).toEqual([packageName]);
    expect(pluginStore.committed).toEqual([]);
    expect(pluginStore.importRequests).toEqual([
      { packageName, version: '1.0.0' },
      { packageName, version: 'selected' },
    ]);
    expect(registryAttempts).toEqual(['registry-1', 'registry-2']);
    expect(rawSnapshots).toHaveLength(2);
    expect(rawSnapshots[0]).not.toBe(rawSnapshots[1]);
    expect(rawSnapshots[1]).toEqual({ keep: true });
  });
  it('does not reject a candidate when an unrelated selected provider fails', async () => {
    const candidatePackage = '@example/candidate-provider';
    const selectedPackage = '@example/selected-provider';
    const candidateRef = `npm:${candidatePackage}#runtime`;
    const selectedRef = `npm:${selectedPackage}#runtime`;
    writeConfigObject(
      testConfigFileObject({
        agents: [
          { id: 'candidate', provider: candidateRef, config: {} },
          { id: 'selected', provider: selectedRef, config: {} },
        ],
        dispatchers: [
          { id: 'flow', agentRuntime: 'candidate' },
          { id: 'docs', agentRuntime: 'selected' },
        ],
      }),
    );
    const pluginStore = new FakeProviderPluginStore();
    pluginStore.candidatePackages.add(candidatePackage);
    pluginStore.selectedPackages.add(selectedPackage);
    pluginStore.modules.set(candidatePackage, runtimeModule((raw) => raw));
    pluginStore.selectedModules.set(
      selectedPackage,
      throwingRuntime('selected provider readConfig failed'),
    );
    await expect(
      loadConfig({
        configDir,
        providerPluginStore: pluginStore,
      }),
    ).rejects.toThrow(/selected provider readConfig failed/);
    expect(pluginStore.rejected).toEqual([]);
    expect(pluginStore.committed).toEqual([]);
    expect(pluginStore.candidatePackages.has(candidatePackage)).toBe(true);
    expect(pluginStore.importRequests).toEqual([
      { packageName: candidatePackage, version: '1.0.0' },
      { packageName: selectedPackage, version: 'selected' },
    ]);
  });
  it('preserves candidate and selected-only causes when fallback validation fails', async () => {
    const packageName = '@example/dreamux-provider';
    const runtimeRef = `npm:${packageName}#runtime`;
    writeConfigObject(runtimePluginConfig(runtimeRef));
    const pluginStore = new FakeProviderPluginStore();
    pluginStore.candidatePackages.add(packageName);
    pluginStore.selectedPackages.add(packageName);
    pluginStore.modules.set(packageName, throwingRuntime('candidate cause'));
    pluginStore.selectedModules.set(packageName, throwingRuntime('selected cause'));
    let thrown = await loadConfig({ configDir, providerPluginStore: pluginStore })
      .catch((err: unknown) => err);
    expect(thrown).toBeInstanceOf(AggregateError);
    expect((thrown as AggregateError).message).toContain('selected cause');
    expect(pluginStore.rejected).toEqual([packageName]);
    pluginStore.rejected.length = 0;
    pluginStore.candidatePackages.add(packageName);
    pluginStore.failReject = new Error('metadata write failed');
    thrown = await loadConfig({ configDir, providerPluginStore: pluginStore })
      .catch((err: unknown) => err);
    expect(thrown).toBeInstanceOf(AggregateError);
    expect(((thrown as AggregateError).cause as Error).message).toContain('candidate cause');
    expect((thrown as AggregateError).errors[1]).toBeInstanceOf(AggregateError);
    expect(pluginStore.rejected).toEqual([packageName]);
    expect(pluginStore.importRequests.at(-1)).toEqual({ packageName, version: '1.0.0' });
    expect(pluginStore.candidatePackages.has(packageName)).toBe(true);
  });
  it('commits multi-package candidates sequentially and leaves safe partial state on write failure', async () => {
    const runtimePackage = '@example/runtime-provider';
    const channelPackage = '@example/channel-provider';
    const runtimeRef = `npm:${runtimePackage}#runtime`;
    const channelRef = `npm:${channelPackage}#channel`;
    writeConfigObject(runtimeChannelPluginConfig(runtimeRef, channelRef));
    const pluginStore = new FakeProviderPluginStore();
    pluginStore.modules.set(runtimePackage, { runtime: externalRuntimeFactory });
    pluginStore.modules.set(channelPackage, { channel: externalChannelFactory() });
    pluginStore.failCommitPackages.add(runtimePackage);
    pluginStore.failCommit = new Error('runtime metadata write failed');
    await expect(
      loadConfig({
        configDir,
        providerPluginStore: pluginStore,
      }),
    ).rejects.toThrow(/runtime metadata write failed/);
    expect(pluginStore.imported.sort()).toEqual([channelPackage, runtimePackage].sort());
    expect(pluginStore.committed).toEqual([channelPackage]);
    expect(pluginStore.rejected).toEqual([]);
  });
  it('pins runtime and channel imports to the inspected plugin generation', async () => {
    const packageName = '@example/dreamux-provider';
    const runtimeRef = `npm:${packageName}#runtime`;
    const channelRef = `npm:${packageName}#channel`;
    writeConfigObject(runtimeChannelPluginConfig(runtimeRef, channelRef));
    const pluginRoot = mkdtempSync(join(tmpdir(), 'dreamux-plugin-store-'));
    publishProviderPluginGenerationSync({ root: pluginRoot, packageName, version: '1.0.0' });
    publishProviderPluginGenerationSync({ root: pluginRoot, packageName, version: '2.0.0' });
    writeProviderPluginMetadataSync({
      root: pluginRoot,
      packageName,
      version: '1.0.0',
      checkedAt: 1000,
    });
    let importCount = 0;
    const importedUrls: string[] = [];
    const pluginStore = new ProviderPluginStore({
      root: pluginRoot,
      importBridge: async (url) => {
        importCount += 1;
        importedUrls.push(url);
        const imported = await import(`${url}?config-plan-${importCount}`);
        if (importCount === 1) {
          writeProviderPluginMetadataSync({
            root: pluginRoot,
            packageName,
            version: '2.0.0',
            checkedAt: 2000,
          });
        }
        return imported as unknown;
      },
    });
    try {
      const { config } = await loadConfigInstalledOnly({
        configDir,
        providerPluginStore: pluginStore,
      });
      expect(config.agents['flow']?.config).toMatchObject({
        runtime_generation: '1.0.0',
      });
      expect(config.dispatchers[0]?.channels[0]?.config).toMatchObject({
        channel_generation: '1.0.0',
      });
      expect(importedUrls).toHaveLength(2);
      expect(importedUrls.every((url) =>
        url.includes('/versions/1.0.0/dreamux-import.mjs'),
      )).toBe(true);
      expect(readPluginMetadata(pluginRoot, packageName)).toMatchObject({
        selected_version: '2.0.0',
      });
    } finally {
      rmSync(pluginRoot, { recursive: true, force: true });
    }
  });
  it('uses one installed-only inspection session across same-package runtime and channel refs', async () => {
    const packageName = '@example/inspection-provider';
    const channelRef = `npm:${packageName}#channel`;
    writeConfigObject(runtimeChannelPluginConfig(`npm:${packageName}#runtime`, channelRef));
    const pluginStore = new FakeProviderPluginStore();
    pluginStore.selectedPackages.add(packageName);
    pluginStore.modules.set(packageName, {
      runtime: externalRuntimeFactory,
      channel: externalChannelFactory(),
    });
    const inspection = await inspectConfigProviderDeclarations({
      configDir,
      providerPluginStore: pluginStore,
    });
    expect(inspection.failures).toEqual([]);
    expect(pluginStore.installedOnlySessions).toEqual([[packageName]]);
    expect(pluginStore.importRequests).toEqual(
      Array.from({ length: 2 }, () => ({ packageName, version: '1.0.0' })),
    );
    expect(inspection.agents[0]?.config).toMatchObject({
      parsed_by_provider: true,
    });
    expect(inspection.dispatchers[0]?.channels[0]?.provider).toBe(channelRef);
  });
  it('reports plugin materialization failures with provider ref and package', async () => {
    const providerRef = 'npm:@example/broken-runtime#provider';
    writeConfigObject(runtimePluginConfig(providerRef));
    const runner = new FailingInstallRunner();
    const { pluginRoot, pluginStore, cleanup } = withPluginStore({
      runner,
      now: () => 5000,
    });
    try {
      await expect(
        loadConfig({ configDir, providerPluginStore: pluginStore }),
      ).rejects.toThrow(
        /failed to prepare provider plugin package "@example\/broken-runtime" for npm:@example\/broken-runtime#provider: install failed/,
      );
      expect(runner.latestCalls).toEqual(['@example/broken-runtime']);
      expect(runner.installCalls).toEqual(['@example/broken-runtime']);
      expect(existsSync(providerPluginMetadataPath('@example/broken-runtime', pluginRoot))).toBe(false);
    } finally {
      cleanup();
    }
  });
  it('retries first-use after candidate rejection and reuses the published generation', async () => {
    const packageName = '@example/retry-runtime';
    const providerRef = `npm:${packageName}#provider`;
    writeConfigObject(runtimePluginConfig(providerRef));
    const runner = new PublishingInstallRunner(
      '1.0.0',
      providerPluginSource({ readConfigBody: 'throw new Error("candidate readConfig failed");' }),
    );
    const { pluginRoot, pluginStore, cleanup } = withPluginStore({
      runner,
      now: () => 5000,
    });
    try {
      await expect(
        loadConfig({ configDir, providerPluginStore: pluginStore }),
      ).rejects.toThrow(/candidate readConfig failed/);
      expect(runner.latestCalls).toEqual([packageName]);
      expect(runner.installCalls).toEqual([packageName]);
      expect(readPluginMetadata(pluginRoot, packageName)).toMatchObject({
        selected_version: null,
        candidate_version: null,
        last_check_completed_at: 5000,
      });
      await expect(
        loadConfig({ configDir, providerPluginStore: pluginStore }),
      ).rejects.toThrow(/candidate readConfig failed/);
      expect(runner.latestCalls).toEqual([packageName, packageName]);
      expect(runner.installCalls).toEqual([packageName]);
      expect(readPluginMetadata(pluginRoot, packageName)).toMatchObject({
        selected_version: null,
        candidate_version: null,
      });
    } finally {
      cleanup();
    }
  });
  it('awaits an external runtime provider whose readConfig is async (#209 F4)', async () => {
    const providerRef = 'npm:@example/dreamux-async-runtime#provider';
    writeConfigObject(runtimePluginConfig(providerRef, { provider_option: 'kept' }));
    const asyncFactory: ExternalAgentRuntimeProviderFactory = ({
      ref,
      descriptor,
    }) => ({
      ref,
      descriptor: asAgentRuntimeDescriptor(descriptor),
      getCapabilities: () => EXTERNAL_RUNTIME_CAPABILITIES,
      async readConfig(rawConfig) {
        await Promise.resolve();
        return { ...rawConfig, parsed_async: true };
      },
      async readTranscript() {
        return { turns: [], nextCursor: null, truncated: false };
      },
      createRuntime() {
        throw new Error('async runtime config test does not create a runtime');
      },
    });
    const { config } = await loadConfig({
      configDir,
      externalAgentRuntimeModuleImporter: async () => ({ provider: asyncFactory }),
    });
    expect(config.agents['flow']).toEqual({
      provider: providerRef,
      config: { provider_option: 'kept', parsed_async: true },
      rawConfig: { provider_option: 'kept' },
    });
  });
  it('fails loud when an external runtime async readConfig rejects (#209 F4)', async () => {
    const providerRef = 'npm:@example/dreamux-bad-runtime#provider';
    writeConfigObject(runtimePluginConfig(providerRef));
    const rejectingFactory: ExternalAgentRuntimeProviderFactory = ({
      ref,
      descriptor,
    }) => ({
      ref,
      descriptor: asAgentRuntimeDescriptor(descriptor),
      getCapabilities: () => EXTERNAL_RUNTIME_CAPABILITIES,
      async readConfig() {
        await Promise.resolve();
        throw new Error('async config validation failed: bad flow');
      },
      async readTranscript() {
        return { turns: [], nextCursor: null, truncated: false };
      },
      createRuntime() {
        throw new Error('rejecting runtime config test does not create a runtime');
      },
    });
    await expect(
      loadConfig({
        configDir,
        externalAgentRuntimeModuleImporter: async () => ({
          provider: rejectingFactory,
        }),
      }),
    ).rejects.toThrow(/async config validation failed: bad flow/);
  });
  it('fails loudly when an external npm runtime package cannot be imported', async () => {
    writeConfigObject(runtimePluginConfig('npm:@example/missing-runtime'));
    await expect(
      loadConfig({
        configDir,
        externalAgentRuntimeModuleImporter: async () => {
          throw new Error('package not found');
        },
      }),
    ).rejects.toThrow(/npm:@example\/missing-runtime/);
    await expect(
      loadConfig({
        configDir,
        externalAgentRuntimeModuleImporter: async () => {
          throw new Error('package not found');
        },
      }),
    ).rejects.toThrow(/could not import package/);
  });
  it('Q2: loadConfig loads builtin:codex + builtin:claude-code + builtin:feishu impls through the single dynamic path', async () => {
    writeConfigObject(
      testConfigFileObject({
        agents: [
          { id: 'codex-agent', provider: 'builtin:codex', config: {} },
          { id: 'claude-agent', provider: 'builtin:claude-code', config: {} },
        ],
        dispatchers: [
          {
            id: 'flow-codex',
            agentRuntime: 'codex-agent',
            feishu: { app_id: 'app-codex', app_secret: 'secret-codex' },
          },
          {
            id: 'flow-claude',
            agentRuntime: 'claude-agent',
            feishu: { app_id: 'app-claude', app_secret: 'secret-claude' },
          },
        ],
      }),
    );
    const { providerRegistry } = await loadConfig({ configDir });
    expect(providerRegistry.getImplementation('codex')).not.toBeUndefined();
    expect(providerRegistry.getImplementation('claude-code')).not.toBeUndefined();
    expect(providerRegistry.getImplementation('feishu')).not.toBeUndefined();
    expect(providerRegistry.resolve('builtin:codex').kind).toBe('agentRuntime');
    expect(providerRegistry.resolve('builtin:claude-code').kind).toBe('agentRuntime');
    expect(providerRegistry.resolve('builtin:feishu').kind).toBe('channel');
  });
  it('accepts a builtin:claude-code agent with its own config shape', async () => {
    writeConfigObject(
      testConfigFileObject({
        agents: [
          {
            id: 'flow',
            provider: 'builtin:claude-code',
            config: {
              bin: 'claude',
              model: 'sonnet',
              permission_mode: 'acceptEdits',
              remote_control: true,
              extra_args: [],
              extra_env: {},
            },
          },
        ],
        dispatchers: [{ id: 'flow', agentRuntime: 'flow' }],
      }),
    );
    const { config } = await loadConfig({ configDir });
    expect(config.agents['flow']?.provider).toBe('builtin:claude-code');
    expect(config.dispatchers[0]?.runtime.provider).toBe('builtin:claude-code');
    expect(config.dispatchers[0]?.runtime.config).toMatchObject({
      remote_control: true,
    });
  });
  for (const testCase of [
    {
      name: 'non-boolean remote_control under a claude-code agent config',
      config: { bin: 'claude', remote_control: 'yes' },
      error: /remote_control must be a boolean/,
    },
    {
      name: 'codex-only keys under a claude-code agent config',
      config: { bin: 'claude', approval_policy: 'never' },
      error: /approval_policy is not supported/,
    },
  ]) {
    it(`rejects ${testCase.name}`, async () => {
      writeConfigObject(
        testConfigFileObject({
          agents: [{ id: 'flow', provider: 'builtin:claude-code', config: testCase.config }],
          dispatchers: [{ id: 'flow', agentRuntime: 'flow' }],
        }),
      );
      await expect(loadConfig({ configDir })).rejects.toThrow(testCase.error);
    });
  }
  for (const testCase of [
    {
      name: 'two channels using the same provider ref on one dispatcher (#209 Decision #4)',
      channel: {
        id: 'secondary',
        provider: 'builtin:feishu',
        config: { app_id: 'app-flow-secondary', app_secret: 'secret-flow-secondary' },
      },
      error: /each provider may appear at most once per dispatcher/,
    },
    {
      name: 'duplicate channel ids within a dispatcher',
      channel: {
        id: 'primary',
        provider: 'builtin:feishu',
        config: { app_id: 'app-flow-2', app_secret: 'secret-flow-2' },
      },
      error: /channel ids must be unique per dispatcher/,
    },
  ]) {
    it(`rejects ${testCase.name}`, async () => {
      const fileObject = testSingleDispatcherFileObject({ id: 'flow' });
      const dispatcher = (fileObject['dispatchers'] as Record<string, unknown>[])[0]!;
      (dispatcher['channels'] as unknown[]).push(testCase.channel);
      writeConfigObject(fileObject);
      await expect(loadConfig({ configDir })).rejects.toThrow(testCase.error);
    });
  }
  it('rejects unknown channel config fields via the channel provider', async () => {
    writeConfigObject(
      testSingleDispatcherFileObject({
        id: 'flow',
        feishu: {
          app_id: 'app-flow',
          app_secret: 'secret-flow',
          callback_secret: 'future-only',
        } as never,
      }),
    );
    await expect(loadConfig({ configDir })).rejects.toThrow(
      /feishu channel config has unknown key\(s\): 'callback_secret'/,
    );
  });
  it('keeps access out of config and validates agent extra_env fields', async () => {
    const withAccess = testSingleDispatcherFileObject({ id: 'flow' });
    (withAccess['dispatchers'] as Record<string, unknown>[])[0]!['access'] = {};
    writeConfigObject(withAccess);
    await expect(loadConfig({ configDir })).rejects.toThrow(
      /access is not supported/,
    );
    writeConfigObject(
      testSingleDispatcherFileObject({
        id: 'flow',
        codex: {
          extra_env: {
            EXAMPLE_FLAG: 1,
          },
        },
      }),
    );
    await expect(loadConfig({ configDir })).rejects.toThrow(
      /agents\[0\]\.config\.extra_env\.EXAMPLE_FLAG must be a string/,
    );
  });
  it('rejects dispatcher ids that would not be stable path segments', async () => {
    writeConfigObject(
      testConfigFileObject({
        agents: [{ id: 'flow', provider: 'builtin:codex', config: {} }],
        dispatchers: [
          {
            id: 'team/alpha beta',
            agentRuntime: 'flow',
            feishu: { app_id: 'app-flow', app_secret: 'secret-flow' },
          },
        ],
      }),
    );
    await expect(loadConfig({ configDir })).rejects.toThrow(/dispatchers\[0\]\.id/);
    await expect(loadConfig({ configDir })).rejects.toThrow(/ASCII letters/);
  });
  for (const [name, feishu, error] of [
    ['app_id', { app_id: '', app_secret: 'secret-flow' }, /feishu channel config requires a non-empty app_id/],
    ['app_secret', { app_id: 'app-flow', app_secret: '   ' }, /feishu channel config requires a non-empty app_secret/],
  ] as const) {
    it(`requires non-empty Feishu ${name}`, async () => {
      writeConfigObject(testSingleDispatcherFileObject({
        id: 'flow',
        feishu,
      }));
      await expect(loadConfig({ configDir })).rejects.toThrow(error);
    });
  }
  it('expandHome expands ~/ and bare ~', async () => {
    expect(expandHome('~/x')).toMatch(/[/\\]x$/);
    expect(expandHome('~/x').startsWith('/')).toBe(true);
    expect(expandHome('~')).not.toContain('~');
    expect(expandHome('/abs/path')).toBe('/abs/path');
  });
  it('DREAMUX_CONFIG_DIR overrides ~/.dreamux when no explicit override', async () => {
    process.env['DREAMUX_CONFIG_DIR'] = configDir;
    expect(globalConfigDir()).toBe(configDir);
    expect(globalConfigFile()).toBe(join(configDir, 'config.json'));
  });
  it('first-boot file is mode 0600', async () => {
    const { configFile, createdOnThisBoot } = await loadOrInitConfig({ configDir });
    expect(createdOnThisBoot).toBe(true);
    const mode = statSync(configFile).mode & 0o777;
    expect(mode).toBe(0o600);
  });
  it('rejects existing config files that are not mode 0600', async () => {
    if (process.platform === 'win32') return;
    const file = globalConfigFile({ configDir });
    writeConfigText(file, JSON.stringify(BUILT_IN_DEFAULTS), 0o644);
    await expect(loadConfig({ configDir })).rejects.toThrow(/must be mode 0600/);
  });
  it('throws when the config dir cannot be written', async () => {
    if (process.getuid?.() === 0) return;
    const lockedParent = mkdtempSync(join(tmpdir(), 'dreamux-locked-'));
    const lockedChild = join(lockedParent, 'cfg');
    chmodSync(lockedParent, 0o500);
    try {
      await expect(loadOrInitConfig({ configDir: lockedChild })).rejects.toThrow(
        /EACCES|EPERM|permission/i,
      );
    } finally {
      chmodSync(lockedParent, 0o700);
      rmSync(lockedParent, { recursive: true, force: true });
    }
  });
});
describe('runtime path precedence', () => {
  let configDir: string;
  const envSnapshot: Record<string, string | undefined> = {};
  beforeEach(() => {
    configDir = mkdtempSync(join(tmpdir(), 'dreamux-prec-'));
    for (const k of [
      'CODEX_HOST_RUNTIME_DIR',
      'CODEX_HOST_ADMIN_SOCKET',
      'CODEX_HOST_CODEX_BIN',
    ]) {
      envSnapshot[k] = process.env[k];
      delete process.env[k];
    }
  });
  afterEach(() => {
    for (const [k, v] of Object.entries(envSnapshot)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    rmSync(configDir, { recursive: true, force: true });
    resetRuntimeConfig();
  });
  it('adminSocketPath is fixed under runRoot', async () => {
    writeConfigObjectAt(configDir, {});
    const { config } = await loadOrInitConfig({ configDir });
    setRuntimeConfig(config);
    process.env['CODEX_HOST_ADMIN_SOCKET'] = '/tmp/env-admin.sock';
    expect(adminSocketPath()).toBe(join(runRoot(), 'admin.sock'));
  });
  it('parseCodexArgs: per-dispatcher overrides config defaults', async () => {
    const parsed = parseCodexArgs(
      JSON.stringify({ approvalPolicy: 'on-failure' }),
      { approvalPolicy: 'never', extraArgs: ['--model', 'gpt-5'] },
    );
    expect(parsed.approvalPolicy).toBe('on-failure');
    expect(parsed.extraArgs).toEqual(['--model', 'gpt-5']);
  });
  it('parseCodexArgs: per-dispatcher extraArgs append after config defaults', async () => {
    const parsed = parseCodexArgs(
      JSON.stringify({ extraArgs: ['--model', 'override'] }),
      { approvalPolicy: 'never', extraArgs: ['--model', 'default'] },
    );
    expect(parsed.extraArgs).toEqual([
      '--model',
      'default',
      '--model',
      'override',
    ]);
  });
  it('parseCodexArgs hard-fails on invalid policy or sandbox mode', async () => {
    expect(() =>
      parseCodexArgs(JSON.stringify({ approvalPolicy: 'untrusted-policy' })),
    ).toThrow(/refused/);
    expect(() =>
      parseCodexArgs(JSON.stringify({ sandboxMode: 'invalid-mode' })),
    ).toThrow(/sandboxMode='invalid-mode'/);
  });
});
describe('sandbox_mode precedence', () => {
  let configDir: string;
  beforeEach(() => {
    configDir = mkdtempSync(join(tmpdir(), 'dreamux-sandbox-'));
  });
  afterEach(() => {
    rmSync(configDir, { recursive: true, force: true });
    resetRuntimeConfig();
  });
  it('a dispatcher omitting sandbox_mode gets the workspace-write default', async () => {
    expect(DEFAULT_SANDBOX_MODE).toBe('workspace-write');
    writeConfigObjectAt(
      configDir,
      testSingleDispatcherFileObject({ id: 'flow', codex: {} }),
    );
    const { config } = await loadOrInitConfig({ configDir });
    expect(dispatcherCodexConfig(config.dispatchers[0]!).sandbox_mode).toBe(
      'workspace-write',
    );
  });
  it('an agent sandbox_mode is loaded and validated', async () => {
    writeConfigObjectAt(
      configDir,
      testSingleDispatcherFileObject({
        id: 'flow',
        codex: { sandbox_mode: 'danger-full-access' },
      }),
    );
    const { config } = await loadOrInitConfig({ configDir });
    expect(dispatcherCodexConfig(config.dispatchers[0]!).sandbox_mode).toBe(
      'danger-full-access',
    );
  });
  it('config rejects an invalid agent sandbox_mode at load time', async () => {
    writeConfigObjectAt(
      configDir,
      testSingleDispatcherFileObject({
        id: 'flow',
        codex: { sandbox_mode: 'not-a-mode' },
      }),
    );
    await expect(loadOrInitConfig({ configDir })).rejects.toThrow(
      /sandbox_mode='not-a-mode'/,
    );
  });
  it('parseCodexArgs: per-dispatcher sandboxMode overrides config default', async () => {
    const parsed = parseCodexArgs(
      JSON.stringify({ sandboxMode: 'read-only' }),
      { sandboxMode: 'danger-full-access' },
    );
    expect(parsed.sandboxMode).toBe('read-only');
  });
  it('codexArgsToCli emits `-c sandbox_mode=<value>` after approval_policy', async () => {
    const parsed = parseCodexArgs(
      JSON.stringify({
        approvalPolicy: 'never',
        sandboxMode: 'workspace-write',
      }),
    );
    const cli = codexArgsToCli(parsed);
    expect(cli).toContain('-c');
    expect(cli).toContain('approval_policy=never');
    expect(cli).toContain('sandbox_mode=workspace-write');
    expect(cli.indexOf('sandbox_mode=workspace-write')).toBeGreaterThan(
      cli.indexOf('approval_policy=never'),
    );
  });
});
