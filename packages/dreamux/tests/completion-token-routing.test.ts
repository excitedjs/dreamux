/**
 * Core contract: completion-token exactly-once routing.
 *
 * These tests exercise `CompletionDeliveryPolicy.deliverRuntime` — the stateful
 * Core chokepoint that turns provider-observed completion tokens into at most one
 * user-visible push per recipient.
 *
 * The locked contract deliberately makes the PROVIDER decide how many logical
 * completions exist; Core only obeys. So every case below expresses fold/queue by
 * WIRING TOKEN IDENTITY (one shared frozen object vs two distinct ones) and then
 * observes the resulting push count. No fake is ever handed a "how many pushes"
 * number.
 */
import { describe, expect, it } from 'vitest';

import type {
  DreamuxLogger,
  RuntimeCompletion,
} from '@excitedjs/dreamux-types';

import {
  CompletionDeliveryPolicy,
  type CompletionDeliveryResult,
  type CompletionInitiator,
  type PreparedCompletionDelivery,
  type PreparedCompletionFact,
} from '../src/service/completion-router/index.js';
import {
  completedCompletion,
  controllableRuntimeSubmission,
  foldSubmissions,
} from './helpers/runtime-submission.js';

/** Records every user-visible send attempt the router actually makes. */
class RecordingInitiator implements CompletionInitiator {
  readonly prepared: PreparedCompletionFact[] = [];
  readonly submitted: PreparedCompletionFact[] = [];

  constructor(
    private readonly gate?: (fact: PreparedCompletionFact) => Promise<void>,
  ) {}

  async prepareCompletion(
    fact: PreparedCompletionFact,
  ): Promise<PreparedCompletionDelivery> {
    this.prepared.push(fact);
    await this.gate?.(fact);
    return Object.freeze({
      submit: async (): Promise<CompletionDeliveryResult> => {
        this.submitted.push(fact);
        return { status: 'accepted' };
      },
    });
  }
}

function policy(attemptTimeoutMs?: number): CompletionDeliveryPolicy {
  return new CompletionDeliveryPolicy({
    dispatcherId: 'flow',
    log: noopLog(),
    fence: { isClosing: () => false },
    ...(attemptTimeoutMs === undefined ? {} : { attemptTimeoutMs }),
  });
}

function fact(
  source: string,
  result: string | null = 'done',
): PreparedCompletionFact {
  return {
    kind: 'teammate',
    source,
    role: 'teammate',
    status: 'completed',
    result,
  };
}

/** A provider-shaped native result: one frozen token per real result boundary. */
function nativeResult(resultText: string | null = 'done'): RuntimeCompletion {
  return completedCompletion(
    controllableRuntimeSubmission().submission,
    resultText,
  );
}

describe('completion token routing: fold vs queue push cardinality', () => {
  it('pushes ONCE for two submissions that folded into one native result', async () => {
    // Steer/fold, expressed natively: two accepted sends, one native result, so
    // the provider settles both with the SAME frozen token.
    const a = controllableRuntimeSubmission();
    const b = controllableRuntimeSubmission();
    const shared = foldSubmissions([a, b], 'ok1 + ok2');

    const settlementA = await a.submission.settled;
    const settlementB = await b.submission.settled;
    expect(settlementA.kind).toBe('completion');
    expect(settlementB.kind).toBe('completion');
    // The contract is object identity, not structural equality.
    expect(settlementA.kind === 'completion' && settlementA.completion).toBe(
      shared,
    );
    expect(settlementB.kind === 'completion' && settlementB.completion).toBe(
      shared,
    );

    const router = policy();
    const recipient = new RecordingInitiator();
    await Promise.all([
      router.deliverRuntime(recipient, shared, fact('worker', 'ok1 + ok2')),
      router.deliverRuntime(recipient, shared, fact('worker', 'ok1 + ok2')),
    ]);

    expect(recipient.submitted).toHaveLength(1);
    expect(recipient.prepared).toHaveLength(1);
  });

  it('pushes TWICE for two queued native results', async () => {
    const first = nativeResult('the novel');
    const second = nativeResult('ok');
    expect(first).not.toBe(second);

    const router = policy();
    const recipient = new RecordingInitiator();
    await router.deliverRuntime(recipient, first, fact('worker', 'the novel'));
    await router.deliverRuntime(recipient, second, fact('worker', 'ok'));

    expect(recipient.submitted.map((f) => f.result)).toEqual([
      'the novel',
      'ok',
    ]);
  });

  it('pushes TWICE for two distinct results whose text is byte-identical', async () => {
    // Acceptance criterion 3: identity is the token, never the text.
    const first = nativeResult('ok');
    const second = nativeResult('ok');
    expect(first).not.toBe(second);
    expect(first.status === 'completed' && first.resultText).toBe(
      second.status === 'completed' && second.resultText,
    );

    const router = policy();
    const recipient = new RecordingInitiator();
    await router.deliverRuntime(recipient, first, fact('worker', 'ok'));
    await router.deliverRuntime(recipient, second, fact('worker', 'ok'));

    expect(recipient.submitted).toHaveLength(2);
  });
});

describe('completion token routing: exactly-once per provider completion token', () => {
  it('collapses repeated registration of one token to a single send', async () => {
    const token = nativeResult();
    const router = policy();
    const recipient = new RecordingInitiator();

    await router.deliverRuntime(recipient, token, fact('worker'));
    await router.deliverRuntime(recipient, token, fact('worker'));
    await router.deliverRuntime(recipient, token, fact('worker'));

    expect(recipient.submitted).toHaveLength(1);
  });

  it('single-flights concurrent registrations before the transport is called', async () => {
    // The reservation must be created atomically BEFORE transport, or two
    // concurrent folded submissions both cross the check.
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const recipient = new RecordingInitiator(() => gate);
    const token = nativeResult();
    const router = policy();

    const both = Promise.all([
      router.deliverRuntime(recipient, token, fact('worker')),
      router.deliverRuntime(recipient, token, fact('worker')),
    ]);
    release();
    await both;

    expect(recipient.prepared).toHaveLength(1);
    expect(recipient.submitted).toHaveLength(1);
  });

  it('keeps a terminal reservation after an ambiguous send, so a folded follower cannot resend', async () => {
    const token = nativeResult();
    const router = policy();
    let attempts = 0;
    const recipient: CompletionInitiator = {
      prepareCompletion: async () =>
        Object.freeze({
          submit: async (): Promise<CompletionDeliveryResult> => {
            attempts += 1;
            return { status: 'ambiguous', error: new Error('response lost') };
          },
        }),
    };

    await router.deliverRuntime(recipient, token, fact('worker'));
    await router.deliverRuntime(recipient, token, fact('worker'));

    expect(attempts).toBe(1);
  });
});

describe('completion token routing: per-recipient FIFO order', () => {
  it('delivers C1 before C2 to one recipient even when C1 transport is slow', async () => {
    const order: string[] = [];
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const recipient = new RecordingInitiator(async (received) => {
      if (received.result === 'C1') await firstGate;
      order.push(received.result ?? '');
    });

    const router = policy();
    const c1 = nativeResult('C1');
    const c2 = nativeResult('C2');

    const first = router.deliverRuntime(recipient, c1, fact('worker', 'C1'));
    const second = router.deliverRuntime(recipient, c2, fact('worker', 'C2'));
    // C2 is ready first, but the recipient tail must hold it behind C1.
    await Promise.resolve();
    expect(order).toEqual([]);
    releaseFirst();
    await Promise.all([first, second]);

    expect(order).toEqual(['C1', 'C2']);
    expect(recipient.submitted.map((f) => f.result)).toEqual(['C1', 'C2']);
  });

  it('does not head-of-line block a different recipient behind a slow one', async () => {
    let releaseSlow!: () => void;
    const slowGate = new Promise<void>((resolve) => {
      releaseSlow = resolve;
    });
    const slow = new RecordingInitiator(() => slowGate);
    const fast = new RecordingInitiator();
    const router = policy();

    const slowDelivery = router.deliverRuntime(
      slow,
      nativeResult('slow'),
      fact('worker', 'slow'),
    );
    await router.deliverRuntime(
      fast,
      nativeResult('fast'),
      fact('worker', 'fast'),
    );

    // The fast recipient completed while the slow one is still gated.
    expect(fast.submitted).toHaveLength(1);
    expect(slow.submitted).toHaveLength(0);

    releaseSlow();
    await slowDelivery;
    expect(slow.submitted).toHaveLength(1);
  });

  it('keeps FIFO for a folded token followed by a queued token', async () => {
    // A steer/fold produces C1 (one push), then a queued result produces C2.
    const a = controllableRuntimeSubmission();
    const b = controllableRuntimeSubmission();
    const c1 = foldSubmissions([a, b], 'folded');
    const c2 = nativeResult('queued');

    const recipient = new RecordingInitiator();
    const router = policy();

    await Promise.all([
      router.deliverRuntime(recipient, c1, fact('worker', 'folded')),
      router.deliverRuntime(recipient, c1, fact('worker', 'folded')),
    ]);
    await router.deliverRuntime(recipient, c2, fact('worker', 'queued'));

    expect(recipient.submitted.map((f) => f.result)).toEqual([
      'folded',
      'queued',
    ]);
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
  return log as DreamuxLogger;
}
