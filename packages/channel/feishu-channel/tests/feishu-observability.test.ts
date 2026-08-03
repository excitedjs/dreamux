import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  ChannelSession,
  ChannelTargetLifecycleEvent,
  DreamuxLogger,
} from '@excitedjs/dreamux-types';

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

function topicInbound(): FeishuInboundEvent {
  return {
    messageId: 'message-topic',
    chatId: 'chat-topic',
    chatType: 'group',
    threadId: 'topic-a',
    senderId: 'sender-1',
    senderType: 'user',
    senderName: 'Ada',
    messageType: 'text',
    rawContent: JSON.stringify({ text: 'private message body' }),
    parsedText: '@Bot private message body',
    mentions: [{
      key: '@_user_1',
      id: { open_id: 'fake-open-id-app-test' },
      name: 'Bot',
    }],
    createTime: '1782660000000',
    raw: { private_payload: true },
  };
}

function recall(eventId: string = 'event-recall'): FeishuMessageRecalledEvent {
  return {
    eventId,
    chatId: 'chat-topic',
    messageId: 'message-topic',
    recallType: 'message_owner',
    recallTime: '1782660000000',
  };
}

describe('Feishu structured observability without lifecycle inference', () => {
  let stateDir: string;

  beforeEach(async () => {
    stateDir = mkdtempSync(join(tmpdir(), 'dreamux-feishu-observability-'));
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
    calls: LogCall[];
    captureRoutes?: (routes: FeishuInboundRoutes) => void;
  }): {
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
      appSecret: 'not-a-real-secret',
    };
    const session = provider.createSession({
      dispatcher_id: 'flow',
      channel_id: 'primary',
      provider: 'builtin:feishu',
      config,
      logger: logger(input.calls),
      state_root: stateDir,
      cache_root: stateDir,
    });
    return { bot, session };
  }

  async function startSession(
    session: ChannelSession,
    lifecycleEvents: ChannelTargetLifecycleEvent[],
  ): Promise<void> {
    await session.start({
      deliver: async () => ({ status: 'submitted', turnId: 'turn-1' }),
      targetLifecycle: async (event) => {
        lifecycleEvents.push(event);
      },
    });
  }

  function reply(session: ChannelSession, text: string): Promise<unknown> {
    if (session.handleTool === undefined) {
      throw new Error('missing Feishu session tools');
    }
    return session.handleTool(
      {
        name: 'reply',
        arguments: {
          chat_id: 'chat-topic',
          message_id: 'message-topic',
          text,
        },
      },
      { dispatcher_id: 'flow', channel_id: 'primary' },
    );
  }

  it('logs a normalized recall once, emits no lifecycle event, and respects close', async () => {
    const calls: LogCall[] = [];
    const lifecycleEvents: ChannelTargetLifecycleEvent[] = [];
    let capturedRoutes: FeishuInboundRoutes | undefined;
    const { bot, session } = buildSession({
      calls,
      captureRoutes: (routes) => {
        capturedRoutes = routes;
      },
    });
    await startSession(session, lifecycleEvents);

    await bot.injectMessageRecalled(Object.assign(recall(), {
      body: 'private message body',
      raw: { private_payload: true },
    }));

    expect(calls).toContainEqual({
      level: 'info',
      fields: {
        dispatcher_id: 'flow',
        event_id: 'event-recall',
        chat_id: 'chat-topic',
        message_id: 'message-topic',
        recall_type: 'message_owner',
        recall_time: '1782660000000',
      },
      message: 'Feishu message recall received',
    });
    expect(lifecycleEvents).toEqual([]);
    expect(JSON.stringify(calls)).not.toContain('private_payload');
    expect(JSON.stringify(calls)).not.toContain('private message body');

    const recallLogCount = calls.filter(
      (call) => call.message === 'Feishu message recall received',
    ).length;
    await session.close();
    await capturedRoutes?.onMessageRecalled?.(recall('event-after-close'));
    expect(calls.filter(
      (call) => call.message === 'Feishu message recall received',
    )).toHaveLength(recallLogCount);
    expect(lifecycleEvents).toEqual([]);
  });

  it('logs bounded SDK fields for 230019 and other reply errors without closing', async () => {
    const calls: LogCall[] = [];
    const lifecycleEvents: ChannelTargetLifecycleEvent[] = [];
    const { bot, session } = buildSession({ calls });
    bot.setChatMode('chat-topic', 'topic');
    await startSession(session, lifecycleEvents);
    await bot.inject(topicInbound());

    const secret = 'credential-that-must-not-be-logged';
    const closedThreadError = Object.assign(new Error('SDK request failed'), {
      config: {
        data: secret,
        headers: { Authorization: secret },
      },
      request: { body: secret },
      response: {
        headers: { authorization: secret },
        data: {
          code: 230019,
          msg: 'm'.repeat(800),
          error: { log_id: 'l'.repeat(400) },
          body: secret,
        },
      },
    });
    bot.setSendError(closedThreadError);
    await expect(reply(session, 'private outbound body')).rejects.toBe(
      closedThreadError,
    );

    const projected230019 = calls.filter((call) => {
      const err = call.fields['err'] as Record<string, unknown> | undefined;
      return err?.['code'] === 230019;
    });
    expect(projected230019).toHaveLength(2);
    for (const call of projected230019) {
      expect(call.fields['err']).toEqual({
        code: 230019,
        msg: 'm'.repeat(512),
        log_id: 'l'.repeat(256),
      });
    }

    const otherError = Object.assign(new Error('another SDK failure'), {
      response: { data: { code: 230018, msg: 'another upstream failure' } },
    });
    bot.setSendError(otherError);
    await expect(reply(session, 'another private outbound body')).rejects.toBe(
      otherError,
    );

    const unknownError = new Error('g'.repeat(800));
    bot.setSendError(unknownError);
    await expect(reply(session, 'unknown failure body')).rejects.toBe(unknownError);

    const genericLogs = calls.filter((call) => {
      const err = call.fields['err'] as Record<string, unknown> | undefined;
      return typeof err?.['message'] === 'string';
    });
    expect(genericLogs).toHaveLength(2);
    for (const call of genericLogs) {
      const err = call.fields['err'] as Record<string, unknown>;
      expect(err['message']).toBe('g'.repeat(512));
      expect((err['stack'] as string).length).toBeLessThanOrEqual(4_096);
    }

    expect(lifecycleEvents).toEqual([]);
    expect(JSON.stringify(calls)).not.toContain(secret);
    expect(JSON.stringify(calls)).not.toContain('private outbound body');
    expect(JSON.stringify(calls)).not.toContain('private message body');
    expect(JSON.stringify(calls)).not.toContain('private_payload');
    await session.close();
  });
});
