import { describe, expect, it } from 'vitest';

import { TurnManager } from '../src/dispatcher/turn-manager.js';
import type { NotificationHandler } from '../src/codex/rpc.js';
import type { ServerNotification, TurnStartResponse } from '../src/codex/types.js';

describe('TurnManager inbound submission', () => {
  it('submits every accepted message through turn/start without coalescing', async () => {
    const client = new FakeCodexClient();
    const manager = new TurnManager({
      dispatcherId: 'flow',
      getThreadId: () => 'thread-1',
      client: client as never,
    });
    const accepted: string[] = [];

    await expect(
      manager.enqueue(input('msg-1', 'first'), {
        onAccepted: (acceptedInput) => {
          accepted.push(acceptedInput.source_message_id);
        },
      }),
    ).resolves.toEqual({ status: 'submitted', turnId: 'turn-1' });
    await expect(
      manager.enqueue(input('msg-2', 'second'), {
        onAccepted: (acceptedInput) => {
          accepted.push(acceptedInput.source_message_id);
        },
      }),
    ).resolves.toEqual({ status: 'submitted', turnId: 'turn-2' });

    expect(accepted).toEqual(['msg-1', 'msg-2']);
    expect(client.methods).toEqual(['turn/start', 'turn/start']);
    expect(client.inputs).toEqual(['first', 'second']);
  });

  it('bounds the process-local message_id dedupe window', async () => {
    const client = new FakeCodexClient();
    const manager = new TurnManager({
      dispatcherId: 'flow',
      getThreadId: () => 'thread-1',
      client: client as never,
      messageIdDedupeWindow: 2,
    });

    await expect(manager.enqueue(input('msg-1', 'first'))).resolves
      .toMatchObject({ status: 'submitted' });

    await expect(manager.enqueue(input('msg-2', 'second'))).resolves
      .toMatchObject({ status: 'submitted' });

    await expect(manager.enqueue(input('msg-3', 'third'))).resolves
      .toMatchObject({ status: 'submitted' });

    await expect(manager.enqueue(input('msg-2', 'second still in window')))
      .resolves.toEqual({ status: 'duplicate' });
    await expect(
      manager.enqueue(input('msg-1', 'first redelivered after eviction')),
    ).resolves.toMatchObject({ status: 'submitted' });

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
  readonly methods: string[] = [];
  private readonly handlers: NotificationHandler[] = [];
  private nextTurnId = 1;

  onNotification(handler: NotificationHandler): void {
    this.handlers.push(handler);
  }

  async request<R>(method: string, params: unknown): Promise<R> {
    if (method !== 'turn/start') throw new Error(`unexpected method ${method}`);
    this.methods.push(method);
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
