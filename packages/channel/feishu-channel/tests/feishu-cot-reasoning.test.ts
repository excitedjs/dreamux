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

import type {
  DreamuxLogger,
  RuntimeActivity,
  TeammateActivityEvent,
  TeammateRole,
} from '@excitedjs/dreamux-types';

import { FeishuCotAdapter } from '../src/cot/adapter.js';
import { COT_REASONING_PREFIX } from '../src/cot/card.js';
import type { VisibleMessageAnchor } from '../src/cot/recipients.js';
import { chatTarget } from '../src/routing/target.js';
import { createFeishuLifecycle } from '../src/session/lifecycle.js';
import {
  cotReasoningBlocks,
  cotReasoningSections,
  cotTerminal,
  cotTexts,
  createFakeCotClient,
  type FakeCotCard,
  type FakeCotClient,
} from './helpers/fake-feishu-cot.js';

const silentLog: DreamuxLogger = {
  error: () => undefined,
  warn: () => undefined,
  info: () => undefined,
  debug: () => undefined,
  trace: () => undefined,
  child: () => silentLog,
};

/** The operator's stated cadence; asserted, not imported from the source. */
const APPEND_INTERVAL_MS = 500;

const LEADER = {
  teammateName: 'alpha-leader',
  role: 'team_leader' as TeammateRole,
  teamName: 'alpha',
};

interface Recipient {
  readonly teammateName: string;
  readonly role: TeammateRole;
  readonly teamName: string | null;
}

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

function anchorAt(chatId: string, messageId: string): VisibleMessageAnchor {
  return {
    chatId,
    messageId,
    target: chatTarget(chatId, 'group'),
    servingTarget: null,
  };
}

let sequence = 0;

function activity(
  recipient: Recipient,
  payload: RuntimeActivity,
): TeammateActivityEvent {
  return {
    schemaVersion: 1,
    kind: 'teammate.activity',
    occurredAt: 1_700_000_000_000 + (sequence += 1),
    ...recipient,
    activity: payload,
  };
}

function reasoning(
  recipient: Recipient,
  id: string,
  partIndex: number,
  text: string,
  status: 'streaming' | 'completed' = 'streaming',
): TeammateActivityEvent {
  return activity(recipient, {
    kind: 'assistant.reasoning',
    occurredAt: 1,
    id,
    partIndex,
    text,
    status,
  });
}

function message(recipient: Recipient, content: string): TeammateActivityEvent {
  return activity(recipient, {
    kind: 'assistant.message',
    occurredAt: 1,
    id: `event-${(sequence += 1)}`,
    text: content,
  });
}

function nativeEnd(
  recipient: Recipient,
  status: 'completed' | 'interrupted',
): TeammateActivityEvent {
  return activity(recipient, {
    kind: 'turn.ended',
    occurredAt: 1,
    status,
    reason: null,
  });
}

function submitInbound(
  adapter: FeishuCotAdapter,
  recipient: Recipient,
  turnId: string,
  anchor: VisibleMessageAnchor,
): void {
  const sourceId = `message-${turnId}`;
  const lease = adapter.beginInboundSubmission({
    teamName: recipient.teamName,
    anchor,
    sourceId,
  });
  adapter.handle({
    schemaVersion: 1,
    kind: 'teammate.input',
    occurredAt: 1_700_000_000_000 + (sequence += 1),
    ...recipient,
    source: 'feishu',
    sourceId,
    content: 'the already visible inbound',
    notice: null,
  });
  lease?.release();
}

/**
 * Let queued promises run and advance the clock by `ms`.
 *
 * Fake timers own both `Date.now` and `setTimeout`, so the append timestamps
 * the fake client records are the instants the adapter really started each
 * request.
 */
async function settle(ms = 0): Promise<void> {
  for (let index = 0; index < 12; index += 1) await Promise.resolve();
  await vi.advanceTimersByTimeAsync(ms);
  for (let index = 0; index < 12; index += 1) await Promise.resolve();
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
    ).toBeGreaterThanOrEqual(APPEND_INTERVAL_MS);
  }
}

/** Close under the fake clock: the terminal append keeps the cadence too. */
async function closeAdapter(adapter: FeishuCotAdapter): Promise<void> {
  const closing = adapter.close();
  await vi.advanceTimersByTimeAsync(10_000);
  await closing;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_700_000_000_000);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('Feishu COT reasoning — native blocks', () => {
  it('opens one reasoning section per visible part, prefixes it once, and closes it', async () => {
    const { adapter, cot } = harness(true);
    submitInbound(adapter, LEADER, 'turn-1', anchorAt('oc_team', 'om_1'));
    await settle();

    adapter.handle(reasoning(LEADER, 'item-1', 0, 'first thought'));
    await settle(APPEND_INTERVAL_MS);
    adapter.handle(reasoning(LEADER, 'item-1', 0, ' and more'));
    await settle(APPEND_INTERVAL_MS);
    adapter.handle(reasoning(LEADER, 'item-1', 0, '', 'completed'));
    await settle(APPEND_INTERVAL_MS);

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

    await closeAdapter(adapter);
  });

  it('keeps one block per native part: a reused item id and a new part position are separate blocks', async () => {
    const { adapter, cot } = harness(true);
    submitInbound(adapter, LEADER, 'turn-1', anchorAt('oc_team', 'om_1'));
    await settle();

    adapter.handle(reasoning(LEADER, 'item-1', 0, 'part zero', 'completed'));
    await settle(APPEND_INTERVAL_MS);
    adapter.handle(reasoning(LEADER, 'item-1', 1, 'part one', 'completed'));
    await settle(APPEND_INTERVAL_MS);

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

    await closeAdapter(adapter);
  });

  it('renders a completed snapshot that had no increments, and ignores an empty completion', async () => {
    const { adapter, cot } = harness(true);
    submitInbound(adapter, LEADER, 'turn-1', anchorAt('oc_team', 'om_1'));
    await settle();

    // No increments arrived at all: the completion is the first text.
    adapter.handle(
      reasoning(LEADER, 'item-1', 0, 'whole thought', 'completed'),
    );
    await settle(APPEND_INTERVAL_MS);
    expect(cotReasoningBlocks(onlyCard(cot))[0]!.text).toBe(
      `${COT_REASONING_PREFIX}\n\nwhole thought`,
    );

    // An empty completion closes no block and opens none.
    adapter.handle(reasoning(LEADER, 'item-2', 0, '', 'completed'));
    await settle(APPEND_INTERVAL_MS);
    expect(cotReasoningBlocks(onlyCard(cot))).toHaveLength(1);
    expect(cotReasoningSections(onlyCard(cot))).toMatchObject({
      started: 1,
      ended: 1,
    });

    await closeAdapter(adapter);
  });

  it('splits an increment that would overflow one event, keeping every event within the budget', async () => {
    const { adapter, cot } = harness(true);
    submitInbound(adapter, LEADER, 'turn-1', anchorAt('oc_team', 'om_1'));
    await settle();

    const huge = 'x'.repeat(12_000);
    adapter.handle(reasoning(LEADER, 'item-1', 0, huge, 'completed'));
    await settle(APPEND_INTERVAL_MS);

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

    await closeAdapter(adapter);
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
    await settle(APPEND_INTERVAL_MS - 1);
    expect(card.appendStarts).toHaveLength(before);

    await settle(1);
    expect(card.appendStarts).toHaveLength(before + 1);
    expect(card.appendStarts[before]! - card.appendStarts[before - 1]!).toBe(
      APPEND_INTERVAL_MS,
    );

    // Another increment after that flush is paced from the previous start.
    adapter.handle(reasoning(LEADER, 'item-1', 0, 'b'));
    await settle(APPEND_INTERVAL_MS - 1);
    expect(card.appendStarts).toHaveLength(before + 1);
    await settle(1);
    expect(card.appendStarts).toHaveLength(before + 2);

    await closeAdapter(adapter);
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
    expect(card.appendStarts.at(-1)! - previousStart).toBe(APPEND_INTERVAL_MS);
    expect(cotReasoningSections(card).contents).toBe(1);
    expect(cotReasoningBlocks(card)[0]!.text).toBe(
      `${COT_REASONING_PREFIX}\n\nab`,
    );

    await closeAdapter(adapter);
  });

  it('coalesces adjacent increments of one block into a single content event before admission', async () => {
    const { adapter, cot } = harness(true);
    submitInbound(adapter, LEADER, 'turn-1', anchorAt('oc_team', 'om_1'));
    await settle();

    // All three arrive within one pacing window.
    adapter.handle(reasoning(LEADER, 'item-1', 0, 'a'));
    adapter.handle(reasoning(LEADER, 'item-1', 0, 'b'));
    adapter.handle(reasoning(LEADER, 'item-1', 0, 'c'));
    await settle(APPEND_INTERVAL_MS);

    const card = onlyCard(cot);
    expect(cotReasoningSections(card).contents).toBe(1);
    expect(cotReasoningBlocks(card)[0]!.text).toBe(
      `${COT_REASONING_PREFIX}\n\nabc`,
    );

    await closeAdapter(adapter);
  });

  it('keeps parts independently open, so an interleaved part does not re-prefix the first', async () => {
    const { adapter, cot } = harness(true);
    submitInbound(adapter, LEADER, 'turn-1', anchorAt('oc_team', 'om_1'));
    await settle();

    // A part opens, another part opens, then the first part continues.
    adapter.handle(reasoning(LEADER, 'item-1', 0, 'a1'));
    adapter.handle(reasoning(LEADER, 'item-2', 0, 'b1'));
    adapter.handle(reasoning(LEADER, 'item-1', 0, 'a2'));
    await settle(APPEND_INTERVAL_MS);

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

    await closeAdapter(adapter);
  });

  it('never coalesces across a text or tool barrier, and keeps the original order', async () => {
    const { adapter, cot } = harness(true);
    submitInbound(adapter, LEADER, 'turn-1', anchorAt('oc_team', 'om_1'));
    await settle();

    adapter.handle(reasoning(LEADER, 'item-1', 0, 'before'));
    adapter.handle(message(LEADER, 'visible answer'));
    adapter.handle(reasoning(LEADER, 'item-1', 0, 'after'));
    await settle(APPEND_INTERVAL_MS);

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

    await closeAdapter(adapter);
  });

  it('paces the terminal batch from the previous append and delivers it after the reasoning close', async () => {
    const { adapter, cot } = harness(true);
    submitInbound(adapter, LEADER, 'turn-1', anchorAt('oc_team', 'om_1'));
    await settle();

    const card = onlyCard(cot);
    const before = card.appendStarts.length;

    adapter.handle(reasoning(LEADER, 'item-1', 0, 'thought'));
    adapter.handle(nativeEnd(LEADER, 'completed'));

    await settle(APPEND_INTERVAL_MS - 1);
    expect(card.appendStarts).toHaveLength(before);
    await settle(1);

    expect(card.appendStarts).toHaveLength(before + 1);
    expect(card.appendStarts[before]! - card.appendStarts[before - 1]!).toBe(
      APPEND_INTERVAL_MS,
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

    await closeAdapter(adapter);
  });

  it('starts a replacement card immediately with a fresh prefix, without waiting out the old card', async () => {
    const { adapter, cot } = harness(true);
    submitInbound(adapter, LEADER, 'turn-1', anchorAt('oc_team', 'om_1'));
    await settle();
    adapter.handle(reasoning(LEADER, 'item-1', 0, 'old thought'));
    await settle(APPEND_INTERVAL_MS);

    const first = cot.cards[0]!;
    // Replace the anchor while the first card's terminal is still pending.
    submitInbound(adapter, LEADER, 'turn-2', anchorAt('oc_team', 'om_2'));
    adapter.handle(reasoning(LEADER, 'item-1', 0, 'new thought'));
    await settle();
    // The recipient's serialized queue is still draining the old card's own
    // paced terminal, so the replacement is created after it, not instead.
    expect(cot.cards).toHaveLength(1);

    await settle(APPEND_INTERVAL_MS);
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

    await closeAdapter(adapter);
  });

  it('re-prefixes after an append failure opened a fresh card', async () => {
    const { adapter, cot } = harness(true);
    submitInbound(adapter, LEADER, 'turn-1', anchorAt('oc_team', 'om_1'));
    await settle();
    cot.appendError = new Error('append refused');

    adapter.handle(reasoning(LEADER, 'item-1', 0, 'first attempt'));
    await settle(APPEND_INTERVAL_MS);
    expect(cotReasoningBlocks(cot.cards[0]!)).toHaveLength(0);

    cot.appendError = null;
    adapter.handle(reasoning(LEADER, 'item-1', 0, 'second attempt'));
    await settle(APPEND_INTERVAL_MS);

    expect(cot.cards).toHaveLength(2);
    expect(cotReasoningBlocks(cot.cards[1]!)[0]!.text).toBe(
      `${COT_REASONING_PREFIX}\n\nsecond attempt`,
    );

    await closeAdapter(adapter);
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
    await settle(APPEND_INTERVAL_MS);
    await closing;

    // Closes and the terminal arrive during the wait, so they travel in the
    // one append the cadence allows rather than forcing a second beat.
    expect(card.appendStarts).toHaveLength(before + 1);
    expect(card.appendStarts[before]! - card.appendStarts[before - 1]!).toBe(
      APPEND_INTERVAL_MS,
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
    await settle(APPEND_INTERVAL_MS);
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
      ).toBeGreaterThanOrEqual(APPEND_INTERVAL_MS);
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
    await settle(APPEND_INTERVAL_MS * 10);

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

    await closeAdapter(adapter);
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
    await settle(APPEND_INTERVAL_MS * 10);

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

    await closeAdapter(adapter);
  }, 20_000);
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
    await settle(APPEND_INTERVAL_MS);

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

    await closeAdapter(adapter);
  });
});
