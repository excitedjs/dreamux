import { afterEach, describe, expect, it, vi } from 'vitest';

import type { DreamuxLogger } from '@excitedjs/dreamux-types';

import {
  CompletionDeliveryPolicy,
  type CompletionDeliveryResult,
  type CompletionInitiator,
  type PreparedCompletionFact,
  type PreparedCompletionDelivery,
} from '../src/service/completion-router/index.js';

const completion: PreparedCompletionFact = {
  kind: 'teammate',
  source: 'worker',
  status: 'completed',
  result: 'done',
};

class ScriptedInitiator implements CompletionInitiator {
  prepareCalls = 0;
  submitCalls = 0;

  constructor(
    private readonly outcomes: Array<CompletionDeliveryResult | Error>,
  ) {}

  async prepareCompletion(
    received: PreparedCompletionFact,
  ): Promise<PreparedCompletionDelivery> {
    this.prepareCalls += 1;
    expect(received).toBe(completion);
    return Object.freeze({
      submit: async () => {
        this.submitCalls += 1;
        const outcome = this.outcomes.shift() ?? { status: 'accepted' as const };
        if (outcome instanceof Error) throw outcome;
        return outcome;
      },
    });
  }
}

function policy(attemptTimeoutMs?: number): CompletionDeliveryPolicy {
  return new CompletionDeliveryPolicy({
    dispatcherId: 'flow',
    log: noopLog(),
    attemptTimeoutMs,
  });
}

describe('CompletionDeliveryPolicy', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('prepares once and submits an accepted immutable payload once', async () => {
    const initiator = new ScriptedInitiator([{ status: 'accepted' }]);

    await policy().deliver(initiator, completion);

    expect(initiator.prepareCalls).toBe(1);
    expect(initiator.submitCalls).toBe(1);
  });

  it('retries only explicit pre-admission failures with a bound', async () => {
    const initiator = new ScriptedInitiator([
      { status: 'failed', error: new Error('one') },
      { status: 'failed', error: new Error('two') },
      { status: 'accepted' },
    ]);

    await policy().deliver(initiator, completion);

    expect(initiator.prepareCalls).toBe(1);
    expect(initiator.submitCalls).toBe(3);
  });

  it('drops an ambiguous admission without retry', async () => {
    const initiator = new ScriptedInitiator([
      { status: 'ambiguous', error: new Error('response lost') },
      { status: 'accepted' },
    ]);

    await policy().deliver(initiator, completion);

    expect(initiator.submitCalls).toBe(1);
  });

  it('drops a thrown submit without an ambiguous retry', async () => {
    const initiator = new ScriptedInitiator([
      new Error('native submission threw'),
      { status: 'accepted' },
    ]);

    await policy().deliver(initiator, completion);

    expect(initiator.submitCalls).toBe(1);
  });

  it('drops unsupported delivery without retry', async () => {
    const initiator = new ScriptedInitiator([
      { status: 'unsupported', reason: 'target closed' },
      { status: 'accepted' },
    ]);

    await policy().deliver(initiator, completion);

    expect(initiator.submitCalls).toBe(1);
  });

  it('drops preparation failure before any native submit', async () => {
    const initiator: CompletionInitiator = {
      prepareCompletion: async () => {
        throw new Error('spill write failed');
      },
    };

    await expect(policy().deliver(initiator, completion)).resolves.toBeUndefined();
  });

  it('bounds preparation and observes a rejection that arrives after timeout', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const preparation = deferred<PreparedCompletionDelivery>();
    const initiator: CompletionInitiator = {
      prepareCompletion: vi.fn(() => preparation.promise),
    };

    const delivery = policy(100).deliver(initiator, completion);
    await vi.advanceTimersByTimeAsync(99);
    expect(await isSettled(delivery)).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await expect(delivery).resolves.toBeUndefined();

    preparation.reject(new Error('late preparation rejection'));
    await Promise.resolve();
    expect(initiator.prepareCompletion).toHaveBeenCalledTimes(1);
  });

  it('treats a timed-out submit as ambiguous and never retries its late result', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const submission = deferred<CompletionDeliveryResult>();
    const prepared = Object.freeze({
      submit: vi.fn(() => submission.promise),
    });
    const initiator: CompletionInitiator = {
      prepareCompletion: vi.fn(async () => prepared),
    };

    const delivery = policy(100).deliver(initiator, completion);
    await waitForMicrotasks(() => prepared.submit.mock.calls.length === 1);
    expect(prepared.submit).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(100);
    await expect(delivery).resolves.toBeUndefined();

    submission.resolve({ status: 'failed', error: new Error('late failure') });
    await Promise.resolve();
    expect(prepared.submit).toHaveBeenCalledTimes(1);
    expect(initiator.prepareCompletion).toHaveBeenCalledTimes(1);
  });

  it('reuses one prepared payload while bounding every proven-safe retry', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const second = deferred<CompletionDeliveryResult>();
    const outcomes: Array<CompletionDeliveryResult | Promise<CompletionDeliveryResult>> = [
      { status: 'failed', error: new Error('safe first failure') },
      second.promise,
    ];
    const prepared = Object.freeze({
      submit: vi.fn(async (): Promise<CompletionDeliveryResult> =>
        outcomes.shift() ?? { status: 'accepted' }),
    });
    const initiator: CompletionInitiator = {
      prepareCompletion: vi.fn(async () => prepared),
    };

    const delivery = policy(100).deliver(initiator, completion);
    await waitForMicrotasks(() => prepared.submit.mock.calls.length === 2);
    await vi.advanceTimersByTimeAsync(100);
    await delivery;

    second.resolve({ status: 'failed', error: new Error('late second failure') });
    await Promise.resolve();
    expect(initiator.prepareCompletion).toHaveBeenCalledTimes(1);
    expect(prepared.submit).toHaveBeenCalledTimes(2);
  });
});

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: Error) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((resolveValue, rejectValue) => {
    resolve = resolveValue;
    reject = rejectValue;
  });
  return { promise, resolve, reject };
}

async function isSettled(promise: Promise<unknown>): Promise<boolean> {
  let settled = false;
  void promise.finally(() => {
    settled = true;
  });
  await Promise.resolve();
  return settled;
}

async function waitForMicrotasks(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (predicate()) return;
    await Promise.resolve();
  }
  throw new Error('microtask condition was not reached');
}

function noopLog(): DreamuxLogger {
  const log = {
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    debug: () => undefined,
    trace: () => undefined,
    child: () => log,
  };
  return log as DreamuxLogger;
}
