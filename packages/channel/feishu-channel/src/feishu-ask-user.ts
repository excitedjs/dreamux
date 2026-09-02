/**
 * Open ask-user rounds, and what a click does to one.
 *
 * The tool does not wait for an answer. It sends the card and returns, and the
 * answer arrives later as an ordinary inbound submission — the same path a
 * typed reply takes. That is the whole reason this registry exists: something
 * has to hold the question between the tool call that asked it and the click
 * that answers it, and a tool handler that has already returned cannot.
 *
 * Waiting inside the tool call was the alternative, and it loses on the case
 * that matters: a person who answers after lunch. The MCP client, not this
 * package, decides how long a tool call may run, so a blocking handler would
 * have been abandoned mid-question by a timeout Dreamux does not own.
 *
 * The module is pure. `apply` decides and hands back what to deliver; the ops
 * layer performs the delivery, matching how the access gate splits from its IO.
 */
import { randomBytes } from 'node:crypto';

import type { FeishuCardActionEvent } from './bot.js';
import {
  DREAMUX_ASK_ACTIONS,
  DREAMUX_ASK_CANCEL_ACTION,
  DREAMUX_ASK_OPTION_KEY,
  DREAMUX_ASK_PICK_ACTION,
  DREAMUX_ASK_QUESTION_KEY,
  DREAMUX_ASK_REQUEST_KEY,
  DREAMUX_ASK_SUBMIT_ACTION,
  answerLabel,
  buildAskUserCard,
  buildAskUserClosedCard,
  buildAskUserSubmittedCard,
  type AskUserAnswer,
  type AskUserQuestionSpec,
} from './feishu-ask-user-card.js';
import { DREAMUX_ACTION_KEY, type FeishuCardActionResponse } from './feishu-pairing-card.js';
import type { FeishuTarget } from './routing/target.js';

const REQUEST_ID_BYTES = 8;

/**
 * How long a question card stays answerable.
 *
 * Feishu stops accepting interaction on a card 15 minutes after it is sent, so
 * a round has to close itself before that: past the platform's cutoff the card
 * still looks live but every click is dropped, and the model would wait for an
 * answer that can no longer be given. Closing a minute early leaves room for
 * the repaint to land while the card is still writable.
 */
export const ASK_USER_CARD_TTL_MS = 14 * 60 * 1000;

/** The timer seam, so tests can expire a round without waiting for one. */
export interface AskUserTimers {
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

const realTimers: AskUserTimers = {
  set(fn, ms) {
    const handle = setTimeout(fn, ms);
    // A waiting question must never be the reason a process stays alive.
    (handle as { unref?: () => void }).unref?.();
    return handle;
  },
  clear(handle) {
    clearTimeout(handle as Parameters<typeof clearTimeout>[0]);
  },
};

export interface AskUserOpenInput {
  readonly questions: readonly AskUserQuestionSpec[];
  readonly target: FeishuTarget;
}

export interface AskUserOpened {
  readonly requestId: string;
  readonly card: unknown;
  /**
   * Put the round in play, carrying the id of the card that now shows it —
   * absent only when the send reported none. Nothing can answer a round before
   * this runs, and nothing has to undo one when the send never lands.
   */
  activate(messageId: string | undefined): void;
}

/**
 * What a settled round hands the ops layer to deliver. `sourceId` is derived
 * from the request, so the round can only ever be delivered once even if two
 * clicks race — the same identity Core deduplicates an inbound repeat on.
 */
export interface AskUserSettlement {
  readonly requestId: string;
  readonly target: FeishuTarget;
  readonly outcome: 'submitted' | 'cancelled' | 'expired';
  readonly text: string;
  /**
   * The dedup identity Core keys the submission on. Synthetic on purpose: one
   * round settles once, however many clicks race for it. It is NOT a Feishu
   * message id and must never be used as one.
   */
  readonly sourceId: string;
  /**
   * The question card's own message id — a real `om_` id, and the anchor the
   * answer belongs under. Absent only if the send never reported one.
   */
  readonly cardMessageId?: string;
  /** Who clicked. Absent when the round closed on its timer. */
  readonly operatorOpenId?: string;
}

/**
 * A round that closed on its own. Unlike a click, nothing is there to repaint
 * the card from a callback response, so the message id is carried out and the
 * session patches the card in place.
 */
export interface AskUserExpiry {
  readonly settlement: AskUserSettlement;
  /** Absent only if the card's id never came back from the send. */
  readonly messageId?: string;
  readonly card: unknown;
}

export type AskUserApplyResult =
  /** Not an ask action — some other card owns it. */
  | { readonly kind: 'ignored' }
  | { readonly kind: 'response'; readonly response: FeishuCardActionResponse }
  | {
      readonly kind: 'settled';
      readonly response: FeishuCardActionResponse;
      readonly settlement: AskUserSettlement;
    };

export interface AskUserRegistry {
  /**
   * Build a round and the card that asks it. The round is neither answerable
   * nor on the clock until `activate`, because a round this registry holds is
   * a card somebody can look at. Registering it here instead would let a send
   * that threw leave a question behind with no card, and its TTL would later
   * report an unanswered question to a model whose user was never asked one.
   */
  open(input: AskUserOpenInput): AskUserOpened;
  apply(event: FeishuCardActionEvent): AskUserApplyResult;
  /** Drop every open round; their cards report the round as gone on next click. */
  abandonAll(): void;
}

interface OpenRound {
  readonly requestId: string;
  readonly questions: readonly AskUserQuestionSpec[];
  readonly target: FeishuTarget;
  readonly answers: Map<number, AskUserAnswer>;
  messageId?: string;
  timer?: unknown;
}

function toast(
  type: 'info' | 'success' | 'error' | 'warning',
  content: string,
): FeishuCardActionResponse {
  return { toast: { type, content } };
}

function repaint(round: OpenRound, message: string): FeishuCardActionResponse {
  return {
    toast: { type: 'info', content: message },
    card: { type: 'raw', data: buildAskUserCard(round) },
  };
}

function asIndex(value: unknown): number | undefined {
  const index = typeof value === 'number' ? value : Number(value);
  return Number.isInteger(index) && index >= 0 ? index : undefined;
}

/** The body Core is handed when the user submits. */
function submittedText(round: OpenRound): string {
  const lines = round.questions.map((question, index) => {
    const chosen = answerLabel(question, round.answers.get(index));
    return `- ${question.header} · ${question.question} → ${
      chosen ?? '(left unanswered)'
    }`;
  });
  return [
    'The user answered the question card:',
    '',
    ...lines,
  ].join('\n');
}

/**
 * The body for an abandoned round. It states the consequence rather than the
 * click, because "the user pressed a red button" is not something the model can
 * act on and "stop asking, talk it through" is.
 */
function cancelledText(): string {
  return [
    'The user dismissed the question card and wants to talk it through instead.',
    '',
    'Do not send another question card for this decision. Continue in plain',
    'conversation and let the user steer.',
  ].join('\n');
}

/** The body for a round nobody answered before the card stopped accepting clicks. */
function expiredText(): string {
  return [
    'The question card expired with no answer from the user.',
    '',
    'Stop where you are and take no further action. Wait for the user\'s next',
    'message, and decide only then whether to ask again with a new card.',
  ].join('\n');
}

export interface AskUserRegistryOptions {
  /**
   * Called when a round closes on its own. The session delivers the settlement
   * and repaints the card; the registry only decides that the round is over.
   */
  readonly onExpire?: (expiry: AskUserExpiry) => void;
  readonly ttlMs?: number;
  readonly newRequestId?: () => string;
  readonly timers?: AskUserTimers;
}

export function createAskUserRegistry(
  options: AskUserRegistryOptions = {},
): AskUserRegistry {
  const rounds = new Map<string, OpenRound>();
  const timers = options.timers ?? realTimers;
  const ttlMs = options.ttlMs ?? ASK_USER_CARD_TTL_MS;
  const newRequestId =
    options.newRequestId ??
    ((): string => randomBytes(REQUEST_ID_BYTES).toString('hex'));

  /** Take the round out of play and describe what Core should be told. */
  function closeRound(
    round: OpenRound,
    outcome: AskUserSettlement['outcome'],
    by?: { cardMessageId?: string; operatorOpenId?: string },
  ): AskUserSettlement {
    rounds.delete(round.requestId);
    if (round.timer !== undefined) timers.clear(round.timer);
    const text =
      outcome === 'submitted'
        ? submittedText(round)
        : outcome === 'cancelled'
          ? cancelledText()
          : expiredText();
    // The click reports the card it came from; the timer has only what the
    // send recorded.
    const cardMessageId = by?.cardMessageId ?? round.messageId;
    return {
      requestId: round.requestId,
      target: round.target,
      outcome,
      text,
      sourceId: `ask_user_question:${round.requestId}`,
      ...(cardMessageId !== undefined ? { cardMessageId } : {}),
      ...(by?.operatorOpenId !== undefined
        ? { operatorOpenId: by.operatorOpenId }
        : {}),
    };
  }


  function settle(
    round: OpenRound,
    outcome: 'submitted' | 'cancelled',
    event: FeishuCardActionEvent,
  ): AskUserApplyResult {
    const view = { ...round };
    const settlement = closeRound(round, outcome, {
      ...(event.openMessageId !== undefined
        ? { cardMessageId: event.openMessageId }
        : {}),
      ...(event.operatorOpenId !== undefined
        ? { operatorOpenId: event.operatorOpenId }
        : {}),
    });
    return {
      kind: 'settled',
      response: {
        toast: {
          type: outcome === 'submitted' ? 'success' : 'info',
          content: outcome === 'submitted' ? '已提交' : '已取消',
        },
        card: {
          type: 'raw',
          data:
            outcome === 'submitted'
              ? buildAskUserSubmittedCard(view)
              : buildAskUserClosedCard('cancelled'),
        },
      },
      settlement,
    };
  }

  return {
    open(input): AskUserOpened {
      const requestId = newRequestId();
      const round: OpenRound = {
        requestId,
        questions: input.questions,
        target: input.target,
        answers: new Map(),
      };
      return {
        requestId,
        card: buildAskUserCard(round),
        activate(messageId): void {
          if (messageId !== undefined) round.messageId = messageId;
          rounds.set(requestId, round);
          round.timer = timers.set(() => {
            // Already settled by a click? Then this timer lost the race and
            // the round is gone; `closeRound` on a stale round would report a
            // second settlement for one question.
            if (rounds.get(requestId) !== round) return;
            const settlement = closeRound(round, 'expired');
            options.onExpire?.({
              settlement,
              ...(round.messageId !== undefined
                ? { messageId: round.messageId }
                : {}),
              card: buildAskUserClosedCard('expired'),
            });
          }, ttlMs);
        },
      };
    },

    apply(event): AskUserApplyResult {
      const action = String(event.actionValue[DREAMUX_ACTION_KEY] ?? '');
      if (!DREAMUX_ASK_ACTIONS.has(action)) return { kind: 'ignored' };

      const requestId = String(event.actionValue[DREAMUX_ASK_REQUEST_KEY] ?? '');
      const round = rounds.get(requestId);
      if (round === undefined) {
        // The round is gone: settled already, expired, or lost with a previous
        // session. Saying so beats a dead click the user cannot explain.
        return {
          kind: 'response',
          response: toast('error', '这轮提问已失效，直接说你的想法就行。'),
        };
      }

      if (action === DREAMUX_ASK_SUBMIT_ACTION) {
        // 提交 sits directly under the questions, so it is also the button
        // pressed before anything has been chosen. Settling on that click
        // would spend the round's one settlement telling the model every
        // question was left unanswered, which is worse than saying nothing.
        if (round.answers.size === 0) {
          return {
            kind: 'response',
            response: toast('warning', '先选一个再提交，或者点「不用问了」。'),
          };
        }
        return settle(round, 'submitted', event);
      }
      if (action === DREAMUX_ASK_CANCEL_ACTION) {
        return settle(round, 'cancelled', event);
      }

      const questionIndex = asIndex(event.actionValue[DREAMUX_ASK_QUESTION_KEY]);
      const question =
        questionIndex === undefined
          ? undefined
          : round.questions[questionIndex];
      if (questionIndex === undefined || question === undefined) {
        return { kind: 'response', response: toast('error', '这个选项已失效') };
      }

      if (action === DREAMUX_ASK_PICK_ACTION) {
        const optionIndex = asIndex(event.actionValue[DREAMUX_ASK_OPTION_KEY]);
        const option =
          optionIndex === undefined ? undefined : question.options[optionIndex];
        if (optionIndex === undefined || option === undefined) {
          return { kind: 'response', response: toast('error', '这个选项已失效') };
        }
        // Single-select, and an option and free text answer the same question:
        // whichever came last is the answer.
        round.answers.set(questionIndex, { kind: 'option', index: optionIndex });
        return { kind: 'response', response: repaint(round, option.label) };
      }

      // Free text is the last action the guard at the top admitted, so it is
      // what is left once pick, submit and cancel have been handled.
      const text = (event.inputValue ?? '').trim();
      if (text === '') {
        round.answers.delete(questionIndex);
        return { kind: 'response', response: repaint(round, '已清空') };
      }
      round.answers.set(questionIndex, { kind: 'other', text });
      return { kind: 'response', response: repaint(round, `Other：${text}`) };
    },

    abandonAll(): void {
      for (const round of rounds.values()) {
        if (round.timer !== undefined) timers.clear(round.timer);
      }
      rounds.clear();
    },
  };
}
