import { describe, expect, it, vi } from 'vitest';

import type { RuntimeCompletion, RuntimeSubmission } from '@excitedjs/dreamux-types';

import type { PreparedCompletionFact } from '../src/service/completion-router/index.js';
import type { TurnCompletionDelivery } from '../src/service/teammate-service/turn-recording.js';
import { EntityTurn } from '../src/service/teammate-service/turn-recording.js';
import {
  completedCompletion,
  controllableRuntimeSubmission,
} from './helpers/runtime-submission.js';

describe('entity-owned in-process Turn terminal pipeline', () => {
  it('settles immediately without a persistence dependency', async () => {
    const runtime = controllableRuntimeSubmission();
    const delivery = deliveryMock();
    const turn = makeTurn(runtime.submission, delivery);

    const completion = runtime.complete('done');

    await expect(turn.settled).resolves.toEqual({
      status: 'completed',
      resultText: 'done',
      truncated: false,
    });
    await turn.delivery;
    expect(delivery).toHaveBeenCalledTimes(1);
    expect(delivery).toHaveBeenCalledWith(completion, {
      kind: 'teammate',
      source: 'reviewer',
      status: 'completed',
      result: 'done',
    });
  });

  it('delivers a close-induced stopped settlement with no native token', async () => {
    const runtime = controllableRuntimeSubmission();
    const delivery = deliveryMock();
    const turn = makeTurn(runtime.submission, delivery);

    expect(turn.isSettled()).toBe(false);
    expect(runtime.stop()).toBe(true);
    // A submission settles once: a result offered after the stop is a no-op and
    // can never retroactively turn this turn into a push.
    expect(
      runtime.settle({
        kind: 'completion',
        completion: completedCompletion(runtime.submission, 'late'),
      }),
    ).toBe(false);

    await expect(turn.settled).resolves.toEqual({ status: 'stopped' });
    await turn.delivery;
    expect(turn.isSettled()).toBe(true);
    // The waiting Agent asked for the work; that it was stopped is news only
    // this turn has. There is no native token to fold on, so none is invented.
    expect(delivery).toHaveBeenCalledTimes(1);
    expect(delivery).toHaveBeenCalledWith(null, {
      kind: 'teammate',
      source: 'reviewer',
      status: 'stopped',
      result: null,
    });
  });

  it('delivers an internal runtime failure with no native token', async () => {
    const runtime = controllableRuntimeSubmission();
    const delivery = deliveryMock();
    const turn = makeTurn(runtime.submission, delivery);
    const runtimeError = new Error('runtime went away before any result');

    expect(runtime.fail(runtimeError)).toBe(true);

    const settled = await turn.settled;
    expect(settled.status).toBe('failed');
    if (settled.status !== 'failed') throw new Error('expected failed outcome');
    expect(settled.error).toBe(runtimeError);
    await turn.delivery;
    expect(delivery).toHaveBeenCalledTimes(1);
    expect(delivery).toHaveBeenCalledWith(null, {
      kind: 'teammate',
      source: 'reviewer',
      status: 'failed',
      result: null,
    });
  });

  it('delivers a rejected submission promise with no native token', async () => {
    const rejection = new Error('settled promise rejected');
    // The helper only models the documented settlement values; a provider that
    // rejects `settled` outright is still not a native result, so the delivery
    // carries the failure fact and no completion token.
    const submission: RuntimeSubmission = Object.freeze({
      settled: Promise.reject(rejection),
    });
    const delivery = deliveryMock();
    const turn = makeTurn(submission, delivery);

    const settled = await turn.settled;
    expect(settled.status).toBe('failed');
    if (settled.status !== 'failed') throw new Error('expected failed outcome');
    expect(settled.error).toBe(rejection);
    await turn.delivery;
    expect(delivery).toHaveBeenCalledTimes(1);
    expect(delivery).toHaveBeenCalledWith(null, {
      kind: 'teammate',
      source: 'reviewer',
      status: 'failed',
      result: null,
    });
  });

  it('makes an early delivery read await and retain delivery rejection', async () => {
    const runtime = controllableRuntimeSubmission();
    let rejectDelivery!: (error: Error) => void;
    let markInvoked!: () => void;
    const invoked = new Promise<void>((resolve) => {
      markInvoked = resolve;
    });
    const delivery = vi.fn(
      (_completion: RuntimeCompletion | null, _fact: PreparedCompletionFact) =>
        new Promise<void>((_resolve, reject) => {
          rejectDelivery = reject;
          markInvoked();
        }),
    );
    const turn = makeTurn(runtime.submission, delivery);

    const observedDelivery = turn.delivery;
    runtime.complete('done');
    await invoked;
    expect(delivery).toHaveBeenCalledTimes(1);
    expect(await hasSettled(observedDelivery)).toBe(false);

    rejectDelivery(new Error('delivery unavailable'));
    await expect(observedDelivery).rejects.toThrow(/delivery unavailable/);
    await expect(turn.delivery).rejects.toThrow(/delivery unavailable/);
    expect(delivery).toHaveBeenCalledTimes(1);
  });

  it('reports and delivers the frozen provider completion token as-is', async () => {
    const runtime = controllableRuntimeSubmission();
    const delivery = deliveryMock();
    const turn = makeTurn(runtime.submission, delivery);
    const completion = completedCompletion(runtime.submission, 'first');

    runtime.settle({ kind: 'completion', completion });
    const settled = await turn.settled;
    expect(turn.isSettled()).toBe(true);

    // The token is provider-owned and frozen: a later mutation attempt cannot
    // rewrite what this turn already reported or what it hands to delivery.
    expect(() => Object.assign(completion, { resultText: 'mutated', truncated: true }))
      .toThrow(TypeError);

    await turn.delivery;
    expect(settled).toEqual({
      status: 'completed',
      resultText: 'first',
      truncated: false,
    });
    const [deliveredCompletion, deliveredFact] = delivery.mock.calls[0] ?? [];
    expect(deliveredCompletion).toBe(completion);
    expect(Object.isFrozen(deliveredCompletion)).toBe(true);
    expect(deliveredFact).toEqual({
      kind: 'teammate',
      source: 'reviewer',
      status: 'completed',
      result: 'first',
    });
  });

  it('delivers a failed completion token as a real result boundary', async () => {
    const runtime = controllableRuntimeSubmission();
    const delivery = deliveryMock();
    const turn = makeTurn(runtime.submission, delivery);
    const providerError = new Error('first failure');
    providerError.name = 'ProviderFailure';

    const completion = runtime.failCompletion(providerError);

    const settled = await turn.settled;
    expect(settled.status).toBe('failed');
    if (settled.status !== 'failed') throw new Error('expected failed outcome');
    expect(settled.error).toBe(providerError);
    await turn.delivery;
    expect(delivery).toHaveBeenCalledTimes(1);
    expect(delivery).toHaveBeenCalledWith(completion, {
      kind: 'teammate',
      source: 'reviewer',
      status: 'failed',
      result: null,
    });
  });

  it('starts the completion delivery at most once', async () => {
    const runtime = controllableRuntimeSubmission();
    const delivery = deliveryMock();
    const turn = makeTurn(runtime.submission, delivery);

    const beforeSettlement = [turn.delivery, turn.ensureDelivery()];
    runtime.complete('done');
    await Promise.all(beforeSettlement);
    await Promise.all([turn.delivery, turn.ensureDelivery()]);
    await turn.delivery;

    expect(delivery).toHaveBeenCalledTimes(1);
  });
});

function makeTurn(
  submission: RuntimeSubmission,
  delivery: TurnCompletionDelivery | null,
): EntityTurn {
  return new EntityTurn(
    submission,
    'dispatcher',
    null,
    'review this',
    'review',
    1,
    'reviewer',
    delivery,
  );
}

function deliveryMock() {
  return vi.fn(
    async (
      _completion: RuntimeCompletion | null,
      _fact: PreparedCompletionFact,
    ): Promise<void> => undefined,
  );
}

async function hasSettled(promise: Promise<unknown>): Promise<boolean> {
  return Promise.race([
    promise.then(
      () => true,
      () => true,
    ),
    new Promise<false>((resolve) => setImmediate(() => resolve(false))),
  ]);
}
