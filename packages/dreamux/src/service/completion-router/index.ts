import type {
  DreamuxLogger,
  RuntimeCompletion,
  TeammateRole,
} from '@excitedjs/dreamux-types';
import type { WorkAdmission } from '../../platform/work-fence.js';

import { errorInfo } from '@excitedjs/dreamux-utils';

interface CompletionFactBase {
  status: 'completed' | 'failed' | 'stopped';
  result: string | null;
}

export interface TeammateCompletionFact extends CompletionFactBase {
  kind: 'teammate';
  source: string;
  /** The producing Agent's runtime role, so delivery can word the notice accordingly. */
  role: TeammateRole;
}

export interface WorkflowCompletionFact extends CompletionFactBase {
  kind: 'workflow';
  source: 'workflow';
  runId: string;
}

export type PreparedCompletionFact =
  TeammateCompletionFact | WorkflowCompletionFact;

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

/** Query the actual current recipient at the operation's ownership boundary. */
export interface CompletionOwner {
  completionRecipient(): CompletionInitiator;
}

const MAX_DELIVERY_ATTEMPTS = 3;
const DEFAULT_COMPLETION_ATTEMPT_TIMEOUT_MS = 30_000;

type DeadlineResult<T> =
  | { status: 'fulfilled'; value: T }
  | { status: 'rejected'; error: Error }
  | { status: 'timed_out' };

/** Stateful completion-token router and transport delivery policy. */
export class CompletionDeliveryPolicy {
  private readonly attemptTimeoutMs: number;
  private readonly completions = new WeakMap<
    RuntimeCompletion,
    Promise<void>
  >();
  private readonly recipientTails = new WeakMap<object, Promise<void>>();

  constructor(
    private readonly deps: {
      dispatcherId: string;
      log: DreamuxLogger;
      /**
       * Whether the dispatcher scope still takes work.
       *
       * Read once per requested delivery, before it is queued. The dispatcher
       * publishes this fence when it stops, shuts down, or rolls back a failed
       * start; a request that arrives behind the fence is news for an owner
       * that is being torn down, and is dropped here rather than raced into a
       * recipient that will refuse or, worse, accept it into a runtime that
       * stops moments later.
       */
      fence: Pick<WorkAdmission, 'isClosing'>;
      /** Deterministic test seam for the internal delivery-operation bound. */
      attemptTimeoutMs?: number | undefined;
    },
  ) {
    this.attemptTimeoutMs =
      deps.attemptTimeoutMs ?? DEFAULT_COMPLETION_ATTEMPT_TIMEOUT_MS;
    if (!Number.isFinite(this.attemptTimeoutMs) || this.attemptTimeoutMs <= 0) {
      throw new Error('completion attempt timeout must be positive');
    }
  }

  /** Deliver a Core-owned fact that no provider settlement produced. */
  async deliver(
    initiator: CompletionInitiator,
    completion: PreparedCompletionFact,
  ): Promise<void> {
    await this.deliverRuntime(initiator, null, completion);
  }

  /**
   * Deliver one settled turn, folding on the provider token when there is one.
   *
   * A native completion is a value several paths can report; the token is its
   * identity, so the same settlement reaches a recipient once. Every submitter
   * carrying the same recipient reports to that actual owner, so folding on the
   * token alone — with no per-recipient nesting — is
   * enough: no code path produces two different recipients for the same
   * `RuntimeCompletion` object. A turn that failed or was stopped produced no
   * such value — there is nothing to fold, and a fabricated identity would
   * only make two distinct settlements look like one. Both forms queue on the
   * same per-recipient tail, so a recipient reads its news in the order the
   * turns settled.
   *
   * The scope fence is read here, before folding or queueing: a delivery that
   * was already queued when the fence went up is never retracted, and a token
   * already folded is not a way past it.
   */
  deliverRuntime(
    initiator: CompletionInitiator,
    token: RuntimeCompletion | null,
    completion: PreparedCompletionFact,
  ): Promise<void> {
    if (this.deps.fence.isClosing()) {
      this.deps.log.info(
        {
          dispatcher_id: this.deps.dispatcherId,
          source: completion.source,
          status: completion.status,
        },
        'dropping completion: dispatcher is not accepting work',
      );
      return Promise.resolve();
    }
    if (token === null) {
      return this.enqueue(initiator, completion);
    }
    const existing = this.completions.get(token);
    if (existing !== undefined) return existing;

    const delivery = this.enqueue(initiator, completion);
    this.completions.set(token, delivery);
    return delivery;
  }

  private enqueue(
    initiator: CompletionInitiator,
    completion: PreparedCompletionFact,
  ): Promise<void> {
    const previous = this.recipientTails.get(initiator) ?? Promise.resolve();
    const delivery = previous
      .catch(() => undefined)
      .then(() => this.deliverPrepared(initiator, completion));
    this.recipientTails.set(initiator, delivery);
    return delivery;
  }

  private async deliverPrepared(
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
    // Only a `failed` outcome loops back here (see the branches below): the
    // provider seam reserves `failed` for a proven pre-admission failure —
    // no native command was accepted — so a repeat costs nothing extra,
    // unlike `ambiguous`, `unsupported`, a timeout, or a throw, none of
    // which this loop retries.
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
