/**
 * `ask_user_question`: the round outlives the tool call, and the server owns
 * the answer.
 *
 * Two properties carry the whole design and neither is visible in the card
 * JSON alone. The card holds no client state — an `interactive_container` has
 * none — so "which option is selected" exists only in the registry, and every
 * assertion about a selected option is really an assertion that a click was
 * applied server-side and the card repainted from it. And the tool never
 * returns an answer: it returns once the card is sent, so what the model is
 * told to do next (`next`) is the only thing standing between a sent question
 * and a model that keeps working while the user reads it.
 *
 * Expiry is the third: Feishu stops accepting clicks on a card 15 minutes in,
 * so a round that nobody answers has to close itself and say so, or the model
 * waits forever for an answer the platform will no longer accept.
 */
import { describe, expect, it, vi } from 'vitest';

import type { FeishuCardActionEvent } from '../src/bot.js';
import {
  ASK_USER_CARD_TTL_MS,
  createAskUserRegistry,
  type AskUserExpiry,
  type AskUserRegistry,
  type AskUserTimers,
} from '../src/feishu-ask-user.js';
import {
  ASK_USER_CANCEL_LABEL,
  DREAMUX_ASK_CANCEL_ACTION,
  DREAMUX_ASK_OPTION_KEY,
  DREAMUX_ASK_OTHER_ACTION,
  DREAMUX_ASK_PICK_ACTION,
  DREAMUX_ASK_QUESTION_KEY,
  DREAMUX_ASK_REQUEST_KEY,
  DREAMUX_ASK_SUBMIT_ACTION,
  type AskUserQuestionSpec,
} from '../src/feishu-ask-user-card.js';
import { DREAMUX_ACTION_KEY } from '../src/feishu-pairing-card.js';
import { FeishuTargetRouter } from '../src/feishu-target-router.js';
import {
  ASK_USER_NEXT_INSTRUCTION,
  askUserQuestionDef,
} from '../src/tools/ask-user-question.js';
import type { FeishuToolContext, FeishuToolSession } from '../src/tools/types.js';
import { chatTarget, topicTarget } from '../src/routing/target.js';

const QUESTIONS: readonly AskUserQuestionSpec[] = [
  {
    header: '存储方案',
    question: 'Where does session state live?',
    options: [
      { label: 'Keep JSON', description: 'Smallest change' },
      { label: 'Move to SQLite', description: 'Better concurrency' },
    ],
  },
  {
    header: '发布节奏',
    question: 'When does it ship?',
    options: [
      { label: 'Next beta', description: 'Batch it' },
      { label: 'Own patch', description: 'Ship now' },
    ],
  },
];

const target = chatTarget('oc_test', 'group');

function event(
  action: string,
  value: Record<string, unknown>,
  inputValue?: string,
): FeishuCardActionEvent {
  return {
    actionValue: { [DREAMUX_ACTION_KEY]: action, ...value },
    ...(inputValue !== undefined ? { inputValue } : {}),
    operatorOpenId: 'ou_clicker',
    openMessageId: 'om_the_card',
    raw: {},
  };
}

/** Every string leaf in a card tree, so a repaint can be asserted on text. */
function stringLeaves(value: unknown, out: string[] = []): string[] {
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) for (const item of value) stringLeaves(item, out);
  else if (value !== null && typeof value === 'object') {
    for (const item of Object.values(value)) stringLeaves(item, out);
  }
  return out;
}

function manualTimers(): AskUserTimers & { fire(): void } {
  const queued: (() => void)[] = [];
  return {
    set(fn) {
      queued.push(fn);
      return queued.length - 1;
    },
    clear(handle) {
      queued[handle as number] = () => undefined;
    },
    fire() {
      for (const fn of [...queued]) fn();
    },
  };
}

/**
 * Open a round and put it in play, which is what a successful send does. A
 * round nobody activated is answerable by nobody, so every test that clicks
 * one has to go through here.
 */
function openRound(
  registry: AskUserRegistry,
  messageId: string | undefined = undefined,
): string {
  const opened = registry.open({ questions: QUESTIONS, target });
  opened.activate(messageId);
  return opened.requestId;
}

/** Answer a question, so a submit has something to submit. */
function pickOption(
  registry: AskUserRegistry,
  requestId: string,
  questionIndex: number,
  optionIndex: number,
): void {
  registry.apply(
    event(DREAMUX_ASK_PICK_ACTION, {
      [DREAMUX_ASK_REQUEST_KEY]: requestId,
      [DREAMUX_ASK_QUESTION_KEY]: questionIndex,
      [DREAMUX_ASK_OPTION_KEY]: optionIndex,
    }),
  );
}

describe('ask-user registry', () => {
  it('records a pick server-side and repaints the card as selected', () => {
    const registry = createAskUserRegistry({ timers: manualTimers() });
    const requestId = openRound(registry);

    const applied = registry.apply(
      event(DREAMUX_ASK_PICK_ACTION, {
        [DREAMUX_ASK_REQUEST_KEY]: requestId,
        [DREAMUX_ASK_QUESTION_KEY]: 0,
        [DREAMUX_ASK_OPTION_KEY]: 1,
      }),
    );

    expect(applied.kind).toBe('response');
    if (applied.kind !== 'response') return;
    // The toast names the choice, and the repainted card carries it in the
    // panel header — which is only possible because the server stored it.
    expect(applied.response.toast?.content).toBe('Move to SQLite');
    const leaves = stringLeaves(applied.response.card?.data).join('\n');
    expect(leaves).toContain('· Move to SQLite');
  });

  it('lets free text answer a question, and replace a picked option', () => {
    const registry = createAskUserRegistry({ timers: manualTimers() });
    const requestId = openRound(registry);
    registry.apply(
      event(DREAMUX_ASK_PICK_ACTION, {
        [DREAMUX_ASK_REQUEST_KEY]: requestId,
        [DREAMUX_ASK_QUESTION_KEY]: 0,
        [DREAMUX_ASK_OPTION_KEY]: 0,
      }),
    );

    registry.apply(
      event(
        DREAMUX_ASK_OTHER_ACTION,
        {
          [DREAMUX_ASK_REQUEST_KEY]: requestId,
          [DREAMUX_ASK_QUESTION_KEY]: 0,
        },
        'neither, use Postgres',
      ),
    );

    const settled = registry.apply(
      event(DREAMUX_ASK_SUBMIT_ACTION, { [DREAMUX_ASK_REQUEST_KEY]: requestId }),
    );
    expect(settled.kind).toBe('settled');
    if (settled.kind !== 'settled') return;
    // Single-select: the later answer replaced the option rather than joining it.
    expect(settled.settlement.text).toContain('neither, use Postgres');
    expect(settled.settlement.text).not.toContain('Keep JSON');
  });

  it('clearing the free-text box takes the answer back', () => {
    const registry = createAskUserRegistry({ timers: manualTimers() });
    const requestId = openRound(registry);
    registry.apply(
      event(
        DREAMUX_ASK_OTHER_ACTION,
        { [DREAMUX_ASK_REQUEST_KEY]: requestId, [DREAMUX_ASK_QUESTION_KEY]: 0 },
        'something',
      ),
    );
    registry.apply(
      event(
        DREAMUX_ASK_OTHER_ACTION,
        { [DREAMUX_ASK_REQUEST_KEY]: requestId, [DREAMUX_ASK_QUESTION_KEY]: 0 },
        '   ',
      ),
    );
    // The second question keeps the submit alive; a round with no answer at
    // all is refused, which is a different test.
    pickOption(registry, requestId, 1, 0);

    const settled = registry.apply(
      event(DREAMUX_ASK_SUBMIT_ACTION, { [DREAMUX_ASK_REQUEST_KEY]: requestId }),
    );
    if (settled.kind !== 'settled') throw new Error('expected settled');
    expect(settled.settlement.text).toContain('(left unanswered)');
  });

  it('cancel tells the model to stop asking, not that a button was pressed', () => {
    const registry = createAskUserRegistry({ timers: manualTimers() });
    const requestId = openRound(registry);

    const settled = registry.apply(
      event(DREAMUX_ASK_CANCEL_ACTION, { [DREAMUX_ASK_REQUEST_KEY]: requestId }),
    );
    if (settled.kind !== 'settled') throw new Error('expected settled');
    expect(settled.settlement.outcome).toBe('cancelled');
    expect(settled.settlement.text).toContain('Do not send another question card');
  });

  it('settles a round exactly once, so a double click cannot deliver twice', () => {
    const registry = createAskUserRegistry({ timers: manualTimers() });
    const requestId = openRound(registry);
    pickOption(registry, requestId, 0, 0);
    const first = registry.apply(
      event(DREAMUX_ASK_SUBMIT_ACTION, { [DREAMUX_ASK_REQUEST_KEY]: requestId }),
    );
    const second = registry.apply(
      event(DREAMUX_ASK_SUBMIT_ACTION, { [DREAMUX_ASK_REQUEST_KEY]: requestId }),
    );

    expect(first.kind).toBe('settled');
    expect(second.kind).toBe('response');
    if (second.kind !== 'response') return;
    expect(second.response.toast?.type).toBe('error');
  });

  it('answers a click on a round it no longer has instead of going silent', () => {
    const registry = createAskUserRegistry({ timers: manualTimers() });
    openRound(registry);
    registry.abandonAll();

    const applied = registry.apply(
      event(DREAMUX_ASK_SUBMIT_ACTION, { [DREAMUX_ASK_REQUEST_KEY]: 'gone' }),
    );
    if (applied.kind !== 'response') throw new Error('expected a response');
    expect(applied.response.toast?.type).toBe('error');
  });

  it('leaves nothing behind when the card never reached the chat', () => {
    const timers = manualTimers();
    const expired: AskUserExpiry[] = [];
    const registry = createAskUserRegistry({
      timers,
      onExpire: (expiry) => expired.push(expiry),
    });
    // The send threw, so `activate` was never reached.
    const opened = registry.open({ questions: QUESTIONS, target });

    const applied = registry.apply(
      event(DREAMUX_ASK_SUBMIT_ACTION, {
        [DREAMUX_ASK_REQUEST_KEY]: opened.requestId,
      }),
    );
    expect(applied.kind).toBe('response');
    // And no clock is running: a round with no card must never tell the model
    // that a question it never asked went unanswered.
    timers.fire();
    expect(expired).toHaveLength(0);
  });

  it('refuses a submit with nothing chosen instead of spending the round', () => {
    const registry = createAskUserRegistry({ timers: manualTimers() });
    const opened = registry.open({ questions: QUESTIONS, target });
    opened.activate(undefined);
    const { requestId } = opened;

    const empty = registry.apply(
      event(DREAMUX_ASK_SUBMIT_ACTION, { [DREAMUX_ASK_REQUEST_KEY]: requestId }),
    );
    expect(empty.kind).toBe('response');
    if (empty.kind !== 'response') return;
    expect(empty.response.toast?.type).toBe('warning');
    // The toast sends the user to the other button, so it has to name one the
    // card actually draws.
    expect(empty.response.toast?.content).toContain(ASK_USER_CANCEL_LABEL);
    expect(stringLeaves(opened.card)).toContain(ASK_USER_CANCEL_LABEL);

    // The round survived the misfire, so the next click still answers it.
    registry.apply(
      event(DREAMUX_ASK_PICK_ACTION, {
        [DREAMUX_ASK_REQUEST_KEY]: requestId,
        [DREAMUX_ASK_QUESTION_KEY]: 0,
        [DREAMUX_ASK_OPTION_KEY]: 1,
      }),
    );
    const settled = registry.apply(
      event(DREAMUX_ASK_SUBMIT_ACTION, { [DREAMUX_ASK_REQUEST_KEY]: requestId }),
    );
    if (settled.kind !== 'settled') throw new Error('expected settled');
    // One question answered, one not: still a submit, and still worth sending.
    expect(settled.settlement.text).toContain('Move to SQLite');
    expect(settled.settlement.text).toContain('(left unanswered)');
  });

  it('leaves other cards alone', () => {
    const registry = createAskUserRegistry({ timers: manualTimers() });
    expect(registry.apply(event('approve_pairing', {})).kind).toBe('ignored');
  });

  it('anchors the answer on the real card, never on the dedup id', () => {
    const registry = createAskUserRegistry({ timers: manualTimers() });
    const requestId = openRound(registry);
    pickOption(registry, requestId, 0, 0);

    const settled = registry.apply(
      event(DREAMUX_ASK_SUBMIT_ACTION, { [DREAMUX_ASK_REQUEST_KEY]: requestId }),
    );
    if (settled.kind !== 'settled') throw new Error('expected settled');
    // `sourceId` is synthetic so one round settles once; it is not a Feishu
    // message id, and the anchor built from it would be handed to the COT
    // create API as a presentation origin.
    expect(settled.settlement.sourceId).toContain('ask_user_question:');
    expect(settled.settlement.cardMessageId).toBe('om_the_card');
    expect(settled.settlement.cardMessageId).not.toBe(
      settled.settlement.sourceId,
    );
    // Anyone in a group can answer the card, so who clicked is carried too.
    expect(settled.settlement.operatorOpenId).toBe('ou_clicker');
  });

  it('falls back to the id recorded at send time when a round expires', () => {
    const timers = manualTimers();
    const expired: AskUserExpiry[] = [];
    const registry = createAskUserRegistry({
      timers,
      onExpire: (expiry) => expired.push(expiry),
    });
    const requestId = openRound(registry, 'om_sent');

    timers.fire();
    // No click means no event to read the card id from — only what the send
    // recorded — and nobody to attribute the (absent) answer to.
    expect(expired[0]?.settlement.cardMessageId).toBe('om_sent');
    expect(expired[0]?.settlement.operatorOpenId).toBeUndefined();
  });

  it('closes an unanswered round and tells the model to stand still', () => {
    const timers = manualTimers();
    const expired: AskUserExpiry[] = [];
    const registry = createAskUserRegistry({
      timers,
      onExpire: (expiry) => expired.push(expiry),
    });
    const requestId = openRound(registry, 'om_card');

    timers.fire();

    expect(expired).toHaveLength(1);
    expect(expired[0]?.settlement.outcome).toBe('expired');
    expect(expired[0]?.messageId).toBe('om_card');
    expect(expired[0]?.settlement.text).toContain('take no further action');
    // The card id is carried out because nothing else can repaint a card that
    // expired without a click to answer.
    expect(stringLeaves(expired[0]?.card).join('\n')).toContain('超时');
  });

  it('does not expire a round a click already settled', () => {
    const timers = manualTimers();
    const expired: AskUserExpiry[] = [];
    const registry = createAskUserRegistry({
      timers,
      onExpire: (expiry) => expired.push(expiry),
    });
    const requestId = openRound(registry);
    pickOption(registry, requestId, 0, 0);
    registry.apply(
      event(DREAMUX_ASK_SUBMIT_ACTION, { [DREAMUX_ASK_REQUEST_KEY]: requestId }),
    );

    timers.fire();
    expect(expired).toHaveLength(0);
  });

  it('closes before Feishu stops accepting clicks', () => {
    // The platform drops interaction at 15 minutes; closing after that would
    // repaint a card nobody can answer any more.
    expect(ASK_USER_CARD_TTL_MS).toBeLessThan(15 * 60 * 1000);
  });
});

describe('ask_user_question tool', () => {
  function context(session: Partial<FeishuToolSession>): FeishuToolContext {
    return {
      caller: { kind: 'dispatcher' } as FeishuToolContext['caller'],
      session: session as FeishuToolSession,
    };
  }

  const validArgs = {
    chat_id: 'oc_test',
    questions: [
      {
        header: '存储方案',
        question: 'Where does session state live?',
        options: [
          { label: 'Keep JSON', description: 'Smallest change' },
          { label: 'Move to SQLite', description: 'Better concurrency' },
        ],
      },
    ],
  };

  it('returns once the card is sent, and tells the model to stop and wait', async () => {
    const askUserQuestion = vi.fn().mockResolvedValue({ request_id: 'r1' });
    const result = await askUserQuestionDef.handle(
      context({ askUserQuestion }),
      askUserQuestionDef.parse(validArgs),
    );

    expect(result['status']).toBe('asked');
    expect(result['request_id']).toBe('r1');
    // The answer never comes back through this tool, so the instruction not to
    // keep working is the only thing carrying that fact to the model.
    expect(result['next']).toBe(ASK_USER_NEXT_INSTRUCTION);
    expect(ASK_USER_NEXT_INSTRUCTION).toContain('end your turn');
  });

  it('offers neither a multi-select nor a preview to fill in', () => {
    const question = (
      askUserQuestionDef.inputSchema as {
        properties: {
          questions: { items: { properties: Record<string, unknown> } };
        };
      }
    ).properties.questions.items.properties;
    expect(Object.keys(question)).toEqual(['header', 'question', 'options']);
    const option = (
      question['options'] as { items: { properties: Record<string, unknown> } }
    ).items.properties;
    expect(Object.keys(option)).toEqual(['label', 'description']);
  });

  it('sends the card under the message the question came out of', async () => {
    const askUserQuestion = vi.fn().mockResolvedValue({ request_id: 'r1' });
    await askUserQuestionDef.handle(
      context({ askUserQuestion }),
      askUserQuestionDef.parse({ ...validArgs, message_id: 'om_asked' }),
    );

    expect(askUserQuestion.mock.calls[0]?.[0]).toMatchObject({
      chatId: 'oc_test',
      messageId: 'om_asked',
    });
  });

  it('leaves the message id out when the model named none', () => {
    // Not an empty string: the target router reads "no message to thread
    // under" from the field's absence, and would look up '' as an id.
    expect(askUserQuestionDef.parse(validArgs)).not.toHaveProperty('messageId');
  });

  it('needs a chat, offers a message, and asks for nothing else', () => {
    const schema = askUserQuestionDef.inputSchema as {
      properties: Record<string, unknown>;
      required: readonly string[];
    };
    expect(Object.keys(schema.properties)).toEqual([
      'chat_id',
      'message_id',
      'questions',
    ]);
    expect(schema.required).toEqual(['chat_id', 'questions']);
  });

  it('rejects a header too long to fit the chip', () => {
    expect(() =>
      askUserQuestionDef.parse({
        ...validArgs,
        questions: [{ ...validArgs.questions[0], header: 'x'.repeat(13) }],
      }),
    ).toThrow(/at most 12 characters/);
  });

  it('rejects a question with only one option', () => {
    expect(() =>
      askUserQuestionDef.parse({
        ...validArgs,
        questions: [
          {
            ...validArgs.questions[0],
            options: [{ label: 'Only', description: 'one' }],
          },
        ],
      }),
    ).toThrow(/2-4 options/);
  });

  it('rejects more questions than the card can hold', () => {
    expect(() =>
      askUserQuestionDef.parse({
        ...validArgs,
        questions: Array.from({ length: 5 }, () => validArgs.questions[0]),
      }),
    ).toThrow(/1-4 questions/);
  });
});

/**
 * Where `message_id` sends the card. The rule is the one `reply` already
 * follows — the card belongs wherever the message it answers lives — so this
 * covers the router, not a second routing path for questions.
 */
describe('addressing the question card', () => {
  const silent = {
    error: () => undefined,
    warn: () => undefined,
    info: () => undefined,
    debug: () => undefined,
    trace: () => undefined,
  };

  function router(): FeishuTargetRouter {
    return new FeishuTargetRouter({ chatModes: {}, log: silent });
  }

  it('follows the named message into its topic', () => {
    const r = router();
    r.observe('om_asked', topicTarget('oc_room', 'omt_thread'));

    expect(r.outboundTarget('oc_room', 'om_asked')).toEqual(
      topicTarget('oc_room', 'omt_thread'),
    );
  });

  it('addresses the chat itself when no message is named', () => {
    const r = router();
    r.observe('om_asked', topicTarget('oc_room', 'omt_thread'));

    // A question that belongs to no message opens a topic of its own.
    expect(r.outboundTarget('oc_room', undefined)).toEqual(
      chatTarget('oc_room', 'group'),
    );
  });

  it('ignores a message from another chat rather than redirecting the card', () => {
    const r = router();
    r.observe('om_elsewhere', topicTarget('oc_other', 'omt_thread'));

    // Deliberate: a stale or copied id must not send a question meant for one
    // conversation into another. The named chat wins.
    expect(r.outboundTarget('oc_room', 'om_elsewhere')).toEqual(
      chatTarget('oc_room', 'group'),
    );
  });
});
