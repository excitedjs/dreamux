import type { AgentRuntimeCreateContext } from '@excitedjs/dreamux-types';
import { isUnsupportedFeatureError } from '@excitedjs/dreamux-utils';
import { describe, expect, it } from 'vitest';

import { defaultAntigravityConfig } from '../src/config.js';
import providerFactory, {
  createAntigravityAgentRuntimeProvider,
} from '../src/index.js';

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
});
