/**
 * Projects Core-sanitized dispatcher and TeamLeader conversation activity into
 * Feishu COT AG-UI events. Core owns generic safety processing. This layer only
 * selects presentation content and enforces Feishu event and batch budgets.
 */
import { createHash } from 'node:crypto';

import type { TeammateActivity } from '@excitedjs/dreamux-types';
import type { FeishuCotEventInput } from '@excitedjs/feishu-transport';

import {
  escapedBytes,
  nonEmpty,
  preserveSpacing,
  prettyJson,
  toolPresentation,
  truncateEscaped,
  TRUNCATION_MARKER,
  type CotToolCallActivity,
} from './feishu-cot-presentation.js';
import type { CotCodeSegment } from './feishu-cot-presentation.js';

export const FEISHU_COT_EVENT_CONTENT_MAX_BYTES = 4_096;
export const FEISHU_COT_APPEND_MAX_BYTES = 64 * 1_024;

const TEXT_MESSAGE_EVENT_GROUP_MAX_BYTES = 224 * 1_024;
/** What an event's content keeps free for its ids and keys beside the one string being fitted. */
const EVENT_CONTENT_RESERVE_BYTES = 256;
const TITLE_MAX_BYTES = FEISHU_COT_EVENT_CONTENT_MAX_BYTES - EVENT_CONTENT_RESERVE_BYTES;
const COT_EVENT_ENCODING_RESERVE_BYTES = 128;
const COT_REQUEST_ENCODING_RESERVE_BYTES = 512;

/**
 * How a card ends: the same three words the runtime uses for a turn end,
 * because a card's terminal *is* the end of what it was showing. The lifecycle
 * paths that retire an anchor or close a session use `interrupted`; replacing
 * an anchor completes its old card. Wire spelling is this module's business.
 *
 * Feishu documents one more `RUN_FINISHED.status`, `paused`, that nothing here
 * produces: a card is open or ended, never held. The omission is deliberate.
 */
export type FeishuCotTerminal = Extract<
  TeammateActivity,
  { kind: 'turn.ended' }
>['status'];

export function runStartedEvent(presentationId: string): FeishuCotEventInput {
  return checkedEvent({
    eventType: 'RUN_STARTED',
    content: { threadId: presentationId, runId: presentationId },
  });
}

/**
 * The one event that ends a card, across two event types: Feishu documents
 * `RUN_FINISHED.status` as exactly `done | paused | interrupted` and puts a
 * failure in its own `RUN_ERROR` event ("COT Message Brief", on the enterprise
 * docs host `open.larkoffice.com`; the public `open.feishu.cn` docs carry no
 * `message_cot` reference at all). A live probe agrees: `RUN_FINISHED` with
 * `failed` renders the client's 已完成 ("completed"), exactly as a deliberately
 * nonsense status does, and only `RUN_ERROR` renders its 任务失败 ("task
 * failed"). The platform accepted every one of them, so only the rendered card
 * is evidence, never the response code.
 *
 * `RUN_ERROR` sends `{ code }` alone. The reference documents a `message`
 * beside it, but two probes show the client neither renders it — an expanded
 * card shows the text appended before the terminal and then the client's own
 * fixed failure line, never the supplied string — nor requires it: a terminal
 * carrying only `code` renders identically. The failure reason reaches the
 * operator as that appended text message, which is the only thing that puts it
 * on the card.
 */
export function runTerminalEvent(
  presentationId: string,
  terminal: FeishuCotTerminal,
): FeishuCotEventInput {
  const run = { threadId: presentationId, runId: presentationId };
  switch (terminal) {
    case 'completed':
      return checkedEvent({
        eventType: 'RUN_FINISHED',
        content: { ...run, status: 'done' },
      });
    case 'interrupted':
      return checkedEvent({
        eventType: 'RUN_FINISHED',
        content: { ...run, status: 'interrupted' },
      });
    case 'failed':
      return checkedEvent({
        eventType: 'RUN_ERROR',
        content: { code: 'RUN_FAILED' },
      });
  }
}

export function textMessageEvents(input: {
  readonly sourceId: string;
  readonly role: 'assistant' | 'user';
  readonly content: string;
}): FeishuCotEventInput[] {
  if (input.content.trim() === '') return [];
  const messageId = opaqueDisplayId('message', input.sourceId);
  const start = checkedEvent({
    eventType: 'TEXT_MESSAGE_START',
    content: { messageId, role: input.role },
  });
  const end = checkedEvent({
    eventType: 'TEXT_MESSAGE_END',
    content: { messageId },
  });
  const contentEvents = splitForEventContent(
    input.content,
    (delta) => ({ messageId, delta }),
  ).map((content) => checkedEvent({
    eventType: 'TEXT_MESSAGE_CONTENT',
    content,
  }));
  if (contentEvents.length === 0) return [];
  return boundedTextMessageEventGroup(start, contentEvents, end, messageId);
}

export function toolCallStartEvents(event: CotToolCallActivity): FeishuCotEventInput[] {
  const toolCallId = opaqueDisplayId('call', event.call_id);
  const presentation = toolPresentation(event);
  const events = [
    checkedEvent({
      eventType: 'TOOL_CALL_START',
      content: {
        toolCallId,
        toolCallName: presentation.toolCallName,
        ...(presentation.icon === undefined ? {} : { icon: presentation.icon }),
        ...(presentation.title === undefined
          ? {}
          : { title: truncateEscaped(presentation.title, TITLE_MAX_BYTES) }),
      },
    }),
    // No row sends `TOOL_CALL_ARGS`: beside a title the client shows the
    // delta nowhere, and a row nothing could title hides it too. What the
    // call was reaches the card as a segment of its result instead.
    checkedEvent({
      eventType: 'TOOL_CALL_END',
      content: { toolCallId },
    }),
  ];
  return events;
}

export function toolCallResultEvents(event: CotToolCallActivity): FeishuCotEventInput[] {
  const messageId = opaqueDisplayId('result', event.event_id);
  const toolCallId = opaqueDisplayId('call', event.call_id);
  const presentation = toolPresentation(event);
  const failed = event.status === 'failed';
  const statusText = failed ? 'Failed' : 'Completed';
  // A call that named the things it was about is presented by those pills
  // alone, whatever its status: they already say what it touched, and the
  // client cannot fold a code segment away beside them, so a diff and an
  // output below them would bury the row that was supposed to be a glance.
  const content: unknown = presentation.items !== null
    ? { type: 'list', ...presentation.items }
    : toolResultContent(
      failed,
      presentation.arguments,
      toolResultOutput(event.result_json),
    );
  const projected = {
    eventType: 'TOOL_CALL_RESULT',
    content: {
      messageId,
      toolCallId,
      content,
      role: 'tool',
    },
  } satisfies FeishuCotEventInput;

  if (cotEventContentBytes(projected) <= FEISHU_COT_EVENT_CONTENT_MAX_BYTES) {
    return [checkedEvent(projected)];
  }
  return [
    checkedEvent({
      eventType: 'TOOL_CALL_RESULT',
      content: {
        messageId,
        toolCallId,
        content: { type: 'text', text: statusText },
        role: 'tool',
      },
    }),
  ];
}

/** Serialized content size checked before any event reaches an outbox. */
export function cotEventContentBytes(event: FeishuCotEventInput): number {
  return Buffer.byteLength(JSON.stringify(event.content), 'utf8');
}

/**
 * Conservative encoded-size estimate used for outbox and append bounds.
 * Transport owns the private request envelope; fixed reserves cover its
 * framing without reproducing that wire shape here.
 */
export function cotEventBytes(event: FeishuCotEventInput): number {
  const semanticContent = JSON.stringify(event.content);
  return jsonBytes(event.eventType) + jsonBytes(semanticContent) +
    COT_EVENT_ENCODING_RESERVE_BYTES;
}

export function cotAppendBatchBytes(
  input: {
    readonly cotId: string;
    readonly messageId: string;
    readonly events: readonly FeishuCotEventInput[];
  },
): number {
  return input.events.reduce((total, event) => total + cotEventBytes(event), 0) +
    jsonBytes(input.messageId) + jsonBytes(input.cotId) +
    COT_REQUEST_ENCODING_RESERVE_BYTES;
}

function checkedEvent(event: FeishuCotEventInput): FeishuCotEventInput {
  if (cotEventContentBytes(event) > FEISHU_COT_EVENT_CONTENT_MAX_BYTES) {
    throw new Error('Feishu COT projector produced oversized event content');
  }
  return event;
}

function opaqueDisplayId(kind: string, source: string): string {
  const digest = createHash('sha256')
    .update(kind)
    .update('\0')
    .update(source)
    .digest('base64url')
    .slice(0, 18);
  return `${kind}-${digest}`;
}


/**
 * What came back, as the card shows it: a structured value pretty-printed as
 * a `json` code segment, anything else as plain text — text output stays
 * text, and only what parses as JSON goes into a code segment. The whole text
 * is parsed first and cut last, so a cut never decides what a value was.
 * Plain text keeps ten content lines, then preserves its spacing the way the
 * client keeps it (`preserveSpacing`) before byte fitting. JSON keeps its lines
 * and spaces until byte fitting.
 */
export interface ToolResultOutput {
  readonly kind: 'json' | 'text';
  readonly text: string;
}

export function toolResultOutput(resultJson: string | null): ToolResultOutput | null {
  const text = nonEmpty(resultJson);
  if (text === null) return null;
  const structured = prettyJson(text);
  if (structured !== null) return { kind: 'json', text: structured };
  let boundary = -1;
  for (let line = 0; line < 10; line += 1) {
    boundary = text.indexOf('\n', boundary + 1);
    if (boundary === -1 || boundary === text.length - 1) {
      return { kind: 'text', text: preserveSpacing(text) };
    }
  }
  return {
    kind: 'text',
    text: preserveSpacing(text.slice(0, boundary + 1) + TRUNCATION_MARKER),
  };
}

/**
 * The label that separates what was asked from what came back.
 *
 * Its own segment, before the output rather than glued onto it, so it survives
 * whatever the output turns out to be — a `json` code block included. The blank
 * line keeps the word a paragraph: directly above `---` it would be Markdown's
 * setext heading instead.
 */
const RESULT_HEADER = 'RESULT\n\n---';

/**
 * One row's content, fitted to what a Feishu event may carry.
 *
 * The two variable strings are cut in the order a reader can spare them:
 * output first, then the arguments, each shrunk by what the whole content
 * overshot. Both shrink to their truncation marker at worst, and the fixed
 * labels beside them are a few dozen bytes, so this always converges well
 * inside the budget; `toolCallResultEvents` still measures the finished event.
 */
function toolResultContent(
  failed: boolean,
  argumentCode: CotCodeSegment | null,
  output: ToolResultOutput | null,
): unknown {
  const maxBytes = FEISHU_COT_EVENT_CONTENT_MAX_BYTES -
    EVENT_CONTENT_RESERVE_BYTES;
  let code = argumentCode;
  let result = output;
  let content = toolResultSegments(failed, code, result);

  if (jsonBytes(content) > maxBytes && result !== null) {
    result = {
      kind: result.kind,
      text: shrinkForContentBudget(result.text, jsonBytes(content) - maxBytes),
    };
    content = toolResultSegments(failed, code, result);
  }
  if (jsonBytes(content) > maxBytes && code !== null) {
    code = {
      language: code.language,
      code: shrinkForContentBudget(code.code, jsonBytes(content) - maxBytes),
    };
    content = toolResultSegments(failed, code, result);
  }
  return content;
}

/**
 * What an expanded row shows, in the order it happened: what was asked, then
 * the RESULT label, then what came back. Without output, Complete or Failed
 * fills that area; actual output needs no additional status line.
 */
function toolResultSegments(
  failed: boolean,
  argumentCode: CotCodeSegment | null,
  result: ToolResultOutput | null,
): unknown {
  const segments: Array<Record<string, unknown>> = [];
  if (argumentCode !== null) {
    segments.push({
      type: 'code',
      language: argumentCode.language,
      code: argumentCode.code,
    });
  }
  segments.push({ type: 'text', text: RESULT_HEADER });
  if (result !== null) {
    segments.push(result.kind === 'json'
      ? { type: 'code', language: 'json', code: result.text }
      : { type: 'text', text: result.text });
  } else {
    segments.push({ type: 'text', text: failed ? 'Failed' : 'Complete' });
  }
  return segments;
}

function shrinkForContentBudget(value: string, overflowBytes: number): string {
  const target = Math.max(
    escapedBytes(TRUNCATION_MARKER),
    escapedBytes(value) - overflowBytes - 32,
  );
  return truncateEscaped(value, target);
}


function splitForEventContent(
  text: string,
  content: (chunk: string) => Record<string, unknown>,
): Record<string, unknown>[] {
  const emptyBytes = jsonBytes(content(''));
  const payloadBudget = FEISHU_COT_EVENT_CONTENT_MAX_BYTES - emptyBytes;
  if (payloadBudget <= 0) return [];
  const chunks: string[] = [];
  let characters: string[] = [];
  let bytes = 0;
  for (const character of text) {
    const escaped = JSON.stringify(character).slice(1, -1);
    const characterBytes = Buffer.byteLength(escaped, 'utf8');
    if (characters.length > 0 && bytes + characterBytes > payloadBudget) {
      chunks.push(characters.join(''));
      characters = [];
      bytes = 0;
    }
    if (characterBytes > payloadBudget) continue;
    characters.push(character);
    bytes += characterBytes;
  }
  if (characters.length > 0) chunks.push(characters.join(''));
  return chunks.map(content);
}

function boundedTextMessageEventGroup(
  start: FeishuCotEventInput,
  contentEvents: readonly FeishuCotEventInput[],
  end: FeishuCotEventInput,
  messageId: string,
): FeishuCotEventInput[] {
  const boundaryBytes = cotEventBytes(start) + cotEventBytes(end);
  let bytes = boundaryBytes;
  const accepted: FeishuCotEventInput[] = [];
  for (const event of contentEvents) {
    const eventBytes = cotEventBytes(event);
    if (bytes + eventBytes > TEXT_MESSAGE_EVENT_GROUP_MAX_BYTES) break;
    accepted.push(event);
    bytes += eventBytes;
  }
  if (accepted.length === contentEvents.length) return [start, ...accepted, end];

  const marker = checkedEvent({
    eventType: 'TEXT_MESSAGE_CONTENT',
    content: { messageId, delta: TRUNCATION_MARKER },
  });
  const markerBytes = cotEventBytes(marker);
  while (
    accepted.length > 0 &&
    bytes + markerBytes > TEXT_MESSAGE_EVENT_GROUP_MAX_BYTES
  ) {
    const removed = accepted.pop();
    if (removed !== undefined) bytes -= cotEventBytes(removed);
  }
  return [start, ...accepted, marker, end];
}


function jsonBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}
