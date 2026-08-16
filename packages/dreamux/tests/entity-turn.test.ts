import { describe, expect, it, vi } from 'vitest';

import type { RuntimeTurn, RuntimeTurnOutcome } from '@excitedjs/dreamux-types';
import { EntityTurn } from '../src/service/teammate-service/turn-recording.js';

describe('entity-owned in-process Turn terminal pipeline', () => {
  it('settles immediately without a persistence dependency', async () => {
    const runtime = deferredRuntimeTurn();
    const delivery = vi.fn(async () => undefined);
    const turn = makeTurn(runtime.turn, delivery);

    runtime.settle({ status: 'completed', resultText: 'done', truncated: false });

    await expect(turn.settled).resolves.toEqual({
      status: 'completed',
      resultText: 'done',
      truncated: false,
    });
    await turn.delivery;
    expect(delivery).toHaveBeenCalledTimes(1);
  });

  it('lets close-induced stopped win once over a late runtime result', async () => {
    const runtime = deferredRuntimeTurn();
    const delivery = vi.fn(async () => undefined);
    const turn = makeTurn(runtime.turn, delivery);

    expect(turn.trySettle({ status: 'stopped' })).toBe(true);
    runtime.settle({ status: 'completed', resultText: 'late', truncated: false });
    await turn.delivery;

    await expect(turn.settled).resolves.toEqual({ status: 'stopped' });
    expect(delivery).toHaveBeenCalledTimes(1);
    expect(delivery).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'stopped', result: null }),
    );
  });

  it('makes an early delivery read await and retain delivery rejection', async () => {
    const runtime = deferredRuntimeTurn();
    let rejectDelivery!: (error: Error) => void;
    const delivery = vi.fn(
      () => new Promise<void>((_resolve, reject) => {
        rejectDelivery = reject;
      }),
    );
    const turn = makeTurn(runtime.turn, delivery);

    const observedDelivery = turn.delivery;
    runtime.settle({ status: 'completed', resultText: 'done', truncated: false });
    await waitFor(() => delivery.mock.calls.length === 1);
    expect(await isSettled(observedDelivery)).toBe(false);

    rejectDelivery(new Error('delivery unavailable'));
    await expect(observedDelivery).rejects.toThrow(/delivery unavailable/);
    await expect(turn.delivery).rejects.toThrow(/delivery unavailable/);
    expect(delivery).toHaveBeenCalledTimes(1);
  });

  it('snapshots a completed provider outcome before later mutation', async () => {
    const runtime = deferredRuntimeTurn();
    const delivery = vi.fn(async () => undefined);
    const turn = makeTurn(runtime.turn, delivery);
    const outcome: RuntimeTurnOutcome & {
      resultText: string | null;
      truncated: boolean;
    } = { status: 'completed', resultText: 'first', truncated: false };

    runtime.settle(outcome);
    await waitFor(() => turn.isOutcomeSelected());
    outcome.resultText = 'mutated';
    outcome.truncated = true;

    const settled = await turn.settled;
    await turn.delivery;
    expect(settled).toEqual({
      status: 'completed',
      resultText: 'first',
      truncated: false,
    });
    expect(settled).not.toBe(outcome);
    expect(Object.isFrozen(settled)).toBe(true);
    expect(delivery).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'completed', result: 'first' }),
    );
  });

  it('snapshots failed error semantics without retaining provider error mutation', async () => {
    const runtime = deferredRuntimeTurn();
    const turn = makeTurn(runtime.turn, vi.fn(async () => undefined));
    const providerError = new Error('first failure');
    providerError.name = 'ProviderFailure';

    runtime.settle({ status: 'failed', error: providerError });
    await waitFor(() => turn.isOutcomeSelected());
    providerError.name = 'MutatedFailure';
    providerError.message = 'mutated';
    providerError.stack = 'mutated stack';

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

  it('installs at most one completion delivery closure', async () => {
    const runtime = deferredRuntimeTurn();
    const first = vi.fn(async () => undefined);
    const second = vi.fn(async () => undefined);
    const turn = makeTurn(runtime.turn, first);
    turn.attachDelivery(second);

    runtime.settle({ status: 'completed', resultText: 'done', truncated: false });
    await turn.delivery;

    expect(first).toHaveBeenCalledTimes(1);
    expect(second).not.toHaveBeenCalled();
  });
});

function makeTurn(
  runtime: RuntimeTurn,
  delivery: ReturnType<typeof vi.fn>,
): EntityTurn {
  return new EntityTurn(
    runtime,
    'dispatcher',
    'review this',
    'review',
    1,
    'reviewer',
    delivery,
  );
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
