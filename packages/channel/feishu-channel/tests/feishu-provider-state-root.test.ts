/**
 * The Feishu provider's state-root precondition.
 *
 * A Feishu session writes durable routing state — bindings, spaces, dispatcher
 * access — under the state root the host supplies. There is deliberately no
 * default: a session that fell back to the process working directory would put
 * durable state wherever the daemon happened to start, and the mistake would
 * only surface later as state that had vanished. So a missing or empty
 * `state_root` is refused at construction, loudly, rather than absorbed.
 */
import { describe, expect, it } from 'vitest';

import type { ChannelSessionCreateContext } from '@excitedjs/dreamux-types';

import { createFeishuChannelProvider } from '../src/provider.js';
import type { FeishuChannelConfig } from '../src/provider.js';

const CONFIG: FeishuChannelConfig = {
  appId: 'cli_test',
  appSecret: 'secret_test',
};

function createContext(
  overrides: Partial<ChannelSessionCreateContext<FeishuChannelConfig>>,
): ChannelSessionCreateContext<FeishuChannelConfig> {
  return {
    dispatcher_id: 'disp-1',
    channel_id: 'primary',
    config: CONFIG,
    ...overrides,
  } as ChannelSessionCreateContext<FeishuChannelConfig>;
}

describe('Feishu provider — state_root is required', () => {
  it('refuses to create a session when the host supplied no state_root', async () => {
    const provider = createFeishuChannelProvider();

    await expect(
      provider.createSession(createContext({})),
    ).rejects.toThrow(/requires an explicit state_root/);
  });

  it('refuses an empty state_root rather than treating it as the current directory', async () => {
    const provider = createFeishuChannelProvider();

    await expect(
      provider.createSession(createContext({ state_root: '' })),
    ).rejects.toThrow(/must never fall back to the process working directory/);
  });
});
