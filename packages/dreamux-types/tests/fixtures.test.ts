/**
 * Runtime assertion that the external-provider fixture (which imports
 * `@excitedjs/dreamux-types` only) behaves, proving the type package is enough
 * to author a provider against. Type-only imports compile away, so this also
 * confirms the package surface is consumable. The fixture's
 * `@excitedjs/dreamux-types`-only import discipline is checked in
 * `import-boundary.test.ts`.
 */
import { describe, it, expect } from 'vitest';

import {
  EXTERNAL_RUNTIME_CAPABILITIES,
  describeConfigContext,
  fixtureChannelProvider,
} from './fixtures/external-provider.js';

describe('external provider fixture', () => {
  it('declares neutral runtime capabilities', () => {
    expect(EXTERNAL_RUNTIME_CAPABILITIES.events.kind).toBe('synthesized');
    expect(EXTERNAL_RUNTIME_CAPABILITIES.teammateCompletion).toEqual([]);
  });

  it('formats a config-read context', () => {
    expect(
      describeConfigContext({
        providerRef: 'npm:@example/fixture',
        agentId: 'a1',
        file: 'config.json',
        prefix: 'agents[0]',
      }),
    ).toBe('npm:@example/fixture:a1');
  });

  it('resolves a channel target through the fixture session', async () => {
    const session = fixtureChannelProvider.createSession({
      dispatcher_id: 'd1',
      channel_id: 'fixture',
      provider: 'npm:@example/fixture-channel',
      config: {},
    });
    const target = await session.resolveTarget({ id: 'group-123' });
    expect(target).toEqual({
      target_type: 'group',
      target_key: 'group-123',
      bindable: true,
    });
  });
});
