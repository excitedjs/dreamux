import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type {
  AgentRuntimeCreateContext,
  DreamuxLogger,
} from '@excitedjs/dreamux-types';
import { isUnsupportedFeatureError } from '@excitedjs/dreamux-utils';
import { describe, expect, it } from 'vitest';

import { defaultAntigravityConfig } from '../src/config.js';
import providerFactory, {
  createAntigravityAgentRuntimeProvider,
} from '../src/index.js';
import { antigravityRuntimeKey } from '../src/runtime-options.js';

const logger: DreamuxLogger = {
  info() {},
  warn() {},
  error() {},
  debug() {},
  trace() {},
  child: () => logger,
};

describe('Antigravity provider', () => {
  it('exports the neutral provider factory and config reader', async () => {
    const provider = await providerFactory({ ref: 'npm:test' });
    expect(provider).toBeDefined();
    expect(
      provider.config?.read(
        {},
        {
          providerRef: 'npm:test',
          agentId: 'agent',
          file: 'config.json',
          prefix: '',
        },
      ),
    ).toEqual(defaultAntigravityConfig());
    expect(createAntigravityAgentRuntimeProvider).toBeTypeOf('function');
  });

  it('rejects structured output before launching either transport', async () => {
    const provider = createAntigravityAgentRuntimeProvider();
    const context = {
      config: defaultAntigravityConfig(),
      outputSchema: { type: 'object' },
    } as unknown as AgentRuntimeCreateContext<
      ReturnType<typeof defaultAntigravityConfig>
    >;
    await expect(provider.createRuntime(context)).rejects.toSatisfy((error) =>
      isUnsupportedFeatureError(error, 'outputSchema'),
    );
  });

  it('rejects prompt replacement on the append-only ACP protocol', async () => {
    const provider = createAntigravityAgentRuntimeProvider();
    const context = {
      config: { ...defaultAntigravityConfig(), transport: 'acp' },
      systemPrompt: { replace: 'replacement' },
    } as unknown as AgentRuntimeCreateContext<
      ReturnType<typeof defaultAntigravityConfig>
    >;
    await expect(provider.createRuntime(context)).rejects.toSatisfy((error) =>
      isUnsupportedFeatureError(error, 'systemPrompt.replace'),
    );
  });

  it.each(['acp', 'tmux'] as const)(
    'accepts alternate replacement and append representations for %s',
    async (transport) => {
      const root = await mkdtemp(join(tmpdir(), 'antigravity-provider-'));
      try {
        const provider = createAntigravityAgentRuntimeProvider();
        const context: AgentRuntimeCreateContext<
          ReturnType<typeof defaultAntigravityConfig>
        > = {
          identity: { runtimeId: 'provider-test', sessionId: null },
          config: { ...defaultAntigravityConfig(), transport },
          cwd: root,
          mcpServers: [],
          skillSources: [],
          disabledFeatures: [],
          systemPrompt: {
            replace: 'replacement-only text',
            append: ['append text'],
          },
          paths: {
            cacheDir: () => root,
            logsDir: () => root,
            runtimeSocketDirs: () => [],
          },
          state: { async publish() {} },
          events: () => undefined,
          logger,
        };
        await expect(provider.createRuntime(context)).resolves.toBeDefined();
        if (transport === 'tmux') {
          const file = join(
            root,
            'antigravity',
            'native-customizations',
            antigravityRuntimeKey(context),
            '.agents',
            'rules',
            'dreamux.md',
          );
          const text = await readFile(file, 'utf8');
          expect(text).toContain('append text');
          expect(text).not.toContain('replacement-only text');
        }
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );
});
