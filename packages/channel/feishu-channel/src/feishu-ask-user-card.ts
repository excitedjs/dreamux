/**
 * The `ask_user_question` card — a v2 card, and the only place its shape lives.
 *
 * Feishu has no radio component: `select_static` is the one native single-select
 * and its options carry a label and nothing else, so an option's description
 * would be lost the moment the dropdown closes. The card therefore draws each
 * option as its own `interactive_container` — label, then description — which is
 * the same shape the open-source Feishu ask-user renderers converged on.
 *
 * That choice is what makes the server authoritative: an `interactive_container`
 * holds no client state, so "which option is selected" only exists here. Every
 * click is a callback, and the answer is visible solely because this module
 * repaints the whole card from {@link AskUserRequestView}.
 *
 * Deliberately no `form`. A `form` would batch its inputs until submit, which
 * costs each question the ability to settle on its own; without one, an `input`
 * carries its own callback and Feishu draws it a send button, so committing free
 * text is the same explicit click as choosing an option.
 */
import { DREAMUX_ACTION_KEY } from './feishu-pairing-card.js';

export const DREAMUX_ASK_PICK_ACTION = 'ask_user_pick';
export const DREAMUX_ASK_OTHER_ACTION = 'ask_user_other';
export const DREAMUX_ASK_SUBMIT_ACTION = 'ask_user_submit';
export const DREAMUX_ASK_CANCEL_ACTION = 'ask_user_cancel';

export const DREAMUX_ASK_REQUEST_KEY = 'dreamux_ask_request';
export const DREAMUX_ASK_QUESTION_KEY = 'dreamux_ask_question';
export const DREAMUX_ASK_OPTION_KEY = 'dreamux_ask_option';

/** Every ask action, for the one membership test the ops dispatcher needs. */
export const DREAMUX_ASK_ACTIONS: ReadonlySet<string> = new Set([
  DREAMUX_ASK_PICK_ACTION,
  DREAMUX_ASK_OTHER_ACTION,
  DREAMUX_ASK_SUBMIT_ACTION,
  DREAMUX_ASK_CANCEL_ACTION,
]);

export interface AskUserOption {
  readonly label: string;
  readonly description: string;
}

export interface AskUserQuestionSpec {
  readonly header: string;
  readonly question: string;
  readonly options: readonly AskUserOption[];
}

/** What the user has settled on for one question, if anything. */
export type AskUserAnswer =
  | { readonly kind: 'option'; readonly index: number }
  | { readonly kind: 'other'; readonly text: string };

/** Everything a repaint reads. The card is a pure function of this. */
export interface AskUserRequestView {
  readonly requestId: string;
  readonly questions: readonly AskUserQuestionSpec[];
  readonly answers: ReadonlyMap<number, AskUserAnswer>;
}

/** The label an answered question shows, in the card and in the injected text. */
export function answerLabel(
  question: AskUserQuestionSpec,
  answer: AskUserAnswer | undefined,
): string | undefined {
  if (answer === undefined) return undefined;
  return answer.kind === 'option'
    ? question.options[answer.index]?.label
    : answer.text;
}

function markdown(
  content: string,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return { tag: 'markdown', content, ...extra };
}

function actionValue(
  action: string,
  requestId: string,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    [DREAMUX_ACTION_KEY]: action,
    [DREAMUX_ASK_REQUEST_KEY]: requestId,
    ...extra,
  };
}

function optionCard(
  requestId: string,
  questionIndex: number,
  optionIndex: number,
  option: AskUserOption,
  selected: boolean,
): Record<string, unknown> {
  return {
    tag: 'interactive_container',
    width: 'fill',
    has_border: true,
    border_color: selected ? 'blue-500' : 'grey-300',
    background_style: selected ? 'blue-50' : 'bg-white',
    corner_radius: '8px',
    padding: '8px 12px 8px 12px',
    vertical_spacing: '2px',
    behaviors: [
      {
        type: 'callback',
        value: actionValue(DREAMUX_ASK_PICK_ACTION, requestId, {
          [DREAMUX_ASK_QUESTION_KEY]: questionIndex,
          [DREAMUX_ASK_OPTION_KEY]: optionIndex,
        }),
      },
    ],
    elements: [
      markdown(
        selected
          ? `**<font color='blue'>${option.label}</font>**`
          : `**${option.label}**`,
      ),
      markdown(`<font color='grey'>${option.description}</font>`, {
        text_size: 'notation',
      }),
    ],
  };
}

/**
 * The free-text escape hatch, outside any form so it settles on its own.
 *
 * `default_value` is not cosmetic: a repaint replaces the whole card, so text
 * already committed has to be written back or the user watches their own answer
 * disappear the next time they touch another question.
 */
function otherInput(
  requestId: string,
  questionIndex: number,
  answer: AskUserAnswer | undefined,
): Record<string, unknown> {
  return {
    tag: 'input',
    name: `ask_${questionIndex}_other`,
    width: 'fill',
    max_length: 200,
    ...(answer?.kind === 'other' ? { default_value: answer.text } : {}),
    placeholder: { tag: 'plain_text', content: 'Other：直接写你的答案' },
    behaviors: [
      {
        type: 'callback',
        value: actionValue(DREAMUX_ASK_OTHER_ACTION, requestId, {
          [DREAMUX_ASK_QUESTION_KEY]: questionIndex,
        }),
      },
    ],
  };
}

function questionPanel(
  view: AskUserRequestView,
  questionIndex: number,
  question: AskUserQuestionSpec,
  expanded: boolean,
): Record<string, unknown> {
  const answer = view.answers.get(questionIndex);
  const elements: Record<string, unknown>[] = question.options.map(
    (option, optionIndex) =>
      optionCard(
        view.requestId,
        questionIndex,
        optionIndex,
        option,
        answer?.kind === 'option' && answer.index === optionIndex,
      ),
  );
  elements.push(otherInput(view.requestId, questionIndex, answer));
  // The panel's own padding is 0 so options reach the card edge, which also
  // removes the gap under the header; the first element restores it.
  elements[0] = { ...elements[0], margin: '8px 0px 0px 0px' };
  const chosen = answerLabel(question, answer);
  return {
    tag: 'collapsible_panel',
    expanded,
    padding: '0px',
    vertical_spacing: '8px',
    header: {
      title: markdown(
        `<text_tag color='${chosen === undefined ? 'blue' : 'green'}'>` +
          `${question.header}</text_tag> **${question.question}**` +
          (chosen === undefined ? '' : ` <font color='grey'>· ${chosen}</font>`),
      ),
      width: 'fill',
      vertical_align: 'center',
    },
    elements,
  };
}

/** The live question card. One unanswered question is open at a time. */
export function buildAskUserCard(view: AskUserRequestView): unknown {
  const answered = view.questions.filter(
    (_, index) => view.answers.has(index),
  ).length;
  const openIndex = view.questions.findIndex(
    (_, index) => !view.answers.has(index),
  );
  return {
    schema: '2.0',
    config: {
      update_multi: true,
      width_mode: 'default',
      summary: { content: `有 ${view.questions.length} 个问题需要你确认` },
    },
    header: {
      title: { tag: 'plain_text', content: '需要你做几个决策' },
      template: 'blue',
      icon: { tag: 'standard_icon', token: 'myai_colorful' },
      text_tag_list: [
        {
          tag: 'text_tag',
          text: {
            tag: 'plain_text',
            content: `${answered}/${view.questions.length}`,
          },
          color: answered === view.questions.length ? 'green' : 'yellow',
        },
      ],
    },
    body: {
      direction: 'vertical',
      padding: '12px 12px 20px 12px',
      vertical_spacing: '16px',
      elements: [
        ...view.questions.map((question, index) =>
          questionPanel(view, index, question, index === openIndex),
        ),
        {
          tag: 'column_set',
          flex_mode: 'none',
          horizontal_spacing: '8px',
          margin: '8px 0px 0px 0px',
          columns: [
            {
              tag: 'column',
              width: 'weighted',
              weight: 3,
              elements: [
                {
                  tag: 'button',
                  type: 'primary_filled',
                  width: 'fill',
                  size: 'medium',
                  text: { tag: 'plain_text', content: '提交回答' },
                  behaviors: [
                    {
                      type: 'callback',
                      value: actionValue(
                        DREAMUX_ASK_SUBMIT_ACTION,
                        view.requestId,
                      ),
                    },
                  ],
                },
              ],
            },
            {
              tag: 'column',
              width: 'weighted',
              weight: 2,
              elements: [
                {
                  tag: 'button',
                  // Red, because it ends the whole round rather than one answer.
                  type: 'danger',
                  width: 'fill',
                  size: 'medium',
                  text: { tag: 'plain_text', content: 'Talk about this' },
                  behaviors: [
                    {
                      type: 'callback',
                      value: actionValue(
                        DREAMUX_ASK_CANCEL_ACTION,
                        view.requestId,
                      ),
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    },
  };
}

/** The settled card: the questions with what was chosen, nothing clickable. */
export function buildAskUserSubmittedCard(view: AskUserRequestView): unknown {
  return {
    schema: '2.0',
    config: { update_multi: true, width_mode: 'default' },
    header: {
      title: { tag: 'plain_text', content: '已收到你的回答' },
      template: 'green',
      icon: { tag: 'standard_icon', token: 'done_outlined' },
    },
    body: {
      padding: '12px 12px 20px 12px',
      vertical_spacing: '12px',
      elements: view.questions.map((question, index) =>
        markdown(
          `**${question.header}** · ${question.question}\n> ` +
            (answerLabel(question, view.answers.get(index)) ?? '未作答'),
        ),
      ),
    },
  };
}

/** Why a round closed without an answer. */
export type AskUserClosedReason = 'cancelled' | 'expired';

/**
 * The closed card. A sent card cannot be deleted, so the nearest thing to
 * taking the question back is collapsing it to a single line with no header.
 */
export function buildAskUserClosedCard(reason: AskUserClosedReason): unknown {
  const line =
    reason === 'cancelled'
      ? '已取消这轮提问，直接说你的想法就行。'
      : '这轮提问已超时关闭，直接说你的想法就行。';
  return {
    schema: '2.0',
    config: {
      update_multi: true,
      width_mode: 'default',
      summary: {
        content: reason === 'cancelled' ? '这轮提问已取消' : '这轮提问已超时',
      },
    },
    body: {
      padding: '12px 12px 12px 12px',
      elements: [markdown(`<font color='grey'>${line}</font>`)],
    },
  };
}
