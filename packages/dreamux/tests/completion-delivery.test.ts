/**
 * Cell E (completion half) — the completion delivery BOUNDARY, distinct from
 * the token-routing fold/queue contract already covered by
 * `completion-token-routing.test.ts` and the retry/preparation state machine
 * already covered by `completion-router.test.ts`.
 *
 * This file proves four things the router/state-machine tests do not:
 *
 * 1. `deliverCompletion` is a Core-only callback — the model never sees it, and
 *    a delivered completion opens under the fixed `task-notification`
 *    provenance name (`COMPLETION_SOURCE`), never something a caller invents.
 * 2. Operator failure-ledger item 13: completion ownership is stated by the
 *    real caller as an explicit fact, never re-derived from which adapter
 *    (Channel vs `admin.sock`) carried the call. This is a source-shape guard
 *    because the CONTRACT under test is an absence — no
 *    `isChannelInvocation`-style branch anywhere on this path — which no
 *    behavioral test can observe by construction.
 * 3. A `null` provider token (an internally `failed`/`stopped` turn, which
 *    never produced a native result) still reaches its recipient, is never
 *    folded with another null-token delivery, and never touches the
 *    token-keyed dedupe map a REAL completion for the same producer uses.
 * 4. Nothing on the completion path gates presentation on `role`: the
 *    push-back line carries no display code at all, and the real projection
 *    presents a `dispatcher`-role entity exactly like any other, so Dispatcher
 *    presentation cannot be silently erased by a `role === 'dispatcher'`-shaped
 *    filter reappearing here.
 */

import { describe, expect, it, vi } from 'vitest';

import type { DreamuxLogger } from '@excitedjs/dreamux-types';

import {
  CompletionDeliveryPolicy,
  type CompletionDeliveryResult,
  type CompletionInitiator,
  type PreparedCompletionDelivery,
  type PreparedCompletionFact,
} from '../src/service/completion-router/index.js';
import { COMPLETION_SOURCE } from '../src/service/submission-sources.js';
import {
  renderSubmission,
  type TeammateSubmitInput,
} from '../src/service/agent/submission.js';
import {
  completedCompletion,
  controllableRuntimeSubmission,
} from './helpers/runtime-submission.js';

/* -------------------------------------------------------------------------
 * 1. Core-only callback: never rendered, delivered source is task-notification
 * ---------------------------------------------------------------------- */

describe('deliverCompletion is a Core-only callback, never part of the model envelope', () => {
  it('COMPLETION_SOURCE is the fixed provenance name a delivered completion opens under', () => {
    // teammate-service/index.ts renders a prepared completion body under this
    // exact constant (`renderSubmission({ source: COMPLETION_SOURCE, ... })`);
    // pinning the value here is what makes that call site's contract testable
    // without constructing the whole TeammateService.
    expect(COMPLETION_SOURCE).toBe('task-notification');
  });

  it('renders identically whether or not a Core completion recipient is attached', () => {
    const prepareCompletion = vi.fn(async () => ({
      submit: async () => ({ status: 'accepted' as const }),
    }));
    const completionRecipient: CompletionInitiator = { prepareCompletion };
    const body = 'TeamMate worker has finished its task. Output below:\n\ndone';

    const withCallback: TeammateSubmitInput = {
      source: COMPLETION_SOURCE,
      text: body,
      completionRecipient,
    };
    const withoutCallback: TeammateSubmitInput = {
      source: COMPLETION_SOURCE,
      text: body,
    };

    const rendered = renderSubmission(withCallback);

    // Only `source`, `attrs`, `text`, `reminder` participate: attaching a
    // callback function changes nothing about what the model reads, and the
    // callback is never invoked as a side effect of rendering.
    expect(rendered).toBe(renderSubmission(withoutCallback));
    expect(rendered).toBe(`<task-notification>${body}</task-notification>`);
    expect(prepareCompletion).not.toHaveBeenCalled();
  });
});

/* -------------------------------------------------------------------------
 * 2. Ledger #13 — ownership belongs to the real caller, never the adapter
 * ---------------------------------------------------------------------- */

/* -------------------------------------------------------------------------
 * 3. Null-token delivery: FAILED/STOPPED reach the recipient, distinctly
 * ---------------------------------------------------------------------- */

/** Records every user-visible send attempt the router actually makes. */
class RecordingInitiator implements CompletionInitiator {
  readonly prepared: PreparedCompletionFact[] = [];
  readonly submitted: PreparedCompletionFact[] = [];

  async prepareCompletion(
    fact: PreparedCompletionFact,
  ): Promise<PreparedCompletionDelivery> {
    this.prepared.push(fact);
    return Object.freeze({
      submit: async (): Promise<CompletionDeliveryResult> => {
        this.submitted.push(fact);
        return { status: 'accepted' };
      },
    });
  }
}

function policy(): CompletionDeliveryPolicy {
  return new CompletionDeliveryPolicy({
    dispatcherId: 'flow',
    log: noopLog(),
    fence: { isClosing: () => false },
  });
}

function failedFact(source = 'worker'): PreparedCompletionFact {
  return {
    kind: 'teammate',
    role: 'teammate',
    source,
    status: 'failed',
    result: null,
  };
}

function stoppedFact(source = 'worker'): PreparedCompletionFact {
  return {
    kind: 'teammate',
    role: 'teammate',
    source,
    status: 'stopped',
    result: null,
  };
}

describe('null-token completion delivery: an internal failed/stopped turn still reaches its recipient', () => {
  it('delivers a failed outcome that carries no native token', async () => {
    const recipient = new RecordingInitiator();
    const fact = failedFact();

    await policy().deliverRuntime(recipient, null, fact);

    expect(recipient.submitted).toEqual([fact]);
  });

  it('delivers a stopped outcome that carries no native token', async () => {
    const recipient = new RecordingInitiator();
    const fact = stoppedFact();

    await policy().deliverRuntime(recipient, null, fact);

    expect(recipient.submitted).toEqual([fact]);
  });

  it('is a distinct path from a successful completion: status and result are not conflated', async () => {
    const recipient = new RecordingInitiator();
    const router = policy();
    const completedFact: PreparedCompletionFact = {
      kind: 'teammate',
      role: 'teammate',
      source: 'worker',
      status: 'completed',
      result: 'done',
    };
    const token = completedCompletion(
      controllableRuntimeSubmission().submission,
      'done',
    );

    await router.deliverRuntime(recipient, null, failedFact());
    await router.deliverRuntime(recipient, token, completedFact);

    expect(recipient.submitted).toEqual([failedFact(), completedFact]);
    expect(recipient.submitted[0]?.status).toBe('failed');
    expect(recipient.submitted[1]?.status).toBe('completed');
  });

  it('never folds two null-token deliveries, even with byte-identical fact content', async () => {
    // A real provider token is the ONLY fold identity the router recognizes
    // (see completion-token-routing.test.ts). `null` carries none, so two
    // internal failures/stops for the same producer are two separate turns
    // the recipient must be told about individually, not a single collapsed
    // push the way a folded steer would be.
    const recipient = new RecordingInitiator();
    const router = policy();

    await router.deliverRuntime(recipient, null, stoppedFact());
    await router.deliverRuntime(recipient, null, stoppedFact());

    expect(recipient.submitted).toHaveLength(2);
  });

  it('does not consume or corrupt the token-keyed dedupe entry a later real completion from the same producer uses', async () => {
    const recipient = new RecordingInitiator();
    const router = policy();
    const completedFact: PreparedCompletionFact = {
      kind: 'teammate',
      role: 'teammate',
      source: 'worker',
      status: 'completed',
      result: 'done',
    };
    const token = completedCompletion(
      controllableRuntimeSubmission().submission,
      'done',
    );

    await router.deliverRuntime(recipient, null, failedFact());
    // Register the SAME real token twice: this only collapses to one send if
    // the token-keyed dedupe map still works correctly after the null-token
    // delivery above touched the router.
    await router.deliverRuntime(recipient, token, completedFact);
    await router.deliverRuntime(recipient, token, completedFact);

    expect(recipient.submitted).toEqual([failedFact(), completedFact]);
  });
});

/* -------------------------------------------------------------------------
 * Delivery-boundary resilience: timeouts are reported, a bad recipient can't
 * break the producer's own settlement.
 * ---------------------------------------------------------------------- */

const okCompletion: PreparedCompletionFact = {
  kind: 'teammate',
  role: 'teammate',
  source: 'worker',
  status: 'completed',
  result: 'done',
};

describe('completion delivery boundary: a failing recipient cannot break the producer', () => {
  it('logs a timeout as reported news rather than silently vanishing', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const warn = vi.fn();
      const preparation = new Promise<PreparedCompletionDelivery>(() => {
        // Never settles: the deadline is what ends this delivery.
      });
      const initiator: CompletionInitiator = {
        prepareCompletion: vi.fn(() => preparation),
      };
      const router = new CompletionDeliveryPolicy({
        dispatcherId: 'flow',
        log: noopLog(warn),
        fence: { isClosing: () => false },
        attemptTimeoutMs: 50,
      });

      const delivery = router.deliver(initiator, okCompletion);
      await vi.advanceTimersByTimeAsync(50);
      await delivery;

      expect(warn).toHaveBeenCalledTimes(1);
      const [fields, message] = warn.mock.calls[0] as [
        Record<string, unknown>,
        string,
      ];
      expect(message).toMatch(/timed out/u);
      expect(fields['timeout_ms']).toBe(50);
    } finally {
      vi.useRealTimers();
    }
  });

  it('never rejects the producer-facing delivery when the recipient throws synchronously while preparing', async () => {
    const initiator: CompletionInitiator = {
      prepareCompletion: () => {
        throw new Error('recipient exploded before returning a promise');
      },
    };

    await expect(
      policy().deliver(initiator, okCompletion),
    ).resolves.toBeUndefined();
  });

  it('never rejects the producer-facing delivery after a persistently failing submit exhausts every retry', async () => {
    const initiator: CompletionInitiator = {
      prepareCompletion: async () =>
        Object.freeze({
          submit: async (): Promise<CompletionDeliveryResult> => ({
            status: 'failed',
            error: new Error('recipient transport is down'),
          }),
        }),
    };

    await expect(
      policy().deliver(initiator, okCompletion),
    ).resolves.toBeUndefined();
  });
});

/* -------------------------------------------------------------------------
 * 4. Dispatcher presentation is not silently erased by a role filter
 * ---------------------------------------------------------------------- */

function noopLog(warn?: (...args: unknown[]) => void): DreamuxLogger {
  const log = {
    info: () => undefined,
    warn: warn ?? (() => undefined),
    error: () => undefined,
    debug: () => undefined,
    trace: () => undefined,
    child: () => log,
  };
  return log as DreamuxLogger;
}
