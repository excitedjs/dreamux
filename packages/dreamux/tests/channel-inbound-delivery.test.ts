import { describe, expect, it } from 'vitest';

import {
  ChannelInboundDeliveryBuffer,
  type ChannelInboundDeliveryInput,
} from '../src/channel/inbound-delivery.js';

describe('ChannelInboundDeliveryBuffer', () => {
  it('jitter-buffers bursty inbound messages before one delivery flush', async () => {
    const delivered: ChannelInboundDeliveryInput[][] = [];
    const buffer = new ChannelInboundDeliveryBuffer({
      deliveryThreadId: 'dispatcher-a',
      jitterMs: 30,
      deliver: async (batch) => {
        delivered.push(batch);
      },
    });

    expect(buffer.accept(input('msg-1', 'first')).accepted).toBe(true);
    expect(buffer.accept(input('msg-2', 'second')).accepted).toBe(true);

    await sleep(10);
    expect(delivered).toEqual([]);

    await waitFor(() => delivered.length === 1);
    expect(delivered[0]?.map((item) => item.source_message_id)).toEqual([
      'msg-1',
      'msg-2',
    ]);
  });

  it('rejects messages over the per-thread rate limit with a log', async () => {
    let now = 1_000;
    const logs: string[] = [];
    const delivered: ChannelInboundDeliveryInput[][] = [];
    const buffer = new ChannelInboundDeliveryBuffer({
      deliveryThreadId: 'dispatcher-a',
      jitterMs: 0,
      rateLimitWindowMs: 100,
      rateLimitMaxMessages: 2,
      now: () => now,
      log: (_level, msg) => logs.push(msg),
      deliver: async (batch) => {
        delivered.push(batch);
      },
    });

    expect(buffer.accept(input('msg-1', 'one')).accepted).toBe(true);
    expect(buffer.accept(input('msg-2', 'two')).accepted).toBe(true);
    expect(buffer.accept(input('msg-3', 'three'))).toEqual({
      accepted: false,
      reason: 'rate limit exceeded',
    });

    await buffer.flushNow();
    expect(delivered[0]?.map((item) => item.source_message_id)).toEqual([
      'msg-1',
      'msg-2',
    ]);
    expect(logs.some((line) => line.includes('rate limit exceeded'))).toBe(true);

    now += 101;
    expect(buffer.accept(input('msg-4', 'four')).accepted).toBe(true);
  });

  it('rejects duplicate message ids before they can receive a reaction', async () => {
    const logs: string[] = [];
    const delivered: ChannelInboundDeliveryInput[][] = [];
    const buffer = new ChannelInboundDeliveryBuffer({
      deliveryThreadId: 'dispatcher-a',
      jitterMs: 0,
      log: (_level, msg) => logs.push(msg),
      deliver: async (batch) => {
        delivered.push(batch);
      },
    });

    expect(buffer.accept(input('msg-1', 'first')).accepted).toBe(true);
    expect(buffer.accept(input('msg-1', 'redelivery'))).toEqual({
      accepted: false,
      reason: 'duplicate message_id within process window',
    });

    await buffer.flushNow();
    expect(delivered[0]?.map((item) => item.parsed_text)).toEqual(['first']);
    expect(logs.some((line) => line.includes('duplicate message_id'))).toBe(true);
  });
});

function input(messageId: string, text: string): ChannelInboundDeliveryInput {
  return {
    source_chat_id: 'chat-a',
    source_message_id: messageId,
    sender_id: 'sender-a',
    parsed_text: text,
  };
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 1000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await sleep(10);
  }
  throw new Error('waitFor timed out');
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
