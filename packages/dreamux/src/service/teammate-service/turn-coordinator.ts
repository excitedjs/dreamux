import type { RuntimeAdmission, RuntimeSubmission } from '@excitedjs/dreamux-types';

import type { AgentEntityIdentity } from '../agent-entity/types.js';
import {
  admissionWithoutTurn,
  EntityTurn,
  type TurnAdmission,
  type TurnCompletionDelivery,
} from './turn-recording.js';

interface EntityTurnCoordinatorOptions {
  identity: () => AgentEntityIdentity;
  isActive: () => boolean;
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
        return admissionWithoutTurn(result.admission);
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

  async settleAndDeliverRetained(): Promise<void> {
    await Promise.resolve();
    const unsettled = [...this.retainedTurns].filter((turn) => !turn.isSettled());
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
      deliverCompletion,
    );
    this.retainedTurns.add(turn);
    void turn.ensureDelivery().finally(() => {
      this.retainedTurns.delete(turn);
    }).catch(() => undefined);
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
