import { afterEach, describe, expect, it } from 'vitest';

import type { DreamuxLogger } from '@excitedjs/dreamux-types';
import type {
  FeishuMessageReadItem,
  FeishuMessageReadResponse,
  InboundContentPart,
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
    contentParts: [{ kind: 'text', text: `(${messageType} message)` }],
    mentions: [],
    createTime: '1710000000000',
    raw: {},
    ...overrides,
  };
}

/** The literal characters the enriched body kept as text. */
function textOf(parts: InboundContentPart[]): string {
  return parts
    .flatMap((part) => (part.kind === 'text' ? [part.text] : []))
    .join('');
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

describe('interactive message enrichment', () => {
  it('keeps exact normalized-line semantics when merging the two reads', async () => {
    const bot = createFakeFeishuBot();
    bot.setMessageRead('om_root', 'user_card_content', response(item(
      'om_root',
      'interactive',
      {
        body: {
          elements: [{
            tag: 'markdown',
            content: 'Same\r\nEdges\rA  B\nx/y\nhttps://a.example\n**Case**\nCase',
          }],
        },
      },
    )));
    bot.setMessageRead('om_root', 'default', response(item(
      'om_root',
      'interactive',
      {
        elements: [[{
          tag: 'text',
          text: ' Same \nEdges\nA B\nxy\nhttps://b.example\n**case**\ncase',
        }]],
      },
    )));

    const result = await enrichFeishuInbound(
      event('interactive'),
      bot,
      work(),
      logger(),
    );

    const body = textOf(result.contentParts);
    expect(body).toContain('Same\nEdges\nA  B')
    expect(body).toContain('Additional rendered card content:')
    expect(body).toContain('A B')
    expect(body).toContain('xy')
    expect(body).toContain('https://b.example')
    expect(body).toContain('**case**')
    expect(body).toContain('\ncase')
    expect(body.match(/^Edges$/gm)).toHaveLength(1)
    expect(bot.messageReadRequests).toEqual([
      { messageId: 'om_root', cardContent: 'user_card_content' },
      { messageId: 'om_root', cardContent: 'default' },
    ])
  });

  it('keeps the accepted event when neither read has a matching root', async () => {
    const bot = createFakeFeishuBot();
    const mismatch = response(item('om_other', 'interactive', { elements: [] }));
    bot.setMessageRead('om_root', 'user_card_content', mismatch);
    bot.setMessageRead('om_root', 'default', mismatch);
    const original = event('interactive', {
      contentParts: [{ kind: 'text', text: 'event fallback' }],
    });

    const result = await enrichFeishuInbound(original, bot, work(), logger());

    expect(result.contentParts).toEqual([
      { kind: 'text', text: 'event fallback' },
    ]);
    expect(result.senderId).toBe('ou_authorized');
    expect(result.contentIncomplete).toBe(true);
  });
});

describe('nonsupport resolution', () => {
  it('reparses only a matching authoritative root and preserves routing identity', async () => {
    const bot = createFakeFeishuBot();
    bot.setMessageRead('om_root', 'default', response(item(
      'om_root',
      'audio',
      { file_key: 'voice-key' },
    )));

    const result = await enrichFeishuInbound(
      event('nonsupport'),
      bot,
      work(),
      logger(),
    );

    expect(result.messageType).toBe('audio');
    expect(result.contentParts).toEqual([{
      kind: 'resource',
      resource: { type: 'file', key: 'voice-key', name: 'voice.opus' },
    }]);
    expect(result.senderId).toBe('ou_authorized');
    expect(result.senderName).toBe('Authorized sender');
  });

  it('stops at a lazy lookup when the authoritative type is merged-forward', async () => {
    const bot = createFakeFeishuBot();
    bot.setMessageRead('om_root', 'default', response(
      item('om_root', 'merge_forward', {}),
      item('om_child', 'text', { text: 'must stay hidden' }),
    ));

    const result = await enrichFeishuInbound(
      event('nonsupport'),
      bot,
      work(),
      logger(),
    );

    expect(result.messageType).toBe('merge_forward');
    expect(result.contentParts).toEqual([]);
    expect(result.contentIncomplete).toBe(false);
    expect(bot.messageReadRequests).toEqual([
      { messageId: 'om_root', cardContent: 'default' },
    ]);
  });
});

describe('lazy message lookup', () => {
  it('does not reread or expand a top-level merged-forward message', async () => {
    const bot = createFakeFeishuBot();

    const result = await enrichFeishuInbound(
      event('merge_forward'),
      bot,
      work(),
      logger(),
    );

    expect(result.contentParts).toEqual([]);
    expect(result.contentIncomplete).toBe(false);
    expect(bot.messageReadRequests).toEqual([]);
  });

  it('reads only an actionable parent of a top-level merged-forward message', async () => {
    const bot = createFakeFeishuBot();
    bot.setMessageRead('om_parent', 'default', response(
      item('om_parent', 'post', { title: 'must stay hidden' }),
    ));

    const result = await enrichFeishuInbound(
      event('merge_forward', { parentId: 'om_parent' }),
      bot,
      work(),
      logger(),
    );

    expect(result.parentMessageType).toBe('post');
    expect(result.contentParts).toEqual([]);
    expect(bot.messageReadRequests).toEqual([
      { messageId: 'om_parent', cardContent: 'default' },
    ]);
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
    bot.setMessageRead('om_parent', 'default', response(
      item('om_parent', parentMessageType, { secret: 'must stay hidden' }),
      item('om_child', 'text', { text: 'child must stay hidden' }),
    ));

    const result = await enrichFeishuInbound(
      event('text', {
        rawContent: JSON.stringify({ text: 'current body' }),
        contentParts: [{ kind: 'text', text: 'current body' }],
        parentId: 'om_parent',
      }),
      bot,
      work(),
      logger(),
    );

    expect(result.parentMessageType).toBe(parentMessageType);
    expect(result.contentParts).toEqual([
      { kind: 'text', text: 'current body' },
    ]);
    expect(bot.messageReadRequests).toEqual([
      { messageId: 'om_parent', cardContent: 'default' },
    ]);
  });

  it('omits invalid parent types and skips non-actionable ancestry reads', async () => {
    const bot = createFakeFeishuBot();
    bot.setMessageRead('om_parent', 'default', response(
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
    expect(bot.messageReadRequests).toEqual([
      { messageId: 'om_parent', cardContent: 'default' },
    ]);
  });

  it.each([
    response(item('om_other', 'text', { text: 'mismatched' })),
    response(item('om_parent', 'text', { text: 'deleted' }, { deleted: true })),
    response(item('om_parent', 'text', '', { malformed: true })),
  ])('omits the parent type for an unusable root', async (parentResponse) => {
    const bot = createFakeFeishuBot();
    bot.setMessageRead('om_parent', 'default', parentResponse);

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
