import { afterEach, describe, expect, it } from 'vitest';

import type { DreamuxLogger } from '@excitedjs/dreamux-types';
import type {
  FeishuMessageReadItem,
  FeishuMessageReadResponse,
} from '@excitedjs/feishu-transport';

import type { FeishuInboundEvent } from '../src/bot.js';
import { enrichFeishuInbound } from '../src/feishu-inbound-enrichment.js';
import {
  alwaysActiveSessionFence,
  createFeishuInboundWork,
  type FeishuInboundWorkContext,
} from '../src/feishu-inbound-work.js';
import { createFakeFeishuBot } from './helpers/fake-feishu-bot.js';

const works: FeishuInboundWorkContext[] = [];

afterEach(() => {
  for (const work of works.splice(0)) work.dispose();
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

function work(): FeishuInboundWorkContext {
  const value = createFeishuInboundWork(alwaysActiveSessionFence());
  works.push(value);
  return value;
}

function event(
  messageType: string,
  overrides: Partial<FeishuInboundEvent> = {},
): FeishuInboundEvent {
  return {
    messageId: 'om_root',
    chatId: 'oc_chat',
    chatType: 'group',
    senderId: 'ou_authorized',
    senderType: 'user',
    senderName: 'Authorized sender',
    messageType,
    rawContent: '{}',
    text: `(${messageType} message)`,
    resources: [],
    mentions: [],
    createTime: '1710000000000',
    raw: {},
    ...overrides,
  };
}

function item(
  messageId: string,
  messageType: string,
  content: unknown,
  overrides: Partial<FeishuMessageReadItem> = {},
): FeishuMessageReadItem {
  return {
    messageId,
    messageType,
    content: typeof content === 'string' ? content : JSON.stringify(content),
    mentions: [],
    deleted: false,
    malformed: false,
    chatId: 'oc_room',
    ...overrides,
  };
}

function response(...items: FeishuMessageReadItem[]): FeishuMessageReadResponse {
  return { items };
}

describe('nonsupport resolution', () => {
  it('adopts a matching authoritative root and preserves routing identity', async () => {
    const bot = createFakeFeishuBot();
    bot.setMessageRead('om_root', response(item(
      'om_root',
      'audio',
      { file_key: 'voice-key' },
      { mentions: [{ key: '@_user_1', id: { open_id: 'ou_x' }, name: 'X' }] },
    )));

    const result = await enrichFeishuInbound(
      event('nonsupport', { contentIncomplete: true }),
      bot,
      work(),
      logger(),
    );

    expect(result.messageType).toBe('audio');
    expect(result.text).toBe('voice-key');
    expect(result.resources).toEqual([
      { type: 'file', key: 'voice-key', name: 'voice.opus' },
    ]);
    expect(result.mentions).toEqual([
      { key: '@_user_1', id: { open_id: 'ou_x' }, name: 'X' },
    ]);
    expect(result.contentIncomplete).toBeUndefined();
    expect(result.senderId).toBe('ou_authorized');
    expect(result.senderName).toBe('Authorized sender');
    expect(bot.messageReadRequests).toEqual([{ messageId: 'om_root' }]);
  });

  it('stops at a lazy lookup when the authoritative type is merged-forward', async () => {
    const bot = createFakeFeishuBot();
    bot.setMessageRead('om_root', response(
      item('om_root', 'merge_forward', ''),
      item('om_child', 'text', { text: 'must stay hidden' }),
    ));

    const result = await enrichFeishuInbound(
      event('nonsupport', { contentIncomplete: true }),
      bot,
      work(),
      logger(),
    );

    expect(result.messageType).toBe('merge_forward');
    expect(result.text).toBe('');
    expect(result.resources).toEqual([]);
    expect(result.contentIncomplete).toBeUndefined();
    expect(bot.messageReadRequests).toEqual([{ messageId: 'om_root' }]);
  });

  it('keeps the accepted event when the read has no matching root', async () => {
    const bot = createFakeFeishuBot();
    bot.setMessageRead('om_root', response(item('om_other', 'text', { text: 'x' })));
    const original = event('nonsupport', { contentIncomplete: true });

    const result = await enrichFeishuInbound(original, bot, work(), logger());

    expect(result).toEqual(original);
  });
});

describe('messages that carry their whole body', () => {
  it.each(['text', 'post', 'interactive', 'image'])(
    'never reads a %s message back',
    async (messageType) => {
      const bot = createFakeFeishuBot();

      const result = await enrichFeishuInbound(
        event(messageType, { text: 'event body' }),
        bot,
        work(),
        logger(),
      );

      expect(result.text).toBe('event body');
      expect(bot.messageReadRequests).toEqual([]);
    },
  );
});

describe('lazy message lookup', () => {
  it('does not reread or expand a top-level merged-forward message', async () => {
    const bot = createFakeFeishuBot();

    const result = await enrichFeishuInbound(
      event('merge_forward', { text: '' }),
      bot,
      work(),
      logger(),
    );

    expect(result.text).toBe('');
    expect(result.resources).toEqual([]);
    expect(bot.messageReadRequests).toEqual([]);
  });

  it('reads only an actionable parent of a top-level merged-forward message', async () => {
    const bot = createFakeFeishuBot();
    bot.setMessageRead('om_parent', response(
      item('om_parent', 'post', { title: 'must stay hidden' }),
    ));

    const result = await enrichFeishuInbound(
      event('merge_forward', { text: '', parentId: 'om_parent' }),
      bot,
      work(),
      logger(),
    );

    expect(result.parentMessageType).toBe('post');
    expect(result.text).toBe('');
    expect(bot.messageReadRequests).toEqual([{ messageId: 'om_parent' }]);
  });

  it.each([
    'text',
    'post',
    'interactive',
    'merge_forward',
    'image',
    'future_type.v2',
  ])('projects the validated parent type %s without consuming its content', async (
    parentMessageType,
  ) => {
    const bot = createFakeFeishuBot();
    bot.setMessageRead('om_parent', response(
      item('om_parent', parentMessageType, { secret: 'must stay hidden' }),
      item('om_child', 'text', { text: 'child must stay hidden' }),
    ));

    const result = await enrichFeishuInbound(
      event('text', {
        rawContent: JSON.stringify({ text: 'current body' }),
        text: 'current body',
        parentId: 'om_parent',
      }),
      bot,
      work(),
      logger(),
    );

    expect(result.parentMessageType).toBe(parentMessageType);
    expect(result.text).toBe('current body');
    expect(bot.messageReadRequests).toEqual([{ messageId: 'om_parent' }]);
  });

  it('omits invalid parent types and skips non-actionable ancestry reads', async () => {
    const bot = createFakeFeishuBot();
    bot.setMessageRead('om_parent', response(
      item('om_parent', 'invalid type!', { secret: true }),
    ));

    const invalid = await enrichFeishuInbound(
      event('text', { parentId: 'om_parent' }),
      bot,
      work(),
      logger(),
    );
    const threadRoot = await enrichFeishuInbound(
      event('text', {
        parentId: 'om_thread_root',
        rootId: 'om_thread_root',
        threadId: 'omt_topic',
      }),
      bot,
      work(),
      logger(),
    );

    expect(invalid.parentMessageType).toBeUndefined();
    expect(threadRoot.parentMessageType).toBeUndefined();
    expect(bot.messageReadRequests).toEqual([{ messageId: 'om_parent' }]);
  });

  it.each([
    response(item('om_other', 'text', { text: 'mismatched' })),
    response(item('om_parent', 'text', { text: 'deleted' }, { deleted: true })),
    response(item('om_parent', 'text', '', { malformed: true })),
  ])('omits the parent type for an unusable root', async (parentResponse) => {
    const bot = createFakeFeishuBot();
    bot.setMessageRead('om_parent', parentResponse);

    const result = await enrichFeishuInbound(
      event('text', { parentId: 'om_parent' }),
      bot,
      work(),
      logger(),
    );

    expect(result.parentMessageType).toBeUndefined();
    expect(result.contentIncomplete).toBeUndefined();
  });
});
