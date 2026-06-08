import { describe, expect, it } from 'vitest';

import {
  FeishuChannelSession,
} from '../src/channel/feishu/feishu-channel.js';
import { feishuMcpServerDescriptor } from '../src/channel/feishu/feishu-mcp-surface.js';
import type {
  SubscriptionChannelPlugin,
} from '../src/channel/plugin.js';
import { createFakeFeishuBot } from '../src/channel/feishu/bot.js';
import { DispatcherStore } from '../src/state/dispatcher-store.js';
import { createBuiltinProviderRegistry } from '../src/registry/index.js';
import { testDreamuxConfig } from './helpers/config.js';

const log = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: () => log,
};

function feishuSession() {
  const config = testDreamuxConfig();
  const store = new DispatcherStore(config);
  const row = store.get('flow');
  expect(row).not.toBeNull();
  const bot = createFakeFeishuBot('app-test');
  return {
    bot,
    session: new FeishuChannelSession({
      dispatcherId: 'flow',
      row: row!,
      config,
      adminSocketPath: '/tmp/admin.sock',
      log,
      skipBotSecret: true,
      botFactory: () => bot,
    }),
  };
}

describe('built-in Feishu channel', () => {
  it('contributes its own MCP descriptor', () => {
    const { session } = feishuSession();
    expect(session.mcpServerDescriptors()).toEqual([
      feishuMcpServerDescriptor({
        dispatcherId: 'flow',
        adminSocketPath: '/tmp/admin.sock',
      }),
    ]);
  });

  it('handles reply MCP calls inside the channel module', async () => {
    const { bot, session } = feishuSession();
    const result = await session.handleMcpTool('reply', {
      chat_id: 'chat-1',
      text: 'hello',
      message_id: 'msg-1',
      mention_user_ids: ['user-1'],
    });

    expect(result).toEqual({ message_ids: ['message-fake-1'] });
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
    const result = await session.handleMcpTool('react', {
      message_id: 'msg-1',
      emoji: 'OK',
    });

    expect(result).toEqual({ reaction_id: 'reaction-fake-1' });
    expect(bot.reactions).toEqual([
      { messageId: 'msg-1', emoji: 'OK', reactionId: 'reaction-fake-1' },
    ]);
  });
});

describe('subscription channel plugin interface', () => {
  it('is interface-only; no builtin subscription channel is registered', () => {
    const registry = createBuiltinProviderRegistry();
    expect(registry.listByKind('channel')).toEqual([]);
    expect(() => registry.resolve('builtin:feishu')).toThrow(
      /unknown builtin provider/,
    );
  });

  it('reserves the shape future subscription plugins must implement', () => {
    const plugin: SubscriptionChannelPlugin = {
      ref: 'builtin:example-subscription',
      descriptor: {
        id: 'example-subscription',
        kind: 'channel',
        ref: {
          source: 'builtin',
          id: 'example-subscription',
          raw: 'builtin:example-subscription',
        },
      },
      mcpServerDescriptors: () => [],
      start: async ({ publish }) => {
        await publish({ id: 'event-1', text: 'subscribed event' });
      },
      stop: async () => undefined,
    };
    expect(plugin.ref).toBe('builtin:example-subscription');
  });
});
