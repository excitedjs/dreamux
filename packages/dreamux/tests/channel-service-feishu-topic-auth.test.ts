import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  saveDispatcherAccess,
  type FeishuInboundEvent,
} from '@excitedjs/feishu-channel';
import type { DreamuxLogger } from '@excitedjs/dreamux-types';

import { dispatcherDir, resetRuntimeConfig } from '../src/platform/paths.js';
import { ChannelService } from '../src/service/channel-service/index.js';
import { invokeDispatcherChannelTool } from '../src/service/dispatcher-service/channel-tool-invocation.js';
import { testDispatcherConfig, testDreamuxConfig } from './helpers/config.js';
import { feishuChannelCatalog } from './helpers/fake-channel.js';
import { createFakeFeishuBot } from './helpers/fake-feishu-bot.js';

function noopLog(): DreamuxLogger {
  const noop = () => undefined;
  return {
    trace: noop,
    debug: noop,
    info: noop,
    warn: noop,
    error: noop,
  };
}

function topicEvent(input: {
  messageId: string;
  threadId: string;
}): FeishuInboundEvent {
  return {
    messageId: input.messageId,
    chatId: 'chat-topic',
    chatType: 'group',
    threadId: input.threadId,
    senderId: 'sender-1',
    senderType: 'user',
    senderName: 'Ada',
    messageType: 'text',
    rawContent: JSON.stringify({ text: '@bot hello' }),
    parsedText: '@Bot hello',
    mentions: [
      {
        key: '@_user_1',
        id: { open_id: 'fake-open-id-app-auth' },
        name: 'Bot',
      },
    ],
    createTime: '1782660000000',
    raw: {},
  };
}

function teamProjection(teamName: string, leaderName: string) {
  return {
    team_name: teamName,
    leader_name: leaderName,
    leader_agent_runtime: 'test:runtime',
    runtime_cwd: `/tmp/${teamName}`,
  };
}

describe('ChannelService Feishu topic authorization', () => {
  let root: string;
  let previousHome: string | undefined;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'dreamux-feishu-topic-auth-'));
    previousHome = process.env['HOME'];
    process.env['HOME'] = join(root, 'home');
    process.env['DREAMUX_ROOT'] = join(root, 'dreamux');
    mkdirSync(process.env['HOME'], { recursive: true });
    resetRuntimeConfig();
  });

  afterEach(() => {
    if (previousHome === undefined) delete process.env['HOME'];
    else process.env['HOME'] = previousHome;
    delete process.env['DREAMUX_ROOT'];
    resetRuntimeConfig();
    rmSync(root, { recursive: true, force: true });
  });

  it('allows replies to the bound topic and rejects cross-topic or ambiguous selectors', async () => {
    const config = testDreamuxConfig([
      testDispatcherConfig({ id: 'flow' }),
    ]);
    const bot = createFakeFeishuBot('app-auth');
    bot.setChatMode('chat-topic', 'topic');
    const service = new ChannelService({
      dispatcherId: 'flow',
      config,
      channelProviders: feishuChannelCatalog(() => bot),
      channelLoggerFactory: () => noopLog(),
    });
    await saveDispatcherAccess(dispatcherDir('flow'), {
      version: 3,
      dm_policy: 'pairing',
      allow_users: ['sender-1'],
      group: { policy: 'follow-user', allow_chats: [], require_mention: true },
      pending: {},
      observed_chats: [],
      warnings: [],
      last_gate: { at: 0 },
    });
    const sessions = await service.build();
    service.adopt(sessions);
    for (const session of sessions.values()) {
      await session.start({
        deliver: async () => ({ status: 'submitted' }),
      });
    }

    try {
      await bot.inject(topicEvent({ messageId: 'msg-own', threadId: 'topic-a' }));
      await bot.inject(topicEvent({ messageId: 'msg-other', threadId: 'topic-b' }));
      const ownTarget = await service.resolveTarget({
        chat_id: 'chat-topic',
        message_id: 'msg-own',
      });
      const owner = {
        kind: 'team' as const,
        teamName: 'team-a',
        leaderName: 'leader-a',
      };
      await service.bindResolvedTarget({
        team: teamProjection(owner.teamName, owner.leaderName),
        channelId: 'primary',
        target: ownTarget,
      });

      await expect(invokeDispatcherChannelTool({
        channels: service,
        name: 'reply',
        arguments: {
          chat_id: 'chat-topic',
          message_id: 'msg-own',
          text: 'authorized reply',
        },
        caller: {
          kind: 'team_leader',
          teamId: owner.teamName,
          leaderName: owner.leaderName,
        },
      })).resolves.toEqual({ message_ids: ['message-fake-1'] });
      expect(bot.sentMessages).toMatchObject([
        {
          chatId: 'chat-topic',
          target: {
            chatId: 'chat-topic',
            replyToMessageId: 'msg-own',
          },
        },
      ]);

      const denied = [
        {
          chat_id: 'chat-topic',
          message_id: 'msg-other',
          text: 'cross-topic',
        },
        { chat_id: 'chat-topic', text: 'chat-only' },
        {
          chat_id: 'chat-topic',
          message_id: 'msg-unknown',
          text: 'unknown message',
        },
        {
          chat_id: 'chat-topic',
          thread_id: 'topic-a',
          text: 'topic without source message',
        },
        {
          chat_id: 'chat-wrong',
          message_id: 'msg-own',
          text: 'mismatched chat',
        },
        {
          chat_id: 'chat-topic',
          thread_id: 'topic-b',
          message_id: 'msg-own',
          text: 'mismatched topic',
        },
      ];
      for (const args of denied) {
        await expect(invokeDispatcherChannelTool({
          channels: service,
          name: 'reply',
          arguments: args,
          caller: {
            kind: 'team_leader',
            teamId: owner.teamName,
            leaderName: owner.leaderName,
          },
        })).rejects.toThrow(/TeamLeader/);
      }
      expect(bot.sentMessages).toHaveLength(1);
    } finally {
      await service.closeAll(noopLog());
    }
  });

  it('allows a group-bound TeamLeader to reply safely to observed topic messages', async () => {
    const config = testDreamuxConfig([
      testDispatcherConfig({ id: 'flow' }),
    ]);
    const bot = createFakeFeishuBot('app-auth');
    bot.setChatMode('chat-topic', 'topic');
    const service = new ChannelService({
      dispatcherId: 'flow',
      config,
      channelProviders: feishuChannelCatalog(() => bot),
      channelLoggerFactory: () => noopLog(),
    });
    await saveDispatcherAccess(dispatcherDir('flow'), {
      version: 3,
      dm_policy: 'pairing',
      allow_users: ['sender-1'],
      group: { policy: 'follow-user', allow_chats: [], require_mention: true },
      pending: {},
      observed_chats: [],
      warnings: [],
      last_gate: { at: 0 },
    });
    const sessions = await service.build();
    service.adopt(sessions);
    for (const session of sessions.values()) {
      await session.start({
        deliver: async () => ({ status: 'submitted' }),
      });
    }

    try {
      await bot.inject(topicEvent({ messageId: 'msg-topic-a', threadId: 'topic-a' }));
      await bot.inject(topicEvent({ messageId: 'msg-topic-b', threadId: 'topic-b' }));
      const groupTarget = await service.resolveTarget({
        chat_id: 'chat-topic',
      });
      const owner = {
        kind: 'team' as const,
        teamName: 'group-team',
        leaderName: 'group-leader',
      };
      await service.bindResolvedTarget({
        team: teamProjection(owner.teamName, owner.leaderName),
        channelId: 'primary',
        target: groupTarget,
      });

      for (const [index, messageId] of ['msg-topic-a', 'msg-topic-b'].entries()) {
        await expect(invokeDispatcherChannelTool({
          channels: service,
          name: 'reply',
          arguments: {
            chat_id: 'chat-topic',
            message_id: messageId,
            text: `reply to ${messageId}`,
          },
          caller: {
            kind: 'team_leader',
            teamId: owner.teamName,
            leaderName: owner.leaderName,
          },
        })).resolves.toEqual({ message_ids: [`message-fake-${index + 1}`] });
      }
      expect(bot.sentMessages.map((message) => message.target)).toMatchObject([
        { chatId: 'chat-topic', replyToMessageId: 'msg-topic-a' },
        { chatId: 'chat-topic', replyToMessageId: 'msg-topic-b' },
      ]);

      const denied = [
        {
          chat_id: 'wrong-chat',
          message_id: 'msg-topic-a',
          text: 'mismatched chat',
        },
        {
          chat_id: 'chat-topic',
          message_id: 'msg-unknown',
          text: 'unknown message',
        },
        {
          chat_id: 'chat-topic',
          thread_id: 'topic-a',
          text: 'topic without source message',
        },
      ];
      for (const args of denied) {
        await expect(invokeDispatcherChannelTool({
          channels: service,
          name: 'reply',
          arguments: args,
          caller: {
            kind: 'team_leader',
            teamId: owner.teamName,
            leaderName: owner.leaderName,
          },
        })).rejects.toThrow(/TeamLeader/);
      }
      expect(bot.sentMessages).toHaveLength(2);
    } finally {
      await service.closeAll(noopLog());
    }
  });
});
