import type {
  RuntimeActivitySink,
  RuntimeAdmission,
  RuntimeSubmission,
} from '@excitedjs/dreamux-types';

import type { AgentEntityTurnOrigin } from '../agent-entity/types.js';
import type { CompletionDeliveryResult } from '../completion-router/index.js';
import {
  admissionWithoutTurn,
  EntityTurn,
  type TurnAdmission,
  type TurnCompletionDelivery,
} from './turn-recording.js';

interface EntityTurnCoordinatorOptions {
  name: () => string;
  intent: () => string | null;
  isActive: () => boolean;
}

export interface EntityTurnInput {
  turnOrigin: AgentEntityTurnOrigin | null;
  prompt: string;
  deliverCompletion?: TurnCompletionDelivery;
}

interface CapturedEntityTurnInput extends EntityTurnInput {
  intent: string | null;
  submittedAt: number;
}

type ObservedRuntimeAdmission =
  | { status: 'fulfilled'; admission: RuntimeAdmission }
  | { status: 'rejected'; error: Error };

/** Entity-owned serialization for provider admission and in-process display work. */
export class EntityTurnCoordinator {
  private readonly pendingAdmissions = new Set<Promise<unknown>>();
  private admissionContinuationTail: Promise<void> = Promise.resolve();
  private readonly retainedTurns = new Set<EntityTurn>();

  constructor(private readonly opts: EntityTurnCoordinatorOptions) {}

  readonly activitySink: RuntimeActivitySink = () => {};

  hasUnsettledCurrent(): boolean {
    return [...this.retainedTurns].some((turn) => !turn.isSettled());
  }

  submitRuntimeTurn(
    operation: () => Promise<RuntimeAdmission>,
    input: EntityTurnInput,
  ): Promise<TurnAdmission> {
    if (!this.opts.isActive()) return Promise.resolve({ status: 'stopped' });
    return this.submitObserved(operation, input);
  }

  submitCompletion(
    operation: () => Promise<RuntimeAdmission>,
    input: EntityTurnInput,
  ): Promise<CompletionDeliveryResult> {
    if (!this.opts.isActive()) {
      return Promise.resolve({ status: 'unsupported', reason: 'runtime stopped' });
    }
    return this.submitObserved(operation, input).then(
      turnAdmissionToCompletionDelivery,
    );
  }

  async drainAdmissions(): Promise<void> {
    while (this.pendingAdmissions.size > 0) {
      await Promise.allSettled([...this.pendingAdmissions]);
    }
  }

  async settleAndDeliverRetained(): Promise<void> {
    await Promise.resolve();
    const unsettled = [...this.retainedTurns].filter((turn) => !turn.isSettled());
    if (unsettled.length > 0) {
      throw new Error(
        `runtime stop returned with ${unsettled.length} unsettled submission(s) for ` +
        `${this.opts.name()}: ${unsettled.map((turn) => turn.id).join(', ')}`,
      );
    }
    for (const turn of [...this.retainedTurns]) await turn.ensureDelivery();
  }

  private submitObserved(
    operation: () => Promise<RuntimeAdmission>,
    input: EntityTurnInput,
  ): Promise<TurnAdmission> {
    const captured = this.capture(input);
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
      const turn = this.attachSubmission(result.admission.submission, captured);
      return { status: 'submitted', turn };
    });
  }

  private enqueueAdmissionContinuation<T>(task: () => Promise<T>): Promise<T> {
    const continuation = this.admissionContinuationTail.then(task, task);
    this.admissionContinuationTail = continuation.then(
      () => undefined,
      () => undefined,
    );
    this.pendingAdmissions.add(continuation);
    void continuation.finally(() => {
      this.pendingAdmissions.delete(continuation);
    }).catch(() => undefined);
    return continuation;
  }

  private attachSubmission(
    submission: RuntimeSubmission,
    input: CapturedEntityTurnInput,
  ): EntityTurn {
    const turn = new EntityTurn(
      submission,
      input.turnOrigin,
      input.prompt,
      input.intent,
      input.submittedAt,
      this.opts.name(),
      input.deliverCompletion ?? null,
    );
    this.retainedTurns.add(turn);
    void turn.ensureDelivery().finally(() => {
      this.retainedTurns.delete(turn);
    }).catch(() => undefined);
    return turn;
  }

  private capture(input: EntityTurnInput): CapturedEntityTurnInput {
    return { ...input, intent: this.opts.intent(), submittedAt: Date.now() };
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

function turnAdmissionToCompletionDelivery(
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

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
