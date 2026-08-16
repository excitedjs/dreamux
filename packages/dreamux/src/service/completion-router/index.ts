import type { DreamuxLogger } from '@excitedjs/dreamux-types';

import { errorInfo } from '../../platform/error-info.js';

interface CompletionFactBase {
  status: 'completed' | 'failed' | 'stopped';
  result: string | null;
}

export interface TeammateCompletionFact extends CompletionFactBase {
  kind: 'teammate';
  source: string;
}

export interface WorkflowCompletionFact extends CompletionFactBase {
  kind: 'workflow';
  source: 'workflow';
  runId: string;
}

export type PreparedCompletionFact =
  | TeammateCompletionFact
  | WorkflowCompletionFact;

export type CompletionDeliveryResult =
  | { status: 'accepted' }
  | { status: 'unsupported'; reason: string }
  | { status: 'failed'; error: Error }
  | { status: 'ambiguous'; error: Error };

export interface PreparedCompletionDelivery {
  submit(): Promise<CompletionDeliveryResult>;
}

export interface CompletionInitiator {
  prepareCompletion(
    completion: PreparedCompletionFact,
  ): Promise<PreparedCompletionDelivery>;
}

const MAX_DELIVERY_ATTEMPTS = 3;
const DEFAULT_COMPLETION_ATTEMPT_TIMEOUT_MS = 30_000;

type DeadlineResult<T> =
  | { status: 'fulfilled'; value: T }
  | { status: 'rejected'; error: Error }
  | { status: 'timed_out' };

/** Stateless, at-most-once completion delivery policy. */
export class CompletionDeliveryPolicy {
  private readonly attemptTimeoutMs: number;

  constructor(
    private readonly deps: {
      dispatcherId: string;
      log: DreamuxLogger;
      /** Deterministic test seam for the internal delivery-operation bound. */
      attemptTimeoutMs?: number;
    },
  ) {
    this.attemptTimeoutMs =
      deps.attemptTimeoutMs ?? DEFAULT_COMPLETION_ATTEMPT_TIMEOUT_MS;
    if (!Number.isFinite(this.attemptTimeoutMs) || this.attemptTimeoutMs <= 0) {
      throw new Error('completion attempt timeout must be positive');
    }
  }

  async deliver(
    initiator: CompletionInitiator,
    completion: PreparedCompletionFact,
  ): Promise<void> {
    const preparation = await settleWithinDeadline(
      () => initiator.prepareCompletion(completion),
      this.attemptTimeoutMs,
    );
    if (preparation.status === 'timed_out') {
      this.deps.log.warn(
        {
          dispatcher_id: this.deps.dispatcherId,
          source: completion.source,
          timeout_ms: this.attemptTimeoutMs,
        },
        'completion preparation timed out; dropping as ambiguous',
      );
      return;
    }
    if (preparation.status === 'rejected') {
      this.deps.log.warn(
        {
          dispatcher_id: this.deps.dispatcherId,
          source: completion.source,
          err: errorInfo(preparation.error),
        },
        'completion preparation failed; dropping',
      );
      return;
    }
    const prepared = preparation.value;
    for (let attempt = 1; attempt <= MAX_DELIVERY_ATTEMPTS; attempt += 1) {
      const submission = await settleWithinDeadline(
        () => prepared.submit(),
        this.attemptTimeoutMs,
      );
      if (submission.status === 'timed_out') {
        this.deps.log.warn(
          {
            dispatcher_id: this.deps.dispatcherId,
            source: completion.source,
            attempt,
            timeout_ms: this.attemptTimeoutMs,
          },
          'completion delivery timed out; dropping as ambiguous',
        );
        return;
      }
      if (submission.status === 'rejected') {
        this.deps.log.warn(
          {
            dispatcher_id: this.deps.dispatcherId,
            source: completion.source,
            err: errorInfo(submission.error),
          },
          'completion delivery threw; dropping without ambiguous retry',
        );
        return;
      }
      const outcome = submission.value;
      if (outcome.status === 'accepted') return;
      if (outcome.status === 'unsupported') {
        this.deps.log.warn(
          {
            dispatcher_id: this.deps.dispatcherId,
            source: completion.source,
            reason: outcome.reason,
          },
          'dropping completion: delivery unsupported',
        );
        return;
      }
      if (outcome.status === 'ambiguous') {
        this.deps.log.warn(
          {
            dispatcher_id: this.deps.dispatcherId,
            source: completion.source,
            err: errorInfo(outcome.error),
          },
          'completion admission was ambiguous; dropping without retry',
        );
        return;
      }
      this.deps.log.warn(
        {
          dispatcher_id: this.deps.dispatcherId,
          source: completion.source,
          attempt,
          max_attempts: MAX_DELIVERY_ATTEMPTS,
          err: errorInfo(outcome.error),
        },
        'completion delivery failed before admission',
      );
    }
    this.deps.log.warn(
      {
        dispatcher_id: this.deps.dispatcherId,
        source: completion.source,
        max_attempts: MAX_DELIVERY_ATTEMPTS,
      },
      'completion delivery exhausted retries; dropping',
    );
  }
}

async function settleWithinDeadline<T>(
  operation: () => Promise<T>,
  timeoutMs: number,
): Promise<DeadlineResult<T>> {
  let operationPromise: Promise<T>;
  try {
    operationPromise = operation();
  } catch (error) {
    return { status: 'rejected', error: asError(error) };
  }
  // Attach both handlers before racing. A timed-out operation may reject much
  // later, but it can never surface as an unhandled rejection or trigger retry.
  const observed: Promise<DeadlineResult<T>> = operationPromise.then(
    (value) => ({ status: 'fulfilled', value }),
    (error: unknown) => ({ status: 'rejected', error: asError(error) }),
  );
  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeout = new Promise<DeadlineResult<T>>((resolve) => {
    timer = setTimeout(() => resolve({ status: 'timed_out' }), timeoutMs);
  });
  try {
    return await Promise.race([observed, timeout]);
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
