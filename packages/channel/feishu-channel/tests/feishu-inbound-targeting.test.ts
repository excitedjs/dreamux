/**
 * Message identity is pure and owned by `messageTarget` in `routing/target.ts`
 * (its own consumers are the extension identity paths). These tests pin what
 * `FeishuInboundTargeting` adds beside it: the per-projection observation that
 * grants automatic Team provisioning, and the stable chat-kind knowledge the
 * card-click gate reads. A group's thread names a topic whatever its current
 * message format is, only a verified topic format grants permission, and the
 * mutable format is never remembered while the stable chat kind is.
 */
import { describe, expect, it } from 'vitest';

import type { DreamuxLogger } from '@excitedjs/dreamux-types';
import type { FeishuInboundEvent } from '@excitedjs/feishu-transport';

import { FeishuInboundTargeting } from '../src/inbound/target.js';
import { chatTarget, topicTarget } from '../src/routing/target.js';
import { createFakeFeishuBot } from './helpers/fake-feishu-bot.js';

const log: DreamuxLogger = {
  error: () => undefined,
  warn: () => undefined,
  info: () => undefined,
  debug: () => undefined,
  trace: () => undefined,
  child: () => log,
};

function eventAt(place: {
  chatId: string;
  chatType?: string;
  threadId?: string;
}): FeishuInboundEvent {
  return {
    messageId: 'om_in',
    chatId: place.chatId,
    chatType: place.chatType ?? 'group',
    ...(place.threadId === undefined ? {} : { threadId: place.threadId }),
    senderId: 'ou_human',
    senderType: 'user',
    senderName: 'Human',
    messageType: 'text',
    rawContent: '{"text":"hello"}',
    text: 'hello',
    resources: [],
    mentions: [],
    createTime: '1',
    raw: {},
  };
}

describe('FeishuInboundTargeting — identity is pure and format-independent', () => {
  it('projects a group message with a thread as a topic in the topic message format', async () => {
    const bot = createFakeFeishuBot();
    bot.setChatMode('oc_chat', 'topic');
    const targeting = new FeishuInboundTargeting({ chatModes: bot, log });

    const route = await targeting.projectInbound(
      eventAt({ chatId: 'oc_chat', threadId: 'omt_old' }),
    );

    expect(route).toEqual({
      target: topicTarget('oc_chat', 'omt_old'),
      canProvision: true,
    });
  });

  it('keeps a chat-format thread a topic and withholds provisioning', async () => {
    const bot = createFakeFeishuBot();
    bot.setChatMode('oc_chat', 'group');
    const targeting = new FeishuInboundTargeting({ chatModes: bot, log });

    const route = await targeting.projectInbound(
      eventAt({ chatId: 'oc_chat', threadId: 'omt_old' }),
    );

    expect(route).toEqual({
      target: topicTarget('oc_chat', 'omt_old'),
      canProvision: false,
    });
  });

  it('keeps the topic identity when the format lookup fails, and withholds provisioning', async () => {
    const bot = createFakeFeishuBot();
    bot.setChatMode('oc_chat', new Error('feishu refused the read'));
    const targeting = new FeishuInboundTargeting({ chatModes: bot, log });

    await expect(
      targeting.projectInbound(
        eventAt({ chatId: 'oc_chat', threadId: 'omt_old' }),
      ),
    ).resolves.toEqual({
      target: topicTarget('oc_chat', 'omt_old'),
      canProvision: false,
    });
  });

  it('keeps the topic identity when the lookup reports no recognized format', async () => {
    const bot = createFakeFeishuBot();
    bot.setChatMode('oc_chat', undefined);
    const targeting = new FeishuInboundTargeting({ chatModes: bot, log });

    await expect(
      targeting.projectInbound(
        eventAt({ chatId: 'oc_chat', threadId: 'omt_old' }),
      ),
    ).resolves.toEqual({
      target: topicTarget('oc_chat', 'omt_old'),
      canProvision: false,
    });
  });

  it('keeps the topic identity when the lookup times out', async () => {
    const bot = createFakeFeishuBot();
    bot.getChatMode = () => new Promise(() => undefined);
    const targeting = new FeishuInboundTargeting({ chatModes: bot, log });

    await expect(
      targeting.projectInbound(
        eventAt({ chatId: 'oc_chat', threadId: 'omt_old' }),
      ),
    ).resolves.toEqual({
      target: topicTarget('oc_chat', 'omt_old'),
      canProvision: false,
    });
  }, 5_000);

  it('a direct chat stays direct even when the event names a thread', async () => {
    const bot = createFakeFeishuBot();
    const targeting = new FeishuInboundTargeting({ chatModes: bot, log });

    await expect(
      targeting.projectInbound(
        eventAt({ chatId: 'oc_dm', chatType: 'p2p', threadId: 'omt_x' }),
      ),
    ).resolves.toEqual({
      target: chatTarget('oc_dm', 'p2p'),
      canProvision: false,
    });
  });

  it('a message with no thread is the chat target and costs no format lookup', async () => {
    const bot = createFakeFeishuBot();
    bot.setChatMode('oc_chat', 'topic');
    const targeting = new FeishuInboundTargeting({ chatModes: bot, log });

    const route = await targeting.projectInbound(
      eventAt({ chatId: 'oc_chat' }),
    );

    expect(route).toEqual({
      target: chatTarget('oc_chat', 'group'),
      canProvision: false,
    });
    // A top-level target can never provision, so its format is not asked for.
    expect(bot.chatModeRequests).toEqual([]);
  });
});

describe('FeishuInboundTargeting — eligibility is observed fresh', () => {
  it('sees a format switch between projections of the same topic', async () => {
    const bot = createFakeFeishuBot();
    const targeting = new FeishuInboundTargeting({ chatModes: bot, log });
    const topic = topicTarget('oc_chat', 'omt_old');

    bot.setChatMode('oc_chat', 'topic');
    await expect(targeting.project(topic)).resolves.toMatchObject({
      canProvision: true,
    });
    // The operator switches the group to chat message format in between.
    bot.setChatMode('oc_chat', 'group');
    await expect(targeting.project(topic)).resolves.toMatchObject({
      canProvision: false,
    });
    // And back again — no re-registration, no restart, no stale permission.
    bot.setChatMode('oc_chat', 'topic');
    await expect(targeting.project(topic)).resolves.toMatchObject({
      canProvision: true,
    });
    expect(bot.chatModeRequests).toEqual(['oc_chat', 'oc_chat', 'oc_chat']);
  });

  it('shares one in-flight lookup between concurrent projections, then fetches again', async () => {
    const bot = createFakeFeishuBot();
    let release!: (mode: 'topic' | 'group') => void;
    let first = true;
    bot.getChatMode = (chatId: string) => {
      bot.chatModeRequests.push(chatId);
      // Later lookups answer the chat's current format: chat message format.
      if (!first) return Promise.resolve('group' as const);
      first = false;
      return new Promise((resolve) => {
        release = resolve;
      });
    };
    const targeting = new FeishuInboundTargeting({ chatModes: bot, log });
    const topic = topicTarget('oc_chat', 'omt_old');

    const one = targeting.project(topic);
    const two = targeting.project(topic);
    release('topic');
    await expect(one).resolves.toMatchObject({ canProvision: true });
    await expect(two).resolves.toMatchObject({ canProvision: true });
    expect(bot.chatModeRequests).toEqual(['oc_chat']);

    // A later projection is a later observation: the shared result is gone and
    // the operator's switch to chat message format is seen at once.
    await expect(targeting.project(topic)).resolves.toMatchObject({
      canProvision: false,
    });
    expect(bot.chatModeRequests).toEqual(['oc_chat', 'oc_chat']);
  });
});

describe('FeishuInboundTargeting — stable chat kinds for the card-click gate', () => {
  it('takes the kind an accepted event reported, with no lookup', async () => {
    const bot = createFakeFeishuBot();
    bot.setChatMode('oc_group', 'group');
    bot.setChatMode('oc_dm', 'p2p');
    const targeting = new FeishuInboundTargeting({ chatModes: bot, log });

    await targeting.projectInbound(eventAt({ chatId: 'oc_group' }));
    await targeting.projectInbound(
      eventAt({ chatId: 'oc_dm', chatType: 'p2p' }),
    );

    await expect(targeting.chatType('oc_group')).resolves.toBe('group');
    await expect(targeting.chatType('oc_dm')).resolves.toBe('p2p');
    expect(bot.chatModeRequests).toEqual([]);
  });

  it('establishes the kind from a successful lookup, and reports nothing when the lookup fails', async () => {
    const bot = createFakeFeishuBot();
    bot.setChatMode('oc_native', 'topic');
    bot.setChatMode('oc_converted', 'group');
    bot.setChatMode('oc_dm', 'p2p');
    bot.setChatMode('oc_broken', new Error('feishu refused the read'));
    const targeting = new FeishuInboundTargeting({ chatModes: bot, log });

    // A topic-format chat is a group whatever native or converted — the kind
    // is stable; only the format it grants is mutable.
    await expect(targeting.chatType('oc_native')).resolves.toBe('group');
    await expect(targeting.chatType('oc_converted')).resolves.toBe('group');
    await expect(targeting.chatType('oc_dm')).resolves.toBe('p2p');
    await expect(targeting.chatType('oc_broken')).resolves.toBeUndefined();
    expect(bot.chatModeRequests).toEqual([
      'oc_native',
      'oc_converted',
      'oc_dm',
      'oc_broken',
    ]);
  });
});
