import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  createFeishuChannelProvider,
  defaultDispatcherAccessState,
  saveDispatcherAccess,
  type FeishuInboundEvent,
} from '@excitedjs/feishu-channel';
import type { DreamuxLogger } from '@excitedjs/dreamux-types';
import { dispatcherDir } from '../src/platform/paths.js';
import {
  BUILTIN_FEISHU_PROVIDER_REF,
  createBuiltinProviderRegistry,
} from '../src/registry/index.js';
import { createFakeFeishuBot } from './helpers/fake-feishu-bot.js';

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
function feishuSession(stateRoot = dispatcherDir('flow')) {
  const bot = createFakeFeishuBot('app-test');
  const provider = createFeishuChannelProvider({ botFactory: () => bot });
  const session = provider.createSession({
    dispatcher_id: 'flow',
    channel_id: 'primary',
    provider: BUILTIN_FEISHU_PROVIDER_REF,
    config: { appId: 'app-test', appSecret: 'secret-test' },
    logger: log,
    state_root: stateRoot,
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
      {
        dispatcher_id: 'flow',
        channel_id: 'primary',
        caller: { kind: 'dispatcher' },
      },
    );

    expect(result).toEqual({
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
      {
        dispatcher_id: 'flow',
        channel_id: 'primary',
        caller: { kind: 'dispatcher' },
      },
    );

    expect(result).toEqual({
      reaction_id: 'reaction-fake-1',
    });
    expect(bot.reactions).toEqual([
      { messageId: 'msg-1', emoji: 'OK', reactionId: 'reaction-fake-1' },
    ]);
  });

  it('keeps the model-facing react tool while automatic reactions stay absent', async () => {
    const stateRoot = mkdtempSync(join(tmpdir(), 'dreamux-channel-reaction-'));
    try {
      const access = defaultDispatcherAccessState();
      access.dm_policy = 'allowlist';
      access.allow_users = ['sender-test'];
      await saveDispatcherAccess(stateRoot, access);
      const { bot, session } = feishuSession(stateRoot);
      const delivered: string[] = [];
      try {
        await session.start({
          deliver: async (input) => {
            delivered.push(input.sourceId);
            return { status: 'submitted' };
          },
        });
        const inbound: FeishuInboundEvent = {
          messageId: 'message-inbound',
          chatId: 'chat-direct',
          chatType: 'p2p',
          senderId: 'sender-test',
          senderType: 'user',
          senderName: 'Ada',
          messageType: 'text',
          rawContent: JSON.stringify({ text: 'hello' }),
          parsedText: 'hello',
          mentions: [],
          createTime: '1710000000000',
          raw: {},
        };

        await bot.inject(inbound);

        expect(delivered).toEqual(['message-inbound']);
        expect(bot.reactions).toEqual([]);
        expect(bot.reactionOps).toEqual([]);
      } finally {
        await session.close();
      }
    } finally {
      rmSync(stateRoot, { recursive: true, force: true });
    }
  });
});

describe('provider registry', () => {
  it('registers only the built-in feishu channel provider', () => {
    // Since the multi-channel config slice (#209) the built-in feishu channel IS
    // a registry descriptor (kind `channel`); it is the only builtin channel.
    const registry = createBuiltinProviderRegistry();
    expect(registry.listByKind('channel').map((d) => d.id)).toEqual(['feishu']);
    expect(registry.resolve('builtin:feishu').kind).toBe('channel');
  });
});
