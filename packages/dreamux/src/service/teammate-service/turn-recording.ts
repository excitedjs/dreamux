import { randomUUID } from 'node:crypto';

import type {
  RuntimeAdmission,
  RuntimeCompletion,
  RuntimeSubmission,
} from '@excitedjs/dreamux-types';

import type { AgentEntitySubmissionResult } from '../agent-entity/types.js';
import type {
  CompletionDeliveryResult,
  PreparedCompletionFact,
} from '../completion-router/index.js';

export type TurnOutcome =
  | { status: 'completed'; resultText: string | null; truncated: boolean }
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

export type TurnAdmission =
  | { status: 'submitted'; turn: Turn }
  | { status: 'duplicate' | 'stopped' | 'skipped' }
  | { status: 'failed' | 'ambiguous'; error: Error };

/**
 * What an inbound delivery reports back to whoever handed Core the message.
 *
 * It is a projection of {@link TurnAdmission}, not a second authority: the
 * admission decides, this states the decision. It stays inside Core because
 * inbound turns no longer cross the provider seam — a Channel hands Core a
 * message and reads the answer through the Command port.
 */
export type InboundDeliveryResult =
  | { status: 'duplicate' }
  | { status: 'stopped' }
  | { status: 'submitted' }
  | { status: 'failed'; error: Error }
  | { status: 'ambiguous'; error: Error };

/**
 * State an admission's decision in the shape an inbound caller reads.
 *
 * One converter, next to both types, because there is only one mapping: a
 * second copy beside a consumer would be a second place for `skipped` to stop
 * meaning `stopped`.
 */
export function asInboundDeliveryResult(
  result: TurnAdmission,
): InboundDeliveryResult {
  switch (result.status) {
    case 'submitted':
      return { status: 'submitted' };
    case 'duplicate':
      return { status: 'duplicate' };
    case 'stopped':
      return { status: 'stopped' };
    case 'failed':
      return { status: 'failed', error: result.error };
    case 'ambiguous':
      return { status: 'ambiguous', error: result.error };
    case 'skipped':
      return { status: 'stopped' };
  }
}

export class EntityTurn implements Turn {
  readonly id = randomUUID();
  readonly settled: Promise<TurnOutcome>;

  private selectedOutcome: TurnOutcome | null = null;
  private selectedCompletion: RuntimeCompletion | null = null;
  private deliveryTask: Promise<void> | null = null;

  constructor(
    readonly runtime: RuntimeSubmission,
    private readonly producerName: string,
    private readonly deliveryClosure: TurnCompletionDelivery | null,
  ) {
    this.settled = runtime.settled.then((settlement): TurnOutcome => {
      if (settlement.kind === 'completion') {
        this.selectedCompletion = settlement.completion;
        return this.settle(
          settlement.completion.status === 'completed'
            ? {
                status: 'completed',
                resultText: settlement.completion.resultText,
                truncated: settlement.completion.truncated,
              }
            : { status: 'failed', error: settlement.completion.error },
        );
      }
      return this.settle(
        settlement.kind === 'failed'
          ? { status: 'failed', error: settlement.error }
          : { status: 'stopped' },
      );
    }, (error: unknown): TurnOutcome =>
      this.settle({ status: 'failed', error: asError(error) }));
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
   * Every settled turn is reported, whatever ended it.
   *
   * The waiting Agent asked for the work, not for a native result: a turn that
   * failed or was stopped is exactly the news it cannot infer on its own, so it
   * is delivered from the outcome this turn already selected. Only a provider
   * completion carries a token, and that token is passed through solely as the
   * settlement's identity for folding.
   */
  private startDeliveryIfReady(): void {
    if (
      this.deliveryTask !== null ||
      this.deliveryClosure === null ||
      this.selectedOutcome === null
    ) {
      return;
    }
    const outcome = this.selectedOutcome;
    const completion = this.selectedCompletion;
    const fact: PreparedCompletionFact = {
      kind: 'teammate',
      source: this.producerName,
      status: outcome.status,
      result: outcome.status === 'completed' ? outcome.resultText : null,
    };
    this.deliveryTask = Promise.resolve().then(() =>
      this.deliveryClosure!(completion, fact));
    void this.deliveryTask.catch(() => undefined);
  }
}

export function toSubmissionResult(
  admission: TurnAdmission,
): AgentEntitySubmissionResult {
  switch (admission.status) {
    case 'submitted':
      return { status: 'submitted' };
    case 'duplicate':
    case 'stopped':
      return { status: admission.status };
    case 'failed':
      return { status: 'failed', error: admission.error.message };
    case 'ambiguous':
      return { status: 'ambiguous', error: admission.error.message };
    case 'skipped':
      return { status: 'stopped', error: 'turn skipped' };
  }
}

/**
 * State an admission's decision in the shape a completion push-back reads.
 *
 * Beside {@link asInboundDeliveryResult} for the same reason it exists: the
 * admission decides, and every caller-facing shape is one stated mapping of
 * that decision rather than a second authority that could drift from it.
 */
export function asCompletionDeliveryResult(
  result: TurnAdmission,
): CompletionDeliveryResult {
  switch (result.status) {
    case 'submitted':
    case 'duplicate':
      return { status: 'accepted' };
    case 'stopped':
      return { status: 'unsupported', reason: 'runtime stopped' };
    case 'failed':
      return { status: 'failed', error: result.error };
    case 'ambiguous':
      return { status: 'ambiguous', error: result.error };
    case 'skipped':
      return { status: 'failed', error: new Error('completion delivery unexpectedly skipped') };
  }
}

/**
 * Why an admission that produced no turn fails the display surface its input
 * opened; `null` when a turn exists and the runtime will end it.
 *
 * Only a `submitted` admission produces a turn, and only a live turn's runtime
 * ever reports a native end — so every other outcome would leave that surface
 * open forever. All four are the same verdict, `failed`: nothing answered the
 * input. Only the reason differs, so only the reason is returned. The third
 * stated mapping of the one decision, for the same reason as the other two.
 */
export function failedAdmissionReason(result: TurnAdmission): string | null {
  switch (result.status) {
    case 'submitted':
    case 'duplicate':
      return null;
    case 'stopped':
      return 'the agent runtime is not running';
    case 'skipped':
      return 'the agent runtime skipped this input';
    case 'failed':
    case 'ambiguous':
      return result.error.message;
  }
}

export function admissionWithoutTurn(
  admission: Exclude<RuntimeAdmission, { status: 'submitted' }>,
): TurnAdmission {
  return admission;
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
