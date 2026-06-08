import { describe, expect, it } from 'vitest';

import { TurnManager } from '../src/agent-runtime/builtin/codex/turn-manager.js';
import type { NotificationHandler } from '../src/agent-runtime/builtin/codex/rpc.js';
import type { ServerNotification, TurnStartResponse } from '../src/agent-runtime/builtin/codex/types.js';
import type { CollectedTurn } from '../src/agent-runtime/builtin/codex/events.js';
import type { TurnSettledSignal } from '../src/agent-runtime/turn.js';

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
          accepted.push(acceptedInput.sourceId);
        },
      }),
    ).resolves.toEqual({ status: 'submitted', turnId: 'turn-1' });
    await expect(
      manager.enqueue(input('msg-2', 'second'), {
        onAccepted: (acceptedInput) => {
          accepted.push(acceptedInput.sourceId);
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

describe('TurnManager restart-notice injection', () => {
  it('injects the notice as a turn when the thread is bound and idle', async () => {
    const client = new FakeCodexClient();
    const manager = new TurnManager({
      dispatcherId: 'flow',
      getThreadId: () => 'thread-1',
      client: client as never,
    });

    await expect(manager.injectNotice('Restart completed.')).resolves.toEqual({
      status: 'submitted',
      turnId: 'turn-1',
    });
    expect(client.inputs).toEqual(['Restart completed.']);
  });

  it('skips when a real inbound has already woken the thread', async () => {
    const client = new FakeCodexClient();
    const manager = new TurnManager({
      dispatcherId: 'flow',
      getThreadId: () => 'thread-1',
      client: client as never,
    });

    await manager.enqueue(input('msg-1', 'real work'));
    await expect(manager.injectNotice('Restart completed.')).resolves.toEqual({
      status: 'skipped',
    });
    expect(client.inputs).toEqual(['real work']);
  });

  it('fails (does not throw) when no thread is bound', async () => {
    const client = new FakeCodexClient();
    const manager = new TurnManager({
      dispatcherId: 'flow',
      getThreadId: () => null,
      client: client as never,
    });

    const result = await manager.injectNotice('Restart completed.');
    expect(result.status).toBe('failed');
    expect(client.inputs).toEqual([]);
  });

  it('injects at most once', async () => {
    const client = new FakeCodexClient();
    const manager = new TurnManager({
      dispatcherId: 'flow',
      getThreadId: () => 'thread-1',
      client: client as never,
    });

    await expect(manager.injectNotice('Restart completed.')).resolves
      .toMatchObject({ status: 'submitted' });
    await expect(manager.injectNotice('Restart completed.')).resolves.toEqual({
      status: 'skipped',
    });
    expect(client.inputs).toEqual(['Restart completed.']);
  });
});

describe('TurnManager turn settlement', () => {
  it('forwards the completed turn (with its turn id) on turn/completed', async () => {
    const client = new FakeCodexClient();
    const completed: CollectedTurn[] = [];
    const manager = new TurnManager({
      dispatcherId: 'flow',
      getThreadId: () => 'thread-1',
      client: client as never,
      onTurnCompleted: (turn) => completed.push(turn),
    });

    const res = await manager.enqueue(input('msg-1', 'work'));
    expect(res).toEqual({ status: 'submitted', turnId: 'turn-1' });

    await waitFor(() => completed.length === 1);
    expect(completed[0]?.turnId).toBe('turn-1');
  });

  it('settles each still-pending turn as stopped on stop()', async () => {
    // A manual client never emits turn/completed, so the submitted turn stays
    // in flight until stop() tears it down.
    const client = new ManualFakeCodexClient();
    const settled: TurnSettledSignal[] = [];
    const manager = new TurnManager({
      dispatcherId: 'flow',
      getThreadId: () => 'thread-1',
      client: client as never,
      onTurnSettled: (s) => settled.push(s),
    });

    const res = await manager.enqueue(input('msg-1', 'work'));
    expect(res).toEqual({ status: 'submitted', turnId: 'turn-1' });
    expect(settled).toEqual([]);

    await manager.stop();
    expect(settled).toEqual([{ turnId: 'turn-1', status: 'stopped' }]);
  });

  it('does not re-settle a completed turn as stopped', async () => {
    const client = new FakeCodexClient();
    const settled: TurnSettledSignal[] = [];
    const manager = new TurnManager({
      dispatcherId: 'flow',
      getThreadId: () => 'thread-1',
      client: client as never,
      // The auto-completing client clears the pending turn before stop().
      onTurnCompleted: () => undefined,
      onTurnSettled: (s) => settled.push(s),
    });

    await manager.enqueue(input('msg-1', 'work'));
    await waitFor(() => client.inputs.length === 1);
    // Let the queued turn/completed microtask clear the pending set.
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    await manager.stop();
    expect(settled).toEqual([]);
  });
});

async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('waitFor timed out');
}

function input(messageId: string, text: string) {
  return {
    sourceId: messageId,
    text,
  };
}

/** A fake client that acks turn/start but never emits turn/completed. */
class ManualFakeCodexClient {
  readonly inputs: string[] = [];
  private nextTurnId = 1;

  onNotification(_handler: NotificationHandler): void {
    /* no notifications are ever emitted */
  }

  async request<R>(method: string, params: unknown): Promise<R> {
    if (method !== 'turn/start') throw new Error(`unexpected method ${method}`);
    const p = params as { input: Array<{ text: string }> };
    this.inputs.push(p.input[0]?.text ?? '');
    return { turn: { id: `turn-${this.nextTurnId++}` } } as TurnStartResponse as R;
  }
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
