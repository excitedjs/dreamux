import { describe, expect, it, vi } from 'vitest';

import type { RuntimeTurn, RuntimeTurnOutcome } from '@excitedjs/dreamux-types';
import type { AgentRuntimeStateStore } from '../src/service/agent-entity/runtime-state.js';
import type { AgentTurnsStore } from '../src/service/agent-entity/turns-store.js';
import type { AgentEntityTurnRecord } from '../src/service/agent-entity/types.js';
import { EntityTurn } from '../src/service/teammate-service/turn-recording.js';

describe('entity-owned Turn terminal pipeline', () => {
  it('retries only the rolling projection after the terminal row commits', async () => {
    const runtime = deferredRuntimeTurn();
    const row = terminalRow('completed');
    const appendTerminal = vi.fn(async () => row);
    const recordTerminalTurn = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error('projection unavailable'))
      .mockResolvedValue(undefined);
    const delivery = vi.fn(async () => undefined);
    const onPersistenceFailure = vi.fn();
    const turn = makeTurn(
      runtime.turn,
      appendTerminal,
      recordTerminalTurn,
      delivery,
      onPersistenceFailure,
    );

    runtime.settle({ status: 'completed', resultText: 'done', truncated: false });
    await waitFor(() => recordTerminalTurn.mock.calls.length === 1);
    expect(delivery).not.toHaveBeenCalled();
    await expect(turn.settled).rejects.toThrow(/projection unavailable/u);
    expect(onPersistenceFailure).toHaveBeenCalledTimes(1);
    expect(onPersistenceFailure).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'projection unavailable' }),
    );

    await turn.ensurePersisted();
    await turn.delivery;
    await expect(turn.settled).rejects.toThrow(/projection unavailable/u);

    expect(appendTerminal).toHaveBeenCalledTimes(1);
    expect(recordTerminalTurn).toHaveBeenCalledTimes(2);
    expect(delivery).toHaveBeenCalledTimes(1);
  });

  it('does not settle or deliver until a failed terminal append is retried', async () => {
    const runtime = deferredRuntimeTurn();
    const row = terminalRow('failed');
    const appendTerminal = vi
      .fn()
      .mockRejectedValueOnce(new Error('archive unavailable'))
      .mockResolvedValue(row);
    const recordTerminalTurn = vi.fn(async () => undefined);
    const delivery = vi.fn(async () => undefined);
    const onPersistenceFailure = vi.fn();
    const turn = makeTurn(
      runtime.turn,
      appendTerminal,
      recordTerminalTurn,
      delivery,
      onPersistenceFailure,
    );

    runtime.settle({ status: 'failed', error: new Error('provider failed') });
    await waitFor(() => appendTerminal.mock.calls.length === 1);
    await expect(turn.settled).rejects.toThrow(/archive unavailable/u);
    expect(onPersistenceFailure).toHaveBeenCalledTimes(1);
    expect(recordTerminalTurn).not.toHaveBeenCalled();
    expect(delivery).not.toHaveBeenCalled();

    await turn.ensurePersisted();
    await turn.delivery;
    await expect(turn.settled).rejects.toThrow(/archive unavailable/u);

    expect(appendTerminal).toHaveBeenCalledTimes(2);
    expect(recordTerminalTurn).toHaveBeenCalledTimes(1);
    expect(delivery).toHaveBeenCalledTimes(1);
  });

  it('lets close-induced stopped win once over a late runtime result', async () => {
    const runtime = deferredRuntimeTurn();
    const appendTerminal = vi.fn(async () => terminalRow('stopped'));
    const recordTerminalTurn = vi.fn(async () => undefined);
    const delivery = vi.fn(async () => undefined);
    const turn = makeTurn(runtime.turn, appendTerminal, recordTerminalTurn, delivery);

    expect(turn.trySettle({ status: 'stopped' })).toBe(true);
    runtime.settle({ status: 'completed', resultText: 'late', truncated: false });
    await turn.delivery;

    await expect(turn.settled).resolves.toEqual({ status: 'stopped' });
    expect(appendTerminal).toHaveBeenCalledTimes(1);
    expect((appendTerminal.mock.calls as unknown[][])[0]?.[1]).toMatchObject({
      settleStatus: 'stopped',
      assistant: null,
    });
    expect(recordTerminalTurn).toHaveBeenCalledTimes(1);
    expect(delivery).toHaveBeenCalledTimes(1);
  });

  it('makes an early delivery read await and retain delivery rejection', async () => {
    const runtime = deferredRuntimeTurn();
    const appendTerminal = vi.fn(async () => terminalRow('completed'));
    const recordTerminalTurn = vi.fn(async () => undefined);
    let rejectDelivery!: (error: Error) => void;
    const delivery = vi.fn(
      () => new Promise<void>((_resolve, reject) => {
        rejectDelivery = reject;
      }),
    );
    const turn = makeTurn(runtime.turn, appendTerminal, recordTerminalTurn, delivery);

    const observedDelivery = turn.delivery;
    runtime.settle({ status: 'completed', resultText: 'done', truncated: false });
    await waitFor(() => delivery.mock.calls.length === 1);
    expect(await isSettled(observedDelivery)).toBe(false);

    rejectDelivery(new Error('delivery unavailable'));
    await expect(observedDelivery).rejects.toThrow(/delivery unavailable/);
    await expect(turn.delivery).rejects.toThrow(/delivery unavailable/);
    expect(delivery).toHaveBeenCalledTimes(1);
  });

  it('snapshots a completed provider outcome before prior persistence releases', async () => {
    const runtime = deferredRuntimeTurn();
    const prior = deferred<void>();
    const appendTerminal = vi.fn(async () => terminalRow('completed'));
    const recordTerminalTurn = vi.fn(async () => undefined);
    const delivery = vi.fn(async () => undefined);
    const turn = makeTurn(
      runtime.turn,
      appendTerminal,
      recordTerminalTurn,
      delivery,
      () => undefined,
      prior.promise,
    );
    const outcome: RuntimeTurnOutcome & {
      resultText: string | null;
      truncated: boolean;
    } = { status: 'completed', resultText: 'first', truncated: false };

    runtime.settle(outcome);
    await waitFor(() => turn.isOutcomeSelected());
    outcome.resultText = 'mutated';
    outcome.truncated = true;
    prior.resolve(undefined);

    const settled = await turn.settled;
    await turn.delivery;
    expect(settled).toEqual({
      status: 'completed',
      resultText: 'first',
      truncated: false,
    });
    expect(settled).not.toBe(outcome);
    expect(Object.isFrozen(settled)).toBe(true);
    expect((appendTerminal.mock.calls as unknown[][])[0]?.[1]).toMatchObject({
      settleStatus: 'completed',
      assistant: 'first',
      assistantTruncated: false,
    });
    expect(delivery).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'completed', result: 'first' }),
    );
  });

  it('snapshots failed error semantics without retaining the provider error', async () => {
    const runtime = deferredRuntimeTurn();
    const prior = deferred<void>();
    const appendTerminal = vi.fn(async () => terminalRow('failed'));
    const recordTerminalTurn = vi.fn(async () => undefined);
    const delivery = vi.fn(async () => undefined);
    const turn = makeTurn(
      runtime.turn,
      appendTerminal,
      recordTerminalTurn,
      delivery,
      () => undefined,
      prior.promise,
    );
    const providerError = new Error('first failure');
    providerError.name = 'ProviderFailure';

    runtime.settle({ status: 'failed', error: providerError });
    await waitFor(() => turn.isOutcomeSelected());
    providerError.name = 'MutatedFailure';
    providerError.message = 'mutated';
    providerError.stack = 'mutated stack';
    prior.resolve(undefined);

    const settled = await turn.settled;
    expect(settled.status).toBe('failed');
    if (settled.status !== 'failed') throw new Error('expected failed outcome');
    expect(settled.error).not.toBe(providerError);
    expect(settled.error).toMatchObject({
      name: 'ProviderFailure',
      message: 'first failure',
    });
    expect(settled.error.stack).not.toBe('mutated stack');
    expect(Object.isFrozen(settled.error)).toBe(true);
    expect(Object.isFrozen(settled)).toBe(true);
  });
});

function makeTurn(
  runtime: RuntimeTurn,
  appendTerminal: ReturnType<typeof vi.fn>,
  recordTerminalTurn: ReturnType<typeof vi.fn>,
  delivery: ReturnType<typeof vi.fn>,
  onPersistenceFailure: (error: Error) => void = () => undefined,
  priorPersistence: Promise<void> = Promise.resolve(),
): EntityTurn {
  const turnsStore = { appendTerminal } as unknown as AgentTurnsStore;
  const state = {
    current: () => ({
      dispatcher_id: 'flow',
      name: 'reviewer',
      team_id: null,
      role: 'teammate',
    }),
    recordTerminalTurn,
  } as unknown as AgentRuntimeStateStore;
  return new EntityTurn(
    runtime,
    'dispatcher',
    'review this',
    'review',
    1,
    'reviewer',
    turnsStore,
    state,
    delivery,
    onPersistenceFailure,
    priorPersistence,
  );
}

function terminalRow(
  settleStatus: AgentEntityTurnRecord['settle_status'],
): AgentEntityTurnRecord {
  return {
    version: 2,
    type: 'terminal',
    submitted_at: 1,
    settled_at: 2,
    turn_origin: 'dispatcher',
    prompt_preview: 'review this',
    intent: 'review',
    settle_status: settleStatus,
    assistant: settleStatus === 'completed' ? 'done' : null,
    assistant_preview: settleStatus === 'completed' ? 'done' : null,
    assistant_truncated: false,
  };
}

function deferredRuntimeTurn(): {
  turn: RuntimeTurn;
  settle: (outcome: RuntimeTurnOutcome) => void;
} {
  let settle!: (outcome: RuntimeTurnOutcome) => void;
  const settled = new Promise<RuntimeTurnOutcome>((resolve) => {
    settle = resolve;
  });
  return { turn: Object.freeze({ settled }), settle };
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

async function isSettled(promise: Promise<unknown>): Promise<boolean> {
  return Promise.race([
    promise.then(
      () => true,
      () => true,
    ),
    new Promise<false>((resolve) => setImmediate(() => resolve(false))),
  ]);
}

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('waitFor timed out');
}
