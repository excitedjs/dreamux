import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  ChannelInboundEnvelope,
  ChannelTarget,
  DreamuxLogger,
  InboundTurnInput,
} from '@excitedjs/dreamux-types';

import type { FeishuInboundEvent } from '../src/bot.js';
import {
  createFeishuChannelProvider,
  type FeishuChannelConfig,
} from '../src/provider.js';
import { saveDispatcherAccess } from '../src/feishu-gate.js';
import { FeishuTargetRouter } from '../src/feishu-target-router.js';
import { createFakeFeishuBot } from './helpers/fake-feishu-bot.js';

interface Warning {
  fields: Record<string, unknown>;
  message?: string;
}

function logger(warnings: Warning[] = []): DreamuxLogger {
  const noop = () => undefined;
  return {
    trace: noop,
    debug: noop,
    info: noop,
    error: noop,
    warn(fields, message) {
      warnings.push({
        fields: typeof fields === 'string' ? {} : fields,
        ...(message !== undefined ? { message } : {}),
      });
    },
  };
}

function event(input: {
  messageId: string;
  chatId: string;
  threadId?: string;
  rootId?: string;
  parentId?: string;
}): FeishuInboundEvent {
  return {
    messageId: input.messageId,
    chatId: input.chatId,
    chatType: 'group',
    ...(input.threadId !== undefined ? { threadId: input.threadId } : {}),
    ...(input.rootId !== undefined ? { rootId: input.rootId } : {}),
    ...(input.parentId !== undefined ? { parentId: input.parentId } : {}),
    senderId: 'sender-1',
    senderType: 'user',
    senderName: 'Ada',
    messageType: 'text',
    rawContent: JSON.stringify({ text: '@bot hello' }),
    parsedText: '@Bot hello',
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

describe('Feishu topic routing', () => {
  let stateDir: string;

  beforeEach(async () => {
    stateDir = mkdtempSync(join(tmpdir(), 'dreamux-feishu-topic-'));
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
  });

  afterEach(() => {
    vi.useRealTimers();
    rmSync(stateDir, { recursive: true, force: true });
  });

  function buildSession(input: {
    warnings?: Warning[];
    bot?: ReturnType<typeof createFakeFeishuBot>;
  } = {}) {
    const bot = input.bot ?? createFakeFeishuBot('app-test');
    const provider = createFeishuChannelProvider({ botFactory: () => bot });
    const config: FeishuChannelConfig = {
      appId: 'app-test',
      appSecret: 'secret-test',
    };
    const session = provider.createSession({
      dispatcher_id: 'flow',
      channel_id: 'primary',
      provider: 'builtin:feishu',
      config,
      logger: logger(input.warnings),
      state_root: stateDir,
      cache_root: stateDir,
    });
    return { bot, session };
  }

  it('projects topic roots, replies, and different topics while preserving ordinary groups', async () => {
    const { bot, session } = buildSession();
    bot.setChatMode('chat-topic', 'topic');
    bot.setChatMode('chat-normal', 'group');
    const envelopes: ChannelInboundEnvelope[] = [];
    const turns: InboundTurnInput[] = [];
    await session.start({
      deliver: async (turn, envelope) => {
        turns.push(turn);
        envelopes.push(envelope);
        return { status: 'submitted' };
      },
    });

    await bot.inject(event({
      messageId: 'msg-root',
      chatId: 'chat-topic',
      threadId: 'topic-a',
    }));
    await bot.inject(event({
      messageId: 'msg-reply',
      chatId: 'chat-topic',
      threadId: 'topic-a',
      rootId: 'msg-root',
      parentId: 'msg-root',
    }));
    await bot.inject(event({
      messageId: 'msg-other',
      chatId: 'chat-topic',
      threadId: 'topic-b',
    }));
    await bot.inject(event({
      messageId: 'msg-normal-thread',
      chatId: 'chat-normal',
      threadId: 'ordinary-thread',
      rootId: 'ordinary-root',
      parentId: 'ordinary-parent',
    }));
    await bot.inject(event({
      messageId: 'msg-normal-thread-reply',
      chatId: 'chat-normal',
      threadId: 'ordinary-thread',
      rootId: 'ordinary-root',
      parentId: 'msg-normal-thread',
    }));
    await bot.inject(event({
      messageId: 'msg-topic-without-thread',
      chatId: 'chat-topic',
      rootId: 'must-not-be-a-topic-key',
    }));
    await bot.inject(event({
      messageId: 'msg-topic-empty-thread',
      chatId: 'chat-topic',
      threadId: '',
      rootId: 'must-not-be-a-topic-key',
    }));

    expect(envelopes.map((envelope) => envelope.target)).toMatchObject([
      {
        target_type: 'topic',
        target_key: 'topic-a',
        bindable: true,
        meta: {
          chat_id: 'chat-topic',
          chat_mode: 'topic',
          thread_id: 'topic-a',
          message_id: 'msg-root',
        },
      },
      {
        target_type: 'topic',
        target_key: 'topic-a',
        meta: {
          thread_id: 'topic-a',
          message_id: 'msg-reply',
          root_id: 'msg-root',
          parent_id: 'msg-root',
        },
      },
      { target_type: 'topic', target_key: 'topic-b' },
      {
        target_type: 'group',
        target_key: 'chat-normal',
        meta: { chat_id: 'chat-normal', chat_type: 'group' },
      },
      {
        target_type: 'group',
        target_key: 'chat-normal',
        meta: { chat_id: 'chat-normal', chat_type: 'group' },
      },
      {
        target_type: 'group',
        target_key: 'chat-topic',
        meta: { chat_id: 'chat-topic', chat_type: 'group' },
      },
      {
        target_type: 'group',
        target_key: 'chat-topic',
        meta: { chat_id: 'chat-topic', chat_type: 'group' },
      },
    ]);
    expect(envelopes.map((envelope) => envelope.container)).toEqual([
      {
        container_type: 'topic_group',
        container_key: 'chat-topic',
        meta: { chat_id: 'chat-topic', chat_mode: 'topic' },
      },
      {
        container_type: 'topic_group',
        container_key: 'chat-topic',
        meta: { chat_id: 'chat-topic', chat_mode: 'topic' },
      },
      {
        container_type: 'topic_group',
        container_key: 'chat-topic',
        meta: { chat_id: 'chat-topic', chat_mode: 'topic' },
      },
      undefined,
      undefined,
      undefined,
      undefined,
    ]);
    expect(
      envelopes.map((envelope) => envelope.target.binding_fallbacks),
    ).toEqual([
      [{
        target_type: 'group',
        target_key: 'chat-topic',
        bindable: true,
        meta: { chat_id: 'chat-topic', chat_type: 'group' },
      }],
      [{
        target_type: 'group',
        target_key: 'chat-topic',
        bindable: true,
        meta: { chat_id: 'chat-topic', chat_type: 'group' },
      }],
      [{
        target_type: 'group',
        target_key: 'chat-topic',
        bindable: true,
        meta: { chat_id: 'chat-topic', chat_type: 'group' },
      }],
      undefined,
      undefined,
      undefined,
      undefined,
    ]);
    expect(turns.map((turn) =>
      turn.attrs?.find(([key]) => key === 'thread_id')?.[1],
    )).toEqual([
      'topic-a',
      'topic-a',
      'topic-b',
      'ordinary-thread',
      'ordinary-thread',
      undefined,
      undefined,
    ]);
    expect(bot.chatModeRequests).toEqual(['chat-topic', 'chat-normal']);

    const topicA = await session.resolveTarget({
      chat_id: 'chat-topic',
      message_id: 'msg-reply',
    });
    const topicB = await session.resolveTarget({
      chat_id: 'chat-topic',
      message_id: 'msg-other',
    });
    await expect(session.resolveTarget({
      chat_id: 'chat-topic',
      thread_id: 'topic-a',
    })).rejects.toThrow(/observed message_id.*topic replies/);
    expect(topicA.target_key).toBe('topic-a');
    expect(topicA.binding_fallbacks).toMatchObject([
      { target_type: 'group', target_key: 'chat-topic' },
    ]);
    expect(session.messageBelongsToTarget?.({
      target: topicA,
      message_id: 'msg-root',
    })).toBe(true);
    expect(session.messageBelongsToTarget?.({
      target: topicA,
      message_id: 'msg-other',
    })).toBe(false);
    expect(session.messageBelongsToTarget?.({
      target: topicB,
      message_id: 'msg-other',
    })).toBe(true);
    await expect(session.resolveTarget({
      chat_id: 'wrong-chat',
      message_id: 'msg-root',
    })).rejects.toThrow(/chat_id.*conflicts/);
    await expect(session.resolveTarget({
      chat_id: 'chat-topic',
      thread_id: 'topic-b',
      message_id: 'msg-root',
    })).rejects.toThrow(/thread_id.*conflicts/);
  });

  it('fails safe when a legacy bot does not expose chat-mode lookup', async () => {
    const warnings: Warning[] = [];
    const router = new FeishuTargetRouter({
      chatModes: {},
      log: logger(warnings),
    });

    const route = await router.projectInbound(event({
      messageId: 'msg-legacy-bot',
      chatId: 'chat-legacy',
      threadId: 'topic-a',
    }));
    expect(route).toMatchObject({
      target: {
        target_type: 'group',
        target_key: 'chat-legacy',
      },
    });
    expect(route.container).toBeUndefined();
    expect(warnings).toMatchObject([
      {
        fields: {
          chat_id: 'chat-legacy',
          reason: 'chat_mode_lookup_unavailable',
        },
      },
    ]);
  });

  it('warns and retries mode lookup failures instead of caching a fallback', async () => {
    const warnings: Warning[] = [];
    const { bot, session } = buildSession({ warnings });
    bot.setChatMode('chat-retry', new Error('permission denied'));
    const envelopes: ChannelInboundEnvelope[] = [];
    await session.start({
      deliver: async (_turn, envelope) => {
        envelopes.push(envelope);
        return { status: 'submitted' };
      },
    });

    await bot.inject(event({
      messageId: 'msg-error',
      chatId: 'chat-retry',
      threadId: 'topic-a',
    }));
    bot.setChatMode('chat-retry', undefined);
    await bot.inject(event({
      messageId: 'msg-missing',
      chatId: 'chat-retry',
      threadId: 'topic-a',
    }));
    bot.setChatMode('chat-retry', 'topic');
    await bot.inject(event({
      messageId: 'msg-recovered',
      chatId: 'chat-retry',
      threadId: 'topic-a',
    }));
    await bot.inject(event({
      messageId: 'msg-cached',
      chatId: 'chat-retry',
      threadId: 'topic-a',
    }));

    expect(envelopes.map((envelope) => envelope.target.target_type)).toEqual([
      'group',
      'group',
      'topic',
      'topic',
    ]);
    expect(bot.chatModeRequests).toEqual([
      'chat-retry',
      'chat-retry',
      'chat-retry',
    ]);
    expect(warnings).toMatchObject([
      {
        fields: {
          chat_id: 'chat-retry',
          reason: 'chat_mode_lookup_failed',
          err: { message: 'permission denied' },
        },
      },
      {
        fields: {
          chat_id: 'chat-retry',
          reason: 'missing_or_unknown_chat_mode',
        },
      },
    ]);
    expect(JSON.stringify(warnings)).not.toContain('@bot hello');
    expect(JSON.stringify(warnings)).not.toContain('secret-test');
  });

  it('single-flights concurrent mode lookups for one chat', async () => {
    let release!: (mode: 'topic') => void;
    const mode = new Promise<'topic'>((resolve) => {
      release = resolve;
    });
    let calls = 0;
    const router = new FeishuTargetRouter({
      chatModes: {
        async getChatMode() {
          calls += 1;
          return mode;
        },
      },
      log: logger(),
    });

    const first = router.projectInbound(event({
      messageId: 'msg-a',
      chatId: 'chat-concurrent',
      threadId: 'topic-a',
    }));
    const second = router.projectInbound(event({
      messageId: 'msg-b',
      chatId: 'chat-concurrent',
      threadId: 'topic-b',
    }));
    await Promise.resolve();
    expect(calls).toBe(1);

    release('topic');
    await expect(Promise.all([first, second])).resolves.toMatchObject([
      { target: { target_key: 'topic-a' } },
      { target: { target_key: 'topic-b' } },
    ]);
  });

  it('bounds a hung mode lookup and clears it so a later request can retry', async () => {
    vi.useFakeTimers();
    const warnings: Warning[] = [];
    let calls = 0;
    const router = new FeishuTargetRouter({
      chatModes: {
        async getChatMode() {
          calls += 1;
          if (calls === 1) return new Promise(() => undefined);
          return 'topic';
        },
      },
      log: logger(warnings),
    });

    const timedOut = router.projectInbound(event({
      messageId: 'msg-timeout',
      chatId: 'chat-timeout',
      threadId: 'topic-timeout',
    }));
    await vi.advanceTimersByTimeAsync(2_001);
    await expect(timedOut).resolves.toMatchObject({
      target: { target_type: 'group', target_key: 'chat-timeout' },
    });

    await expect(router.projectInbound(event({
      messageId: 'msg-retry',
      chatId: 'chat-timeout',
      threadId: 'topic-retry',
    }))).resolves.toMatchObject({
      target: { target_type: 'topic', target_key: 'topic-retry' },
    });
    expect(calls).toBe(2);
    expect(warnings).toMatchObject([{
      fields: {
        chat_id: 'chat-timeout',
        reason: 'chat_mode_lookup_timed_out',
      },
    }]);
  });

  it('does not query or record topic routing for access-gated input', async () => {
    await saveDispatcherAccess(stateDir, {
      version: 3,
      dm_policy: 'pairing',
      allow_users: [],
      group: { policy: 'follow-user', allow_chats: [], require_mention: true },
      pending: {},
      observed_chats: [],
      warnings: [],
      last_gate: { at: 0 },
    });
    const { bot, session } = buildSession();
    bot.setChatMode('chat-gated', 'topic');
    const delivered: ChannelInboundEnvelope[] = [];
    await session.start({
      deliver: async (_turn, envelope) => {
        delivered.push(envelope);
        return { status: 'submitted' };
      },
    });

    await bot.inject(event({
      messageId: 'msg-gated',
      chatId: 'chat-gated',
      threadId: 'topic-gated',
    }));

    expect(delivered).toEqual([]);
    expect(bot.chatModeRequests).toEqual([]);
    const fabricated: ChannelTarget = {
      target_type: 'topic',
      target_key: 'topic-gated',
      bindable: true,
      meta: { chat_id: 'chat-gated', thread_id: 'topic-gated' },
    };
    expect(session.messageBelongsToTarget?.({
      target: fabricated,
      message_id: 'msg-gated',
    })).toBe(false);
  });
});
