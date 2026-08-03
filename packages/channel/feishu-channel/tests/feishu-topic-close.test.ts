import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  ChannelSession,
  ChannelTargetLifecycleEvent,
  DreamuxLogger,
} from '@excitedjs/dreamux-types';
import { FeishuOutboundError } from '@excitedjs/feishu-transport';

import type {
  FeishuInboundEvent,
  FeishuInboundRoutes,
  FeishuMessageRecalledEvent,
} from '../src/bot.js';
import { saveDispatcherAccess } from '../src/feishu-gate.js';
import {
  createFeishuChannelProvider,
  type FeishuChannelConfig,
} from '../src/provider.js';
import { createFakeFeishuBot } from './helpers/fake-feishu-bot.js';

interface LogCall {
  level: 'error' | 'warn' | 'info' | 'debug' | 'trace';
  fields: Record<string, unknown>;
  message?: string;
}

function logger(calls: LogCall[]): DreamuxLogger {
  const record = (level: LogCall['level']) =>
    (fields: Record<string, unknown> | string, message?: string): void => {
      calls.push({
        level,
        fields: typeof fields === 'string' ? {} : fields,
        ...(message !== undefined ? { message } : {}),
      });
    };
  return {
    error: record('error'),
    warn: record('warn'),
    info: record('info'),
    debug: record('debug'),
    trace: record('trace'),
  };
}

function inbound(input: {
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
    rawContent: JSON.stringify({ text: 'sensitive-message-content' }),
    parsedText: 'sensitive-message-content',
    mentions: [{
      key: '@_user_1',
      id: { open_id: 'fake-open-id-app-test' },
      name: 'Bot',
    }],
    createTime: '1782660000000',
    raw: {},
  };
}

function recall(input: {
  eventId: string;
  chatId: string;
  messageId: string;
}): FeishuMessageRecalledEvent {
  return {
    eventId: input.eventId,
    chatId: input.chatId,
    messageId: input.messageId,
    recallType: 'message_owner',
    recallTime: '1782660000000',
  };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('Feishu topic-close lifecycle', () => {
  let stateDir: string;

  beforeEach(async () => {
    stateDir = mkdtempSync(join(tmpdir(), 'dreamux-feishu-topic-close-'));
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
    rmSync(stateDir, { recursive: true, force: true });
  });

  function buildSession(input: {
    calls?: LogCall[];
    captureRoutes?: (routes: FeishuInboundRoutes) => void;
  } = {}): {
    bot: ReturnType<typeof createFakeFeishuBot>;
    session: ChannelSession;
  } {
    const bot = createFakeFeishuBot('app-test');
    if (input.captureRoutes !== undefined) {
      const start = bot.start.bind(bot);
      bot.start = async (routes): Promise<void> => {
        input.captureRoutes?.(routes);
        await start(routes);
      };
    }
    const provider = createFeishuChannelProvider({ botFactory: () => bot });
    const config: FeishuChannelConfig = {
      appId: 'app-test',
      appSecret: 'secret-test',
    };
    return {
      bot,
      session: provider.createSession({
        dispatcher_id: 'flow',
        channel_id: 'primary',
        provider: 'builtin:feishu',
        config,
        logger: logger(input.calls ?? []),
        state_root: stateDir,
        cache_root: stateDir,
      }),
    };
  }

  async function startSession(input: {
    session: ChannelSession;
    lifecycle?: (event: ChannelTargetLifecycleEvent) => Promise<void>;
  }): Promise<void> {
    await input.session.start({
      deliver: async () => ({ status: 'submitted', turnId: 'turn-1' }),
      ...(input.lifecycle !== undefined
        ? { targetLifecycle: input.lifecycle }
        : {}),
    });
  }

  function reply(
    session: ChannelSession,
    input: { chatId: string; messageId: string; text?: string },
  ): Promise<unknown> {
    if (session.handleTool === undefined) throw new Error('missing Feishu tools');
    return session.handleTool(
      {
        name: 'reply',
        arguments: {
          chat_id: input.chatId,
          message_id: input.messageId,
          text: input.text ?? 'reply body',
        },
      },
      { dispatcher_id: 'flow', channel_id: 'primary' },
    );
  }

  it('closes only an exactly observed topic root using recorded ancestry', async () => {
    const calls: LogCall[] = [];
    const lifecycle: ChannelTargetLifecycleEvent[] = [];
    const { bot, session } = buildSession({ calls });
    bot.setChatMode('chat-topic', 'topic');
    bot.setChatMode('chat-ordinary', 'group');
    await startSession({
      session,
      lifecycle: async (event) => {
        lifecycle.push(event);
      },
    });

    await bot.inject(inbound({
      messageId: 'message-root',
      chatId: 'chat-topic',
      threadId: 'topic-key-different-from-root-id',
    }));
    await bot.inject(inbound({
      messageId: 'message-reply',
      chatId: 'chat-topic',
      threadId: 'topic-key-different-from-root-id',
      rootId: 'message-root',
      parentId: 'message-root',
    }));
    await bot.inject(inbound({
      messageId: 'message-root-ancestry-only',
      chatId: 'chat-topic',
      threadId: 'topic-key-different-from-root-id',
      rootId: 'message-root',
    }));
    await bot.inject(inbound({
      messageId: 'message-parent-ancestry-only',
      chatId: 'chat-topic',
      threadId: 'topic-key-different-from-root-id',
      parentId: 'message-root',
    }));
    await bot.inject(inbound({
      messageId: 'ordinary-message',
      chatId: 'chat-ordinary',
      threadId: 'ordinary-thread',
    }));

    await bot.injectMessageRecalled(recall({
      eventId: 'event-reply',
      chatId: 'chat-topic',
      messageId: 'message-reply',
    }));
    await bot.injectMessageRecalled(recall({
      eventId: 'event-root-ancestry-only',
      chatId: 'chat-topic',
      messageId: 'message-root-ancestry-only',
    }));
    await bot.injectMessageRecalled(recall({
      eventId: 'event-parent-ancestry-only',
      chatId: 'chat-topic',
      messageId: 'message-parent-ancestry-only',
    }));
    await bot.injectMessageRecalled(recall({
      eventId: 'event-ordinary',
      chatId: 'chat-ordinary',
      messageId: 'ordinary-message',
    }));
    await bot.injectMessageRecalled(recall({
      eventId: 'event-unknown',
      chatId: 'chat-topic',
      messageId: 'unknown-message',
    }));
    await bot.injectMessageRecalled(recall({
      eventId: 'event-wrong-chat',
      chatId: 'different-chat',
      messageId: 'message-root',
    }));
    expect(lifecycle).toEqual([]);

    await bot.injectMessageRecalled(recall({
      eventId: 'event-root',
      chatId: 'chat-topic',
      messageId: 'message-root',
    }));

    expect(lifecycle).toEqual([{
      kind: 'target_closed',
      event_id: 'event-root',
      timestamp: 1782660000000,
      container: {
        container_type: 'topic_group',
        container_key: 'chat-topic',
        meta: { chat_id: 'chat-topic', chat_mode: 'topic' },
      },
      target: {
        target_type: 'topic',
        target_key: 'topic-key-different-from-root-id',
        bindable: true,
        meta: {
          chat_id: 'chat-topic',
          chat_type: 'group',
          chat_mode: 'topic',
          thread_id: 'topic-key-different-from-root-id',
          message_id: 'message-root',
        },
        binding_fallbacks: [{
          target_type: 'group',
          target_key: 'chat-topic',
          bindable: true,
          meta: { chat_id: 'chat-topic', chat_type: 'group' },
        }],
      },
    }]);
    const logged = JSON.stringify(calls);
    expect(logged).not.toContain('sensitive-message-content');
    expect(logged).not.toContain('secret-test');
    for (const call of calls) {
      for (const value of Object.values(call.fields)) {
        if (typeof value === 'string') expect(value.length).toBeLessThanOrEqual(512);
      }
    }
    await session.close();
  });

  it('keeps recall retryable on lifecycle failure and logs absent compatibility', async () => {
    const lifecycleError = new Error('lifecycle unavailable');
    const { bot, session } = buildSession();
    bot.setChatMode('chat-topic', 'topic');
    let attempts = 0;
    await startSession({
      session,
      lifecycle: async () => {
        attempts += 1;
        if (attempts === 1) throw lifecycleError;
      },
    });
    await bot.inject(inbound({
      messageId: 'message-root',
      chatId: 'chat-topic',
      threadId: 'topic-a',
    }));
    const recalled = recall({
      eventId: 'event-root',
      chatId: 'chat-topic',
      messageId: 'message-root',
    });

    await expect(bot.injectMessageRecalled(recalled)).rejects.toBe(lifecycleError);
    await expect(bot.injectMessageRecalled(recalled)).resolves.toBeUndefined();
    expect(attempts).toBe(2);
    await session.close();

    const calls: LogCall[] = [];
    const compatible = buildSession({ calls });
    compatible.bot.setChatMode('chat-topic', 'topic');
    await startSession({ session: compatible.session });
    await compatible.bot.inject(inbound({
      messageId: 'compatible-root',
      chatId: 'chat-topic',
      threadId: 'topic-compatible',
    }));
    await expect(compatible.bot.injectMessageRecalled(recall({
      eventId: 'event-compatible',
      chatId: 'chat-topic',
      messageId: 'compatible-root',
    }))).resolves.toBeUndefined();
    expect(calls).toContainEqual(expect.objectContaining({
      level: 'warn',
      message: expect.stringContaining('target lifecycle is unavailable'),
    }));
    const closed = new FeishuOutboundError({
      code: 230019,
      message: 'The thread does NOT exist',
    });
    compatible.bot.setSendError(closed);
    await expect(reply(compatible.session, {
      chatId: 'chat-topic',
      messageId: 'compatible-root',
    })).rejects.toBe(closed);
    expect(calls.filter((call) =>
      call.message?.includes('target lifecycle is unavailable') === true
    )).toHaveLength(2);
    await compatible.session.close();
  });

  it('emits on reply 230019 only for observed topic messages and rethrows it', async () => {
    const lifecycle: ChannelTargetLifecycleEvent[] = [];
    const { bot, session } = buildSession();
    bot.setChatMode('chat-topic', 'topic');
    bot.setChatMode('chat-ordinary', 'group');
    await startSession({
      session,
      lifecycle: async (event) => {
        lifecycle.push(event);
      },
    });
    await bot.inject(inbound({
      messageId: 'topic-reply',
      chatId: 'chat-topic',
      threadId: 'topic-a',
      rootId: 'topic-root',
      parentId: 'topic-root',
    }));
    await bot.inject(inbound({
      messageId: 'ordinary-message',
      chatId: 'chat-ordinary',
      threadId: 'ordinary-thread',
    }));

    const closed = new FeishuOutboundError({
      code: 230019,
      message: 'The thread does NOT exist',
      logId: 'upstream-log-1',
    });
    bot.setSendError(closed);
    await expect(reply(session, {
      chatId: 'chat-topic',
      messageId: 'topic-reply',
    })).rejects.toBe(closed);
    expect(lifecycle).toEqual([expect.objectContaining({
      kind: 'target_closed',
      container: expect.objectContaining({ container_key: 'chat-topic' }),
      target: expect.objectContaining({ target_key: 'topic-a' }),
    })]);

    const other = new FeishuOutboundError({
      code: 230018,
      message: 'another upstream failure',
    });
    bot.setSendError(other);
    await expect(reply(session, {
      chatId: 'chat-topic',
      messageId: 'topic-reply',
    })).rejects.toBe(other);
    bot.setSendError(closed);
    await expect(reply(session, {
      chatId: 'chat-ordinary',
      messageId: 'ordinary-message',
    })).rejects.toBe(closed);
    await expect(reply(session, {
      chatId: 'chat-topic',
      messageId: 'unknown-message',
    })).rejects.toBe(closed);
    await expect(reply(session, {
      chatId: 'different-chat',
      messageId: 'topic-reply',
    })).rejects.toBe(closed);
    expect(lifecycle).toHaveLength(1);
    await session.close();
  });

  it('preserves the 230019 error when lifecycle delivery fails', async () => {
    const calls: LogCall[] = [];
    const { bot, session } = buildSession({ calls });
    bot.setChatMode('chat-topic', 'topic');
    await startSession({
      session,
      lifecycle: async () => {
        throw new Error('core lifecycle failed');
      },
    });
    await bot.inject(inbound({
      messageId: 'topic-message',
      chatId: 'chat-topic',
      threadId: 'topic-a',
    }));
    const closed = new FeishuOutboundError({
      code: 230019,
      message: 'The thread does NOT exist',
    });
    bot.setSendError(closed);

    await expect(reply(session, {
      chatId: 'chat-topic',
      messageId: 'topic-message',
      text: 'credential-must-not-be-logged',
    })).rejects.toBe(closed);
    expect(calls).toContainEqual(expect.objectContaining({
      level: 'error',
      fields: expect.objectContaining({
        upstream_code: 230019,
        lifecycle_error: true,
      }),
    }));
    expect(JSON.stringify(calls)).not.toContain('credential-must-not-be-logged');
    expect(JSON.stringify(calls)).not.toContain('The thread does NOT exist');
    expect(JSON.stringify(calls)).not.toContain('core lifecycle failed');
    await session.close();
  });

  it('suppresses 230019 and recalled-root emissions after the captured fence closes', async () => {
    let capturedRoutes: FeishuInboundRoutes | undefined;
    const lifecycle: ChannelTargetLifecycleEvent[] = [];
    const { bot, session } = buildSession({
      captureRoutes: (routes) => {
        capturedRoutes = routes;
      },
    });
    bot.setChatMode('chat-topic', 'topic');
    await startSession({
      session,
      lifecycle: async (event) => {
        lifecycle.push(event);
      },
    });
    await bot.inject(inbound({
      messageId: 'topic-message',
      chatId: 'chat-topic',
      threadId: 'topic-a',
    }));
    const closed = new FeishuOutboundError({
      code: 230019,
      message: 'The thread does NOT exist',
    });
    const sendStarted = deferred<void>();
    const sendFinished = deferred<void>();
    vi.spyOn(bot, 'send').mockImplementation(async () => {
      sendStarted.resolve();
      await sendFinished.promise;
      throw closed;
    });

    const sending = reply(session, {
      chatId: 'chat-topic',
      messageId: 'topic-message',
    });
    await sendStarted.promise;
    await session.close();
    sendFinished.resolve();
    await expect(sending).rejects.toBe(closed);

    await capturedRoutes?.onMessageRecalled?.(recall({
      eventId: 'late-recall',
      chatId: 'chat-topic',
      messageId: 'topic-message',
    }));
    expect(lifecycle).toEqual([]);
  });
});
