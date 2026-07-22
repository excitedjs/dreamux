import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AgentRuntimeTurnResult, DreamuxLogger } from '@excitedjs/dreamux-types';
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
      submitTurn: vi.fn(async (input): Promise<AgentRuntimeTurnResult> => {
        submitted.push(input.sourceId);
        return { status: 'submitted', turnId: `turn-${input.sourceId}` };
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
      submitTurn: async (): Promise<AgentRuntimeTurnResult> => ({
        status: 'submitted',
        turnId: 'unexpected',
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
      submitTurn: async (input): Promise<AgentRuntimeTurnResult> => {
        submitted.push(input.sourceId);
        return { status: 'submitted', turnId: `turn-${input.sourceId}` };
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
});
