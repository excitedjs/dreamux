/** Pure bounded buffering and append-batch selection for one COT presentation. */
import {
  FEISHU_COT_APPEND_MAX_EVENTS,
  type FeishuCotEventInput,
} from '@excitedjs/feishu-transport';

import {
  cotAppendBatchBytes,
  cotEventBytes,
  FEISHU_COT_APPEND_MAX_BYTES,
} from './feishu-cot-events.js';
import type { CotOutboxState } from './feishu-cot-state.js';

const FEISHU_COT_OUTBOX_MAX_EVENTS = 400;
const FEISHU_COT_OUTBOX_MAX_BYTES = 256 * 1_024;

export type CotOutboxAdmission =
  | { readonly accepted: true }
  | {
      readonly accepted: false;
      readonly firstDrop: boolean;
      readonly bufferedEvents: number;
      readonly bufferedBytes: number;
    };

export function createCotOutbox(): CotOutboxState {
  return { events: [], bytes: 0, droppedEvents: 0 };
}

export function admitCotOutboxEvents(
  outbox: CotOutboxState,
  events: readonly FeishuCotEventInput[],
): CotOutboxAdmission {
  const bytes = events.reduce((total, event) => total + cotEventBytes(event), 0);
  if (
    outbox.events.length + events.length > FEISHU_COT_OUTBOX_MAX_EVENTS ||
    outbox.bytes + bytes > FEISHU_COT_OUTBOX_MAX_BYTES
  ) {
    const firstDrop = outbox.droppedEvents === 0;
    outbox.droppedEvents += events.length;
    return {
      accepted: false,
      firstDrop,
      bufferedEvents: outbox.events.length,
      bufferedBytes: outbox.bytes,
    };
  }
  outbox.events.push(...events);
  outbox.bytes += bytes;
  return { accepted: true };
}

export function cotOutboxHasEvents(outbox: CotOutboxState): boolean {
  return outbox.events.length > 0;
}

export function clearCotOutbox(outbox: CotOutboxState): void {
  outbox.events.length = 0;
  outbox.bytes = 0;
}

export function takeCotAppendBatch(
  outbox: CotOutboxState,
  cotId: string,
  messageId: string,
): FeishuCotEventInput[] {
  const batch: FeishuCotEventInput[] = [];
  while (
    batch.length < FEISHU_COT_APPEND_MAX_EVENTS &&
    outbox.events.length > 0
  ) {
    const next = outbox.events[0];
    if (next === undefined) break;
    if (cotAppendBatchBytes({
      cotId,
      messageId,
      events: [...batch, next],
    }) > FEISHU_COT_APPEND_MAX_BYTES) {
      break;
    }
    outbox.events.shift();
    outbox.bytes -= cotEventBytes(next);
    batch.push(next);
  }
  return batch;
}

export function appendCotTerminalIfFits(
  batch: FeishuCotEventInput[],
  terminal: FeishuCotEventInput,
  cotId: string,
  messageId: string,
): boolean {
  if (
    batch.length >= FEISHU_COT_APPEND_MAX_EVENTS ||
    cotAppendBatchBytes({
      cotId,
      messageId,
      events: [...batch, terminal],
    }) > FEISHU_COT_APPEND_MAX_BYTES
  ) {
    return false;
  }
  batch.push(terminal);
  return true;
}
