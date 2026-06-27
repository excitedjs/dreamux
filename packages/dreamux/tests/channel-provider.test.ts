import { describe, expect, it } from 'vitest';

import { createFeishuChannelProvider, createFakeFeishuBot } from '@excitedjs/feishu-channel';
import type {
  DreamuxLogger,
  SubscribeChannelProvider,
} from '@excitedjs/dreamux-types';
import { dispatcherDir } from '../src/platform/paths.js';
import {
  BUILTIN_FEISHU_PROVIDER_REF,
  createBuiltinProviderRegistry,
} from '../src/registry/index.js';

const log = ((): DreamuxLogger => {
  const noop = {
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    debug: () => undefined,
    trace: () => undefined,
    child: () => noop,
  };
  return noop as unknown as DreamuxLogger;
})();

// Build the REAL package Feishu session over a fake bot through the neutral
// provider seam — the same path production drives. The package's `botFactory`
// test option swaps the live Lark connection for the fake bot; egress flows
// through the real reply/react wire mapping.
function feishuSession() {
  const bot = createFakeFeishuBot('app-test');
  const provider = createFeishuChannelProvider({ botFactory: () => bot });
  const session = provider.createSession({
    dispatcher_id: 'flow',
    channel_id: 'primary',
    provider: BUILTIN_FEISHU_PROVIDER_REF,
    config: { appId: 'app-test', appSecret: 'secret-test' },
    logger: log,
    state_root: dispatcherDir('flow'),
  });
  return { bot, session };
}

describe('built-in Feishu channel', () => {
  it('handles reply MCP calls inside the channel module', async () => {
    const { bot, session } = feishuSession();
    const result = await session.handleTool!(
      {
        name: 'reply',
        arguments: {
          chat_id: 'chat-1',
          text: 'hello',
          message_id: 'msg-1',
          mention_user_ids: ['user-1'],
        },
      },
      { dispatcher_id: 'flow', channel_id: 'primary' },
    );

    expect(result).toEqual({
      status: 'ok',
      message: 'reply sent',
      message_ids: ['message-fake-1'],
    });
    expect(bot.sentMessages).toHaveLength(1);
    expect(bot.sentMessages[0]?.target).toMatchObject({
      chatId: 'chat-1',
      replyToMessageId: 'msg-1',
      mentionUserIds: ['user-1'],
    });
    expect(bot.sentMessages[0]?.text).toBe('hello');
  });

  it('handles react MCP calls inside the channel module', async () => {
    const { bot, session } = feishuSession();
    const result = await session.handleTool!(
      { name: 'react', arguments: { message_id: 'msg-1', emoji: 'OK' } },
      { dispatcher_id: 'flow', channel_id: 'primary' },
    );

    expect(result).toEqual({
      status: 'ok',
      message: 'reaction added',
      reaction_id: 'reaction-fake-1',
    });
    expect(bot.reactions).toEqual([
      { messageId: 'msg-1', emoji: 'OK', reactionId: 'reaction-fake-1' },
    ]);
  });
});

describe('subscription channel plugin interface', () => {
  it('registers only the built-in feishu channel; subscription plugins stay interface-only', () => {
    // Since the multi-channel config slice (#209) the built-in feishu channel IS
    // a registry descriptor (kind `channel`); it is the only builtin channel.
    // Subscription-style channel plugins (github/jira) remain interface-only —
    // no builtin subscription channel descriptor is registered.
    const registry = createBuiltinProviderRegistry();
    expect(registry.listByKind('channel').map((d) => d.id)).toEqual(['feishu']);
    expect(registry.resolve('builtin:feishu').kind).toBe('channel');
  });

  it('reserves the shape future subscription plugins must implement', () => {
    const plugin: SubscribeChannelProvider = {
      ref: 'builtin:example-subscription',
      descriptor: {
        id: 'example-subscription',
        kind: 'subscribeChannel',
        ref: {
          source: 'builtin',
          id: 'example-subscription',
          raw: 'builtin:example-subscription',
        },
      },
      createSession: () => ({
        provider: 'builtin:example-subscription',
        subscription_id: 'issues',
        start: async ({ publish }) => {
          await publish({ id: 'event-1', text: 'subscribed event' });
        },
        close: async () => undefined,
        mcpServerDescriptors: () => [],
      }),
    };
    expect(plugin.ref).toBe('builtin:example-subscription');
  });
});
