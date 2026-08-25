import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type {
  ChannelSession,
  ChannelTarget,
  DreamuxLogger,
  InboundDeliveryResult,
} from '@excitedjs/dreamux-types';

import type { FeishuInboundEvent } from '../src/bot.js';
import { createFeishuChannelProvider } from '../src/provider.js';
import type { FeishuTargetRouter } from '../src/feishu-target-router.js';
import {
  createFakeFeishuBot,
  type FakeFeishuBot,
} from './helpers/fake-feishu-bot.js';

const temporaryRoots: string[] = [];

interface RecordedLogLine {
  readonly fields: Record<string, unknown>;
  readonly message: string;
}

interface ReplyRoutingHarness {
  readonly session: ChannelSession;
  readonly bot: FakeFeishuBot;
  readonly router: FeishuTargetRouter;
}

function recordingLogger(lines: RecordedLogLine[]): DreamuxLogger {
  const noop = () => undefined;
  const record = (
    fields: Record<string, unknown> | string,
    message?: string,
  ): void => {
    lines.push({
      fields: typeof fields === 'string' ? {} : fields,
      message: typeof fields === 'string' ? fields : message ?? '',
    });
  };
  return {
    trace: noop,
    debug: noop,
    info: noop,
    error: noop,
    warn: record,
  };
}

async function createHarness(
  lines: RecordedLogLine[] = [],
): Promise<ReplyRoutingHarness> {
  const root = mkdtempSync(join(tmpdir(), 'dreamux-feishu-reply-routing-'));
  temporaryRoots.push(root);
  const bot = createFakeFeishuBot('cot-reply-routing');
  const provider = createFeishuChannelProvider({ botFactory: () => bot });
  const session = provider.createSession({
    dispatcher_id: 'dispatcher-a',
    channel_id: 'primary',
    provider: 'builtin:feishu',
    config: { appId: 'cot-reply-routing', appSecret: 'secret' },
    logger: recordingLogger(lines),
    state_root: root,
    cache_root: root,
  });
  await session.start({
    deliver: async (): Promise<InboundDeliveryResult> => ({ status: 'submitted' }),
  });
  const raw = session as unknown as {
    session: { readonly targetRouter: FeishuTargetRouter };
  };
  return { session, bot, router: raw.session.targetRouter };
}

function inbound(messageId: string, chatId: string): FeishuInboundEvent {
  return {
    messageId,
    chatId,
    chatType: 'group',
    senderId: 'sender-a',
    senderType: 'user',
    senderName: 'Ada',
    messageType: 'text',
    rawContent: JSON.stringify({ text: 'hello' }),
    parsedText: 'hello',
    mentions: [],
    createTime: '1782660000000',
    raw: {},
  };
}

const replyCall = {
  name: 'reply',
  arguments: {
    chat_id: 'chat-requested',
    message_id: 'message-source',
    text: 'visible reply',
  },
};

const requestedTarget: ChannelTarget = {
  target_type: 'group',
  target_key: 'chat-requested',
  bindable: true,
  meta: { chat_id: 'chat-requested', chat_type: 'group' },
};

async function recordConflictingTarget(router: FeishuTargetRouter): Promise<void> {
  await router.projectInbound(inbound('message-source', 'chat-recorded'));
  expect(() => router.resolveTarget(replyCall.arguments)).toThrow(
    /chat_id.*conflicts/,
  );
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('Feishu Reply target routing', () => {
  it('does not add pre-send routing failure for a dispatcher Reply', async () => {
    const lines: RecordedLogLine[] = [];
    const { session, bot, router } = await createHarness(lines);
    await recordConflictingTarget(router);

    await expect(session.handleTool!(replyCall, {
      dispatcher_id: 'dispatcher-a',
      channel_id: 'primary',
      caller: { kind: 'dispatcher' },
    })).resolves.toEqual({ message_ids: ['message-fake-1'] });

    expect(bot.sentMessages[0]?.target).toEqual({
      chatId: 'chat-requested',
      replyToMessageId: 'message-source',
    });
    expect(lines).toEqual([]);
    await session.close();
  });

  it('does not add pre-send routing failure for a neutral Reply', async () => {
    const lines: RecordedLogLine[] = [];
    const { session, bot, router } = await createHarness(lines);
    await recordConflictingTarget(router);

    await expect(session.reply!({
      target: requestedTarget,
      text: 'visible reply',
      meta: { message_id: 'message-source' },
    })).resolves.toEqual({ message_ids: ['message-fake-1'] });

    expect(bot.sentMessages[0]?.target).toEqual({
      chatId: 'chat-requested',
      replyToMessageId: 'message-source',
    });
    expect(lines).toEqual([]);
    await session.close();
  });

  it('contains TeamLeader COT target conflicts after the Reply is sent', async () => {
    const lines: RecordedLogLine[] = [];
    const { session, bot, router } = await createHarness(lines);
    await recordConflictingTarget(router);

    await expect(session.handleTool!(replyCall, {
      dispatcher_id: 'dispatcher-a',
      channel_id: 'primary',
      caller: {
        kind: 'team_leader',
        team_name: 'team-alpha',
        leader_name: 'leader',
      },
    })).resolves.toEqual({ message_ids: ['message-fake-1'] });

    expect(bot.sentMessages[0]?.target).toEqual({
      chatId: 'chat-requested',
      replyToMessageId: 'message-source',
    });
    expect(lines).toContainEqual(expect.objectContaining({
      message: 'Feishu COT reply anchor refresh failed; Reply unchanged',
    }));
    await session.close();
  });

});
