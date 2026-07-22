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
    parsedText: `(${messageType} message)`,
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

    expect(result.parsedText).toContain('Same\nEdges\nA  B')
    expect(result.parsedText).toContain('Additional rendered card content:')
    expect(result.parsedText).toContain('A B')
    expect(result.parsedText).toContain('xy')
    expect(result.parsedText).toContain('https://b.example')
    expect(result.parsedText).toContain('**case**')
    expect(result.parsedText).toContain('\ncase')
    expect(result.parsedText.match(/^Edges$/gm)).toHaveLength(1)
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
    const original = event('interactive', { parsedText: 'event fallback' });

    const result = await enrichFeishuInbound(original, bot, work(), logger());

    expect(result.parsedText).toBe('event fallback');
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
      { sender: { id: 'ou_untrusted_replacement', type: 'user', name: 'Mallory' } },
    )));

    const result = await enrichFeishuInbound(
      event('nonsupport'),
      bot,
      work(),
      logger(),
    );

    expect(result.messageType).toBe('audio');
    expect(result.parsedText).toBe('[voice message attachment: voice-key]');
    expect(result.resources).toEqual([
      { type: 'file', key: 'voice-key', name: 'voice.opus' },
    ]);
    expect(result.senderId).toBe('ou_authorized');
    expect(result.senderName).toBe('Authorized sender');
  });

  it('continues into merged-forward expansion when that is the authoritative type', async () => {
    const bot = createFakeFeishuBot();
    bot.setMessageRead('om_root', 'default', response(
      item('om_root', 'merge_forward', {}),
      item('om_child', 'text', { text: 'resolved child' }, {
        upperMessageId: 'om_root',
        sender: { id: 'ou_child', type: 'user', name: 'Child' },
      }),
    ));

    const result = await enrichFeishuInbound(
      event('nonsupport'),
      bot,
      work(),
      logger(),
    );

    expect(result.messageType).toBe('merge_forward');
    expect(result.parsedText).toContain('Child (text)');
    expect(result.parsedText).toContain('resolved child');
    expect(bot.messageReadRequests).toEqual([
      { messageId: 'om_root', cardContent: 'default' },
    ]);
  });
});

describe('merged-forward expansion', () => {
  it('walks one top-level response in stable order and never reads children', async () => {
    const bot = createFakeFeishuBot();
    bot.setMessageRead('om_root', 'user_card_content', response(
      item('om_root', 'merge_forward', {}),
      item('om_a', 'post', {
        zh_cn: {
          title: 'First',
          content: [[{ tag: 'img', image_key: 'shared-image' }]],
        },
      }, {
        upperMessageId: 'om_root',
        sender: { id: 'ou_a', type: 'user', name: 'Ada' },
      }),
      item('om_nested', 'merge_forward', {}, {
        upperMessageId: 'om_root',
        sender: { id: 'ou_b', type: 'user', name: 'Bob' },
      }),
      item('om_b', 'image', { image_key: 'shared-image' }, {
        upperMessageId: 'om_nested',
        sender: { id: 'ou_c', type: 'user', name: 'Chen' },
      }),
      item('om_orphan', 'text', { text: 'orphan body' }, {
        upperMessageId: 'om_missing',
      }),
      item('om_a', 'text', { text: 'duplicate body' }, {
        upperMessageId: 'om_root',
      }),
    ));

    const result = await enrichFeishuInbound(
      event('merge_forward'),
      bot,
      work(),
      logger(),
    );

    expect(result.parsedText).toContain('Merged forwarded messages:')
    expect(result.parsedText.indexOf('Ada (post)')).toBeLessThan(
      result.parsedText.indexOf('Bob: [nested merged-forward message]'),
    )
    expect(result.parsedText).toContain('Chen (image)')
    expect(result.parsedText).toContain('Unattached forwarded items:')
    expect(result.parsedText).toContain('orphan body')
    expect(result.parsedText).toContain('duplicate message id')
    expect(result.resources).toEqual([
      { type: 'image', key: 'shared-image', name: 'shared-image.jpg' },
    ])
    expect(result.contentIncomplete).toBe(true)
    expect(bot.messageReadRequests).toEqual([
      { messageId: 'om_root', cardContent: 'user_card_content' },
    ])
  });

  it('preserves localized note markdown in a forwarded child card', async () => {
    const bot = createFakeFeishuBot();
    bot.setMessageRead('om_root', 'user_card_content', response(
      item('om_root', 'merge_forward', {}),
      item('om_card', 'interactive', {
        header: {
          title: {
            tag: 'plain_text',
            i18n: { en_us: 'English title', zh_cn: '中文标题' },
          },
        },
        i18n_elements: {
          en_us: [{ tag: 'note', elements: [{ tag: 'lark_md', content: 'English note' }] }],
          zh_cn: [{ tag: 'note', elements: [{ tag: 'lark_md', content: '可见备注' }] }],
        },
      }, {
        upperMessageId: 'om_root',
        sender: { id: 'ou_card', type: 'bot', name: 'Card bot' },
      }),
    ));

    const result = await enrichFeishuInbound(
      event('merge_forward'),
      bot,
      work(),
      logger(),
    );

    expect(result.parsedText).toContain('中文标题');
    expect(result.parsedText).toContain('可见备注');
    expect(result.parsedText).not.toContain('unsupported card component');
  });

  it('uses at most one default-mode fallback and still performs zero child reads', async () => {
    const bot = createFakeFeishuBot();
    bot.setMessageRead(
      'om_root',
      'user_card_content',
      new Error('structured unavailable'),
    );
    bot.setMessageRead('om_root', 'default', response(
      item('om_root', 'merge_forward', {}),
      item('om_child', 'text', { text: 'fallback child' }, {
        upperMessageId: 'om_root',
      }),
    ));

    const result = await enrichFeishuInbound(
      event('merge_forward'),
      bot,
      work(),
      logger(),
    );

    expect(result.parsedText).toContain('fallback child')
    expect(bot.messageReadRequests).toEqual([
      { messageId: 'om_root', cardContent: 'user_card_content' },
      { messageId: 'om_root', cardContent: 'default' },
    ])
  });

  it('bounds descendant count and nesting depth with stable omission markers', async () => {
    const bot = createFakeFeishuBot();
    const descendants = Array.from({ length: 501 }, (_, index) => item(
      `om_wide_${index}`,
      'text',
      { text: `wide-${index}` },
      { upperMessageId: 'om_root' },
    ));
    let parentId = 'om_root';
    const deep = Array.from({ length: 6 }, (_, index) => {
      const messageId = `om_deep_${index}`;
      const value = item(messageId, 'merge_forward', {}, {
        upperMessageId: parentId,
      });
      parentId = messageId;
      return value;
    });
    bot.setMessageRead('om_root', 'user_card_content', response(
      item('om_root', 'merge_forward', {}),
      ...deep,
      ...descendants,
    ));

    const result = await enrichFeishuInbound(
      event('merge_forward'),
      bot,
      work(),
      logger(),
    );

    expect(result.parsedText).toContain('depth limit reached');
    expect(result.parsedText).toContain('item(s) omitted: item limit reached');
    expect(result.contentIncomplete).toBe(true);
  });
});
