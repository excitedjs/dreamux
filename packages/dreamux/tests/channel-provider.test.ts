import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  RECEIVED_REACTION_EMOJI,
  createFeishuChannelProvider,
  saveDispatcherAccess,
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

function inboundEvent(messageId: string) {
  return {
    messageId,
    chatId: 'chat-1',
    chatType: 'group',
    senderId: 'sender-1',
    senderType: 'user',
    senderName: 'Ada Sender',
    messageType: 'text',
    rawContent: JSON.stringify({ text: '<at id="fake-open-id-app-test"></at> hi' }),
    parsedText: '@bot hi',
    mentions: [
      {
        key: '@_user_1',
        id: { open_id: 'fake-open-id-app-test' },
        name: 'Bot',
      },
    ],
    createTime: '1782660000000',
    raw: {},
  };
}

async function assertNonSubmittedDeliveryClearsReceivedReaction(
  delivery:
    | { status: 'duplicate' }
    | { status: 'stopped' }
    | { status: 'failed'; error: Error },
): Promise<void> {
  const stateDir = mkdtempSync(join(tmpdir(), 'dreamux-feishu-ack-'));
  try {
    const bot = createFakeFeishuBot('app-test');
    const provider = createFeishuChannelProvider({ botFactory: () => bot });
    const session = provider.createSession({
      dispatcher_id: 'flow',
      channel_id: 'primary',
      provider: BUILTIN_FEISHU_PROVIDER_REF,
      config: { appId: 'app-test', appSecret: 'secret-test' },
      logger: log,
      state_root: stateDir,
    });
    await saveDispatcherAccess(stateDir, {
      version: 3,
      dm_policy: 'pairing',
      allow_users: ['sender-1'],
      group: { policy: 'follow-user', allow_chats: [], require_mention: true },
      pending: {},
      observed_chats: [],
      warnings: [],
      last_gate: { at: 0 },
    });
    await session.start({
      deliver: async () => delivery,
    });
    await bot.inject(inboundEvent(`msg-${delivery.status}`));

    expect(bot.reactions).toEqual([
      {
        messageId: `msg-${delivery.status}`,
        emoji: RECEIVED_REACTION_EMOJI,
        reactionId: 'reaction-fake-1',
      },
    ]);
    expect(bot.removedReactions).toEqual([
      { messageId: `msg-${delivery.status}`, reactionId: 'reaction-fake-1' },
    ]);
    expect(bot.reactionOps).toEqual([
      {
        op: 'add',
        messageId: `msg-${delivery.status}`,
        emoji: RECEIVED_REACTION_EMOJI,
        reactionId: 'reaction-fake-1',
      },
      { op: 'remove', messageId: `msg-${delivery.status}`, reactionId: 'reaction-fake-1' },
    ]);
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
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
      reaction_id: 'reaction-fake-1',
    });
    expect(bot.reactions).toEqual([
      { messageId: 'msg-1', emoji: 'OK', reactionId: 'reaction-fake-1' },
    ]);
  });

  it.each([
    [{ status: 'duplicate' } as const],
    [{ status: 'stopped' } as const],
    [{ status: 'failed', error: new Error('boom') } as const],
  ])('clears optimistic received reaction when delivery is %s', async (delivery) => {
    await assertNonSubmittedDeliveryClearsReceivedReaction(delivery);
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
