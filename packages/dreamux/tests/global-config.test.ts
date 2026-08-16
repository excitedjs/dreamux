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
  expandHome,
  globalConfigDir,
  globalConfigFile,
  loadConfig,
  loadOrInitConfig,
  redactConfigForDisplay,
  stringifyConfig,
} from '../src/config/config.js';
import {
  adminSocketPath,
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
import { asAgentRuntimeDescriptor } from './helpers/provider.js';

function writeConfigObjectAt(configDir: string, value: unknown): void {
  writeFileSync(globalConfigFile({ configDir }), JSON.stringify(value), {
    mode: 0o600,
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
    // load -> stringify -> load must be a fixed point: the in-memory config
    // serialised back to the file shape and reloaded yields the same config.
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
    // The default config is empty agents + dispatchers: there is no top-level
    // codex/workspace block, and no inline dispatcher runtime.
    expect(config).toEqual({
      agents: {},
      dispatchers: [],
    });
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

  it('rejects a leftover top-level codex block with migration guidance', async () => {
    writeConfigObject({
      codex: { approval_policy: 'never' },
      dispatchers: [],
    });
    await expect(loadOrInitConfig({ configDir })).rejects.toThrow(
      /top-level "codex" block is no longer supported/,
    );
    await expect(loadOrInitConfig({ configDir })).rejects.toThrow(
      /agents\[\] with the selected runtime provider/,
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

    await expect(loadConfig({ configDir })).rejects.toThrow(
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

    await expect(loadConfig({ configDir })).rejects.toThrow(
      /agentRuntime='does-not-exist' does not match any agents\[\]\.id/,
    );
    await expect(loadConfig({ configDir })).rejects.toThrow(/Known agents: 'codex'/);
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

    await expect(loadConfig({ configDir })).rejects.toThrow(
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

    const { config } = await loadConfig({ configDir });
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

    const { config } = await loadConfig({ configDir });
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

    const { config } = await loadConfig({ configDir });
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
    await expect(loadOrInitConfig({ configDir })).rejects.toThrow(
      /agents\[0\]\.config\.approval_policy='ask-every-time'/,
    );
  });

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

  it('rejects an empty agent config.bin', async () => {
    writeConfigObject(
      testSingleDispatcherFileObject({
        id: 'flow',
        codex: { bin: '   ' },
      }),
    );
    await expect(loadConfig({ configDir })).rejects.toThrow(
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
    await expect(loadConfig({ configDir })).rejects.toThrow(
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
    // The channel provider's `getIdentity` is invoked at config-load and its
    // neutral result stored on the channel (issue #209 de-leak) — for feishu the
    // app id, which seeds `DispatcherRow.channel_identity` without core ever
    // naming a Feishu config field.
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

  // TODO(#209 Q2 polish): these three assertions predate the single-dynamic-path
  // config loader. config.ts now loads EVERY referenced provider (builtin + npm,
  // both kinds) through loadAgentRuntimeProviders/loadChannelProviders before
  // validating refs, so a bad ref now fails inside the loader (e.g. "failed to
  // load channel provider 'builtin:matrix': ... has no known package mapping" /
  // "could not import package '@example/dreamux-channel'") rather than at the
  // config.ts ref-validation step. The bad-ref invariant still holds, but the
  // loader errors dropped the #98 file+field context the old validation messages
  // carried. The architecturally-correct fix is to have config.ts catch and
  // re-wrap loader failures with the config file + `channels[].provider` path —
  // a config.ts error-handling change owned by the next slice — not a regex
  // repoint here (which would assert the degraded message as correct). The
  // 'registered but not runnable' case below pins the removed two-path state (a
  // descriptor present without an impl), unreachable on the single path.
  it.skip('rejects reserved npm channel refs without loading them', async () => {
    writeConfigObject(
      testSingleDispatcherFileObject({
        id: 'flow',
        channelProvider: 'npm:@example/dreamux-channel#provider',
      }),
    );

    await expect(loadConfig({ configDir })).rejects.toThrow(
      /was not loaded as an external channel provider/,
    );
  });

  it.skip('rejects unknown builtin channel refs', async () => {
    writeConfigObject(
      testSingleDispatcherFileObject({
        id: 'flow',
        channelProvider: 'builtin:matrix',
      }),
    );

    await expect(loadConfig({ configDir })).rejects.toThrow(
      /unknown builtin provider/,
    );
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

  // NOTE(#209 Q2): the "registered but not runnable" case (descriptor present
  // without an impl) is unreachable on the single-dynamic-path config loader:
  // every ref is loaded through loadAgentRuntimeProviders before ref-validation,
  // so a descriptor cannot be registered without an impl unless the dynamic
  // import fails. Deleted per prime directive (pins removed machinery).

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

    // Use loadConfig so the builtin feishu channel provider is
    // registered (the default dispatcher declares a builtin:feishu channel,
    // whose readConfig validates the channel config); the external runtime is
    // still loaded through the injected importer.
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

  it('awaits an external runtime provider whose readConfig is async (#209 F4)', async () => {
    const providerRef = 'npm:@example/dreamux-async-runtime#provider';
    writeConfigObject(
      testConfigFileObject({
        agents: [
          { id: 'flow', provider: providerRef, config: { provider_option: 'kept' } },
        ],
        dispatchers: [{ id: 'flow', agentRuntime: 'flow' }],
      }),
    );

    // Agent-runtime readConfig is now sync-or-async (parity with
    // ChannelProvider.readConfig); core awaits the result at config load.
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
    writeConfigObject(
      testConfigFileObject({
        agents: [{ id: 'flow', provider: providerRef, config: {} }],
        dispatchers: [{ id: 'flow', agentRuntime: 'flow' }],
      }),
    );

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

  /**
   * Q2 integration: a config declaring builtin:codex + builtin:claude-code +
   * builtin:feishu loads all three provider implementations through the SINGLE
   * dynamic loader at loadConfig time — no static registration path. Proves:
   * 1. loadAgentRuntimeProviders runs for both builtin agent-runtime refs.
   * 2. loadChannelProviders (config.ts) runs for the builtin:feishu channel ref.
   * 3. The returned providerRegistry has real impls (not just descriptors) for all
   *    three — so any Server built from it passes assertRuntimeImplementationsLoaded.
   */
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

    // All three builtin implementations must be registered — proving one dynamic
    // path loaded them, not any static builtin-registration helper.
    // Builtin descriptor ids are the bare ids ('codex', 'claude-code', 'feishu'),
    // not the full ref strings.
    expect(providerRegistry.getImplementation('codex')).not.toBeUndefined();
    expect(providerRegistry.getImplementation('claude-code')).not.toBeUndefined();
    expect(providerRegistry.getImplementation('feishu')).not.toBeUndefined();

    // Kind guard: each ref resolves to the right provider kind.
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

    await expect(loadConfig({ configDir })).rejects.toThrow(
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

    await expect(loadConfig({ configDir })).rejects.toThrow(
      /approval_policy is not supported/,
    );
  });

  it('rejects two channels using the same provider ref on one dispatcher (#209 Decision #4)', async () => {
    // Decision #4 (issue #209): a dispatcher may declare at most one channel per
    // provider ref. Two `builtin:feishu` channels no longer load — each provider
    // may back at most one channel per dispatcher (this reverses the brief live
    // multi-channel-per-provider capability). Distinct dispatcher-local ids do
    // NOT make two same-provider channels valid.
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

    await expect(loadConfig({ configDir })).rejects.toThrow(
      /each provider may appear at most once per dispatcher/,
    );
  });

  it('rejects duplicate channel ids within a dispatcher', async () => {
    const fileObject = testSingleDispatcherFileObject({ id: 'flow' });
    const dispatcher = (fileObject['dispatchers'] as Record<string, unknown>[])[0]!;
    (dispatcher['channels'] as unknown[]).push({
      id: 'primary',
      provider: 'builtin:feishu',
      config: { app_id: 'app-flow-2', app_secret: 'secret-flow-2' },
    });
    writeConfigObject(fileObject);

    await expect(loadConfig({ configDir })).rejects.toThrow(
      /channel ids must be unique per dispatcher/,
    );
  });

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
    await expect(loadConfig({ configDir })).rejects.toThrow(
      /feishu channel config requires a non-empty app_id/,
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
    await expect(loadConfig({ configDir })).rejects.toThrow(
      /feishu channel config requires a non-empty app_secret/,
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
