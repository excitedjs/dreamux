import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { InboundDeliveryResult, DreamuxLogger } from '@excitedjs/dreamux-types';
import type {
  FeishuMessageReadResponse,
  FeishuMessageResourceResponse,
} from '@excitedjs/feishu-transport';

import type { FeishuInboundEvent } from '../src/bot.js';
import {
  defaultDispatcherAccessState,
  saveDispatcherAccess,
} from '../src/feishu-gate.js';
import {
  FeishuChannelSession,
  type FeishuInboundSubmitter,
} from '../src/feishu-channel.js';
import { createFakeFeishuBot } from './helpers/fake-feishu-bot.js';

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function logger(): DreamuxLogger {
  const noop = () => undefined;
  return {
    trace: noop,
    debug: noop,
    info: noop,
    warn: noop,
    error: noop,
    fatal: noop,
    child: () => logger(),
  } as unknown as DreamuxLogger;
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
} {
  let resolvePromise: (value: T) => void = () => undefined;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  return { promise, resolve: resolvePromise };
}

function event(messageId: string): FeishuInboundEvent {
  return {
    messageId,
    chatId: 'oc_chat',
    chatType: 'p2p',
    senderId: 'ou_allowed',
    senderType: 'user',
    senderName: 'Ada',
    messageType: 'interactive',
    rawContent: JSON.stringify({ text: 'event fallback' }),
    parsedText: 'event fallback',
    mentions: [],
    createTime: '1710000000000',
    raw: {},
  };
}

async function allowSender(stateDir: string): Promise<void> {
  const access = defaultDispatcherAccessState();
  access.dm_policy = 'allowlist';
  access.allow_users = ['ou_allowed'];
  await saveDispatcherAccess(stateDir, access);
}

async function allowGroupSender(stateDir: string): Promise<void> {
  const access = defaultDispatcherAccessState();
  access.dm_policy = 'allowlist';
  access.allow_users = ['ou_allowed'];
  access.group = {
    policy: 'allowlist',
    allow_chats: ['oc_chat'],
    require_mention: false,
  };
  await saveDispatcherAccess(stateDir, access);
}

function readResponse(messageId: string): FeishuMessageReadResponse {
  return {
    items: [{
      messageId,
      messageType: 'interactive',
      content: JSON.stringify({
        body: { elements: [{ tag: 'markdown', content: 'resolved card' }] },
      }),
      mentions: [],
      deleted: false,
      malformed: false,
    }],
  };
}

describe('Feishu session lifecycle fencing', () => {
  it('does not let a hung chat-mode lookup block close', async () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'dreamux-feishu-route-close-'));
    dirs.push(stateDir);
    await allowGroupSender(stateDir);
    const bot = createFakeFeishuBot();
    const mode = deferred<'topic'>();
    const getChatMode = vi.fn(async () => mode.promise);
    bot.getChatMode = getChatMode;
    const submitted: string[] = [];
    const session = new FeishuChannelSession({
      dispatcherId: 'dispatcher-a',
      appId: 'app-test',
      appSecret: '',
      stateDir,
      attachmentCacheDir: join(stateDir, 'attachments'),
      log: logger(),
      botFactory: () => bot,
    });
    await session.start({
      submitTurn: async (input): Promise<InboundDeliveryResult> => {
        submitted.push(input.sourceId);
        return { status: 'submitted' };
      },
    });

    const delivery = bot.inject({
      ...event('om_route_hung'),
      chatType: 'group',
      threadId: 'omt_topic',
      messageType: 'text',
      rawContent: JSON.stringify({ text: 'hello' }),
      parsedText: 'hello',
    });
    await vi.waitFor(() => {
      expect(getChatMode).toHaveBeenCalledTimes(1);
    });

    await session.close();
    await delivery;
    expect(submitted).toEqual([]);
    expect(bot.reactionOps).toEqual([]);

    mode.resolve('topic');
    await Promise.resolve();
    expect(submitted).toEqual([]);
  });

  it('does not let a hung received reaction block close', async () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'dreamux-feishu-reaction-hung-'));
    dirs.push(stateDir);
    await allowSender(stateDir);
    const bot = createFakeFeishuBot();
    bot.setReactionDelay('Get', new Promise(() => undefined));
    const submitted: string[] = [];
    const session = new FeishuChannelSession({
      dispatcherId: 'dispatcher-a',
      appId: 'app-test',
      appSecret: '',
      stateDir,
      attachmentCacheDir: join(stateDir, 'attachments'),
      log: logger(),
      botFactory: () => bot,
    });
    await session.start({
      submitTurn: async (input): Promise<InboundDeliveryResult> => {
        submitted.push(input.sourceId);
        return { status: 'submitted' };
      },
    });

    const delivery = bot.inject({
      ...event('om_reaction_hung'),
      messageType: 'text',
      rawContent: JSON.stringify({ text: 'hello' }),
      parsedText: 'hello',
    });
    await vi.waitFor(() => {
      expect(bot.reactionOps).toHaveLength(1);
    });

    await session.close();
    await delivery;
    expect(submitted).toEqual([]);
    expect(bot.reactionOps).toEqual([
      expect.objectContaining({ op: 'add', messageId: 'om_reaction_hung' }),
    ]);
  });

  it('does not let a hung in-progress reaction block close', async () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'dreamux-feishu-progress-hung-'));
    dirs.push(stateDir);
    await allowSender(stateDir);
    const bot = createFakeFeishuBot();
    bot.setReactionDelay('OnIt', new Promise(() => undefined));
    const session = new FeishuChannelSession({
      dispatcherId: 'dispatcher-a',
      appId: 'app-test',
      appSecret: '',
      stateDir,
      attachmentCacheDir: join(stateDir, 'attachments'),
      log: logger(),
      botFactory: () => bot,
    });
    await session.start({
      submitTurn: async (): Promise<InboundDeliveryResult> => ({
        status: 'submitted',
      }),
    });

    const delivery = bot.inject({
      ...event('om_progress_hung'),
      messageType: 'text',
      rawContent: JSON.stringify({ text: 'hello' }),
      parsedText: 'hello',
    });
    await vi.waitFor(() => {
      expect(bot.reactionOps.filter((entry) => entry.op === 'add')).toHaveLength(2);
    });

    await session.close();
    await delivery;
    expect(bot.reactionOps).toEqual([
      expect.objectContaining({
        op: 'add',
        messageId: 'om_progress_hung',
        emoji: 'Get',
      }),
      expect.objectContaining({
        op: 'add',
        messageId: 'om_progress_hung',
        emoji: 'OnIt',
      }),
      expect.objectContaining({
        op: 'remove',
        messageId: 'om_progress_hung',
      }),
    ]);
  });

  it('revokes a hanging sender-name lookup before close and never submits it', async () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'dreamux-feishu-name-close-'));
    dirs.push(stateDir);
    await allowSender(stateDir);
    const bot = createFakeFeishuBot();
    const resolvedName = deferred<string | undefined>();
    const nameRequests: string[] = [];
    bot.resolveUserName = async (openId: string): Promise<string | undefined> => {
      nameRequests.push(openId);
      return resolvedName.promise;
    };
    const submitted: string[] = [];
    const session = new FeishuChannelSession({
      dispatcherId: 'dispatcher-a',
      appId: 'app-test',
      appSecret: '',
      stateDir,
      attachmentCacheDir: join(stateDir, 'attachments'),
      log: logger(),
      botFactory: () => bot,
    });
    await session.start({
      submitTurn: async (input): Promise<InboundDeliveryResult> => {
        submitted.push(input.sourceId);
        return { status: 'submitted' };
      },
    });

    const delivery = bot.inject({
      ...event('om_sender_name'),
      messageType: 'text',
      rawContent: JSON.stringify({ text: 'hello' }),
      parsedText: 'hello',
      senderName: '',
    });
    await vi.waitFor(() => {
      expect(nameRequests).toEqual(['ou_allowed']);
    });

    await session.close();
    await delivery;
    expect(submitted).toEqual([]);
    expect(bot.reactionOps.map((entry) => entry.op)).toEqual(['add', 'remove']);

    resolvedName.resolve('Late Ada');
    await Promise.resolve();
    expect(submitted).toEqual([]);
  });

  it('revokes a hanging enrichment before close and prevents stale submission after restart', async () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'dreamux-feishu-lifecycle-'));
    dirs.push(stateDir);
    await allowSender(stateDir);
    const bot = createFakeFeishuBot();
    const structured = deferred<FeishuMessageReadResponse>();
    const simplified = deferred<FeishuMessageReadResponse>();
    bot.setMessageRead('om_old', 'user_card_content', structured.promise);
    bot.setMessageRead('om_old', 'default', simplified.promise);
    const submitted: string[] = [];
    const submitter: FeishuInboundSubmitter = {
      submitTurn: vi.fn(async (input): Promise<InboundDeliveryResult> => {
        submitted.push(input.sourceId);
        return { status: 'submitted' };
      }),
    };
    const session = new FeishuChannelSession({
      dispatcherId: 'dispatcher-a',
      appId: 'app-test',
      appSecret: '',
      stateDir,
      attachmentCacheDir: join(stateDir, 'attachments'),
      log: logger(),
      botFactory: () => bot,
    });
    await session.start(submitter);

    const oldDelivery = bot.inject(event('om_old'));
    await vi.waitFor(() => {
      expect(bot.messageReadRequests).toHaveLength(2);
    });
    await session.close();
    await oldDelivery;
    expect(submitted).toEqual([]);
    expect(bot.reactionOps.map((entry) => entry.op)).toEqual(['add', 'remove']);

    await session.start(submitter);
    bot.setMessageRead('om_new', 'user_card_content', readResponse('om_new'));
    bot.setMessageRead('om_new', 'default', readResponse('om_new'));
    await bot.inject(event('om_new'));
    expect(submitted).toEqual(['om_new']);

    structured.resolve(readResponse('om_old'));
    simplified.resolve(readResponse('om_old'));
    await Promise.resolve();
    expect(submitted).toEqual(['om_new']);
    await session.close();
  });

  it('performs no enrichment I/O for a dropped rich message', async () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'dreamux-feishu-drop-'));
    dirs.push(stateDir);
    const bot = createFakeFeishuBot();
    const session = new FeishuChannelSession({
      dispatcherId: 'dispatcher-a',
      appId: 'app-test',
      appSecret: '',
      stateDir,
      attachmentCacheDir: join(stateDir, 'attachments'),
      log: logger(),
      botFactory: () => bot,
    });
    await session.start({
      submitTurn: async (): Promise<InboundDeliveryResult> => ({
        status: 'submitted',
      }),
    });

    await bot.inject(event('om_dropped'));

    expect(bot.messageReadRequests).toEqual([]);
    expect(bot.messageResourceRequests).toEqual([]);
    await session.close();
  });

  it('fences a late resource response so close leaves no cache file or submission', async () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'dreamux-feishu-resource-close-'));
    dirs.push(stateDir);
    await allowSender(stateDir);
    const bot = createFakeFeishuBot();
    const resource = deferred<FeishuMessageResourceResponse>();
    bot.setMessageResource('img-late', resource.promise);
    const submitted: string[] = [];
    const session = new FeishuChannelSession({
      dispatcherId: 'dispatcher-a',
      appId: 'app-test',
      appSecret: '',
      stateDir,
      attachmentCacheDir: join(stateDir, 'attachments'),
      log: logger(),
      botFactory: () => bot,
    });
    await session.start({
      submitTurn: async (input): Promise<InboundDeliveryResult> => {
        submitted.push(input.sourceId);
        return { status: 'submitted' };
      },
    });

    const delivery = bot.inject({
      ...event('om_resource'),
      messageType: 'post',
      rawContent: JSON.stringify({
        zh_cn: { content: [[{ tag: 'img', image_key: 'img-late' }]] },
      }),
      parsedText: '[image attachment: img-late]',
      resources: [{ type: 'image', key: 'img-late' }],
    });
    await vi.waitFor(() => {
      expect(bot.messageResourceRequests).toEqual([
        { messageId: 'om_resource', fileKey: 'img-late', type: 'image' },
      ]);
    });

    await session.close();
    await delivery;
    resource.resolve({ stream: Readable.from([Buffer.from('late')]), headers: {} });
    await Promise.resolve();

    expect(submitted).toEqual([]);
    expect(readdirSync(join(stateDir, 'attachments'))).toEqual([]);
    expect(bot.reactionOps.map((entry) => entry.op)).toEqual(['add', 'remove']);
  });

  it('clears received when close races the in-progress reaction replacement', async () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'dreamux-feishu-reaction-close-'));
    dirs.push(stateDir);
    await allowSender(stateDir);
    const bot = createFakeFeishuBot();
    const progress = deferred<void>();
    bot.setReactionDelay('OnIt', progress.promise);
    const session = new FeishuChannelSession({
      dispatcherId: 'dispatcher-a',
      appId: 'app-test',
      appSecret: '',
      stateDir,
      attachmentCacheDir: join(stateDir, 'attachments'),
      log: logger(),
      botFactory: () => bot,
    });
    await session.start({
      submitTurn: async (): Promise<InboundDeliveryResult> => ({
        status: 'submitted',
      }),
    });

    const delivery = bot.inject(event('om_reaction_close'));
    await vi.waitFor(() => {
      expect(bot.reactionOps.filter((entry) => entry.op === 'add')).toHaveLength(2);
    });
    const closing = session.close();
    progress.resolve(undefined);
    await closing;
    await delivery;

    expect(bot.reactionOps.map((entry) => entry.op)).toEqual([
      'add',
      'add',
      'remove',
      'remove',
    ]);
  });
});
