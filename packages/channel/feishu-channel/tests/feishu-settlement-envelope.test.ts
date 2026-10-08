/**
 * An ask-card answer is a channel message, and it arrives where the card is.
 *
 * Two things are settled here and nowhere else. The envelope is built by hand
 * by the card-actions owner using the same chatSubmission builder as inbound, so nothing
 * but this test keeps the two in step: what matters is the `source` attribute
 * and its position, because the model reads `<channel source="feishu" …>` and
 * ties the answer to the `channel-feishu` MCP server whose tools it must use to
 * reply, exactly as it does for an ordinary inbound message.
 *
 * And where the answer goes is read back from the card itself. The round is
 * opened before its card exists, so it cannot know where Feishu put one — a
 * question sent as a reply lands in the replied-to message's topic — which is
 * why a settlement uses its send landing or asks Feishu when none was recorded; a card that
 * cannot be found is delivered nowhere at all.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DreamuxLogger } from '@excitedjs/dreamux-types';
import { TransactionalStore } from '@excitedjs/dreamux-utils';
import {
  createAskUserRegistry,
  type AskUserRegistry,
  type AskUserExpiry,
} from '../src/ask-user/registry.js';
import {
  DREAMUX_ASK_OPTION_KEY,
  DREAMUX_ASK_QUESTION_KEY,
  DREAMUX_ASK_REQUEST_KEY,
  type AskUserQuestionSpec,
} from '../src/cards/ask-user.js';
import {
  DREAMUX_ACTION_KEY,
  DREAMUX_ASK_CANCEL_ACTION,
  DREAMUX_ASK_PICK_ACTION,
  DREAMUX_ASK_SUBMIT_ACTION,
} from '../src/card-actions.js';
import { FeishuInboundTargeting } from '../src/inbound/target.js';
import { FeishuCardActions } from '../src/session/card-actions.js';
import { FeishuAccess } from '../src/access/index.js';
import { defaultDispatcherAccessState } from '../src/access/state.js';
import { FeishuSessionExtensions } from '../src/feishu-extensions.js';
import { FeishuOutbound } from '../src/outbound/index.js';
import { FeishuInboundRouter } from '../src/inbound/router.js';
import { FeishuProvisioning } from '../src/feishu-provisioning.js';
import { FeishuCoreCommands } from '../src/feishu-core-commands.js';
import { FeishuCotAdapter } from '../src/cot/adapter.js';
import { FeishuTeamSubmitter } from '../src/session/submitter.js';
import { createFeishuLifecycle } from '../src/session/lifecycle.js';
import { FeishuBindingOperations } from '../src/routing/operations.js';
import { FeishuRouting } from '../src/routing/index.js';
import { FeishuDocumentComments } from '../src/feishu-document-comments.js';
import {
  CHANNEL_REMINDER,
  type FeishuSubmitOutcome,
} from '../src/feishu-submit.js';
import { chatTarget, topicTarget } from '../src/routing/target.js';
import { CHAT_BOTS_FILENAME, loadChatBots } from '../src/chat-bots-store.js';
import { askUserQuestionDef } from '../src/tools/ask-user-question.js';
import type { FeishuToolSession } from '../src/tools/types.js';
import {
  createFakeFeishuBot,
  type FakeFeishuBot,
} from './helpers/fake-feishu-bot.js';

const silent: DreamuxLogger = {
  error: () => undefined,
  warn: () => undefined,
  info: () => undefined,
  debug: () => undefined,
  trace: () => undefined,
  child: () => silent,
};
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close();
  vi.restoreAllMocks();
});

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

type Delivered = Parameters<FeishuInboundRouter['deliver']>[0];
type CaptureDelivery = (input: Delivered) => Promise<FeishuSubmitOutcome>;
function capturingDelivery(): {
  delivery: CaptureDelivery;
  delivered: Delivered[];
} {
  const delivered: Delivered[] = [];
  return {
    delivered,
    delivery: async (input) => {
      delivered.push(input);
      return { status: 'submitted', turnId: 'turn-1' };
    },
  };
}

interface ActionsHarness {
  actions: FeishuCardActions;
  registry: AskUserRegistry;
  tools: FeishuToolSession;
  bot: FakeFeishuBot;
}

async function handle(
  delivery: CaptureDelivery,
  bot: FakeFeishuBot = createFakeFeishuBot(),
): Promise<ActionsHarness> {
  const stateDir = await mkdtemp(join(tmpdir(), 'dreamux-settlement-'));
  const dispatcherId = 'dispatcher-1';
  const channelId = 'channel-1';
  const log = silent;
  await writeFile(
    join(stateDir, 'access.json'),
    JSON.stringify({
      ...defaultDispatcherAccessState(),
      allow_users: ['ou_clicker'],
      group: { policy: 'follow-user', allow_chats: [], require_mention: true },
    }),
  );
  const lifecycle = createFeishuLifecycle();
  const routing = new FeishuRouting({ dispatcherId, channelId, stateDir });
  await routing.initialize();
  const targetRouter = new FeishuInboundTargeting({ chatModes: bot, log });
  const outbound = new FeishuOutbound({
    channelId,
    dispatcherId,
    bot,
    log,
    lifecycle,
    routing,
    targetRouter,
  });
  const commands = new FeishuCoreCommands();
  commands.initialize({
    invoke: async () => {
      throw new Error('unexpected Core command');
    },
  });
  const cot = new FeishuCotAdapter({
    dispatcherId,
    channelId,
    log,
    lifecycle,
    cotClient: undefined,
  });
  const submitter = new FeishuTeamSubmitter({ lifecycle, cot, commands });
  const bindings = new FeishuBindingOperations({
    dispatcherId,
    channelId,
    log,
    routing,
    cot,
    commands,
    outbound,
  });
  const provisioning = new FeishuProvisioning({
    dispatcherId,
    channelId,
    log,
    routing,
    submitter,
    commands,
    bindings,
  });
  const router = new FeishuInboundRouter({
    log,
    routing,
    bindings,
    provisioning,
    submitter,
    commands,
    bot,
  });
  // Capture only the envelope after the real card-action and placement owners
  // assembled it. Routing/submission behavior has separate owner tests.
  vi.spyOn(router, 'deliver').mockImplementation(delivery);
  const access = new FeishuAccess({ stateDir, dispatcherId, log });
  const registry = createAskUserRegistry();
  const extensions = new FeishuSessionExtensions(undefined, log);
  const actions = new FeishuCardActions({
    dispatcherId,
    log,
    bot,
    access,
    extensions,
    askUser: registry,
    targetRouter,
    outbound,
    router,
  });
  const tools: FeishuToolSession = {
    logger: log,
    channelId,
    outbound,
    cardActions: actions,
    bindings,
    routing,
    chatBotsStore: new TransactionalStore({
      path: join(stateDir, CHAT_BOTS_FILENAME),
      load: () => loadChatBots(stateDir),
    }),
    docComments: new FeishuDocumentComments({
      dispatcherId,
      channelId,
      log,
      routing,
      submitter,
      bot,
      access,
    }),
  };
  cleanup.push(async () => {
    registry.abandonAll();
    lifecycle.abort();
    await cot.close();
    await lifecycle.drain();
    await routing.close();
    await rm(stateDir, { recursive: true, force: true });
  });
  return { actions, registry, tools, bot };
}

async function askUserQuestion(
  h: ActionsHarness,
  input: Omit<Parameters<FeishuCardActions['askUserQuestion']>[0], 'sender'>,
): Promise<{ request_id: string }> {
  const result = await askUserQuestionDef.handle(
    {
      caller: { kind: 'dispatcher' },
      session: h.tools,
    },
    input,
  );
  const requestId = result['request_id'];
  if (typeof requestId !== 'string')
    throw new Error('question did not return its request id');
  return { request_id: requestId };
}

async function expireAskUserQuestion(
  h: ActionsHarness,
  expiry: AskUserExpiry,
): Promise<void> {
  const previous = h.bot.editedCards.length;
  // This is the registry's current notification boundary, not a call to a
  // removed private session function. Registry timer coverage is separate.
  h.registry.events.emit('expired', expiry);
  await vi.waitFor(() => expect(h.bot.editedCards).toHaveLength(previous + 1));
}

function sentCardWillLandIn(
  bot: FakeFeishuBot,
  place: { chatId: string; threadId: string | undefined },
): void {
  const send = bot.sendCard.bind(bot);
  vi.spyOn(bot, 'sendCard').mockImplementation(async (...args) => {
    const sent = await send(...args);
    return {
      messages: sent.messages.map((message) => ({ ...message, ...place })),
    };
  });
}

/** What Feishu will report about a card the session sent. */
function cardSitsIn(
  bot: FakeFeishuBot,
  messageId: string,
  place: { chatId: string; threadId?: string },
): void {
  bot.setMessageRead(messageId, {
    items: [
      {
        messageId,
        messageType: 'interactive',
        content: '{}',
        mentions: [],
        deleted: false,
        malformed: false,
        chatId: place.chatId,
        ...(place.threadId !== undefined ? { threadId: place.threadId } : {}),
      },
    ],
  });
}

/** Ask a question and answer the card it sent, as a user's two clicks would. */
async function clickThrough(
  h: ActionsHarness,
  cardMessageId: string,
  requestId: string,
  last: string = DREAMUX_ASK_SUBMIT_ACTION,
): Promise<void> {
  for (const action of [DREAMUX_ASK_PICK_ACTION, last]) {
    await h.actions.handle({
      actionValue: {
        [DREAMUX_ACTION_KEY]: action,
        [DREAMUX_ASK_REQUEST_KEY]: requestId,
        [DREAMUX_ASK_QUESTION_KEY]: 0,
        [DREAMUX_ASK_OPTION_KEY]: 0,
      },
      openMessageId: cardMessageId,
      operatorOpenId: 'ou_clicker',
      openChatId: 'oc_room',
      raw: {},
    });
  }
}

/** A click hands the answer to Core detached, so its arrival is awaited here. */
async function answers(delivered: Delivered[], count: number): Promise<void> {
  await vi.waitFor(() => expect(delivered).toHaveLength(count));
}

describe('sending the question card', () => {
  it('sends the explanation above the questions', async () => {
    const bot = createFakeFeishuBot();
    const h = await handle(capturingDelivery().delivery, bot);
    const text = '# Context\n\n- Compare both options.';

    await askUserQuestion(h, { chatId: 'oc_room', text, questions: QUESTIONS });

    expect(bot.sentCards[0]?.card).toMatchObject({
      body: {
        elements: [
          { tag: 'markdown', content: text },
          { tag: 'collapsible_panel' },
          { tag: 'column_set' },
        ],
      },
    });
  });

  it('replies to the message the model named, seen before or not', async () => {
    const bot = createFakeFeishuBot();
    const h = await handle(capturingDelivery().delivery, bot);

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
    const h = await handle(capturingDelivery().delivery, bot);

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
    const h = await handle(delivery, bot);
    bot.setChatMode('oc_room', 'topic');
    sentCardWillLandIn(bot, { chatId: 'oc_room', threadId: 'omt_thread' });

    const opened = await askUserQuestion(h, {
      chatId: 'oc_room',
      messageId: 'om_root',
      questions: QUESTIONS,
    });
    const cardId = bot.sentCards[0]?.messageIds[0] ?? '';
    // The send returned the root's topic; the round remembers that landing.
    // A separately configured read must not replace the send's authority.
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
    expect(bot.messageReadRequests).toEqual([]);
  });

  it('routes a dismissal from its card too', async () => {
    const { delivery, delivered } = capturingDelivery();
    const bot = createFakeFeishuBot();
    const h = await handle(delivery, bot);
    bot.setChatMode('oc_room', 'topic');
    sentCardWillLandIn(bot, { chatId: 'oc_room', threadId: 'omt_thread' });

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
    expect(delivered[0]?.submission.attrs).toMatchObject({
      message_id: cardId,
    });
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
    const h = await handle(delivery, bot);
    bot.setChatMode('oc_room', 'topic');
    sentCardWillLandIn(bot, { chatId: 'oc_room', threadId: 'omt_thread' });
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
    const h = await handle(delivery, bot);
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
    const h = await handle(delivery, bot);
    bot.setMessageRead('om_card', read);

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

describe('settlement without a send landing', () => {
  it('looks up the clicked card when the send reported no landing', async () => {
    const { delivery, delivered } = capturingDelivery();
    const bot = createFakeFeishuBot();
    bot.setChatMode('oc_room', 'topic');
    const h = await handle(delivery, bot);
    const opened = h.registry.open({ questions: QUESTIONS });
    opened.activate(undefined);
    cardSitsIn(bot, 'om_clicked', {
      chatId: 'oc_room',
      threadId: 'omt_actual',
    });
    await clickThrough(h, 'om_clicked', opened.requestId);
    await answers(delivered, 1);
    expect(bot.messageReadRequests).toEqual([{ messageId: 'om_clicked' }]);
    expect(delivered[0]?.target).toEqual(topicTarget('oc_room', 'omt_actual'));
    expect(delivered[0]?.submission.attrs['message_id']).toBe('om_clicked');
  });
});
