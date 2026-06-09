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

  it('steers active submissions into the current turn and settles it once', async () => {
    const client = new FoldingFakeCodexClient(['turn-1', 'turn-2', 'turn-3']);
    const completed: CollectedTurn[] = [];
    const manager = new TurnManager({
      dispatcherId: 'flow',
      getThreadId: () => 'thread-1',
      client: client as never,
      onTurnCompleted: (turn) => completed.push(turn),
    });

    await expect(manager.enqueue(input('msg-1', 'first'))).resolves.toEqual({
      status: 'submitted',
      turnId: 'turn-1',
    });
    await expect(manager.enqueue(input('msg-2', 'second steered'))).resolves.toEqual({
      status: 'submitted',
      turnId: 'turn-1',
    });
    await expect(manager.enqueue(input('msg-3', 'third steered'))).resolves.toEqual({
      status: 'submitted',
      turnId: 'turn-1',
    });
    expect(client.inputs).toEqual(['first', 'second steered', 'third steered']);

    client.emitCompleted('thread-1', 'turn-1', 'folded result');
    await waitFor(() => completed.length === 1);
    await flush();

    expect(completed.map((turn) => turn.turnId)).toEqual(['turn-1']);
  });

  it('coalesces concurrent cold-start submissions into one completion-producing turn', async () => {
    const client = new DelayedFakeCodexClient();
    const completed: CollectedTurn[] = [];
    const manager = new TurnManager({
      dispatcherId: 'flow',
      getThreadId: () => 'thread-1',
      client: client as never,
      onTurnCompleted: (turn) => completed.push(turn),
    });

    const first = manager.enqueue(input('msg-1', 'first'));
    const second = manager.enqueue(input('msg-2', 'second'));
    await waitFor(() => client.inputs.length === 2);

    expect(client.handlerCount).toBe(1);
    client.resolveNext('turn-1');
    client.resolveNext('turn-2');
    await expect(Promise.all([first, second])).resolves.toEqual([
      { status: 'submitted', turnId: 'turn-1' },
      { status: 'submitted', turnId: 'turn-1' },
    ]);

    client.emitCompleted('thread-1', 'turn-1', 'folded result');
    client.emitCompleted('thread-1', 'turn-2', 'extra physical result');
    await waitFor(() => completed.length === 1);
    await flush();

    expect(completed.map((turn) => turn.turnId)).toEqual(['turn-1']);
  });

  it('starts a fresh subscription for a sequential send after the previous turn completed', async () => {
    const client = new FoldingFakeCodexClient(['turn-1', 'turn-2']);
    const completed: CollectedTurn[] = [];
    const manager = new TurnManager({
      dispatcherId: 'flow',
      getThreadId: () => 'thread-1',
      client: client as never,
      onTurnCompleted: (turn) => completed.push(turn),
    });

    await expect(manager.enqueue(input('msg-1', 'first'))).resolves.toEqual({
      status: 'submitted',
      turnId: 'turn-1',
    });

    client.emitCompleted('thread-1', 'turn-1', 'first result');
    await waitFor(() => completed.length === 1);
    expect(completed.map((turn) => turn.turnId)).toEqual(['turn-1']);

    await expect(manager.enqueue(input('msg-2', 'second'))).resolves.toEqual({
      status: 'submitted',
      turnId: 'turn-2',
    });
    client.emitCompleted('thread-1', 'turn-2', 'second result');
    await waitFor(() => completed.length === 2);
    expect(completed.map((turn) => turn.turnId)).toEqual(['turn-1', 'turn-2']);
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

  it('settles a turn as failed on a fatal codex error notification (willRetry:false)', async () => {
    const client = new ErroringFakeCodexClient(false);
    const settled: TurnSettledSignal[] = [];
    const manager = new TurnManager({
      dispatcherId: 'flow',
      getThreadId: () => 'thread-1',
      client: client as never,
      onTurnCompleted: () => undefined,
      onTurnSettled: (s) => settled.push(s),
    });

    const res = await manager.enqueue(input('msg-1', 'work'));
    expect(res).toEqual({ status: 'submitted', turnId: 'turn-1' });

    await waitFor(() => settled.length === 1);
    expect(settled[0]?.turnId).toBe('turn-1');
    expect(settled[0]?.status).toBe('failed');
    expect(settled[0]?.error?.message).toContain('boom');
  });

  it('ignores a transient codex error (willRetry:true) and completes normally', async () => {
    const client = new ErroringFakeCodexClient(true);
    const completed: CollectedTurn[] = [];
    const settled: TurnSettledSignal[] = [];
    const manager = new TurnManager({
      dispatcherId: 'flow',
      getThreadId: () => 'thread-1',
      client: client as never,
      onTurnCompleted: (turn) => completed.push(turn),
      onTurnSettled: (s) => settled.push(s),
    });

    await manager.enqueue(input('msg-1', 'work'));
    await waitFor(() => completed.length === 1);
    expect(completed[0]?.turnId).toBe('turn-1');
    // A transient error must not produce a `failed` settlement.
    expect(settled.filter((s) => s.status === 'failed')).toEqual([]);
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

async function flush(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
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

class FoldingFakeCodexClient {
  readonly inputs: string[] = [];
  private readonly handlers: NotificationHandler[] = [];
  private nextIndex = 0;

  constructor(private readonly turnIds: string[]) {}

  onNotification(handler: NotificationHandler): void {
    this.handlers.push(handler);
  }

  async request<R>(method: string, params: unknown): Promise<R> {
    if (method !== 'turn/start') throw new Error(`unexpected method ${method}`);
    const p = params as {
      input: Array<{ text: string }>;
    };
    this.inputs.push(p.input[0]?.text ?? '');
    const turnId = this.turnIds[this.nextIndex++];
    if (turnId === undefined) throw new Error('no scripted turn id');
    return { turn: { id: turnId } } as TurnStartResponse as R;
  }

  emitCompleted(threadId: string, turnId: string, text: string): void {
    this.emit({
      method: 'item/completed',
      params: {
        threadId,
        turnId,
        completedAtMs: Date.now(),
        item: { type: 'agentMessage', id: `item-${turnId}`, text },
      },
    });
    this.emit({
      method: 'turn/completed',
      params: {
        threadId,
        turn: { id: turnId, items: [] },
      },
    });
  }

  private emit(notification: ServerNotification): void {
    for (const handler of this.handlers) handler(notification);
  }
}

class DelayedFakeCodexClient {
  readonly inputs: string[] = [];
  private readonly handlers: NotificationHandler[] = [];
  private readonly pending: Array<(turnId: string) => void> = [];

  get handlerCount(): number {
    return this.handlers.length;
  }

  onNotification(handler: NotificationHandler): void {
    this.handlers.push(handler);
  }

  request<R>(method: string, params: unknown): Promise<R> {
    if (method !== 'turn/start') throw new Error(`unexpected method ${method}`);
    const p = params as {
      input: Array<{ text: string }>;
    };
    this.inputs.push(p.input[0]?.text ?? '');
    return new Promise<R>((resolve) => {
      this.pending.push((turnId) => {
        resolve({ turn: { id: turnId } } as TurnStartResponse as R);
      });
    });
  }

  resolveNext(turnId: string): void {
    const resolve = this.pending.shift();
    if (resolve === undefined) throw new Error('no pending turn/start');
    resolve(turnId);
  }

  emitCompleted(threadId: string, turnId: string, text: string): void {
    this.emit({
      method: 'item/completed',
      params: {
        threadId,
        turnId,
        completedAtMs: Date.now(),
        item: { type: 'agentMessage', id: `item-${turnId}`, text },
      },
    });
    this.emit({
      method: 'turn/completed',
      params: {
        threadId,
        turn: { id: turnId, items: [] },
      },
    });
  }

  private emit(notification: ServerNotification): void {
    for (const handler of this.handlers) handler(notification);
  }
}

/**
 * Acks turn/start then emits a codex `error` notification. With willRetry=false
 * (fatal) it emits no turn/completed — the turn must still settle as `failed`.
 * With willRetry=true (transient) a normal turn/completed follows.
 */
class ErroringFakeCodexClient {
  private readonly handlers: NotificationHandler[] = [];
  private nextTurnId = 1;

  constructor(private readonly willRetry: boolean) {}

  onNotification(handler: NotificationHandler): void {
    this.handlers.push(handler);
  }

  async request<R>(method: string, params: unknown): Promise<R> {
    if (method !== 'turn/start') throw new Error(`unexpected method ${method}`);
    const p = params as { threadId: string; input: Array<{ text: string }> };
    const turnId = `turn-${this.nextTurnId++}`;
    queueMicrotask(() => {
      this.emit({
        method: 'error',
        params: {
          threadId: p.threadId,
          turnId,
          willRetry: this.willRetry,
          error: { message: 'boom' },
        },
      });
      if (this.willRetry) {
        this.emit({
          method: 'turn/completed',
          params: { threadId: p.threadId, turn: { id: turnId, items: [] } },
        });
      }
    });
    return { turn: { id: turnId } } as TurnStartResponse as R;
  }

  private emit(notification: ServerNotification): void {
    for (const handler of this.handlers) handler(notification);
  }
}
