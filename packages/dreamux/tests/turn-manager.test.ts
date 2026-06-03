import { describe, expect, it } from 'vitest';

import { TurnManager } from '../src/dispatcher/turn-manager.js';
import type { NotificationHandler } from '../src/codex/rpc.js';
import type { ServerNotification, TurnStartResponse } from '../src/codex/types.js';

describe('TurnManager in-memory queue', () => {
  it('coalesces same-chat messages enqueued in the same tick without outbound', async () => {
    const client = new FakeCodexClient();
    const manager = new TurnManager({
      dispatcherId: 'flow',
      getThreadId: () => 'thread-1',
      client: client as never,
    });

    expect(manager.enqueue(input('msg-1', 'first'))).toBe(true);
    expect(manager.enqueue(input('msg-2', 'second'))).toBe(true);

    await waitFor(() => client.inputs.length === 1);
    expect(client.inputs).toEqual(['first\n\nsecond']);
  });

  it('bounds the process-local message_id dedupe window', async () => {
    const client = new FakeCodexClient();
    const manager = new TurnManager({
      dispatcherId: 'flow',
      getThreadId: () => 'thread-1',
      client: client as never,
      messageIdDedupeWindow: 2,
    });

    expect(manager.enqueue(input('msg-1', 'first'))).toBe(true);
    await waitFor(() => client.inputs.length === 1);

    expect(manager.enqueue(input('msg-2', 'second'))).toBe(true);
    await waitFor(() => client.inputs.length === 2);

    expect(manager.enqueue(input('msg-3', 'third'))).toBe(true);
    await waitFor(() => client.inputs.length === 3);

    expect(manager.enqueue(input('msg-2', 'second still in window'))).toBe(false);
    expect(manager.enqueue(input('msg-1', 'first redelivered after eviction')))
      .toBe(true);

    await waitFor(() => client.inputs.length === 4);
    expect(client.inputs).toEqual([
      'first',
      'second',
      'third',
      'first redelivered after eviction',
    ]);
  });
});

function input(messageId: string, text: string) {
  return {
    source_chat_id: 'chat-a',
    source_message_id: messageId,
    sender_id: 'sender-a',
    parsed_text: text,
  };
}

class FakeCodexClient {
  readonly inputs: string[] = [];
  private readonly handlers: NotificationHandler[] = [];
  private nextTurnId = 1;

  onNotification(handler: NotificationHandler): void {
    this.handlers.push(handler);
  }

  async request<R>(method: string, params: unknown): Promise<R> {
    if (method !== 'turn/start') throw new Error(`unexpected method ${method}`);
    const p = params as {
      threadId: string;
      input: Array<{ text: string }>;
    };
    const text = p.input[0]?.text ?? '';
    this.inputs.push(text);
    const turnId = `turn-${this.nextTurnId++}`;
    queueMicrotask(() => {
      this.emit({
        method: 'item/completed',
        params: {
          threadId: p.threadId,
          turnId,
          completedAtMs: Date.now(),
          item: { type: 'agentMessage', id: `item-${turnId}`, text },
        },
      });
      this.emit({
        method: 'turn/completed',
        params: {
          threadId: p.threadId,
          turn: { id: turnId, items: [] },
        },
      });
    });
    return { turn: { id: turnId } } as TurnStartResponse as R;
  }

  private emit(notification: ServerNotification): void {
    for (const handler of this.handlers) handler(notification);
  }
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 1000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('waitFor timed out');
}
