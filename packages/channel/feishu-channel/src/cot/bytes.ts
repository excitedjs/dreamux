/**
 * Whether something fits Feishu's COT wire budgets, and how to cut it down
 * when it does not. This module makes no display decision — `./card.js` picks
 * what a card shows; everything here only measures bytes and truncates.
 */
import {
  FEISHU_COT_APPEND_MAX_EVENTS,
  type FeishuCotEventInput,
} from '@excitedjs/feishu-transport';

/** The one bound a single event's `content` must fit, whatever produced it. */
export const FEISHU_COT_EVENT_CONTENT_MAX_BYTES = 4_096;
/** What an event's content keeps free for its ids and keys beside the one string being fitted. */
export const EVENT_CONTENT_RESERVE_BYTES = 256;
/** A `TOOL_CALL_START.title` shares the same per-event content budget. */
export const TITLE_MAX_BYTES =
  FEISHU_COT_EVENT_CONTENT_MAX_BYTES - EVENT_CONTENT_RESERVE_BYTES;
/** What the pills of a result's item list may spend before the rest is folded into a `more` pill. */
export const TOOL_ITEMS_SOFT_MAX_BYTES = 512;
export const TRUNCATION_MARKER = '… (truncated)';

const TEXT_MESSAGE_EVENT_GROUP_MAX_BYTES = 224 * 1_024;
const COT_EVENT_ENCODING_RESERVE_BYTES = 128;
const COT_REQUEST_ENCODING_RESERVE_BYTES = 512;
const FEISHU_COT_APPEND_MAX_BYTES = 64 * 1_024;
const FEISHU_COT_OUTBOX_MAX_EVENTS = 400;
const FEISHU_COT_OUTBOX_MAX_BYTES = 256 * 1_024;

function jsonBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

export function escapedBytes(value: string): number {
  return Buffer.byteLength(JSON.stringify(value).slice(1, -1), 'utf8');
}

export function truncateEscaped(value: string, maxBytes: number): string {
  const valueBytes = escapedBytes(value);
  if (valueBytes <= maxBytes) return value;
  const markerBytes = escapedBytes(TRUNCATION_MARKER);
  const prefixBudget = Math.max(0, maxBytes - markerBytes);
  const prefix: string[] = [];
  let bytes = 0;
  for (const character of value) {
    const characterBytes = escapedBytes(character);
    if (bytes + characterBytes > prefixBudget) break;
    prefix.push(character);
    bytes += characterBytes;
  }
  return `${prefix.join('')}${TRUNCATION_MARKER}`;
}

/** Shrink a string by roughly `overflowBytes`, to its truncation marker at worst. */
export function shrinkForContentBudget(
  value: string,
  overflowBytes: number,
): string {
  const target = Math.max(
    escapedBytes(TRUNCATION_MARKER),
    escapedBytes(value) - overflowBytes - 32,
  );
  return truncateEscaped(value, target);
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
  return (
    jsonBytes(event.eventType) +
    jsonBytes(semanticContent) +
    COT_EVENT_ENCODING_RESERVE_BYTES
  );
}

function cotAppendBatchBytes(input: {
  readonly cotId: string;
  readonly messageId: string;
  readonly events: readonly FeishuCotEventInput[];
}): number {
  return (
    input.events.reduce((total, event) => total + cotEventBytes(event), 0) +
    jsonBytes(input.messageId) +
    jsonBytes(input.cotId) +
    COT_REQUEST_ENCODING_RESERVE_BYTES
  );
}

/** Refuses an event whose own content already overshoots the per-event bound. */
export function checkedEvent(event: FeishuCotEventInput): FeishuCotEventInput {
  if (cotEventContentBytes(event) > FEISHU_COT_EVENT_CONTENT_MAX_BYTES) {
    throw new Error('Feishu COT projector produced oversized event content');
  }
  return event;
}

/** Split text into chunks that each fit one event's content budget. */
export function splitForEventContent(
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

/** Bound one `TEXT_MESSAGE_*` group to Feishu's per-group byte budget, marking a cut. */
export function boundedTextMessageEventGroup(
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
  if (accepted.length === contentEvents.length)
    return [start, ...accepted, end];

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

/** Whether an outbox holding `bufferedEvents`/`bufferedBytes` can also admit `incoming`. */
export function outboxAdmits(
  bufferedEvents: number,
  bufferedBytes: number,
  incoming: readonly FeishuCotEventInput[],
): { readonly fits: boolean; readonly incomingBytes: number } {
  const incomingBytes = incoming.reduce(
    (total, event) => total + cotEventBytes(event),
    0,
  );
  const fits =
    bufferedEvents + incoming.length <= FEISHU_COT_OUTBOX_MAX_EVENTS &&
    bufferedBytes + incomingBytes <= FEISHU_COT_OUTBOX_MAX_BYTES;
  return { fits, incomingBytes };
}

/** Whether one append call carrying `events` fits Feishu's per-append bounds. */
export function appendBatchFits(
  cotId: string,
  messageId: string,
  events: readonly FeishuCotEventInput[],
): boolean {
  return (
    events.length <= FEISHU_COT_APPEND_MAX_EVENTS &&
    cotAppendBatchBytes({ cotId, messageId, events }) <=
      FEISHU_COT_APPEND_MAX_BYTES
  );
}
