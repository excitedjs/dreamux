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
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  BUILT_IN_DEFAULTS,
  DEFAULT_APPROVAL_POLICY,
  DEFAULT_CONFIG_JSON,
  DEFAULT_SANDBOX_MODE,
  dispatcherCodexConfig,
  dispatcherFeishuConfig,
  expandHome,
  globalConfigDir,
  globalConfigFile,
  loadConfig,
  loadOrInitConfig,
  redactConfigForDisplay,
  stringifyConfig,
} from '../src/config/config.js';
import {
  loadConfigWithBuiltins,
  loadOrInitConfigWithBuiltins,
} from '../src/agent-runtime/load-config.js';
import {
  adminSocketPath,
  resetRuntimeConfig,
  serverJsonPath,
  setRuntimeConfig,
  stateRoot,
} from '../src/platform/paths.js';
import { codexArgsToCli, parseCodexArgs } from '../src/agent-runtime/builtin/codex/args.js';
import {
  createBuiltinProviderRegistry,
  parseProviderRef,
} from '../src/registry/index.js';
import type {
  AgentRuntimeCapabilities,
  ExternalAgentRuntimeProviderFactory,
} from '../src/agent-runtime/index.js';
import {
  testDispatcherConfig,
  testConfigFileObject,
  testSingleDispatcherFileObject,
} from './helpers/config.js';

function writeConfigObjectAt(configDir: string, value: unknown): void {
  writeFileSync(globalConfigFile({ configDir }), JSON.stringify(value), {
    mode: 0o600,
  });
}

const EXTERNAL_RUNTIME_CAPABILITIES: AgentRuntimeCapabilities = {
  resume: { supported: true, checkpoint: 'externalSession' },
  steer: { supported: false },
  events: { kind: 'synthesized' },
  last: { supported: true },
  context: { supported: false },
  teammateCompletion: [],
};

const externalRuntimeFactory: ExternalAgentRuntimeProviderFactory = ({
  ref,
  descriptor,
}) => ({
  ref,
  descriptor,
  getCapabilities: () => EXTERNAL_RUNTIME_CAPABILITIES,
  readConfig(rawConfig) {
    return {
      ...rawConfig,
      parsed_by_provider: true,
    };
  },
  createRuntime() {
    throw new Error('external runtime config test does not create a runtime');
  },
});

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
    const c1 = (await loadConfigWithBuiltins({ configDir })).config;
    // load -> stringify -> load must be a fixed point: the in-memory config
    // serialised back to the file shape and reloaded yields the same config.
    writeConfigText(globalConfigFile({ configDir }), stringifyConfig(c1));
    const c2 = (await loadConfigWithBuiltins({ configDir })).config;
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
    // The default config is empty agents + dispatchers: there is no top-level
    // codex block, and no inline dispatcher runtime.
    expect(config).toEqual({ agents: {}, dispatchers: [] });
    expect(JSON.parse(readFileSync(configFile, 'utf8'))).not.toHaveProperty(
      'codex',
    );
    // First boot writes the on-disk file shape (agents[] array), which the
    // parser then accepts on the next boot.
    expect(JSON.parse(readFileSync(configFile, 'utf8'))).toEqual({
      agents: [],
      dispatchers: [],
    });
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

    const { config, createdOnThisBoot } = await loadOrInitConfigWithBuiltins({ configDir });
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
    await expect(loadOrInitConfigWithBuiltins({ configDir })).rejects.toThrow(
      /enabled must be a boolean/,
    );
  });

  it('rejects a leftover top-level codex block with migration guidance', async () => {
    writeConfigObject({
      codex: { approval_policy: 'never' },
      dispatchers: [],
    });
    await expect(loadOrInitConfig({ configDir })).rejects.toThrow(
      /top-level "codex" block is no longer supported/,
    );
    await expect(loadOrInitConfig({ configDir })).rejects.toThrow(
      /agents\[\] with provider "builtin:codex"/,
    );
  });

  it('rejects pre-providerized dispatcher config without rewriting it', async () => {
    const file = globalConfigFile({ configDir });
    const original = JSON.stringify({
      dispatchers: [
        {
          id: 'flow',
          feishu: { app_id: 'app-flow', app_secret: 'secret-flow' },
          codex: { approval_policy: 'never' },
        },
      ],
    });
    writeConfigText(file, original);

    await expect(loadConfig({ configDir })).rejects.toThrow(
      /feishu is not supported by the providerized config v2 schema/,
    );
    await expect(loadConfig({ configDir })).rejects.toThrow(/channels\[\]/);
    expect(readFileSync(file, 'utf8')).toBe(original);
  });

  // #98 fail-loud: the old inline-runtime shape and the new schema's broken
  // references each fail with rebuild guidance — no compat shim, no silent
  // migration.
  it('fails loud on the old inline dispatchers[].runtime shape with rebuild guidance', async () => {
    const file = globalConfigFile({ configDir });
    const original = JSON.stringify({
      agents: [],
      dispatchers: [
        {
          id: 'flow',
          channels: [
            {
              id: 'primary',
              provider: 'builtin:feishu',
              config: { app_id: 'app-flow', app_secret: 'secret-flow' },
            },
          ],
          runtime: {
            provider: 'builtin:codex',
            config: { approval_policy: 'never' },
          },
        },
      ],
    });
    writeConfigText(file, original);

    await expect(loadConfig({ configDir })).rejects.toThrow(
      /dispatchers\[0\]\.runtime is no longer supported/,
    );
    await expect(loadConfig({ configDir })).rejects.toThrow(/agentRuntime/);
    // No silent migration: the operator's file is untouched.
    expect(readFileSync(file, 'utf8')).toBe(original);
  });

  it('fails loud when a dispatcher is missing agentRuntime', async () => {
    writeConfigObject({
      agents: [{ id: 'codex', provider: 'builtin:codex', config: {} }],
      dispatchers: [
        {
          id: 'flow',
          channels: [
            {
              id: 'primary',
              provider: 'builtin:feishu',
              config: { app_id: 'app-flow', app_secret: 'secret-flow' },
            },
          ],
        },
      ],
    });

    await expect(loadConfigWithBuiltins({ configDir })).rejects.toThrow(
      /dispatchers\[0\]\.agentRuntime is required/,
    );
  });

  it('fails loud on a dangling agentRuntime reference', async () => {
    writeConfigObject(
      testConfigFileObject({
        agents: [{ id: 'codex', provider: 'builtin:codex', config: {} }],
        dispatchers: [{ id: 'flow', agentRuntime: 'does-not-exist' }],
      }),
    );

    await expect(loadConfigWithBuiltins({ configDir })).rejects.toThrow(
      /agentRuntime='does-not-exist' does not match any agents\[\]\.id/,
    );
    await expect(loadConfigWithBuiltins({ configDir })).rejects.toThrow(/Known agents: 'codex'/);
  });

  it('fails loud on a duplicate agents[].id', async () => {
    writeConfigObject(
      testConfigFileObject({
        agents: [
          { id: 'codex', provider: 'builtin:codex', config: {} },
          { id: 'codex', provider: 'builtin:codex', config: {} },
        ],
        dispatchers: [{ id: 'flow', agentRuntime: 'codex' }],
      }),
    );

    await expect(loadConfigWithBuiltins({ configDir })).rejects.toThrow(
      /agents\[1\]\.id duplicates agent 'codex'/,
    );
  });

  it('fails loud when top-level agents is not an array', async () => {
    writeConfigObject({
      agents: { codex: { provider: 'builtin:codex' } },
      dispatchers: [],
    });

    await expect(loadConfig({ configDir })).rejects.toThrow(
      /agents must be an array \(got object\)/,
    );
  });

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

    const { config } = await loadConfigWithBuiltins({ configDir });
    expect(Object.keys(config.agents)).toEqual(['shared-codex']);
    expect(dispatcherCodexConfig(config.dispatchers[0]!).sandbox_mode).toBe(
      'read-only',
    );
    expect(dispatcherCodexConfig(config.dispatchers[1]!).sandbox_mode).toBe(
      'read-only',
    );
    // Both dispatchers resolve to the same shared agent config.
    expect(config.dispatchers[0]?.runtime).toEqual(config.dispatchers[1]?.runtime);
  });

  it('resolves a claude teammate-style agent alongside a codex dispatcher agent', async () => {
    // The cross-provider case the normalization structurally fixes: a codex
    // dispatcher with a distinct claude agent both declared in agents[].
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

    const { config } = await loadConfigWithBuiltins({ configDir });
    expect(config.agents['codex']?.provider).toBe('builtin:codex');
    expect(config.agents['claude']?.provider).toBe('builtin:claude-code');
    expect(config.dispatchers[0]?.runtime.provider).toBe('builtin:codex');
  });

  it('one provider, two named agent configs resolve to different configs (#148)', async () => {
    // A single provider (builtin:codex) may have TWO named entries in agents[]
    // with different config blocks. Two dispatchers referencing each one must
    // land on independent resolved configs — not the same object.
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

    const { config } = await loadConfigWithBuiltins({ configDir });
    // Both agents map to the same provider …
    expect(config.agents['codex-safe']?.provider).toBe('builtin:codex');
    expect(config.agents['codex-yolo']?.provider).toBe('builtin:codex');
    // … but their resolved configs are different instances with distinct values.
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
    // Each dispatcher's runtime matches only its own named agent.
    expect(config.dispatchers[0]?.runtime).toEqual(config.agents['codex-safe']);
    expect(config.dispatchers[1]?.runtime).toEqual(config.agents['codex-yolo']);
  });

  it('rejects an invalid agent approval_policy', async () => {
    writeConfigObject(
      testSingleDispatcherFileObject({
        id: 'flow',
        codex: { approval_policy: 'ask-every-time' },
      }),
    );
    await expect(loadOrInitConfigWithBuiltins({ configDir })).rejects.toThrow(
      /agents\[0\]\.config\.approval_policy='ask-every-time'/,
    );
  });

  it('defaults agent config.bin and initialize_timeout_ms', async () => {
    writeConfigObject(
      testSingleDispatcherFileObject({ id: 'flow', codex: {} }),
    );
    const { config } = await loadConfigWithBuiltins({ configDir });
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
    const { config } = await loadConfigWithBuiltins({ configDir });
    const codex = dispatcherCodexConfig(config.dispatchers[0]!);
    expect(codex.bin).toBe('/opt/custom-codex');
    expect(codex.initialize_timeout_ms).toBe(30000);
  });

  it('rejects an empty agent config.bin', async () => {
    writeConfigObject(
      testSingleDispatcherFileObject({
        id: 'flow',
        codex: { bin: '   ' },
      }),
    );
    await expect(loadConfigWithBuiltins({ configDir })).rejects.toThrow(
      /agents\[0\]\.config\.bin must be a non-empty string/,
    );
  });

  it('rejects a non-positive agent config.initialize_timeout_ms', async () => {
    writeConfigObject(
      testSingleDispatcherFileObject({
        id: 'flow',
        codex: { initialize_timeout_ms: 0 },
      }),
    );
    await expect(loadConfigWithBuiltins({ configDir })).rejects.toThrow(
      /agents\[0\]\.config\.initialize_timeout_ms must be > 0/,
    );
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

    const { config } = await loadConfigWithBuiltins({ configDir });
    const firstFeishu = dispatcherFeishuConfig(config.dispatchers[0]!);
    const firstCodex = dispatcherCodexConfig(config.dispatchers[0]!);
    expect(config.dispatchers[0]).toMatchObject({
      id: 'dispatcher-a',
      enabled: true,
      channels: [{ provider: 'builtin:feishu' }],
      runtime: { provider: 'builtin:codex' },
    });
    expect(firstFeishu).toEqual({
      app_id: 'app-a',
      app_secret: 'secret-a',
    });
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
    expect(dispatcherFeishuConfig(config.dispatchers[1]!)).toEqual({
      app_id: 'app-b',
      app_secret: 'secret-b',
    });
  });

  it('rejects reserved npm channel refs without loading them', async () => {
    writeConfigObject(
      testSingleDispatcherFileObject({
        id: 'flow',
        channelProvider: 'npm:@example/dreamux-channel#provider',
      }),
    );

    await expect(loadConfigWithBuiltins({ configDir })).rejects.toThrow(
      /not a built-in Dreamux channel/,
    );
  });

  it('rejects unknown builtin channel refs', async () => {
    writeConfigObject(
      testSingleDispatcherFileObject({
        id: 'flow',
        channelProvider: 'builtin:matrix',
      }),
    );

    await expect(loadConfigWithBuiltins({ configDir })).rejects.toThrow(
      /not a built-in Dreamux channel/,
    );
  });

  it('rejects runtime provider refs in channel config', async () => {
    writeConfigObject(
      testSingleDispatcherFileObject({
        id: 'flow',
        channelProvider: 'builtin:codex',
      }),
    );

    await expect(loadConfigWithBuiltins({ configDir })).rejects.toThrow(
      /not a built-in Dreamux channel/,
    );
  });

  it('validates config provider refs through the injected provider registry', async () => {
    const registry = createBuiltinProviderRegistry();
    registry.register({
      id: 'custom-runtime',
      kind: 'agentRuntime',
      ref: parseProviderRef('builtin:custom-runtime'),
    });
    writeConfigObject(
      testConfigFileObject({
        agents: [
          { id: 'flow', provider: 'builtin:custom-runtime', config: {} },
        ],
        dispatchers: [{ id: 'flow', agentRuntime: 'flow' }],
      }),
    );

    await expect(loadConfig({ configDir, providerRegistry: registry })).rejects.toThrow(
      /registered but not runnable/,
    );
    await expect(loadConfig({ configDir })).rejects.toThrow(
      /unknown builtin provider 'custom-runtime'/,
    );
  });

  it('loads external npm runtime providers before validating runtime config', async () => {
    const providerRef = 'npm:@example/dreamux-runtime#provider';
    writeConfigObject(
      testConfigFileObject({
        agents: [
          { id: 'flow', provider: providerRef, config: { provider_option: 'kept' } },
        ],
        dispatchers: [{ id: 'flow', agentRuntime: 'flow' }],
      }),
    );

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
    });
    expect(config.dispatchers[0]?.runtime).toEqual({
      provider: providerRef,
      config: {
        provider_option: 'kept',
        parsed_by_provider: true,
      },
    });
    expect(providerRegistry.resolve(providerRef).kind).toBe('agentRuntime');
    expect(providerRegistry.getImplementation(providerRef)).not.toBeUndefined();
  });

  it('fails loudly when an external npm runtime package cannot be imported', async () => {
    writeConfigObject(
      testConfigFileObject({
        agents: [
          { id: 'flow', provider: 'npm:@example/missing-runtime', config: {} },
        ],
        dispatchers: [{ id: 'flow', agentRuntime: 'flow' }],
      }),
    );

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

    const { config } = await loadConfigWithBuiltins({ configDir });
    expect(config.agents['flow']?.provider).toBe('builtin:claude-code');
    expect(config.dispatchers[0]?.runtime.provider).toBe('builtin:claude-code');
    expect(config.dispatchers[0]?.runtime.config).toMatchObject({
      remote_control: true,
    });
  });

  it('rejects non-boolean remote_control under a claude-code agent config', async () => {
    writeConfigObject(
      testConfigFileObject({
        agents: [
          {
            id: 'flow',
            provider: 'builtin:claude-code',
            config: { bin: 'claude', remote_control: 'yes' },
          },
        ],
        dispatchers: [{ id: 'flow', agentRuntime: 'flow' }],
      }),
    );

    await expect(loadConfigWithBuiltins({ configDir })).rejects.toThrow(
      /remote_control must be a boolean/,
    );
  });

  it('rejects codex-only keys under a claude-code agent config (runtime-owned validation)', async () => {
    writeConfigObject(
      testConfigFileObject({
        agents: [
          {
            id: 'flow',
            provider: 'builtin:claude-code',
            // approval_policy is a Codex-only field; the Claude Code runtime
            // owns its own schema and must reject it rather than ignore it.
            config: { bin: 'claude', approval_policy: 'never' },
          },
        ],
        dispatchers: [{ id: 'flow', agentRuntime: 'flow' }],
      }),
    );

    await expect(loadConfigWithBuiltins({ configDir })).rejects.toThrow(
      /approval_policy is not supported/,
    );
  });

  it('rejects multiple channels while Phase 1 wires one channel per dispatcher', async () => {
    const fileObject = testSingleDispatcherFileObject({ id: 'flow' });
    const dispatcher = (fileObject['dispatchers'] as Record<string, unknown>[])[0]!;
    (dispatcher['channels'] as unknown[]).push({
      id: 'secondary',
      provider: 'builtin:feishu',
      config: {
        app_id: 'app-flow-secondary',
        app_secret: 'secret-flow-secondary',
      },
    });
    writeConfigObject(fileObject);

    await expect(loadConfigWithBuiltins({ configDir })).rejects.toThrow(
      /must contain exactly one channel in this phase/,
    );
  });

  it('rejects unsupported dispatcher secret fields', async () => {
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

    await expect(loadConfigWithBuiltins({ configDir })).rejects.toThrow(
      /callback_secret is not supported/,
    );
  });

  it('keeps access out of config and validates agent extra_env fields', async () => {
    const withAccess = testSingleDispatcherFileObject({ id: 'flow' });
    (withAccess['dispatchers'] as Record<string, unknown>[])[0]!['access'] = {};
    writeConfigObject(withAccess);
    await expect(loadConfigWithBuiltins({ configDir })).rejects.toThrow(
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
    await expect(loadConfigWithBuiltins({ configDir })).rejects.toThrow(
      /agents\[0\]\.config\.extra_env\.EXAMPLE_FLAG must be a string/,
    );
  });

  it('requires unique Feishu app_id values across all dispatchers', async () => {
    writeConfigObject(
      testConfigFileObject({
        agents: [
          { id: 'flow', provider: 'builtin:codex', config: {} },
          { id: 'docs', provider: 'builtin:codex', config: {} },
        ],
        dispatchers: [
          {
            id: 'flow',
            enabled: false,
            agentRuntime: 'flow',
            feishu: { app_id: 'app-shared', app_secret: 'secret-flow' },
          },
          {
            id: 'docs',
            agentRuntime: 'docs',
            feishu: { app_id: 'app-shared', app_secret: 'secret-docs' },
          },
        ],
      }),
    );

    await expect(loadConfigWithBuiltins({ configDir })).rejects.toThrow(
      /duplicates dispatcher 'flow'/,
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

    await expect(loadConfigWithBuiltins({ configDir })).rejects.toThrow(/dispatchers\[0\]\.id/);
    await expect(loadConfigWithBuiltins({ configDir })).rejects.toThrow(/ASCII letters/);
  });

  it('requires non-empty Feishu app_id and app_secret values', async () => {
    writeConfigObject(
      testSingleDispatcherFileObject({
        id: 'flow',
        feishu: {
          app_id: '',
          app_secret: 'secret-flow',
        },
      }),
    );
    await expect(loadConfigWithBuiltins({ configDir })).rejects.toThrow(
      /app_id must be a non-empty string/,
    );

    writeConfigObject(
      testSingleDispatcherFileObject({
        id: 'flow',
        feishu: {
          app_id: 'app-flow',
          app_secret: '   ',
        },
      }),
    );
    await expect(loadConfigWithBuiltins({ configDir })).rejects.toThrow(
      /app_secret must be a non-empty string/,
    );
  });

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

  it('adminSocketPath is fixed under stateRoot', async () => {
    writeConfigObjectAt(configDir, {});
    const { config } = await loadOrInitConfig({ configDir });
    setRuntimeConfig(config);
    process.env['CODEX_HOST_ADMIN_SOCKET'] = '/tmp/env-admin.sock';
    expect(adminSocketPath()).toBe(join(stateRoot(), 'admin.sock'));
    expect(serverJsonPath()).toBe(join(stateRoot(), 'server.json'));
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
    const { config } = await loadOrInitConfigWithBuiltins({ configDir });
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
    const { config } = await loadOrInitConfigWithBuiltins({ configDir });
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
    await expect(loadOrInitConfigWithBuiltins({ configDir })).rejects.toThrow(
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
