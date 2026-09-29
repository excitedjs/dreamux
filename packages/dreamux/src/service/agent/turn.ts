import { randomUUID } from 'node:crypto';

import type {
  RuntimeCompletion,
  RuntimeSubmission,
  TeammateRole,
} from '@excitedjs/dreamux-types';

import type { PreparedCompletionFact } from '../completion-router/index.js';

export function asError(error: unknown): Error {
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
 * It carries only what the push-back line needs: its id and its eventual
 * outcome. Provenance, source id, body, intent, and submission time used to
 * live here for the display projection; display is keyed on the Agent now
 * and reads none of them. The native `RuntimeSubmission` and the delivery
 * promise are `EntityTurn`'s own bookkeeping — no reader outside this file
 * needs either, so neither is part of this contract.
 */
export interface Turn {
  readonly id: string;
  readonly settled: Promise<TurnOutcome>;
}

/**
 * The outcome of trying to get a {@link Turn}: either one, or a reason there
 * isn't one. `AgentService.submitRuntimeTurn` is what produces every value of
 * this type.
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
    runtime: RuntimeSubmission,
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
