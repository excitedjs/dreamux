import { describe, expect, expectTypeOf, it, vi, afterEach } from 'vitest';
import codexFactory, * as codexApi from '@excitedjs/agent-runtime-codex';
import type {
  CodexAgentRuntimeProviderOptions,
  DispatcherCodexConfig,
} from '@excitedjs/agent-runtime-codex';
import claudeFactory, * as claudeApi from '@excitedjs/agent-runtime-claude-code';
import type { DispatcherClaudeCodeConfig } from '@excitedjs/agent-runtime-claude-code';
import feishuFactory, { createFeishuPlugin } from '@excitedjs/feishu-channel';
import type {
  AgentRuntimeProviderFactory,
  ChannelProviderFactory,
  DreamuxLogger,
} from '@excitedjs/dreamux-types';
import { ProviderRegistry } from '../src/registry/index.js';
import {
  ALWAYS_LOADED_PLUGIN_REFS,
  BUILTIN_PLUGIN_PACKAGES,
} from '../src/registry/builtins.js';
import { loadPlugins } from '../src/plugin/loader.js';
import { loadConfig } from '../src/config/load.js';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
const logger: DreamuxLogger = {
  error() {},
  warn() {},
  info() {},
  debug() {},
  trace() {},
  child() {
    return logger;
  },
};

describe('official package public entries', () => {
  it('Codex exposes exactly the reviewed public runtime names', () => {
    expect(Object.keys(codexApi).sort()).toEqual([
      'ALLOWED_SANDBOX_MODES',
      'DEFAULT_CODEX_BIN',
      'DEFAULT_INITIALIZE_TIMEOUT_MS',
      'DEFAULT_SANDBOX_MODE',
      'createCodexAgentRuntimeProvider',
      'createCodexPlugin',
      'default',
      'defaultDispatcherCodexConfig',
      'readDispatcherCodexConfig',
    ]);
    expectTypeOf<
      ReturnType<typeof codexApi.defaultDispatcherCodexConfig>
    >().toEqualTypeOf<DispatcherCodexConfig>();
    expectTypeOf<
      Parameters<typeof codexApi.createCodexAgentRuntimeProvider>[0]
    >().toEqualTypeOf<CodexAgentRuntimeProviderOptions | undefined>();
  });
  it('Claude Code exposes exactly the reviewed public runtime names', () => {
    expect(Object.keys(claudeApi).sort()).toEqual([
      'ALLOWED_CLAUDE_CODE_PERMISSION_MODES',
      'DEFAULT_CLAUDE_CODE_BIN',
      'DEFAULT_CLAUDE_CODE_TURN_TIMEOUT_MS',
      'createClaudeCodeAgentRuntimeProvider',
      'createClaudeCodePlugin',
      'default',
      'defaultDispatcherClaudeCodeConfig',
      'readDispatcherClaudeCodeConfig',
    ]);
    expectTypeOf<
      ReturnType<typeof claudeApi.defaultDispatcherClaudeCodeConfig>
    >().toEqualTypeOf<DispatcherClaudeCodeConfig>();
  });
  it('root defaults are neutral context-taking provider factories and named plugins remain available', async () => {
    const runtimeFactories: AgentRuntimeProviderFactory<unknown>[] = [
      codexFactory,
      claudeFactory,
    ];
    const channelFactory: ChannelProviderFactory<unknown> = feishuFactory;
    for (const factory of runtimeFactories) {
      expect(await factory({ ref: 'npm:fixture' })).toMatchObject({
        createRuntime: expect.any(Function),
        readRecentActivity: expect.any(Function),
      });
    }
    expect(await channelFactory({ ref: 'npm:fixture' })).toMatchObject({
      createSession: expect.any(Function),
    });
    expect(
      [
        codexApi.createCodexPlugin(),
        claudeApi.createClaudeCodePlugin(),
        createFeishuPlugin(),
      ].map((p) => p.name),
    ).toEqual(['codex', 'claude-code', 'feishu']);
  });
  it('loads configured unqualified official npm providers alongside always-loaded plugins', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'official-providers-'));
    try {
      vi.stubEnv('DREAMUX_ROOT', dir);
      const path = join(dir, 'config.json');
      await writeFile(
        path,
        JSON.stringify({
          agents: [
            {
              id: 'codex',
              provider: 'npm:@excitedjs/agent-runtime-codex',
              config: {},
            },
            {
              id: 'claude',
              provider: 'npm:@excitedjs/agent-runtime-claude-code',
              config: {},
            },
          ],
          dispatchers: [
            {
              id: 'test',
              cwd: dir,
              agentRuntime: 'codex',
              channels: [
                {
                  id: 'chat',
                  provider: 'npm:@excitedjs/feishu-channel',
                  config: { app_id: 'test-app', app_secret: 'test-secret' },
                },
              ],
            },
          ],
        }),
        { mode: 0o600 },
      );
      const loaded = await loadConfig();
      expect(loaded.config.dispatchers[0]?.channels[0]?.provider).toBe(
        'npm:@excitedjs/feishu-channel',
      );
      expect(loaded.config.agents['codex']?.provider).toBe(
        'npm:@excitedjs/agent-runtime-codex',
      );
      expect(loaded.config.agents['claude']?.provider).toBe(
        'npm:@excitedjs/agent-runtime-claude-code',
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
  it('loads builtin named plugin entries and preserves duplicate-name refusal', async () => {
    expect(
      (
        await loadPlugins({
          registry: new ProviderRegistry(),
          entries: [],
          logger,
        })
      ).map((p) => p.name),
    ).toEqual(['feishu', 'codex', 'claude-code']);
    await expect(
      loadPlugins({
        registry: new ProviderRegistry(),
        logger,
        entries: [
          { ref: 'npm:@excitedjs/agent-runtime-codex#createCodexPlugin' },
        ],
      }),
    ).rejects.toThrow(/declared by both/);
  });
  it('resolves exactly the shipped builtin plugin catalog through the real loader', async () => {
    const plugins = await loadPlugins({
      registry: new ProviderRegistry(),
      logger,
      entries: Object.keys(BUILTIN_PLUGIN_PACKAGES)
        .map((id) => `builtin:${id}`)
        .filter((ref) => !ALWAYS_LOADED_PLUGIN_REFS.includes(ref))
        .map((ref) => ({ ref })),
    });
    expect(plugins.map((plugin) => plugin.name)).toEqual([
      'feishu',
      'codex',
      'claude-code',
      'bootstrap',
    ]);
  });
});

afterEach(() => vi.unstubAllEnvs());

// The installed package must actually ship every default provider; source imports alone do not prove packaging.
it('a default @excitedjs/dreamux install bundles the built-in provider packages', async () => {
  const manifest = JSON.parse(
    await readFile(new URL('../package.json', import.meta.url), 'utf8'),
  );
  for (const name of [
    '@excitedjs/agent-runtime-codex',
    '@excitedjs/agent-runtime-claude-code',
    '@excitedjs/feishu-channel',
  ]) {
    expect(manifest.dependencies[name]).toBe('workspace:*');
  }
});
