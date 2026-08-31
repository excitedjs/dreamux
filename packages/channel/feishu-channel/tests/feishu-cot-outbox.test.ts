/**
 * The COT outbox contract (COVERAGE CELL F).
 *
 * This is the whole buffering half of the display: a presentation admits
 * projected activity into a bounded buffer, and a flush takes as much of it as
 * one platform append may legally carry. Both bounds are load-bearing —
 * an unbounded buffer would let a runaway Agent grow a session's heap, and an
 * over-budget batch would be rejected by Feishu itself — so they are asserted
 * as observable behavior of the pure functions that own them, not as constants
 * read back out of the module.
 *
 * Admission is *group-atomic*: one projected activity is several AG-UI events
 * (start/content/end) that only make sense together, so a group that does not
 * fit is dropped whole and never half-buffered.
 */
import { describe, expect, it } from 'vitest';

import {
  FEISHU_COT_APPEND_MAX_EVENTS,
  type FeishuCotEventInput,
} from '@excitedjs/feishu-transport';

import {
  cotAppendBatchBytes,
  cotEventBytes,
  FEISHU_COT_APPEND_MAX_BYTES,
} from '../src/feishu-cot-events.js';
import {
  admitCotOutboxEvents,
  appendCotTerminalIfFits,
  clearCotOutbox,
  cotOutboxHasEvents,
  createCotOutbox,
  takeCotAppendBatch,
} from '../src/feishu-cot-outbox.js';

const COT_ID = 'cot-1';
const MESSAGE_ID = 'om-cot-1';

function event(delta: string, messageId = 'message-1'): FeishuCotEventInput {
  return {
    eventType: 'TEXT_MESSAGE_CONTENT',
    content: { messageId, delta },
  };
}

/** A single event whose encoded size is at least `bytes`. */
function heavyEvent(bytes: number): FeishuCotEventInput {
  const built = event('x'.repeat(Math.max(1, bytes)));
  return cotEventBytes(built) >= bytes ? built : event('x'.repeat(bytes * 2));
}

describe('outbox admission is bounded and group-atomic', () => {
  it('starts empty and admits an ordinary activity group whole', () => {
    const outbox = createCotOutbox();
    expect(cotOutboxHasEvents(outbox)).toBe(false);

    const group = [event('a'), event('b'), event('c')];
    expect(admitCotOutboxEvents(outbox, group)).toEqual({ accepted: true });
    expect(outbox.events).toEqual(group);
    expect(outbox.bytes).toBe(
      group.reduce((total, item) => total + cotEventBytes(item), 0),
    );
    expect(outbox.droppedEvents).toBe(0);
    expect(cotOutboxHasEvents(outbox)).toBe(true);
  });

  it('refuses the group that would cross the 400-event bound, buffering none of it', () => {
    const outbox = createCotOutbox();
    for (let index = 0; index < 398; index += 1) {
      expect(admitCotOutboxEvents(outbox, [event(`e${index}`)]).accepted).toBe(true);
    }
    expect(outbox.events).toHaveLength(398);

    // Three more would be 401: the whole group is refused, not the one event
    // that overflows, because a half-written message renders as garbage.
    const rejected = admitCotOutboxEvents(outbox, [
      event('x'),
      event('y'),
      event('z'),
    ]);
    expect(rejected.accepted).toBe(false);
    expect(outbox.events).toHaveLength(398);
    expect(outbox.droppedEvents).toBe(3);

    // A group that still fits is admitted after the refusal: the buffer is
    // bounded, not poisoned.
    expect(admitCotOutboxEvents(outbox, [event('tail')]).accepted).toBe(true);
    expect(outbox.events).toHaveLength(399);
  });

  it('refuses a group that would cross the 256 KiB byte bound', () => {
    const outbox = createCotOutbox();
    const chunk = heavyEvent(32 * 1_024);
    let admitted = 0;
    while (admitCotOutboxEvents(outbox, [chunk]).accepted) {
      admitted += 1;
      if (admitted > 64) throw new Error('byte bound never reached');
    }
    // The event count bound (400) is nowhere near reached, so the byte bound
    // is what stopped it.
    expect(outbox.events.length).toBeLessThan(400);
    expect(outbox.bytes).toBeLessThanOrEqual(256 * 1_024);
    expect(outbox.bytes + cotEventBytes(chunk)).toBeGreaterThan(256 * 1_024);
  });

  it('reports only the first drop, and counts every dropped event thereafter', () => {
    const outbox = createCotOutbox();
    const filler = heavyEvent(64 * 1_024);
    let first = admitCotOutboxEvents(outbox, [filler]);
    for (let guard = 0; first.accepted && guard < 64; guard += 1) {
      first = admitCotOutboxEvents(outbox, [filler]);
    }

    // The refusal that ends the fill is the one the adapter logs about, and it
    // reports what is still buffered so the warning is actionable.
    expect(first).toMatchObject({
      accepted: false,
      firstDrop: true,
      bufferedEvents: outbox.events.length,
      bufferedBytes: outbox.bytes,
    });
    expect(outbox.droppedEvents).toBe(1);

    // The warning is emitted once per presentation; later drops still count.
    const second = admitCotOutboxEvents(outbox, [filler, filler]);
    expect(second).toMatchObject({ accepted: false, firstDrop: false });
    expect(outbox.droppedEvents).toBe(3);
  });

  it('clearing releases the buffer and its byte credit but keeps the drop tally', () => {
    const outbox = createCotOutbox();
    admitCotOutboxEvents(outbox, [event('a'), event('b')]);
    const oversized = heavyEvent(300 * 1_024);
    admitCotOutboxEvents(outbox, [oversized]);
    expect(outbox.droppedEvents).toBe(1);

    clearCotOutbox(outbox);

    expect(outbox.events).toHaveLength(0);
    expect(outbox.bytes).toBe(0);
    expect(cotOutboxHasEvents(outbox)).toBe(false);
    // The tally survives: it is what the finished-card log reports.
    expect(outbox.droppedEvents).toBe(1);
  });
});

describe('append batching respects both platform budgets', () => {
  it('takes at most one legal append worth of events and removes exactly those', () => {
    const outbox = createCotOutbox();
    for (let index = 0; index < FEISHU_COT_APPEND_MAX_EVENTS + 7; index += 1) {
      admitCotOutboxEvents(outbox, [event(`e${index}`)]);
    }
    const buffered = outbox.events.length;

    const batch = takeCotAppendBatch(outbox, COT_ID, MESSAGE_ID);

    expect(batch).toHaveLength(FEISHU_COT_APPEND_MAX_EVENTS);
    expect(outbox.events).toHaveLength(buffered - FEISHU_COT_APPEND_MAX_EVENTS);
    // FIFO: the batch is the head of the buffer, in order.
    expect(batch[0]).toEqual(event('e0'));
    expect(outbox.events[0]).toEqual(event(`e${FEISHU_COT_APPEND_MAX_EVENTS}`));
    expect(outbox.bytes).toBe(
      outbox.events.reduce((total, item) => total + cotEventBytes(item), 0),
    );
  });

  it('stops below the 50-event cap when the next event would cross the append byte budget', () => {
    const outbox = createCotOutbox();
    const chunk = heavyEvent(8 * 1_024);
    for (let index = 0; index < 20; index += 1) {
      admitCotOutboxEvents(outbox, [chunk]);
    }

    const batch = takeCotAppendBatch(outbox, COT_ID, MESSAGE_ID);

    expect(batch.length).toBeGreaterThan(0);
    expect(batch.length).toBeLessThan(FEISHU_COT_APPEND_MAX_EVENTS);
    expect(
      cotAppendBatchBytes({ cotId: COT_ID, messageId: MESSAGE_ID, events: batch }),
    ).toBeLessThanOrEqual(FEISHU_COT_APPEND_MAX_BYTES);
    // What did not fit stays buffered for the next flush.
    expect(cotOutboxHasEvents(outbox)).toBe(true);
  });

  it('takes nothing when the head event alone cannot fit — the signal a card is unsendable', () => {
    const outbox = createCotOutbox();
    const unsendable = heavyEvent(FEISHU_COT_APPEND_MAX_BYTES + 1_024);
    admitCotOutboxEvents(outbox, [unsendable]);

    const batch = takeCotAppendBatch(outbox, COT_ID, MESSAGE_ID);

    // An empty batch over a non-empty outbox is exactly the state the flush
    // loop treats as `append_batch_too_large`; without it the loop would spin.
    expect(batch).toHaveLength(0);
    expect(cotOutboxHasEvents(outbox)).toBe(true);
  });

  it('takes nothing from an empty outbox', () => {
    const outbox = createCotOutbox();
    expect(takeCotAppendBatch(outbox, COT_ID, MESSAGE_ID)).toHaveLength(0);
  });
});

describe('the terminal event rides the last append only when it fits', () => {
  const terminal: FeishuCotEventInput = {
    eventType: 'RUN_FINISHED',
    content: { threadId: 'p-1', runId: 'p-1', status: 'done' },
  };

  it('appends the terminal to a batch with room', () => {
    const batch = [event('a')];
    expect(appendCotTerminalIfFits(batch, terminal, COT_ID, MESSAGE_ID)).toBe(true);
    expect(batch).toHaveLength(2);
    expect(batch.at(-1)).toEqual(terminal);
  });

  it('refuses a batch already at the 50-event cap', () => {
    const batch = Array.from({ length: FEISHU_COT_APPEND_MAX_EVENTS }, (_, i) =>
      event(`e${i}`),
    );
    expect(appendCotTerminalIfFits(batch, terminal, COT_ID, MESSAGE_ID)).toBe(false);
    expect(batch).toHaveLength(FEISHU_COT_APPEND_MAX_EVENTS);
  });

  it('refuses a batch that has no byte room left for it', () => {
    const outbox = createCotOutbox();
    const chunk = heavyEvent(8 * 1_024);
    for (let index = 0; index < 20; index += 1) {
      admitCotOutboxEvents(outbox, [chunk]);
    }
    const batch = takeCotAppendBatch(outbox, COT_ID, MESSAGE_ID);
    // Pad the batch back up to the byte ceiling so the terminal cannot fit.
    while (
      batch.length < FEISHU_COT_APPEND_MAX_EVENTS &&
      cotAppendBatchBytes({
        cotId: COT_ID,
        messageId: MESSAGE_ID,
        events: [...batch, chunk],
      }) <= FEISHU_COT_APPEND_MAX_BYTES
    ) {
      batch.push(chunk);
    }
    const filler = heavyEvent(
      FEISHU_COT_APPEND_MAX_BYTES -
        cotAppendBatchBytes({
          cotId: COT_ID,
          messageId: MESSAGE_ID,
          events: batch,
        }),
    );
    batch.push(filler);

    const before = batch.length;
    expect(appendCotTerminalIfFits(batch, terminal, COT_ID, MESSAGE_ID)).toBe(false);
    expect(batch).toHaveLength(before);
  });
});
