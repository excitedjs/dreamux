/**
 * Native reasoning on the Feishu COT card.
 *
 * The operator asked for reasoning increments to reach the card, each visible
 * block headed by `Thinking...`, with append calls paced to at most one every
 * 500 milliseconds. These tests drive the adapter under a fake clock, so the
 * cadence they assert is the real request cadence rather than a promise that
 * the code merely awaited something.
 *
 * Every identifier here is a placeholder.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { FeishuCotAdapter } from '../src/cot/adapter.js';
import {
  COT_REASONING_PREFIX,
  mergeAdjacentReasoningDelta,
} from '../src/cot/card.js';
import type { FeishuCotEventInput } from '@excitedjs/feishu-transport';

import { cotEventBytes, cotEventContentBytes } from '../src/cot/bytes.js';
import { CotOutbox, type CotOutboxAdmission } from '../src/cot/recipients.js';
import { createFeishuLifecycle } from '../src/session/lifecycle.js';
import {
  COT_APPEND_INTERVAL_MS,
  LEADER,
  anchorAt,
  cotTestClock,
  message,
  nativeEnd,
  reasoning,
  restoreCotClock,
  silentLog,
  submitInbound,
  useCotClock,
} from './helpers/feishu-cot-fixtures.js';
import {
  cotReasoningBlocks,
  cotReasoningSections,
  cotTerminal,
  cotTexts,
  createFakeCotClient,
  type FakeCotCard,
  type FakeCotClient,
} from './helpers/fake-feishu-cot.js';

interface Harness {
  readonly adapter: FeishuCotAdapter;
  readonly cot: FakeCotClient;
}

function harness(cotReasoning: boolean): Harness {
  const cot = createFakeCotClient();
  const adapter = new FeishuCotAdapter({
    dispatcherId: 'disp-cot',
    channelId: 'chan-cot',
    log: silentLog,
    cotClient: cot,
    lifecycle: createFeishuLifecycle(),
    cotReasoning,
  });
  return { adapter, cot };
}

function onlyCard(cot: FakeCotClient): FakeCotCard {
  expect(cot.cards).toHaveLength(1);
  return cot.cards[0]!;
}

/** One provider reasoning chunk: 32 ASCII characters, distinguishable by ordinal. */
function chunk(ordinal: number): string {
  return `${String(ordinal).padStart(6, '0')}${'.'.repeat(26)}`;
}

/** The platform's per-event, per-request, and request-count ceilings. */
const EVENT_CONTENT_MAX_BYTES = 4_096;
const APPEND_MAX_EVENTS = 50;
const APPEND_MAX_WIRE_BYTES = 64 * 1_024;

/**
 * One append request exactly as the transport builds it: `content` is
 * stringified a second time inside the event object, and the body carries the
 * card's message and COT ids beside the event array.
 */
function appendWireBody(
  card: FakeCotCard,
  batch: readonly { readonly eventType: string; readonly content: object }[],
): string {
  return JSON.stringify({
    events: batch.map((event) => ({
      event_type: event.eventType,
      content: JSON.stringify(event.content),
      timestamp: Date.now(),
    })),
    message_id: card.messageId,
    cot_id: card.cotId,
  });
}

function expectWithinPlatformLimits(card: FakeCotCard): void {
  expect(card.appendBatches.length).toBeGreaterThan(1);
  for (const batch of card.appendBatches) {
    expect(batch.length).toBeLessThanOrEqual(APPEND_MAX_EVENTS);
    for (const event of batch) {
      // The channel's own per-event budget applies to the serialized content.
      expect(
        Buffer.byteLength(JSON.stringify(event.content), 'utf8'),
      ).toBeLessThanOrEqual(EVENT_CONTENT_MAX_BYTES);
    }
    expect(
      Buffer.byteLength(appendWireBody(card, batch), 'utf8'),
    ).toBeLessThanOrEqual(APPEND_MAX_WIRE_BYTES);
  }
}

function expectPacedAppends(card: FakeCotCard): void {
  for (let index = 1; index < card.appendStarts.length; index += 1) {
    expect(
      card.appendStarts[index]! - card.appendStarts[index - 1]!,
    ).toBeGreaterThanOrEqual(COT_APPEND_INTERVAL_MS);
  }
}

const { settle, closeWithin } = cotTestClock({ settleMs: 0 });

beforeEach(useCotClock);
afterEach(restoreCotClock);

describe('Feishu COT reasoning — native blocks', () => {
  it('opens one reasoning section per visible part, prefixes it once, and closes it', async () => {
    const { adapter, cot } = harness(true);
    submitInbound(adapter, LEADER, 'turn-1', anchorAt('oc_team', 'om_1'));
    await settle();

    adapter.handle(reasoning(LEADER, 'item-1', 0, 'first thought'));
    await settle(COT_APPEND_INTERVAL_MS);
    adapter.handle(reasoning(LEADER, 'item-1', 0, ' and more'));
    await settle(COT_APPEND_INTERVAL_MS);
    adapter.handle(reasoning(LEADER, 'item-1', 0, '', 'completed'));
    await settle(COT_APPEND_INTERVAL_MS);

    const card = onlyCard(cot);
    const blocks = cotReasoningBlocks(card);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.messageId).not.toBe('');
    expect(blocks[0]!.text).toBe(
      `${COT_REASONING_PREFIX}\n\nfirst thought and more`,
    );
    expect(blocks[0]!.starts).toBe(1);
    expect(blocks[0]!.ends).toBe(1);
    expect(cotReasoningSections(card)).toEqual({
      started: 1,
      ended: 1,
      messageStarts: 1,
      messageEnds: 1,
      contents: 2,
    });
    // The native order the COT reference documents, before any other content.
    expect(card.events.map((event) => event.eventType)).toEqual([
      'RUN_STARTED',
      'TEXT_MESSAGE_START',
      'TEXT_MESSAGE_CONTENT',
      'TEXT_MESSAGE_END',
      'REASONING_START',
      'REASONING_MESSAGE_START',
      'REASONING_MESSAGE_CONTENT',
      'REASONING_MESSAGE_CONTENT',
      'REASONING_MESSAGE_END',
      'REASONING_END',
    ]);

    await closeWithin(adapter);
  });

  it('keeps one block per native part: a reused item id and a new part position are separate blocks', async () => {
    const { adapter, cot } = harness(true);
    submitInbound(adapter, LEADER, 'turn-1', anchorAt('oc_team', 'om_1'));
    await settle();

    adapter.handle(reasoning(LEADER, 'item-1', 0, 'part zero', 'completed'));
    await settle(COT_APPEND_INTERVAL_MS);
    adapter.handle(reasoning(LEADER, 'item-1', 1, 'part one', 'completed'));
    await settle(COT_APPEND_INTERVAL_MS);

    const blocks = cotReasoningBlocks(onlyCard(cot));
    expect(blocks).toHaveLength(2);
    expect(blocks.map((block) => block.text)).toEqual([
      `${COT_REASONING_PREFIX}\n\npart zero`,
      `${COT_REASONING_PREFIX}\n\npart one`,
    ]);
    expect(blocks[0]!.messageId).not.toBe(blocks[1]!.messageId);
    expect(cotReasoningSections(onlyCard(cot))).toMatchObject({
      started: 2,
      ended: 2,
    });

    await closeWithin(adapter);
  });

  it('renders a completed snapshot that had no increments, and ignores an empty completion', async () => {
    const { adapter, cot } = harness(true);
    submitInbound(adapter, LEADER, 'turn-1', anchorAt('oc_team', 'om_1'));
    await settle();

    // No increments arrived at all: the completion is the first text.
    adapter.handle(
      reasoning(LEADER, 'item-1', 0, 'whole thought', 'completed'),
    );
    await settle(COT_APPEND_INTERVAL_MS);
    expect(cotReasoningBlocks(onlyCard(cot))[0]!.text).toBe(
      `${COT_REASONING_PREFIX}\n\nwhole thought`,
    );

    // An empty completion closes no block and opens none.
    adapter.handle(reasoning(LEADER, 'item-2', 0, '', 'completed'));
    await settle(COT_APPEND_INTERVAL_MS);
    expect(cotReasoningBlocks(onlyCard(cot))).toHaveLength(1);
    expect(cotReasoningSections(onlyCard(cot))).toMatchObject({
      started: 1,
      ended: 1,
    });

    await closeWithin(adapter);
  });

  it('splits an increment that would overflow one event, keeping every event within the budget', async () => {
    const { adapter, cot } = harness(true);
    submitInbound(adapter, LEADER, 'turn-1', anchorAt('oc_team', 'om_1'));
    await settle();

    const huge = 'x'.repeat(12_000);
    adapter.handle(reasoning(LEADER, 'item-1', 0, huge, 'completed'));
    await settle(COT_APPEND_INTERVAL_MS);

    const card = onlyCard(cot);
    expect(cotReasoningBlocks(card)[0]!.text).toBe(
      `${COT_REASONING_PREFIX}\n\n${huge}`,
    );
    const contents = card.events.filter(
      (event) => event.eventType === 'REASONING_MESSAGE_CONTENT',
    );
    expect(contents.length).toBeGreaterThan(1);
    for (const event of contents) {
      expect(
        Buffer.byteLength(JSON.stringify(event.content), 'utf8'),
      ).toBeLessThanOrEqual(4_096);
    }

    await closeWithin(adapter);
  });
});

describe('Feishu COT reasoning — 500ms append cadence', () => {
  it('starts every append at least 500ms after the previous one, the first immediately', async () => {
    const { adapter, cot } = harness(true);
    submitInbound(adapter, LEADER, 'turn-1', anchorAt('oc_team', 'om_1'));
    await settle();

    const card = onlyCard(cot);
    const before = card.appendStarts.length;
    expect(before).toBeGreaterThan(0);

    adapter.handle(reasoning(LEADER, 'item-1', 0, 'a'));
    await settle(COT_APPEND_INTERVAL_MS - 1);
    expect(card.appendStarts).toHaveLength(before);

    await settle(1);
    expect(card.appendStarts).toHaveLength(before + 1);
    expect(card.appendStarts[before]! - card.appendStarts[before - 1]!).toBe(
      COT_APPEND_INTERVAL_MS,
    );

    // Another increment after that flush is paced from the previous start.
    adapter.handle(reasoning(LEADER, 'item-1', 0, 'b'));
    await settle(COT_APPEND_INTERVAL_MS - 1);
    expect(card.appendStarts).toHaveLength(before + 1);
    await settle(1);
    expect(card.appendStarts).toHaveLength(before + 2);

    await closeWithin(adapter);
  });

  it('waits before taking the batch, so an increment arriving mid-window joins it', async () => {
    const { adapter, cot } = harness(true);
    submitInbound(adapter, LEADER, 'turn-1', anchorAt('oc_team', 'om_1'));
    await settle();

    const card = onlyCard(cot);
    const before = card.appendStarts.length;
    const previousStart = card.appendStarts.at(-1)!;

    // A arrives 100ms after the previous append, B at 400ms — both inside
    // the one 500ms window the cadence allows.
    await settle(100);
    adapter.handle(reasoning(LEADER, 'item-1', 0, 'a'));
    await settle(300);
    adapter.handle(reasoning(LEADER, 'item-1', 0, 'b'));
    await settle(100);

    // No extra beat: A and B travel in the one append the cadence allows,
    // and neither was delayed to the following window.
    expect(card.appendStarts).toHaveLength(before + 1);
    expect(card.appendStarts.at(-1)! - previousStart).toBe(
      COT_APPEND_INTERVAL_MS,
    );
    expect(cotReasoningSections(card).contents).toBe(1);
    expect(cotReasoningBlocks(card)[0]!.text).toBe(
      `${COT_REASONING_PREFIX}\n\nab`,
    );

    await closeWithin(adapter);
  });

  it('coalesces adjacent increments of one block into a single content event before admission', async () => {
    const { adapter, cot } = harness(true);
    submitInbound(adapter, LEADER, 'turn-1', anchorAt('oc_team', 'om_1'));
    await settle();

    // All three arrive within one pacing window.
    adapter.handle(reasoning(LEADER, 'item-1', 0, 'a'));
    adapter.handle(reasoning(LEADER, 'item-1', 0, 'b'));
    adapter.handle(reasoning(LEADER, 'item-1', 0, 'c'));
    await settle(COT_APPEND_INTERVAL_MS);

    const card = onlyCard(cot);
    expect(cotReasoningSections(card).contents).toBe(1);
    expect(cotReasoningBlocks(card)[0]!.text).toBe(
      `${COT_REASONING_PREFIX}\n\nabc`,
    );

    await closeWithin(adapter);
  });

  it('keeps parts independently open, so an interleaved part does not re-prefix the first', async () => {
    const { adapter, cot } = harness(true);
    submitInbound(adapter, LEADER, 'turn-1', anchorAt('oc_team', 'om_1'));
    await settle();

    // A part opens, another part opens, then the first part continues.
    adapter.handle(reasoning(LEADER, 'item-1', 0, 'a1'));
    adapter.handle(reasoning(LEADER, 'item-2', 0, 'b1'));
    adapter.handle(reasoning(LEADER, 'item-1', 0, 'a2'));
    await settle(COT_APPEND_INTERVAL_MS);

    const blocks = cotReasoningBlocks(onlyCard(cot));
    expect(blocks).toHaveLength(2);
    expect(blocks[0]!.text).toBe(`${COT_REASONING_PREFIX}\n\na1a2`);
    expect(blocks[0]!.starts).toBe(1);
    expect(blocks[1]!.text).toBe(`${COT_REASONING_PREFIX}\n\nb1`);
    expect(cotReasoningSections(onlyCard(cot))).toMatchObject({
      started: 2,
      messageStarts: 2,
      ended: 0,
      messageEnds: 0,
    });

    await closeWithin(adapter);
  });

  it('never coalesces across a text or tool barrier, and keeps the original order', async () => {
    const { adapter, cot } = harness(true);
    submitInbound(adapter, LEADER, 'turn-1', anchorAt('oc_team', 'om_1'));
    await settle();

    adapter.handle(reasoning(LEADER, 'item-1', 0, 'before'));
    adapter.handle(message(LEADER, 'visible answer'));
    adapter.handle(reasoning(LEADER, 'item-1', 0, 'after'));
    await settle(COT_APPEND_INTERVAL_MS);

    const card = onlyCard(cot);
    expect(cotReasoningSections(card).contents).toBe(2);
    expect(cotReasoningBlocks(card)[0]!.text).toBe(
      `${COT_REASONING_PREFIX}\n\nbeforeafter`,
    );
    const types = card.events.map((event) => event.eventType);
    expect(types.lastIndexOf('TEXT_MESSAGE_START')).toBeGreaterThan(
      types.indexOf('REASONING_MESSAGE_CONTENT'),
    );
    expect(types.lastIndexOf('REASONING_MESSAGE_CONTENT')).toBeGreaterThan(
      types.lastIndexOf('TEXT_MESSAGE_END'),
    );
    expect(cotTexts(card).at(-1)).toBe('visible answer');

    await closeWithin(adapter);
  });

  it('paces the terminal batch from the previous append and delivers it after the reasoning close', async () => {
    const { adapter, cot } = harness(true);
    submitInbound(adapter, LEADER, 'turn-1', anchorAt('oc_team', 'om_1'));
    await settle();

    const card = onlyCard(cot);
    const before = card.appendStarts.length;

    adapter.handle(reasoning(LEADER, 'item-1', 0, 'thought'));
    adapter.handle(nativeEnd(LEADER, 'completed'));

    await settle(COT_APPEND_INTERVAL_MS - 1);
    expect(card.appendStarts).toHaveLength(before);
    await settle(1);

    expect(card.appendStarts).toHaveLength(before + 1);
    expect(card.appendStarts[before]! - card.appendStarts[before - 1]!).toBe(
      COT_APPEND_INTERVAL_MS,
    );
    const types = card.events.map((event) => event.eventType);
    expect(types.at(-1)).toBe('RUN_FINISHED');
    expect(types.indexOf('REASONING_MESSAGE_END')).toBeLessThan(
      types.lastIndexOf('RUN_FINISHED'),
    );
    expect(types.indexOf('REASONING_END')).toBeLessThan(
      types.lastIndexOf('RUN_FINISHED'),
    );
    expect(cotTerminal(card)).toBe('done');

    await closeWithin(adapter);
  });

  it('starts a replacement card immediately with a fresh prefix, without waiting out the old card', async () => {
    const { adapter, cot } = harness(true);
    submitInbound(adapter, LEADER, 'turn-1', anchorAt('oc_team', 'om_1'));
    await settle();
    adapter.handle(reasoning(LEADER, 'item-1', 0, 'old thought'));
    await settle(COT_APPEND_INTERVAL_MS);

    const first = cot.cards[0]!;
    // Replace the anchor while the first card's terminal is still pending.
    submitInbound(adapter, LEADER, 'turn-2', anchorAt('oc_team', 'om_2'));
    adapter.handle(reasoning(LEADER, 'item-1', 0, 'new thought'));
    await settle();
    // The recipient's serialized queue is still draining the old card's own
    // paced terminal, so the replacement is created after it, not instead.
    expect(cot.cards).toHaveLength(1);

    await settle(COT_APPEND_INTERVAL_MS);
    expect(cot.cards).toHaveLength(2);
    const second = cot.cards[1]!;
    expect(second.originMessageId).toBe('om_2');
    // The new presentation's first append is immediate after its create: it
    // never waits out another presentation's cadence.
    expect(second.appendStarts).toHaveLength(1);
    expect(second.appendStarts[0]).toBe(second.createdAt);
    expect(cotTerminal(first)).toBe('done');
    expect(cotReasoningSections(first)).toMatchObject({
      started: 1,
      ended: 1,
    });
    expect(cotReasoningBlocks(second)[0]!.text).toBe(
      `${COT_REASONING_PREFIX}\n\nnew thought`,
    );

    await closeWithin(adapter);
  });

  it('re-prefixes after an append failure opened a fresh card', async () => {
    const { adapter, cot } = harness(true);
    submitInbound(adapter, LEADER, 'turn-1', anchorAt('oc_team', 'om_1'));
    await settle();
    cot.appendError = new Error('append refused');

    adapter.handle(reasoning(LEADER, 'item-1', 0, 'first attempt'));
    await settle(COT_APPEND_INTERVAL_MS);
    expect(cotReasoningBlocks(cot.cards[0]!)).toHaveLength(0);

    cot.appendError = null;
    adapter.handle(reasoning(LEADER, 'item-1', 0, 'second attempt'));
    await settle(COT_APPEND_INTERVAL_MS);

    expect(cot.cards).toHaveLength(2);
    expect(cotReasoningBlocks(cot.cards[1]!)[0]!.text).toBe(
      `${COT_REASONING_PREFIX}\n\nsecond attempt`,
    );

    await closeWithin(adapter);
  });

  it('drains on close: the pending increment, its close, and the terminal share one paced append', async () => {
    const { adapter, cot } = harness(true);
    submitInbound(adapter, LEADER, 'turn-1', anchorAt('oc_team', 'om_1'));
    await settle();
    const card = onlyCard(cot);
    const before = card.appendStarts.length;

    adapter.handle(reasoning(LEADER, 'item-1', 0, 'still thinking'));
    await settle();
    // The flush is now waiting for its cadence slot.
    expect(card.appendStarts).toHaveLength(before);

    const closing = adapter.close();
    await settle(COT_APPEND_INTERVAL_MS);
    await closing;

    // Closes and the terminal arrive during the wait, so they travel in the
    // one append the cadence allows rather than forcing a second beat.
    expect(card.appendStarts).toHaveLength(before + 1);
    expect(card.appendStarts[before]! - card.appendStarts[before - 1]!).toBe(
      COT_APPEND_INTERVAL_MS,
    );
    expect(cotTerminal(card)).toBe('interrupted');
    // The open block was closed before the terminal, never truncated away.
    expect(cotReasoningSections(card)).toMatchObject({
      started: 1,
      ended: 1,
    });
    const types = card.events.map((event) => event.eventType);
    expect(types.indexOf('REASONING_END')).toBeLessThan(
      types.indexOf('RUN_FINISHED'),
    );
  });
  it('never starts an append early when a stalled write outlives the drain cut-off', async () => {
    const { adapter, cot } = harness(true);
    submitInbound(adapter, LEADER, 'turn-1', anchorAt('oc_team', 'om_1'));
    await settle();
    const card = onlyCard(cot);

    // Enough independent parts to fill more than one 50-event append batch,
    // so another cadence wait is still pending when the drain cut-off fires.
    for (let index = 0; index < 60; index += 1) {
      adapter.handle(
        reasoning(LEADER, `item-${index}`, 0, `thought ${index}`, 'completed'),
      );
    }

    cot.stallNextAppendMs = 4_700;
    await settle(COT_APPEND_INTERVAL_MS);
    // The receipt, then the first batch whose platform call is still stalled.
    expect(card.appendStarts).toHaveLength(2);

    const closing = adapter.close();
    await settle(4_700);
    // The stalled call completed; the next batch starts at this (legal) time.
    expect(card.appendStarts).toHaveLength(3);
    const beforeCutoff = [...card.appendStarts];

    await settle(300);
    await closing;
    await settle();

    // The cut-off released a cadence wait whose next append was not legal
    // until 500ms later; aborting first keeps it from starting.
    expect(card.appendStarts).toEqual(beforeCutoff);
    for (let index = 1; index < card.appendStarts.length; index += 1) {
      expect(
        card.appendStarts[index]! - card.appendStarts[index - 1]!,
      ).toBeGreaterThanOrEqual(COT_APPEND_INTERVAL_MS);
    }
    // The released wait's timer is cleared with the drain.
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('Feishu COT reasoning — high-frequency burst and bounded outbox', () => {
  it('coalesces a >400-chunk burst into paced multi-request appends without losing text', async () => {
    const { adapter, cot } = harness(true);
    submitInbound(adapter, LEADER, 'turn-1', anchorAt('oc_team', 'om_1'));
    await settle();
    const card = onlyCard(cot);

    const CHUNKS = 6_000;
    let expected = `${COT_REASONING_PREFIX}\n\n`;
    for (let index = 0; index < CHUNKS; index += 1) {
      const text = chunk(index);
      expected += text;
      adapter.handle(reasoning(LEADER, 'item-1', 0, text));
    }
    // 6,000 chunks × 32 bytes: raw stream far exceeds the 400-event queue,
    // while the coalesced events stay inside its 256 KiB byte budget.
    expect(CHUNKS).toBeGreaterThan(400);
    expect(Buffer.byteLength(expected, 'utf8')).toBeGreaterThan(180_000);

    adapter.handle(reasoning(LEADER, 'item-1', 0, '', 'completed'));
    adapter.handle(nativeEnd(LEADER, 'completed'));
    await settle(COT_APPEND_INTERVAL_MS * 10);

    const blocks = cotReasoningBlocks(card);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.text).toBe(expected);

    const contentEvents = card.appendBatches
      .flat()
      .filter((event) => event.eventType === 'REASONING_MESSAGE_CONTENT');
    expect(contentEvents.length).toBeGreaterThan(1);
    expect(contentEvents.length).toBeLessThan(400);

    expectWithinPlatformLimits(card);
    expectPacedAppends(card);
    expect(cotTerminal(card)).toBe('done');
    expect(card.events.at(-1)?.eventType).toBe('RUN_FINISHED');

    await closeWithin(adapter);
  }, 20_000);

  it('drops new chunks once the outbox byte budget is full, but never the terminal', async () => {
    const { adapter, cot } = harness(true);
    submitInbound(adapter, LEADER, 'turn-1', anchorAt('oc_team', 'om_1'));
    await settle();
    const card = onlyCard(cot);

    // 384 KiB of raw chunks against a 256 KiB outbox: the tail that cannot
    // be admitted is dropped, and the shown text is the surviving prefix.
    const CHUNKS = 12_000;
    let expected = `${COT_REASONING_PREFIX}\n\n`;
    for (let index = 0; index < CHUNKS; index += 1) {
      const text = chunk(index);
      expected += text;
      adapter.handle(reasoning(LEADER, 'item-1', 0, text));
    }
    adapter.handle(reasoning(LEADER, 'item-1', 0, '', 'completed'));
    adapter.handle(nativeEnd(LEADER, 'completed'));
    await settle(COT_APPEND_INTERVAL_MS * 10);

    const shown = cotReasoningBlocks(card)[0]!.text;
    expect(shown.length).toBeGreaterThan(0);
    // Nothing inside the shown prefix was reordered or corrupted; only its
    // unadmitted tail is missing.
    expect(expected.startsWith(shown)).toBe(true);
    expect(shown.length).toBeLessThan(expected.length);

    expectWithinPlatformLimits(card);
    expectPacedAppends(card);
    // The terminal is not an outbox event, so a full queue can never drop it.
    expect(cotTerminal(card)).toBe('done');
    expect(card.events.at(-1)?.eventType).toBe('RUN_FINISHED');

    await closeWithin(adapter);
  }, 20_000);
});

describe('Feishu COT reasoning — merge byte accounting', () => {
  const messageId = 'reasoning-example';

  function contentEvent(id: string, delta: string): FeishuCotEventInput {
    return {
      eventType: 'REASONING_MESSAGE_CONTENT',
      content: { messageId: id, delta },
    };
  }

  it.each([
    { what: 'plain ASCII', previous: 'abc', incoming: 'def' },
    { what: 'a quote', previous: 'a', incoming: '"' },
    { what: 'a backslash', previous: 'a\\', incoming: '\\b' },
    { what: 'control characters', previous: 'a', incoming: '\n\t\u0001' },
    { what: 'non-ASCII text', previous: '汉字', incoming: '🙂д' },
    {
      what: 'a high surrogate split from its low',
      previous: 'a\uD83D',
      incoming: '\uDE00b',
    },
    { what: 'a lone low surrogate', previous: 'a', incoming: '\uDE00b' },
    { what: 'a lone high surrogate', previous: 'a', incoming: '\uD83Db' },
  ])(
    'reports the exact content and wire increases for $what',
    ({ previous, incoming }) => {
      const tail = contentEvent(messageId, previous);
      const next = contentEvent(messageId, incoming);
      const merged = mergeAdjacentReasoningDelta(tail, next);

      expect(merged).not.toBeNull();
      expect(merged!.event.content['delta']).toBe(previous + incoming);
      // The oracles are the two serializations the outbox budgets against.
      expect(merged!.extraContentBytes).toBe(
        cotEventContentBytes(merged!.event) - cotEventContentBytes(tail),
      );
      expect(merged!.extraWireBytes).toBe(
        cotEventBytes(merged!.event) - cotEventBytes(tail),
      );
    },
  );

  it('reports negative increases when a lone high surrogate joins a lone low', () => {
    const tail = contentEvent(messageId, '\uD83D');
    const next = contentEvent(messageId, '\uDE00');
    const merged = mergeAdjacentReasoningDelta(tail, next);

    expect(merged).not.toBeNull();
    // The two escapes (6 single / 7 wire each) collapse into one raw pair
    // (4 bytes); the increase is negative and must not be clamped.
    expect(merged!.extraContentBytes).toBe(-2);
    expect(merged!.extraWireBytes).toBe(-3);
    expect(merged!.extraContentBytes).toBe(
      cotEventContentBytes(merged!.event) - cotEventContentBytes(tail),
    );
    expect(merged!.extraWireBytes).toBe(
      cotEventBytes(merged!.event) - cotEventBytes(tail),
    );
  });

  it('keeps the tail content budget across a partial dequeue, and resets it on clear', () => {
    const outbox = new CotOutbox();
    const merge = mergeAdjacentReasoningDelta;
    const id = 'reasoning-example';

    // A request takes at most 50 events, so these leave the large tail behind.
    for (let index = 0; index < 50; index += 1) {
      outbox.admit([contentEvent(`other-${index}`, 'x')]);
    }
    // Leave four bytes of the event-content budget free on a same-id tail.
    const overhead = cotEventContentBytes(contentEvent(id, ''));
    const tailDelta = 'a'.repeat(4_096 - overhead - 4);
    outbox.admit([contentEvent(id, tailDelta)]);
    expect(outbox.takeAppendBatch('cot-x', 'message-x')).toHaveLength(50);

    // Three bytes still fit the tail; ten would overflow one event, so the
    // increment starts its own event instead of merging.
    const fits = outbox.admit([contentEvent(id, 'bbb')], merge);
    expect(fits.accepted).toBe(true);
    const overflows = outbox.admit([contentEvent(id, 'c'.repeat(10))], merge);
    expect(overflows.accepted).toBe(true);

    const drained: FeishuCotEventInput[] = [];
    for (;;) {
      const batch = outbox.takeAppendBatch('cot-x', 'message-x');
      if (batch.length === 0) break;
      drained.push(...batch);
    }
    const contents = drained.filter(
      (event) => event.eventType === 'REASONING_MESSAGE_CONTENT',
    );
    expect(contents).toHaveLength(2);
    expect(contents[0]!.content['delta']).toBe(`${tailDelta}bbb`);
    expect(contents[1]!.content['delta']).toBe('c'.repeat(10));
    for (const event of contents) {
      expect(cotEventContentBytes(event)).toBeLessThanOrEqual(4_096);
    }

    // A clear() while a nearly-full tail is queued must reset the measured
    // budget: the next small tail accepts a large increment that a stale 4KiB
    // tail would have refused, and the merged event stays within one event.
    outbox.admit([contentEvent(id, tailDelta)]);
    outbox.clear();
    outbox.admit([contentEvent(id, 'a')]);
    const afterClear = outbox.admit(
      [contentEvent(id, 'd'.repeat(4_000))],
      merge,
    );
    expect(afterClear.accepted).toBe(true);

    const reset: FeishuCotEventInput[] = [];
    for (;;) {
      const batch = outbox.takeAppendBatch('cot-x', 'message-x');
      if (batch.length === 0) break;
      reset.push(...batch);
    }
    expect(reset).toHaveLength(1);
    expect(reset[0]!.content['delta']).toBe(`a${'d'.repeat(4_000)}`);
    expect(cotEventContentBytes(reset[0]!)).toBeLessThanOrEqual(4_096);
  });

  it('keeps the wire byte total exact across merges, a dequeue, and a refusal', () => {
    const outbox = new CotOutbox();
    const merge = mergeAdjacentReasoningDelta;

    // A merged tail, then enough independent events that one append request
    // cannot dequeue them all.
    for (let index = 0; index < 8; index += 1) {
      outbox.admit([contentEvent(messageId, 'chunk')], merge);
    }
    for (let index = 0; index < 20; index += 1) {
      outbox.admit([contentEvent(`other-${index}`, 'z'.repeat(4000))]);
    }
    outbox.takeAppendBatch('cot-x', 'message-x');

    let refused: CotOutboxAdmission | null = null;
    for (let index = 0; index < 400 && refused === null; index += 1) {
      const result = outbox.admit(
        [contentEvent(messageId, 'y'.repeat(4000))],
        merge,
      );
      if (!result.accepted) refused = result;
    }
    expect(refused).not.toBeNull();
    expect(refused!.bufferedBytes).toBeLessThanOrEqual(256 * 1_024);

    // Drain what the refusal reported and compare the outbox's own total with
    // the exact wire sizes of the events it still holds.
    const drained: FeishuCotEventInput[] = [];
    for (;;) {
      const batch = outbox.takeAppendBatch('cot-x', 'message-x');
      if (batch.length === 0) break;
      drained.push(...batch);
    }
    const expectedBytes = drained.reduce(
      (total, event) => total + cotEventBytes(event),
      0,
    );
    expect(refused!.bufferedBytes).toBe(expectedBytes);
  });
});

describe('Feishu COT reasoning — configuration gate', () => {
  it('shows no reasoning and no prefix when cot.reasoning is off, while ordinary content continues', async () => {
    const { adapter, cot } = harness(false);
    submitInbound(adapter, LEADER, 'turn-1', anchorAt('oc_team', 'om_1'));
    await settle();

    adapter.handle(
      reasoning(LEADER, 'item-1', 0, 'a private thought', 'completed'),
    );
    adapter.handle(message(LEADER, 'the answer'));
    await settle(COT_APPEND_INTERVAL_MS);

    const card = onlyCard(cot);
    expect(cotReasoningBlocks(card)).toEqual([]);
    expect(cotReasoningSections(card)).toEqual({
      started: 0,
      ended: 0,
      messageStarts: 0,
      messageEnds: 0,
      contents: 0,
    });
    expect(cotTexts(card).at(-1)).toBe('the answer');

    await closeWithin(adapter);
  });
});
