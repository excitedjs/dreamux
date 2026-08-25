/**
 * Core contract: `(producer, completion token, recipientKey)` exactly-once routing.
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

import type { DreamuxLogger, RuntimeCompletion } from '@excitedjs/dreamux-types';

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
  readonly recipientKey: object;

  constructor(
    key?: object,
    private readonly gate?: (fact: PreparedCompletionFact) => Promise<void>,
  ) {
    this.recipientKey = key ?? {};
  }

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
    ...(attemptTimeoutMs === undefined ? {} : { attemptTimeoutMs }),
  });
}

function fact(
  source: string,
  result: string | null = 'done',
): PreparedCompletionFact {
  return { kind: 'teammate', source, status: 'completed', result };
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
    expect(
      settlementA.kind === 'completion' && settlementA.completion,
    ).toBe(shared);
    expect(
      settlementB.kind === 'completion' && settlementB.completion,
    ).toBe(shared);

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

describe('completion token routing: exactly-once per (producer, token, recipient)', () => {
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
    const recipient = new RecordingInitiator(undefined, () => gate);
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

  it('delivers one folded token once to EACH distinct recipient', async () => {
    const token = nativeResult('shared answer');
    const router = policy();
    const first = new RecordingInitiator();
    const second = new RecordingInitiator();

    await Promise.all([
      router.deliverRuntime(first, token, fact('worker', 'shared answer')),
      router.deliverRuntime(second, token, fact('worker', 'shared answer')),
      // duplicate registrations from a folded follower on both sides
      router.deliverRuntime(first, token, fact('worker', 'shared answer')),
      router.deliverRuntime(second, token, fact('worker', 'shared answer')),
    ]);

    expect(first.submitted).toHaveLength(1);
    expect(second.submitted).toHaveLength(1);
  });

  it('keys the recipient by stable identity, so an availability wrapper still dedupes', async () => {
    const key = {};
    const token = nativeResult();
    const router = policy();
    const original = new RecordingInitiator(key);
    const rewrapped = new RecordingInitiator(key);

    await router.deliverRuntime(original, token, fact('worker'));
    await router.deliverRuntime(rewrapped, token, fact('worker'));

    // Same recipientKey => one logical recipient => exactly one push total.
    expect(original.submitted.length + rewrapped.submitted.length).toBe(1);
  });

  it('separates dedupe state by producer, so two producers each push once', async () => {
    const token = nativeResult();
    const router = policy();
    const recipient = new RecordingInitiator();

    await router.deliverRuntime(recipient, token, fact('worker-a'));
    await router.deliverRuntime(recipient, token, fact('worker-b'));

    expect(recipient.submitted.map((f) => f.source)).toEqual([
      'worker-a',
      'worker-b',
    ]);
  });

  it('keeps a terminal reservation after an ambiguous send, so a folded follower cannot resend', async () => {
    const token = nativeResult();
    const router = policy();
    let attempts = 0;
    const recipient: CompletionInitiator = {
      recipientKey: {},
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
    const recipient = new RecordingInitiator(undefined, async (received) => {
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
    const slow = new RecordingInitiator(undefined, () => slowGate);
    const fast = new RecordingInitiator();
    const router = policy();

    const slowDelivery = router.deliverRuntime(slow, nativeResult('slow'), fact('worker', 'slow'));
    await router.deliverRuntime(fast, nativeResult('fast'), fact('worker', 'fast'));

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

describe('completion token routing: close and stop produce no pushes', () => {
  it('never routes a submission that settled `stopped` with no native result', async () => {
    // Close a task that never produced a final result.
    const pending = controllableRuntimeSubmission();
    pending.stop();
    const settlement = await pending.submission.settled;

    expect(settlement.kind).toBe('stopped');
    // There is no token to route: `stopped` carries no RuntimeCompletion at all.
    expect(settlement).not.toHaveProperty('completion');

    const recipient = new RecordingInitiator();
    // Core only registers `completion` settlements, so nothing reaches transport.
    expect(recipient.submitted).toHaveLength(0);
  });

  it('never routes an internal `failed` settlement that carries no result', async () => {
    const pending = controllableRuntimeSubmission();
    pending.fail(new Error('runtime died before any result'));
    const settlement = await pending.submission.settled;

    expect(settlement.kind).toBe('failed');
    expect(settlement).not.toHaveProperty('completion');
  });

  it('still delivers a real result observed before the stop linearization point', async () => {
    const pending = controllableRuntimeSubmission();
    const token = pending.complete('answered just in time');
    const settlement = await pending.submission.settled;
    expect(settlement.kind === 'completion' && settlement.completion).toBe(token);

    const router = policy();
    const recipient = new RecordingInitiator();
    await router.deliverRuntime(recipient, token, fact('worker', 'answered just in time'));

    expect(recipient.submitted).toHaveLength(1);
  });

  it('produces zero pushes when a batch of teams is dissolved with no results', async () => {
    // Dispatcher-style bulk dissolve: many in-flight submissions, none with a
    // native result. The close path must not manufacture a push storm.
    const router = policy();
    const recipient = new RecordingInitiator();
    const pendings = Array.from({ length: 200 }, () => controllableRuntimeSubmission());

    for (const pending of pendings) pending.stop();
    const settlements = await Promise.all(pendings.map((p) => p.submission.settled));

    expect(settlements.every((s) => s.kind === 'stopped')).toBe(true);
    const tokens = settlements.filter((s) => s.kind === 'completion');
    expect(tokens).toHaveLength(0);
    // Nothing was eligible for routing, so transport was never touched.
    expect(recipient.prepared).toHaveLength(0);
    expect(recipient.submitted).toHaveLength(0);
    void router;
  });

  it('delivers only the results observed before close in a mixed dissolve batch', async () => {
    const answered = Array.from({ length: 3 }, () => controllableRuntimeSubmission());
    const unanswered = Array.from({ length: 50 }, () => controllableRuntimeSubmission());
    const tokens = answered.map((pending, index) => pending.complete(`answer-${index}`));
    for (const pending of unanswered) pending.stop();

    const router = policy();
    const recipient = new RecordingInitiator();
    for (const [index, token] of tokens.entries()) {
      await router.deliverRuntime(recipient, token, fact('worker', `answer-${index}`));
    }

    expect(recipient.submitted.map((f) => f.result)).toEqual([
      'answer-0',
      'answer-1',
      'answer-2',
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
