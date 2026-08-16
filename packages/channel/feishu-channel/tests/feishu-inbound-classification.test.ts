import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  InboundDeliveryResult,
  DreamuxLogger,
  InboundTurnInput,
} from '@excitedjs/dreamux-types';

import type { FeishuInboundEvent } from '../src/bot.js';
import { listChatBots } from '../src/chat-bots-store.js';
import {
  defaultDispatcherAccessState,
  loadDispatcherAccess,
  saveDispatcherAccess,
} from '../src/feishu-gate.js';
import {
  FeishuChannelSession,
  type FeishuInboundEnvelope,
} from '../src/feishu-channel.js';
import { createFakeFeishuBot } from './helpers/fake-feishu-bot.js';

interface CapturedLog {
  fields: Record<string, unknown>;
  message?: string;
}

function logger(logs: CapturedLog[]): DreamuxLogger {
  const capture = (fields: Record<string, unknown> | string, message?: string): void => {
    logs.push({
      fields: typeof fields === 'string' ? {} : fields,
      message: typeof fields === 'string' ? fields : message,
    });
  };
  return {
    trace: capture,
    debug: capture,
    info: capture,
    warn: capture,
    error: capture,
    fatal: capture,
    child: () => logger(logs),
  } as DreamuxLogger;
}

function event(overrides: Partial<FeishuInboundEvent> = {}): FeishuInboundEvent {
  return {
    messageId: 'om_source',
    chatId: 'oc_trusted',
    chatType: 'group',
    senderId: 'ou_human',
    senderType: 'user',
    senderName: 'Human',
    messageType: 'text',
    rawContent: JSON.stringify({ text: 'hello' }),
    parsedText: 'hello',
    mentions: [],
    createTime: '1782660000000',
    raw: {},
    ...overrides,
  };
}

describe('Feishu raw inbound classification boundary', () => {
  let stateDir: string;

  beforeEach(async () => {
    stateDir = mkdtempSync(join(tmpdir(), 'dreamux-feishu-classify-'));
    const access = defaultDispatcherAccessState();
    access.dm_policy = 'disabled';
    access.group = {
      policy: 'follow-user',
      allow_chats: ['oc_trusted'],
      require_mention: false,
    };
    await saveDispatcherAccess(stateDir, access);
  });

  afterEach(() => {
    rmSync(stateDir, { recursive: true, force: true });
  });

  it.each([
    {
      label: 'unsupported chat type',
      patch: { chatType: 'meeting', senderType: 'user', senderId: 'ou_human' },
      reason: 'unsupported_chat_type',
    },
    {
      label: 'unknown sender type',
      patch: { chatType: 'group', senderType: 'system', senderId: 'ou_unknown' },
      reason: 'sender_unknown',
    },
    {
      label: 'empty human sender id',
      patch: { chatType: 'group', senderType: 'user', senderId: '' },
      reason: 'sender_unknown',
    },
    {
      label: 'empty bot sender id',
      patch: { chatType: 'group', senderType: 'bot', senderId: '' },
      reason: 'sender_unknown',
    },
    {
      label: 'empty app sender id',
      patch: { chatType: 'group', senderType: 'app', senderId: '' },
      reason: 'sender_unknown',
    },
  ])('fails closed for $label before observation, introduce, pairing, or delivery', async ({ patch, reason }) => {
    const before = await loadDispatcherAccess(stateDir);
    const logs: CapturedLog[] = [];
    const bot = createFakeFeishuBot('app');
    const submitTurn = vi.fn(async (): Promise<InboundDeliveryResult> => ({
      status: 'submitted',
    }));
    const session = new FeishuChannelSession({
      dispatcherId: 'dispatcher-a',
      appId: 'app',
      appSecret: '',
      stateDir,
      attachmentCacheDir: join(stateDir, 'attachments'),
      log: logger(logs),
      botFactory: () => bot,
    });
    await session.start({ submitTurn });

    await bot.inject(event({
      ...patch,
      messageType: 'text',
      rawContent: JSON.stringify({ text: '/introduce @_user_2' }),
      parsedText: '/introduce @Peer',
      mentions: [{
        key: '@_user_2',
        id: { open_id: 'ou_peer' },
        name: 'Peer',
      }],
    }));

    expect(submitTurn).not.toHaveBeenCalled();
    expect(bot.sentCards).toEqual([]);
    expect(bot.sentMessages).toEqual([]);
    expect(await loadDispatcherAccess(stateDir)).toEqual(before);
    expect(await listChatBots(stateDir, 'oc_trusted')).toEqual({ known: [], trusted: [] });
    expect(logs).toContainEqual(expect.objectContaining({
      message: 'feishu inbound dropped',
      fields: expect.objectContaining({ reason }),
    }));
    await session.close();
  });

  it('lets only an exact group user use trusted-chat authority', async () => {
    const bot = createFakeFeishuBot('app');
    const submitTurn = vi.fn(async (
      _input: InboundTurnInput,
      _envelope: FeishuInboundEnvelope,
    ): Promise<InboundDeliveryResult> => ({ status: 'submitted' }));
    const session = new FeishuChannelSession({
      dispatcherId: 'dispatcher-a',
      appId: 'app',
      appSecret: '',
      stateDir,
      attachmentCacheDir: join(stateDir, 'attachments'),
      log: logger([]),
      botFactory: () => bot,
    });
    await session.start({ submitTurn });

    await bot.inject(event());

    expect(submitTurn).toHaveBeenCalledTimes(1);
    expect(bot.sentCards).toEqual([]);
    await session.close();
  });

  it.each(['bot', 'app'])('observes an exact %s sender only in a listed group', async (senderType) => {
    const bot = createFakeFeishuBot('app');
    const submitTurn = vi.fn(async (): Promise<InboundDeliveryResult> => ({
      status: 'submitted',
    }));
    const session = new FeishuChannelSession({
      dispatcherId: 'dispatcher-a',
      appId: 'app',
      appSecret: '',
      stateDir,
      attachmentCacheDir: join(stateDir, 'attachments'),
      log: logger([]),
      botFactory: () => bot,
    });
    await session.start({ submitTurn });

    await bot.inject(event({
      senderType,
      senderId: `ou_${senderType}`,
      senderName: `Peer ${senderType}`,
    }));
    await bot.inject(event({
      chatId: 'oc_unlisted',
      senderType,
      senderId: `ou_${senderType}_unlisted`,
    }));

    expect(submitTurn).not.toHaveBeenCalled();
    expect(await listChatBots(stateDir, 'oc_trusted')).toEqual({
      known: [{ openId: `ou_${senderType}`, name: `Peer ${senderType}` }],
      trusted: [],
    });
    expect(await listChatBots(stateDir, 'oc_unlisted')).toEqual({
      known: [],
      trusted: [],
    });
    await session.close();
  });

  it('delivers an unauthorized /introduce as ordinary trusted-chat text without mutating trust', async () => {
    const logs: CapturedLog[] = [];
    const bot = createFakeFeishuBot('app');
    const submitTurn = vi.fn(async (): Promise<InboundDeliveryResult> => ({
      status: 'submitted',
    }));
    const session = new FeishuChannelSession({
      dispatcherId: 'dispatcher-a',
      appId: 'app',
      appSecret: '',
      stateDir,
      attachmentCacheDir: join(stateDir, 'attachments'),
      log: logger(logs),
      botFactory: () => bot,
    });
    await session.start({ submitTurn });

    await bot.inject(event({
      rawContent: JSON.stringify({ text: '/introduce @_user_2' }),
      parsedText: '/introduce @Peer',
      mentions: [{
        key: '@_user_2',
        id: { open_id: 'ou_peer' },
        name: 'Peer',
      }],
    }));

    expect(submitTurn).toHaveBeenCalledTimes(1);
    expect(logs).toContainEqual(expect.objectContaining({
      message: 'introduce detected but not authorized',
      fields: expect.objectContaining({ reason: 'sender_not_followed' }),
    }));
    expect(await listChatBots(stateDir, 'oc_trusted')).toEqual({ known: [], trusted: [] });
    expect((await loadDispatcherAccess(stateDir)).allow_users).toEqual([]);
    await session.close();
  });
});
