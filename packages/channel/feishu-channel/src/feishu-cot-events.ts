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
  toolPresentation,
  truncateEscaped,
  TRUNCATION_MARKER,
  type CotToolCallActivity,
} from './feishu-cot-presentation.js';
import type { CotItemList } from './feishu-cot-presentation.js';

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
 * paths that end a card with no runtime saying so — a retired anchor, a session
 * close — are exactly `interrupted`. Wire spelling is this module's business.
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
    // delta nowhere (probe, 2026-09-03), and a row nothing could title hides
    // its arguments by ruling (「mcp 工具隐藏掉参数吧」, 2026-09-04).
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
  const statusText = event.status === 'failed' ? 'Failed' : 'Completed';
  let content: unknown;
  if (presentation.items !== null && event.status !== 'failed') {
    // A read or edit that succeeded shows its items and nothing else: the
    // operator ruled the diff and the output redundant beside the pills, and
    // the client cannot fold a code segment away. A failed one keeps them,
    // because the output is the only place the failure's reason appears.
    content = assembleToolResultContent({
      failed: false,
      argumentsText: null,
      items: presentation.items,
      result: null,
    });
  } else {
    content = assembleToolResultContent({
      failed: event.status === 'failed',
      argumentsText: presentation.invocation,
      argumentsLanguage: presentation.invocationLanguage,
      items: presentation.items,
      result: toolResultOutput(event.result_json),
    });
  }
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
 * The pieces of one `TOOL_CALL_RESULT`: what the call was, in the caller's
 * notation, and what came back. Segments follow the COT Message Brief —
 * `{type:'text', text}` and `{type:'code', language, code}`, alone or as an
 * array — and `language` is documented as semantic only, never highlighted.
 */
export interface ToolResultParts {
  readonly failed: boolean;
  readonly argumentsText: string | null;
  readonly argumentsLanguage?: 'text' | 'bash';
  /** The call's items, shown as the pills of a `list` segment before anything else. */
  readonly items?: CotItemList | null;
  readonly result: ToolResultOutput | null;
}

/**
 * What came back, as the card shows it: a structured value pretty-printed as
 * a `json` code segment, anything else as plain text (operator ruling,
 * 2026-09-04: 「文本的输出，就按文本输出。能解析成JSON的再放进代码段」). The whole
 * text is parsed first and cut last, so a cut never decides what a value was.
 * Plain text keeps its spacing the way the client keeps it (`preserveSpacing`),
 * before the cut is measured; a code segment keeps its own spaces.
 */
export interface ToolResultOutput {
  readonly kind: 'json' | 'text';
  readonly text: string;
}

export function toolResultOutput(resultJson: string | null): ToolResultOutput | null {
  const text = nonEmpty(resultJson);
  if (text === null) return null;
  try {
    const value: unknown = JSON.parse(text);
    if (typeof value === 'object' && value !== null) {
      return { kind: 'json', text: JSON.stringify(value, null, 2) };
    }
  } catch {
    // Not JSON: the runtime's own text, shown as text.
  }
  return { kind: 'text', text: preserveSpacing(text) };
}

export function assembleToolResultContent(parts: ToolResultParts): unknown {
  let argumentsText = parts.argumentsText;
  let result = parts.result;
  const maxBytes = FEISHU_COT_EVENT_CONTENT_MAX_BYTES -
    EVENT_CONTENT_RESERVE_BYTES;
  let content = toolResultSegments(parts, argumentsText, result);

  if (jsonBytes(content) > maxBytes && result !== null) {
    result = {
      kind: result.kind,
      text: shrinkForContentBudget(result.text, jsonBytes(content) - maxBytes),
    };
    content = toolResultSegments(parts, argumentsText, result);
  }
  if (jsonBytes(content) > maxBytes && argumentsText !== null) {
    argumentsText = shrinkForContentBudget(
      argumentsText,
      jsonBytes(content) - maxBytes,
    );
    content = toolResultSegments(parts, argumentsText, result);
  }
  if (jsonBytes(content) > maxBytes) {
    result = null;
    content = toolResultSegments(parts, argumentsText, result);
  }
  if (jsonBytes(content) > maxBytes) {
    argumentsText = null;
    content = toolResultSegments(parts, argumentsText, result);
  }
  if (jsonBytes(content) > maxBytes) {
    return { type: 'text', text: parts.failed ? 'Failed' : 'Completed' };
  }
  return content;
}

function toolResultSegments(
  parts: ToolResultParts,
  argumentsText: string | null,
  result: ToolResultOutput | null,
): unknown {
  const segments: Array<Record<string, unknown>> = [];
  if (parts.failed) segments.push({ type: 'text', text: 'Failed' });
  if (parts.items) segments.push({ type: 'list', ...parts.items });
  if (argumentsText !== null) {
    segments.push({
      type: 'code',
      language: parts.argumentsLanguage ?? 'text',
      code: argumentsText,
    });
  }
  if (result !== null) {
    segments.push(result.kind === 'json'
      ? { type: 'code', language: 'json', code: result.text }
      : { type: 'text', text: result.text });
  }
  if (segments.length === 0) {
    return { type: 'text', text: parts.failed ? 'Failed' : 'Completed' };
  }
  return segments.length === 1 ? segments[0] : segments;
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
