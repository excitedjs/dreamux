import { describe, expect, it } from 'vitest';

import type {
  CompletionEnvelope,
  DreamuxLogger,
  TeamMateCompletionDeliveryResult,
} from '@excitedjs/dreamux-types';

import {
  CompletionRouter,
  completionKey,
  type CompletionInitiator,
} from '../src/dispatcher-service/teammate/completion-router.js';

function envelope(name: string, turnId: string): CompletionEnvelope {
  return {
    source: name,
    id: `${name}:${turnId}`,
    status: 'completed',
    result: 'done',
  };
}

/** An initiator that returns scripted outcomes and counts the calls it received. */
class FakeInitiator implements CompletionInitiator {
  readonly received: CompletionEnvelope[] = [];

  constructor(
    private readonly outcomes:
      | TeamMateCompletionDeliveryResult[]
      | (() => TeamMateCompletionDeliveryResult),
  ) {}

  completionInput(
    completion: CompletionEnvelope,
  ): Promise<TeamMateCompletionDeliveryResult> {
    this.received.push(completion);
    const next =
      typeof this.outcomes === 'function'
        ? this.outcomes()
        : this.outcomes.shift() ?? { status: 'accepted' };
    return Promise.resolve(next);
  }
}

/** An initiator whose `completionInput` throws, to drive the ambiguous branch. */
class ThrowingInitiator implements CompletionInitiator {
  calls = 0;
  completionInput(): Promise<TeamMateCompletionDeliveryResult> {
    this.calls += 1;
    throw new Error('boom');
  }
}

function router(): CompletionRouter {
  return new CompletionRouter({ dispatcherId: 'flow', log: noopLog() });
}

describe('CompletionRouter', () => {
  it('delivers a registered settle exactly once to its initiator', async () => {
    const r = router();
    const initiator = new FakeInitiator([{ status: 'accepted' }]);
    r.register(completionKey('mate', 'turn-1'), initiator);
    await r.settle(completionKey('mate', 'turn-1'), envelope('mate', 'turn-1'));
    expect(initiator.received).toHaveLength(1);
    expect(initiator.received[0]?.id).toBe('mate:turn-1');
  });

  it('is a no-op when the key was never registered', async () => {
    const r = router();
    await r.settle(completionKey('ghost', 'turn-1'), envelope('ghost', 'turn-1'));
    // Nothing to assert beyond not throwing; an unregistered key simply drops.
    expect(true).toBe(true);
  });

  it('coalesces a duplicate settle via the terminal cache (at-most-once)', async () => {
    const r = router();
    const initiator = new FakeInitiator([{ status: 'accepted' }]);
    const key = completionKey('mate', 'turn-1');
    r.register(key, initiator);
    await r.settle(key, envelope('mate', 'turn-1'));
    // A second settle of the same key must not re-deliver even after re-register.
    r.register(key, initiator);
    await r.settle(key, envelope('mate', 'turn-1'));
    expect(initiator.received).toHaveLength(1);
  });

  it('keys by producer name so two teammates sharing a turn id never cross-wire', async () => {
    const r = router();
    const one = new FakeInitiator([{ status: 'accepted' }]);
    const two = new FakeInitiator([{ status: 'accepted' }]);
    r.register(completionKey('one', 'turn-1'), one);
    r.register(completionKey('two', 'turn-1'), two);
    await r.settle(completionKey('one', 'turn-1'), envelope('one', 'turn-1'));
    await r.settle(completionKey('two', 'turn-1'), envelope('two', 'turn-1'));
    expect(one.received).toHaveLength(1);
    expect(two.received).toHaveLength(1);
    expect(one.received[0]?.source).toBe('one');
    expect(two.received[0]?.source).toBe('two');
  });

  it('retries an explicit failure with a bound, then drops and records terminal', async () => {
    const r = router();
    const initiator = new FakeInitiator(() => ({
      status: 'failed',
      error: new Error('nope'),
    }));
    const key = completionKey('mate', 'turn-1');
    r.register(key, initiator);
    await r.settle(key, envelope('mate', 'turn-1'));
    // Bounded retry: three attempts, then drop.
    expect(initiator.received).toHaveLength(3);
    // The exhausted key is terminal — a duplicate settle does not retry again.
    r.register(key, initiator);
    await r.settle(key, envelope('mate', 'turn-1'));
    expect(initiator.received).toHaveLength(3);
  });

  it('drops an unsupported delivery without retry and records terminal', async () => {
    const r = router();
    const initiator = new FakeInitiator(() => ({
      status: 'unsupported',
      reason: 'not running',
    }));
    const key = completionKey('mate', 'turn-1');
    r.register(key, initiator);
    await r.settle(key, envelope('mate', 'turn-1'));
    expect(initiator.received).toHaveLength(1);
    // Terminal: a duplicate settle is a no-op.
    r.register(key, initiator);
    await r.settle(key, envelope('mate', 'turn-1'));
    expect(initiator.received).toHaveLength(1);
  });

  it('drops a thrown delivery without retry (ambiguous) and records terminal', async () => {
    const r = router();
    const initiator = new ThrowingInitiator();
    const key = completionKey('mate', 'turn-1');
    r.register(key, initiator);
    await r.settle(key, envelope('mate', 'turn-1'));
    expect(initiator.calls).toBe(1);
    // Terminal: a duplicate settle does not re-attempt the ambiguous delivery.
    r.register(key, initiator);
    await r.settle(key, envelope('mate', 'turn-1'));
    expect(initiator.calls).toBe(1);
  });
});

function noopLog(): DreamuxLogger {
  const log = {
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    debug: () => undefined,
    trace: () => undefined,
    child: () => log,
  };
  return log as unknown as DreamuxLogger;
}
