/**
 * An ask-card answer is a channel message, and it arrives where the card is.
 *
 * Two things are settled here and nowhere else. The envelope is built by hand
 * in `feishu-session-ops.ts` rather than by the inbound formatter, so nothing
 * but this test keeps the two in step: what matters is the `source` attribute
 * and its position, because the model reads `<channel source="feishu" …>` and
 * ties the answer to the `channel-feishu` MCP server whose tools it must use to
 * reply, exactly as it does for an ordinary inbound message.
 *
 * And where the answer goes is read back from the card itself. The round is
 * opened before its card exists, so it cannot know where Feishu put one — a
 * question sent as a reply lands in the replied-to message's topic — which is
 * why every settlement asks Feishu where its card is, and why a card that
 * cannot be found is delivered nowhere at all.
 */
import { describe, expect, it, vi } from 'vitest';

import { createAskUserRegistry } from '../src/feishu-ask-user.js';
import {
  DREAMUX_ASK_CANCEL_ACTION,
  DREAMUX_ASK_OPTION_KEY,
  DREAMUX_ASK_PICK_ACTION,
  DREAMUX_ASK_QUESTION_KEY,
  DREAMUX_ASK_REQUEST_KEY,
  DREAMUX_ASK_SUBMIT_ACTION,
  type AskUserQuestionSpec,
} from '../src/feishu-ask-user-card.js';
import { DREAMUX_ACTION_KEY } from '../src/feishu-pairing-card.js';
import { FeishuTargetRouter } from '../src/feishu-target-router.js';
import {
  askUserQuestion,
  expireAskUserQuestion,
  handleCardAction,
  sessionHandle,
  type SessionHandle,
} from '../src/feishu-session-ops.js';
import { CHANNEL_REMINDER } from '../src/feishu-submit.js';
import type { FeishuInboundDelivery } from '../src/feishu-submit.js';
import { AsyncMutex } from '../src/lib/mutex.js';
import { chatTarget, topicTarget } from '../src/routing/target.js';
import { createFakeFeishuBot, type FakeFeishuBot } from './helpers/fake-feishu-bot.js';

const silent = {
  error: () => undefined,
  warn: () => undefined,
  info: () => undefined,
  debug: () => undefined,
  trace: () => undefined,
};

const QUESTIONS: readonly AskUserQuestionSpec[] = [
  {
    header: 'Choice',
    question: 'Which option?',
    options: [
      { label: 'First', description: 'Use the first option' },
      { label: 'Second', description: 'Use the second option' },
    ],
  },
];

type Delivered = Parameters<FeishuInboundDelivery['deliver']>[0];

function capturingDelivery(): {
  delivery: FeishuInboundDelivery;
  delivered: Delivered[];
} {
  const delivered: Delivered[] = [];
  return {
    delivered,
    delivery: {
      async deliver(input) {
        delivered.push(input);
        return { status: 'submitted', turnId: 'turn-1' };
      },
      // This suite is about the submission envelope; a command never builds one.
      async command() {
        throw new Error('this suite delivers messages, not commands');
      },
    },
  };
}

function handle(
  delivery: FeishuInboundDelivery,
  bot: FakeFeishuBot = createFakeFeishuBot(),
): SessionHandle {
  return sessionHandle({
    opts: {
      dispatcherId: 'dispatcher-1',
      channelId: 'channel-1',
      appId: 'app-1',
      appSecret: '',
      stateDir: '/tmp/unused-state',
      attachmentCacheDir: '/tmp/unused-cache',
      log: silent,
      botFactory: () => bot,
    },
    bot,
    accessMutex: new AsyncMutex(),
    botDisplayName: 'Dreamux bot',
    targetRouter: new FeishuTargetRouter({ chatModes: bot, log: silent }),
    delivery,
    askUser: createAskUserRegistry(),
  });
}

/** What Feishu will report about a card the session sent. */
function cardSitsIn(
  bot: FakeFeishuBot,
  messageId: string,
  place: { chatId: string; threadId?: string },
): void {
  bot.setMessageRead(messageId, 'default', {
    items: [{
      messageId,
      messageType: 'interactive',
      content: '{}',
      mentions: [],
      deleted: false,
      malformed: false,
      chatId: place.chatId,
      ...(place.threadId !== undefined ? { threadId: place.threadId } : {}),
    }],
  });
}

/** Ask a question and answer the card it sent, as a user's two clicks would. */
async function clickThrough(
  h: SessionHandle,
  cardMessageId: string,
  requestId: string,
  last: string = DREAMUX_ASK_SUBMIT_ACTION,
): Promise<void> {
  for (const action of [DREAMUX_ASK_PICK_ACTION, last]) {
    await handleCardAction(h, {
      actionValue: {
        [DREAMUX_ACTION_KEY]: action,
        [DREAMUX_ASK_REQUEST_KEY]: requestId,
        [DREAMUX_ASK_QUESTION_KEY]: 0,
        [DREAMUX_ASK_OPTION_KEY]: 0,
      },
      openMessageId: cardMessageId,
      operatorOpenId: 'ou_clicker',
      raw: {},
    });
  }
}

/** A click hands the answer to Core detached, so its arrival is awaited here. */
async function answers(delivered: Delivered[], count: number): Promise<void> {
  await vi.waitFor(() => expect(delivered).toHaveLength(count));
}

describe('sending the question card', () => {
  it('replies to the message the model named, seen before or not', async () => {
    const bot = createFakeFeishuBot();
    const h = handle(capturingDelivery().delivery, bot);

    await askUserQuestion(h, {
      chatId: 'oc_room',
      // Nothing in this session has ever seen this message. An explicit id is
      // obeyed anyway, exactly as `reply` obeys one.
      messageId: 'om_never_observed',
      questions: QUESTIONS,
    });

    expect(bot.sentCards[0]?.target).toEqual({
      chatId: 'oc_room',
      replyToMessageId: 'om_never_observed',
    });
  });

  it('creates a new message when the model named none', async () => {
    const bot = createFakeFeishuBot();
    const h = handle(capturingDelivery().delivery, bot);

    await askUserQuestion(h, { chatId: 'oc_room', questions: QUESTIONS });

    // A question that belongs to no message opens a topic of its own in a
    // topic group, which is what a question about nothing in particular wants.
    expect(bot.sentCards[0]?.target).toEqual({ chatId: 'oc_room' });
  });
});

describe('the ask-card settlement envelope', () => {
  it('carries source="feishu" and the card the answer came from', async () => {
    const { delivery, delivered } = capturingDelivery();
    const bot = createFakeFeishuBot();
    const h = handle(delivery, bot);
    bot.setChatMode('oc_room', 'topic');

    const opened = await askUserQuestion(h, {
      chatId: 'oc_room',
      messageId: 'om_root',
      questions: QUESTIONS,
    });
    const cardId = bot.sentCards[0]?.messageIds[0] ?? '';
    // The card was sent as a reply, so Feishu put it in the root's topic —
    // a place the round that asked the question never knew.
    cardSitsIn(bot, cardId, { chatId: 'oc_room', threadId: 'omt_thread' });

    await clickThrough(h, cardId, opened.request_id);
    await answers(delivered, 1);

    expect(delivered[0]?.target).toEqual(topicTarget('oc_room', 'omt_thread'));
    // The parent chat a Collaboration Space is keyed by; only a topic has one.
    expect(delivered[0]?.containerChatId).toBe('oc_room');
    expect(delivered[0]?.submission.attrs).toMatchObject({
      source: 'feishu',
      chat_id: 'oc_room',
      thread_id: 'omt_thread',
      message_id: cardId,
      sender_id: 'ou_clicker',
      ask_user_request_id: opened.request_id,
    });
    expect(delivered[0]?.submission.anchor).toEqual({
      chatId: 'oc_room',
      messageId: cardId,
      target: topicTarget('oc_room', 'omt_thread'),
    });
    // The same standing note an inbound message carries: an answer leaves the
    // model in the same chat, under the same consequence.
    expect(delivered[0]?.submission.reminder).toBe(CHANNEL_REMINDER);
  });

  it('routes a dismissal from its card too', async () => {
    const { delivery, delivered } = capturingDelivery();
    const bot = createFakeFeishuBot();
    const h = handle(delivery, bot);
    bot.setChatMode('oc_room', 'topic');

    const opened = await askUserQuestion(h, {
      chatId: 'oc_room',
      messageId: 'om_root',
      questions: QUESTIONS,
    });
    const cardId = bot.sentCards[0]?.messageIds[0] ?? '';
    cardSitsIn(bot, cardId, { chatId: 'oc_room', threadId: 'omt_thread' });

    await clickThrough(h, cardId, opened.request_id, DREAMUX_ASK_CANCEL_ACTION);
    await answers(delivered, 1);

    expect(delivered[0]?.target).toEqual(topicTarget('oc_room', 'omt_thread'));
    expect(delivered[0]?.submission.attrs).toMatchObject({ message_id: cardId });
    expect(delivered[0]?.submission.anchor).toEqual({
      chatId: 'oc_room',
      messageId: cardId,
      target: topicTarget('oc_room', 'omt_thread'),
    });
    expect(delivered[0]?.submission.text).toContain('dismissed');
  });

  it('keeps a follow-up question in the topic its answer came from', async () => {
    const { delivery, delivered } = capturingDelivery();
    const bot = createFakeFeishuBot();
    const h = handle(delivery, bot);
    bot.setChatMode('oc_room', 'topic');
    let messageId = 'om_root';

    for (let round = 0; round < 2; round++) {
      const opened = await askUserQuestion(h, {
        chatId: 'oc_room',
        messageId,
        questions: QUESTIONS,
      });
      expect(bot.sentCards[round]?.target).toEqual({
        chatId: 'oc_room',
        replyToMessageId: messageId,
      });
      const cardId = bot.sentCards[round]?.messageIds[0] ?? '';
      cardSitsIn(bot, cardId, { chatId: 'oc_room', threadId: 'omt_thread' });

      await clickThrough(h, cardId, opened.request_id);
      await answers(delivered, round + 1);

      expect(delivered[round]?.target).toEqual(
        topicTarget('oc_room', 'omt_thread'),
      );
      expect(delivered[round]?.submission.attrs['message_id']).toBe(cardId);
      // What the model hands the next question: the card it just answered.
      messageId = String(delivered[round]?.submission.attrs['message_id']);
    }
  });

  it('delivers an ordinary group card to the group, and repaints it', async () => {
    const { delivery, delivered } = capturingDelivery();
    const bot = createFakeFeishuBot();
    const h = handle(delivery, bot);
    cardSitsIn(bot, 'om_card', { chatId: 'oc_room' });

    // Expiry is the settlement path that delivers synchronously; a click
    // detaches delivery and builds the very same submission, from the id its
    // callback reports instead of the id the send recorded.
    await expireAskUserQuestion(h, {
      settlement: {
        requestId: 'req-1',
        outcome: 'expired',
        text: 'The question expired with no answer.',
        sourceId: 'ask:req-1',
        cardMessageId: 'om_card',
      },
      card: {},
    });

    expect(delivered[0]?.target).toEqual(chatTarget('oc_room', 'group'));
    expect(delivered[0]?.containerChatId).toBeNull();
    expect(delivered[0]?.submission.attrs).toMatchObject({
      chat_id: 'oc_room',
      message_id: 'om_card',
    });
    expect(delivered[0]?.submission.attrs['thread_id']).toBeUndefined();
    expect(bot.editedCards).toEqual([{ messageId: 'om_card', card: {} }]);
  });

  it.each([
    ['the lookup fails', new Error('feishu refused the read')],
    ['it reports nothing about the card', { items: [] }],
  ])('delivers nowhere at all when %s', async (_case, read) => {
    const { delivery, delivered } = capturingDelivery();
    const bot = createFakeFeishuBot();
    const h = handle(delivery, bot);
    bot.setMessageRead('om_card', 'default', read);

    await expireAskUserQuestion(h, {
      settlement: {
        requestId: 'req-1',
        outcome: 'expired',
        text: 'The question expired with no answer.',
        sourceId: 'ask:req-1',
        cardMessageId: 'om_card',
      },
      card: {},
    });

    // Not the chat the question was asked from, and not the Dispatcher Agent:
    // a guessed parent chat shows one conversation's answer to another. The
    // repaint is independent and still happens.
    expect(delivered).toHaveLength(0);
    expect(bot.editedCards).toEqual([{ messageId: 'om_card', card: {} }]);
  });
});
