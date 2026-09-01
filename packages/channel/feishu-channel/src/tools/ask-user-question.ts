/**
 * `ask_user_question` — the decision card, offered to the model.
 *
 * The arguments are AskUserQuestion's, near enough to be read as the same tool:
 * `questions`, each with a `header` chip, a `question`, and 2-4 `options` of
 * `label` + `description` + optional `preview`. Two things differ, and both are
 * forced rather than chosen: a `chat_id`, because a chat tool needs a
 * destination and AskUserQuestion has no such concept, and no `multiSelect`,
 * because the operator ruled multi-select out of this channel.
 *
 * The other difference is in the answer, not the arguments. AskUserQuestion
 * returns what the user chose; this returns as soon as the card is sent, and
 * the answer arrives later as an ordinary inbound message. The model therefore
 * has to be told to stop and wait — which is what `next` in the result is for,
 * repeated on every call so it survives a long context.
 */
import { PublicInvokeFailure } from '@excitedjs/dreamux-utils';

import type { AskUserOption, AskUserQuestionSpec } from '../feishu-ask-user-card.js';
import {
  asRecord,
  closedObjectSchema,
  nonEmptyString,
  requireString,
} from './schema.js';
import type { FeishuToolDef } from './types.js';

const MAX_HEADER_CHARS = 12;
const MIN_QUESTIONS = 1;
const MAX_QUESTIONS = 4;
const MIN_OPTIONS = 2;
const MAX_OPTIONS = 4;

/** The standing instruction for a tool whose answer never arrives in its result. */
export const ASK_USER_NEXT_INSTRUCTION =
  'The question card has been sent. Do NOT do any further work and do NOT ' +
  'guess an answer: end your turn now and wait. The user\'s answer arrives ' +
  'later as a normal inbound message. If the user dismisses the card, that ' +
  'message will say so — drop the card and continue in plain conversation.';

const optionSchema = closedObjectSchema(
  {
    label: {
      ...nonEmptyString,
      description:
        'The display text for this option that the user will see and select. ' +
        'Should be concise (1-5 words) and clearly describe the choice.',
    },
    description: {
      ...nonEmptyString,
      description:
        'Explanation of what this option means or what will happen if chosen. ' +
        'Useful for providing context about trade-offs or implications.',
    },
    preview: {
      ...nonEmptyString,
      description:
        'Optional preview content shown beside the options while this option ' +
        'is the selected one. Use for mockups, code snippets, or visual ' +
        'comparisons that help users compare options. Rendered as a monospace ' +
        'block.',
    },
  },
  ['label', 'description'],
);

const questionSchema = closedObjectSchema(
  {
    header: {
      ...nonEmptyString,
      maxLength: MAX_HEADER_CHARS,
      description:
        'Very short label displayed as a chip/tag (max 12 chars). Examples: ' +
        '"Auth method", "Library", "Approach".',
    },
    question: {
      ...nonEmptyString,
      description:
        'The complete question to ask the user. Should be clear, specific, ' +
        'and end with a question mark.',
    },
    options: {
      type: 'array',
      minItems: MIN_OPTIONS,
      maxItems: MAX_OPTIONS,
      items: optionSchema,
      description:
        'The available choices for this question. Must have 2-4 options. Each ' +
        'option should be a distinct, mutually exclusive choice. There should ' +
        "be no 'Other' option, that will be provided automatically.",
    },
  },
  ['header', 'question', 'options'],
);

interface AskUserQuestionInput {
  chatId: string;
  questions: readonly AskUserQuestionSpec[];
}

function parseOption(raw: unknown, where: string): AskUserOption {
  const obj = asRecord(raw, where);
  const preview = obj['preview'];
  if (preview !== undefined && typeof preview !== 'string') {
    throw new PublicInvokeFailure(`${where}.preview must be a string`);
  }
  return {
    label: requireString(obj, 'label'),
    description: requireString(obj, 'description'),
    ...(typeof preview === 'string' && preview !== '' ? { preview } : {}),
  };
}

function parseQuestion(raw: unknown, index: number): AskUserQuestionSpec {
  const where = `questions[${index}]`;
  const obj = asRecord(raw, where);
  const header = requireString(obj, 'header');
  if ([...header].length > MAX_HEADER_CHARS) {
    throw new PublicInvokeFailure(
      `${where}.header must be at most ${MAX_HEADER_CHARS} characters`,
    );
  }
  const options = obj['options'];
  if (
    !Array.isArray(options) ||
    options.length < MIN_OPTIONS ||
    options.length > MAX_OPTIONS
  ) {
    throw new PublicInvokeFailure(
      `${where}.options must have ${MIN_OPTIONS}-${MAX_OPTIONS} options`,
    );
  }
  return {
    header,
    question: requireString(obj, 'question'),
    options: options.map((option, optionIndex) =>
      parseOption(option, `${where}.options[${optionIndex}]`),
    ),
  };
}

export const askUserQuestionDef: FeishuToolDef<AskUserQuestionInput> = {
  name: 'ask_user_question',
  title: 'Ask the user a question',
  description:
    'Use this tool only when you are blocked on a decision that is genuinely ' +
    "the user's to make: one you cannot resolve from the request, the code, " +
    'or sensible defaults. It renders the questions as an interactive Feishu ' +
    'card in the chat.\n\n' +
    'Usage notes:\n' +
    '- Users will always be able to write an "Other" answer of their own, so ' +
    'never add an "Other" option yourself\n' +
    '- If you recommend a specific option, make that the first option in the ' +
    'list and add "(Recommended)" at the end of the label\n' +
    '- Single-select only: every question takes exactly one answer. Split a ' +
    'decision that needs several answers into several questions\n' +
    '- This tool does NOT return the answer. It returns as soon as the card ' +
    'is sent; end your turn and wait, and the answer will arrive as a normal ' +
    'inbound message\n\n' +
    "Reserve this for decisions where the user's answer changes what you do " +
    'next — not for choices with a conventional default or facts you can ' +
    'verify in the codebase yourself. In those cases pick the obvious option, ' +
    'mention it in your response, and proceed.\n\n' +
    'Preview feature: use the optional `preview` field on options when ' +
    'presenting concrete artifacts that users need to visually compare — ' +
    'ASCII mockups of UI layouts, code snippets showing different ' +
    'implementations, diagram variations, configuration examples. The preview ' +
    'of the selected option is shown beside the options in a monospace block.',
  callers: ['dispatcher', 'team_leader'],
  inputSchema: closedObjectSchema(
    {
      chat_id: {
        ...nonEmptyString,
        description:
          'Feishu chat id from the inbound <channel source="feishu"> block. ' +
          'The card is sent to this conversation.',
      },
      questions: {
        type: 'array',
        minItems: MIN_QUESTIONS,
        maxItems: MAX_QUESTIONS,
        items: questionSchema,
        description: 'Questions to ask the user (1-4 questions)',
      },
    },
    ['chat_id', 'questions'],
  ),
  outputSchema: closedObjectSchema(
    {
      request_id: nonEmptyString,
      status: { type: 'string', enum: ['asked'] },
      next: nonEmptyString,
    },
    ['request_id', 'status', 'next'],
  ),
  annotations: { readOnlyHint: false, destructiveHint: false },
  parse(raw) {
    const obj = asRecord(raw, 'ask_user_question arguments');
    const questions = obj['questions'];
    if (
      !Array.isArray(questions) ||
      questions.length < MIN_QUESTIONS ||
      questions.length > MAX_QUESTIONS
    ) {
      throw new PublicInvokeFailure(
        `questions must have ${MIN_QUESTIONS}-${MAX_QUESTIONS} questions`,
      );
    }
    return {
      chatId: requireString(obj, 'chat_id'),
      questions: questions.map(parseQuestion),
    };
  },
  async handle(ctx, input) {
    const result = await ctx.session.askUserQuestion({
      chatId: input.chatId,
      questions: input.questions,
    });
    return {
      request_id: result.request_id,
      status: 'asked',
      next: ASK_USER_NEXT_INSTRUCTION,
    };
  },
};
