import { describe, expect, it } from 'vitest';

import { TurnManager } from '../src/turn-manager.js';
import type { NotificationHandler } from '../src/rpc.js';
import type { ServerNotification, TurnStartResponse } from '../src/types.js';
import type { CollectedTurn } from '../src/events.js';
import type { TurnSettledSignal } from '@excitedjs/dreamux-types';

describe('TurnManager inbound submission', () => {
  it('submits every accepted message through turn/start without coalescing', async () => {
    const client = new FakeCodexClient();
    const manager = new TurnManager({
      dispatcherId: 'flow',
      getThreadId: () => 'thread-1',
      client: client as never,
    });

    await expect(
      manager.enqueue(input('msg-1', 'first')),
    ).resolves.toEqual({ status: 'submitted', turnId: 'turn-1' });
    await expect(
      manager.enqueue(input('msg-2', 'second')),
    ).resolves.toEqual({ status: 'submitted', turnId: 'turn-2' });

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

describe('TurnManager text input submission', () => {
  it('submits plain text input as a turn when the thread is bound', async () => {
    const client = new FakeCodexClient();
    const manager = new TurnManager({
      dispatcherId: 'flow',
      getThreadId: () => 'thread-1',
      client: client as never,
    });

    await expect(
      manager.submitTextInput({ text: 'Restart completed.', sourceId: 'restart' }),
    ).resolves.toEqual({
      status: 'submitted',
      turnId: 'turn-1',
    });
    expect(client.inputs).toEqual(['Restart completed.']);
  });

  it('does not treat prior channel input as a reason to skip plain text input', async () => {
    const client = new FakeCodexClient();
    const manager = new TurnManager({
      dispatcherId: 'flow',
      getThreadId: () => 'thread-1',
      client: client as never,
    });

    await manager.enqueue(input('msg-1', 'real work'));
    await expect(
      manager.submitTextInput({ text: 'Restart completed.', sourceId: 'restart' }),
    ).resolves.toMatchObject({ status: 'submitted' });
    expect(client.inputs).toEqual(['real work', 'Restart completed.']);
  });

  it('fails (does not throw) when no thread is bound', async () => {
    const client = new FakeCodexClient();
    const manager = new TurnManager({
      dispatcherId: 'flow',
      getThreadId: () => null,
      client: client as never,
    });

    const result = await manager.submitTextInput({ text: 'Restart completed.' });
    expect(result.status).toBe('failed');
    expect(client.inputs).toEqual([]);
  });

  it('dedupes stable sourceIds', async () => {
    const client = new FakeCodexClient();
    const manager = new TurnManager({
      dispatcherId: 'flow',
      getThreadId: () => 'thread-1',
      client: client as never,
    });

    await expect(
      manager.submitTextInput({ text: 'Restart completed.', sourceId: 'restart' }),
    ).resolves.toMatchObject({ status: 'submitted' });
    await expect(
      manager.submitTextInput({ text: 'Restart completed.', sourceId: 'restart' }),
    ).resolves.toEqual({ status: 'duplicate' });
    expect(client.inputs).toEqual(['Restart completed.']);
  });

  it('passes outputSchema to turn/start and settles the validated JSON text', async () => {
    const client = new FakeCodexClient();
    const completed: CollectedTurn[] = [];
    const manager = new TurnManager({
      dispatcherId: 'flow',
      getThreadId: () => 'thread-1',
      client: client as never,
      onTurnCompleted: (turn) => completed.push(turn),
    });
    const outputSchema = {
      type: 'object',
      properties: { answer: { type: 'number' } },
      required: ['answer'],
      additionalProperties: false,
    };

    await expect(manager.submitTextInput({
      text: '{"answer":4}',
      sourceId: 'structured',
      outputSchema,
    })).resolves.toEqual({
      status: 'submitted',
      turnId: 'turn-1',
    });
    await waitFor(() => completed.length === 1);

    expect(client.outputSchemas).toEqual([outputSchema]);
    expect(completed).toEqual([
      {
        threadId: 'thread-1',
        turnId: 'turn-1',
        items: [
          expect.objectContaining({
            type: 'agentMessage',
            text: '{"answer":4}',
          }),
        ],
      },
    ]);
  });

  it('compiles and restores optional output fields before completion', async () => {
    const client = new FoldingFakeCodexClient(['turn-1']);
    const completed: CollectedTurn[] = [];
    const manager = new TurnManager({
      dispatcherId: 'flow',
      getThreadId: () => 'thread-1',
      client: client as never,
      onTurnCompleted: (turn) => completed.push(turn),
    });
    const outputSchema = optionalValueSchema();

    await expect(manager.submitTextInput({
      text: 'return optional JSON',
      outputSchema,
    })).resolves.toEqual({ status: 'submitted', turnId: 'turn-1' });

    expect(client.outputSchemas).toEqual([{
      type: 'object',
      properties: {
        value: { type: ['string', 'null'] },
      },
      required: ['value'],
      additionalProperties: false,
    }]);
    expect(client.outputSchemas[0]).not.toBe(outputSchema);

    client.emitCompleted('thread-1', 'turn-1', '{"value":null}');
    await waitFor(() => completed.length === 1);
    expect(completed[0]?.items).toContainEqual(
      expect.objectContaining({ type: 'agentMessage', text: '{}' }),
    );
  });

  it('rejects incompatible schemas before turn/start and slot admission', async () => {
    const client = new DelayedFakeCodexClient();
    const manager = new TurnManager({
      dispatcherId: 'flow',
      getThreadId: () => 'thread-1',
      client: client as never,
    });

    await expect(manager.submitTextInput({
      text: 'invalid schema',
      outputSchema: {
        type: 'object',
        properties: { value: { type: ['string', 'number'] } },
        additionalProperties: false,
      },
    })).resolves.toMatchObject({
      status: 'failed',
      error: {
        name: 'UnsupportedAgentRuntimeFeatureError',
        feature: 'outputSchema',
        message: expect.stringContaining('$.properties.value.type'),
      },
    });
    expect(client.inputs).toEqual([]);
    expect(manager.isBusy()).toBe(false);
  });

  it('discards a failed submission codec before the next turn', async () => {
    const client = new FailOnceFakeCodexClient();
    const manager = new TurnManager({
      dispatcherId: 'flow',
      getThreadId: () => 'thread-1',
      client: client as never,
    });

    await expect(manager.submitTextInput({
      text: 'structured failure',
      outputSchema: optionalValueSchema(),
    })).resolves.toMatchObject({ status: 'failed' });
    expect(manager.isBusy()).toBe(false);

    await expect(manager.submitTextInput({
      text: 'plain successor',
    })).resolves.toEqual({ status: 'submitted', turnId: 'turn-2' });
    expect(client.outputSchemas).toEqual([
      expect.any(Object),
      undefined,
    ]);
  });

  it.each([
    ['plain failure before structured recovery', false],
    ['structured failure before plain recovery', true],
  ])('disposes the abandoned collector after %s', async (_label, failedStructured) => {
    const client = new RecoveringFakeCodexClient();
    const completed: CollectedTurn[] = [];
    const manager = new TurnManager({
      dispatcherId: 'flow',
      getThreadId: () => 'thread-1',
      client: client as never,
      onTurnCompleted: (turn) => completed.push(turn),
    });

    await expect(manager.submitTextInput(
      failedStructured
        ? { text: 'failed structured', outputSchema: optionalValueSchema() }
        : { text: 'failed plain' },
    )).resolves.toMatchObject({ status: 'failed' });
    expect(client.handlerCount).toBe(0);

    await expect(manager.submitTextInput(
      failedStructured
        ? { text: 'plain recovery' }
        : { text: 'structured recovery', outputSchema: optionalValueSchema() },
    )).resolves.toEqual({ status: 'submitted', turnId: 'turn-2' });
    expect(client.handlerCount).toBe(1);

    client.emitCompleted(
      'thread-1',
      'turn-2',
      failedStructured ? 'plain result' : '{"value":null}',
    );
    await waitFor(() => completed.length === 1);

    expect(completed[0]?.items).toContainEqual(
      expect.objectContaining({
        type: 'agentMessage',
        text: failedStructured ? 'plain result' : '{}',
      }),
    );
    expect(client.handlerCount).toBe(0);
  });
});

describe('TurnManager turn settlement', () => {
  it('waitIdle treats the slot-claimed submission window as busy', async () => {
    const client = new DelayedFakeCodexClient();
    const manager = new TurnManager({
      dispatcherId: 'flow',
      getThreadId: () => 'thread-1',
      client: client as never,
    });

    const submitted = manager.enqueue(input('msg-1', 'first'));
    await waitFor(() => client.inputs.length === 1);
    expect(manager.isBusy()).toBe(true);

    let idle = false;
    void manager.waitIdle().then(() => {
      idle = true;
    });
    await flush();
    expect(idle).toBe(false);

    client.resolveNext('turn-1');
    await expect(submitted).resolves.toEqual({
      status: 'submitted',
      turnId: 'turn-1',
    });
    expect(idle).toBe(false);

    client.emitCompleted('thread-1', 'turn-1', 'done');
    await waitFor(() => idle);
    expect(manager.isBusy()).toBe(false);
  });

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

  it('folds compatible structured submissions and restores exactly once', async () => {
    const client = new FoldingFakeCodexClient(['turn-1', 'turn-2']);
    const completed: CollectedTurn[] = [];
    const settled: TurnSettledSignal[] = [];
    const manager = new TurnManager({
      dispatcherId: 'flow',
      getThreadId: () => 'thread-1',
      client: client as never,
      onTurnCompleted: (turn) => completed.push(turn),
      onTurnSettled: (turn) => settled.push(turn),
    });

    await expect(manager.submitTextInput({
      text: 'first',
      outputSchema: optionalValueSchema(),
    })).resolves.toEqual({ status: 'submitted', turnId: 'turn-1' });
    await expect(manager.submitTextInput({
      text: 'folded',
      outputSchema: {
        additionalProperties: false,
        required: [],
        properties: { value: { type: 'string' } },
        type: 'object',
      },
    })).resolves.toEqual({ status: 'submitted', turnId: 'turn-1' });
    expect(client.inputs).toEqual(['first', 'folded']);

    client.emitCompleted('thread-1', 'turn-1', '{"value":null}');
    client.emitCompleted('thread-1', 'turn-2', '{"value":"ignored"}');
    await waitFor(() => completed.length === 1);
    await flush();

    expect(completed[0]?.items).toContainEqual(
      expect.objectContaining({ text: '{}' }),
    );
    expect(settled).toEqual([]);
  });

  it('rejects incompatible structured folding without another turn/start', async () => {
    const client = new FoldingFakeCodexClient(['turn-1']);
    const manager = new TurnManager({
      dispatcherId: 'flow',
      getThreadId: () => 'thread-1',
      client: client as never,
    });

    await manager.submitTextInput({
      text: 'optional',
      outputSchema: optionalValueSchema(),
    });
    await expect(manager.submitTextInput({
      text: 'required nullable',
      outputSchema: requiredNullableValueSchema(),
    })).resolves.toMatchObject({
      status: 'failed',
      error: {
        name: 'UnsupportedAgentRuntimeFeatureError',
        feature: 'outputSchema',
      },
    });
    expect(client.inputs).toEqual(['optional']);
  });

  it.each([
    ['structured then plain', true],
    ['plain then structured', false],
  ])('rejects active-turn mixing for %s', async (_label, structuredFirst) => {
    const client = new FoldingFakeCodexClient(['turn-1']);
    const manager = new TurnManager({
      dispatcherId: 'flow',
      getThreadId: () => 'thread-1',
      client: client as never,
    });
    const structured = {
      text: 'structured',
      outputSchema: optionalValueSchema(),
    };
    const plain = { text: 'plain' };

    await manager.submitTextInput(structuredFirst ? structured : plain);
    await expect(
      manager.submitTextInput(structuredFirst ? plain : structured),
    ).resolves.toMatchObject({
      status: 'failed',
      error: {
        name: 'UnsupportedAgentRuntimeFeatureError',
        feature: 'outputSchema',
      },
    });
    expect(client.inputs).toHaveLength(1);
  });

  it('settles restoration failure without forwarding completion', async () => {
    const client = new FoldingFakeCodexClient(['turn-1']);
    const completed: CollectedTurn[] = [];
    const settled: TurnSettledSignal[] = [];
    const manager = new TurnManager({
      dispatcherId: 'flow',
      getThreadId: () => 'thread-1',
      client: client as never,
      onTurnCompleted: (turn) => completed.push(turn),
      onTurnSettled: (turn) => settled.push(turn),
    });

    await manager.submitTextInput({
      text: 'invalid restored shape',
      outputSchema: {
        type: 'object',
        properties: {
          values: { type: 'array', items: { type: 'string' } },
        },
        required: ['values'],
        additionalProperties: false,
      },
    });
    client.emitCompleted('thread-1', 'turn-1', '{"values":{}}');
    await waitFor(() => settled.length === 1);

    expect(completed).toEqual([]);
    expect(settled[0]).toMatchObject({
      turnId: 'turn-1',
      status: 'failed',
      result: { text: null },
      error: {
        message: expect.stringContaining('$.values: expected array'),
      },
    });
  });

  it('drops structured late completion after stop without restoring twice', async () => {
    const client = new FoldingFakeCodexClient(['turn-1']);
    const completed: CollectedTurn[] = [];
    const settled: TurnSettledSignal[] = [];
    const manager = new TurnManager({
      dispatcherId: 'flow',
      getThreadId: () => 'thread-1',
      client: client as never,
      onTurnCompleted: (turn) => completed.push(turn),
      onTurnSettled: (turn) => settled.push(turn),
    });

    await manager.submitTextInput({
      text: 'wait',
      outputSchema: optionalValueSchema(),
    });
    await manager.stop();
    client.emitCompleted('thread-1', 'turn-1', '{');
    await flush();

    expect(completed).toEqual([]);
    expect(settled).toEqual([
      { turnId: 'turn-1', status: 'stopped', result: { text: null } },
    ]);
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
    expect(settled).toEqual([
      { turnId: 'turn-1', status: 'stopped', result: { text: null } },
    ]);
    expect(client.handlerCount).toBe(0);
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

function optionalValueSchema(): Record<string, unknown> {
  return {
    type: 'object',
    properties: { value: { type: 'string' } },
    additionalProperties: false,
  };
}

function requiredNullableValueSchema(): Record<string, unknown> {
  return {
    type: 'object',
    properties: { value: { type: ['string', 'null'] } },
    required: ['value'],
    additionalProperties: false,
  };
}

/** A fake client that acks turn/start but never emits turn/completed. */
class ManualFakeCodexClient {
  readonly inputs: string[] = [];
  private readonly handlers = new Set<NotificationHandler>();
  private nextTurnId = 1;

  get handlerCount(): number {
    return this.handlers.size;
  }

  onNotification(handler: NotificationHandler): () => void {
    this.handlers.add(handler);
    return () => {
      this.handlers.delete(handler);
    };
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
  readonly outputSchemas: Array<Record<string, unknown> | undefined> = [];
  private readonly handlers = new Set<NotificationHandler>();
  private nextTurnId = 1;

  onNotification(handler: NotificationHandler): () => void {
    this.handlers.add(handler);
    return () => {
      this.handlers.delete(handler);
    };
  }

  async request<R>(method: string, params: unknown): Promise<R> {
    if (method !== 'turn/start') throw new Error(`unexpected method ${method}`);
    this.methods.push(method);
    const p = params as {
      threadId: string;
      input: Array<{ text: string }>;
      outputSchema?: Record<string, unknown>;
    };
    const text = p.input[0]?.text ?? '';
    this.inputs.push(text);
    this.outputSchemas.push(p.outputSchema);
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
  readonly outputSchemas: Array<Record<string, unknown> | undefined> = [];
  private readonly handlers = new Set<NotificationHandler>();
  private nextIndex = 0;

  constructor(private readonly turnIds: string[]) {}

  onNotification(handler: NotificationHandler): () => void {
    this.handlers.add(handler);
    return () => {
      this.handlers.delete(handler);
    };
  }

  async request<R>(method: string, params: unknown): Promise<R> {
    if (method !== 'turn/start') throw new Error(`unexpected method ${method}`);
    const p = params as {
      input: Array<{ text: string }>;
      outputSchema?: Record<string, unknown>;
    };
    this.inputs.push(p.input[0]?.text ?? '');
    this.outputSchemas.push(p.outputSchema);
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

class FailOnceFakeCodexClient {
  readonly outputSchemas: Array<Record<string, unknown> | undefined> = [];
  private readonly handlers = new Set<NotificationHandler>();
  private requests = 0;

  onNotification(handler: NotificationHandler): () => void {
    this.handlers.add(handler);
    return () => {
      this.handlers.delete(handler);
    };
  }

  async request<R>(method: string, params: unknown): Promise<R> {
    if (method !== 'turn/start') throw new Error(`unexpected method ${method}`);
    this.requests += 1;
    const p = params as { outputSchema?: Record<string, unknown> };
    this.outputSchemas.push(p.outputSchema);
    if (this.requests === 1) throw new Error('turn/start rejected');
    return { turn: { id: 'turn-2' } } as TurnStartResponse as R;
  }
}

class RecoveringFakeCodexClient {
  private readonly handlers = new Set<NotificationHandler>();
  private requests = 0;

  get handlerCount(): number {
    return this.handlers.size;
  }

  onNotification(handler: NotificationHandler): () => void {
    this.handlers.add(handler);
    return () => {
      this.handlers.delete(handler);
    };
  }

  async request<R>(method: string): Promise<R> {
    if (method !== 'turn/start') throw new Error(`unexpected method ${method}`);
    this.requests += 1;
    if (this.requests === 1) throw new Error('turn/start rejected');
    return { turn: { id: 'turn-2' } } as TurnStartResponse as R;
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
  private readonly handlers = new Set<NotificationHandler>();
  private readonly pending: Array<(turnId: string) => void> = [];

  get handlerCount(): number {
    return this.handlers.size;
  }

  onNotification(handler: NotificationHandler): () => void {
    this.handlers.add(handler);
    return () => {
      this.handlers.delete(handler);
    };
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
  private readonly handlers = new Set<NotificationHandler>();
  private nextTurnId = 1;

  constructor(private readonly willRetry: boolean) {}

  onNotification(handler: NotificationHandler): () => void {
    this.handlers.add(handler);
    return () => {
      this.handlers.delete(handler);
    };
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
