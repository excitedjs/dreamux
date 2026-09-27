import { randomUUID } from 'node:crypto';

import type {
  RuntimeAdmission,
  RuntimeCompletion,
  RuntimeSubmission,
  TeammateRole,
} from '@excitedjs/dreamux-types';

import type { PreparedCompletionFact } from '../completion-router/index.js';
import type { AgentEntityIdentity } from './identity.js';

interface EntityTurnCoordinatorOptions {
  identity: () => AgentEntityIdentity;
  /** This entity's runtime role, fixed for its whole lifetime. */
  role: TeammateRole;
  isActive: () => boolean;
  /**
   * Whether a turn that settles now is news the entity still owes its owner.
   * False while the entity is closing or being released by its host: the
   * party that ended the turn is the one that would read the report.
   */
  owesCompletion: () => boolean;
}

type ObservedRuntimeAdmission =
  | { status: 'fulfilled'; admission: RuntimeAdmission }
  | { status: 'rejected'; error: Error };

/**
 * Entity-owned serialization for provider admission.
 *
 * It holds the push-back line and nothing else: which submissions this entity
 * has outstanding, in what order their admissions are attached, and who is
 * waiting for each one's result. Display is not here — a live surface is keyed
 * on the Agent, not on a submission, so it never needed this class's
 * bookkeeping to find its subject.
 */
export class EntityTurnCoordinator {
  private admissionContinuationTail: Promise<void> = Promise.resolve();
  private readonly retainedTurns = new Set<EntityTurn>();

  constructor(private readonly opts: EntityTurnCoordinatorOptions) {}

  hasUnsettledCurrent(): boolean {
    return [...this.retainedTurns].some((turn) => !turn.isSettled());
  }

  submitRuntimeTurn(
    operation: () => Promise<RuntimeAdmission>,
    deliverCompletion: TurnCompletionDelivery | null,
  ): Promise<TurnAdmission> {
    if (!this.opts.isActive()) return Promise.resolve({ status: 'stopped' });
    let admission: Promise<RuntimeAdmission>;
    try {
      admission = operation();
    } catch (error) {
      return Promise.resolve({ status: 'ambiguous', error: asError(error) });
    }
    const observed = observeRuntimeAdmission(admission);
    return this.enqueueAdmissionContinuation(async () => {
      const result = await observed;
      if (result.status === 'rejected') {
        return { status: 'ambiguous', error: result.error };
      }
      if (result.admission.status !== 'submitted') {
        return result.admission;
      }
      const turn = this.attachSubmission(
        result.admission.submission,
        deliverCompletion,
      );
      return { status: 'submitted', turn };
    });
  }

  /**
   * Wait for every admission continuation this entity has accepted.
   *
   * Admissions run strictly in order, so the tail is the whole queue: awaiting
   * it awaits everything enqueued before it, and the loop covers work enqueued
   * while draining.
   */
  async drainAdmissions(): Promise<void> {
    let tail: Promise<void>;
    do {
      tail = this.admissionContinuationTail;
      await tail;
    } while (this.admissionContinuationTail !== tail);
  }

  /**
   * Prove every retained turn settled, then wait for whatever each one still
   * delivers. Whether a turn delivers at all is the turn's own decision, made
   * from `owesCompletion` when it settled.
   */
  async convergeRetainedTurns(): Promise<void> {
    await Promise.resolve();
    const unsettled = [...this.retainedTurns].filter(
      (turn) => !turn.isSettled(),
    );
    if (unsettled.length > 0) {
      throw new Error(
        `runtime stop returned with ${unsettled.length} unsettled submission(s) for ` +
          `${this.opts.identity().name}: ${unsettled.map((turn) => turn.id).join(', ')}`,
      );
    }
    for (const turn of [...this.retainedTurns]) await turn.ensureDelivery();
  }

  private enqueueAdmissionContinuation<T>(task: () => Promise<T>): Promise<T> {
    const continuation = this.admissionContinuationTail.then(task, task);
    this.admissionContinuationTail = continuation.then(
      () => undefined,
      () => undefined,
    );
    return continuation;
  }

  private attachSubmission(
    submission: RuntimeSubmission,
    deliverCompletion: TurnCompletionDelivery | null,
  ): EntityTurn {
    const turn = new EntityTurn(
      submission,
      this.opts.identity().name,
      this.opts.role,
      deliverCompletion,
      this.opts.owesCompletion,
    );
    this.retainedTurns.add(turn);
    void turn
      .ensureDelivery()
      .finally(() => {
        this.retainedTurns.delete(turn);
      })
      .catch(() => undefined);
    return turn;
  }
}

function observeRuntimeAdmission(
  admission: Promise<RuntimeAdmission>,
): Promise<ObservedRuntimeAdmission> {
  return admission.then(
    (value) => ({ status: 'fulfilled', admission: value }),
    (error: unknown) => ({ status: 'rejected', error: asError(error) }),
  );
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

export type TurnOutcome =
  | { status: 'completed'; resultText: string | null }
  | { status: 'failed'; error: Error }
  | { status: 'stopped' };

/**
 * Report one settled turn to whoever is waiting for it.
 *
 * The fact is what the recipient reads. The provider token is only the identity
 * of the settlement that produced it, used to fold the same completion reported
 * through several paths into one delivery; a turn that ended without a native
 * result has no such identity and passes `null` rather than a fabricated one.
 */
export type TurnCompletionDelivery = (
  completion: RuntimeCompletion | null,
  fact: PreparedCompletionFact,
) => Promise<void>;

/**
 * One submission this entity is waiting on.
 *
 * It carries only what the push-back line needs. Provenance, source id, body,
 * intent, and submission time used to live here for the display projection;
 * display is keyed on the Agent now and reads none of them.
 */
export interface Turn {
  readonly id: string;
  readonly runtime: RuntimeSubmission;
  readonly settled: Promise<TurnOutcome>;
  readonly delivery: Promise<void>;
}

/**
 * The outcome of trying to get a {@link Turn}: either one, or a reason there
 * isn't one. `submitRuntimeTurn` is what produces every value of this type.
 *
 * Declared here rather than in `admission.ts`: that file's own
 * `AdmissionLedger` and result-mapping helpers (`toSubmissionResult`,
 * `failedAdmissionReason`, `asCompletionDeliveryResult`) operate on
 * `TurnAdmission` values without producing them, so the type belongs with its
 * producer.
 */
export type TurnAdmission =
  | { status: 'submitted'; turn: Turn }
  | { status: 'duplicate' | 'stopped' | 'skipped' }
  | { status: 'failed' | 'ambiguous'; error: Error };

export class EntityTurn implements Turn {
  readonly id = randomUUID();
  readonly settled: Promise<TurnOutcome>;

  private selectedOutcome: TurnOutcome | null = null;
  private selectedCompletion: RuntimeCompletion | null = null;
  private deliveryTask: Promise<void> | null = null;

  constructor(
    readonly runtime: RuntimeSubmission,
    private readonly producerName: string,
    private readonly producerRole: TeammateRole,
    private deliveryClosure: TurnCompletionDelivery | null,
    /**
     * Whether the entity still owes its owner this turn's news, read once, at
     * the moment delivery would start.
     */
    private readonly owed: () => boolean,
  ) {
    this.settled = runtime.settled.then(
      (settlement): TurnOutcome => {
        if (settlement.kind === 'completion') {
          this.selectedCompletion = settlement.completion;
          return this.settle(
            settlement.completion.status === 'completed'
              ? {
                  status: 'completed',
                  resultText: settlement.completion.resultText,
                }
              : { status: 'failed', error: settlement.completion.error },
          );
        }
        return this.settle(
          settlement.kind === 'failed'
            ? { status: 'failed', error: settlement.error }
            : { status: 'stopped' },
        );
      },
      (error: unknown): TurnOutcome =>
        this.settle({ status: 'failed', error: asError(error) }),
    );
  }

  get delivery(): Promise<void> {
    return this.ensureDelivery();
  }

  isSettled(): boolean {
    return this.selectedOutcome !== null;
  }

  async ensureDelivery(): Promise<void> {
    await this.settled;
    this.startDeliveryIfReady();
    await (this.deliveryTask ?? Promise.resolve());
  }

  /** Record the one outcome this turn ever has, then report it. */
  private settle(outcome: TurnOutcome): TurnOutcome {
    this.selectedOutcome = outcome;
    this.startDeliveryIfReady();
    return outcome;
  }

  /**
   * A settled turn is reported while the entity still owes its owner news.
   *
   * The waiting Agent asked for the work, not for a native result: a turn that
   * failed or was stopped on its own is exactly the news it cannot infer, so it
   * is delivered from the outcome this turn already selected. Only a provider
   * completion carries a token, and that token is passed through solely as the
   * settlement's identity for folding.
   *
   * A turn the entity's own close or host release ended is different news:
   * the party that ended it is the one that would read the report. The
   * entity says so through {@link owed}, read once here; a negative answer
   * releases the closure for good, so a later `ensureDelivery()` cannot revive
   * the report, while a delivery that already started is never retracted.
   */
  private startDeliveryIfReady(): void {
    if (
      this.deliveryTask !== null ||
      this.deliveryClosure === null ||
      this.selectedOutcome === null
    ) {
      return;
    }
    if (!this.owed()) {
      this.deliveryClosure = null;
      return;
    }
    const outcome = this.selectedOutcome;
    const completion = this.selectedCompletion;
    const fact: PreparedCompletionFact = {
      kind: 'teammate',
      source: this.producerName,
      role: this.producerRole,
      status: outcome.status,
      result: outcome.status === 'completed' ? outcome.resultText : null,
    };
    this.deliveryTask = Promise.resolve().then(() =>
      this.deliveryClosure!(completion, fact),
    );
    void this.deliveryTask.catch(() => undefined);
  }
}
