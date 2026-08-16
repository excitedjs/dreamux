import type {
  RuntimeAdmission,
  RuntimeTurn,
} from '@excitedjs/dreamux-types';

import type { AgentRuntimeStateStore } from '../agent-entity/runtime-state.js';
import type { AgentTurnsStore } from '../agent-entity/turns-store.js';
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
  onAutomaticPersistenceFailure: (error: Error) => void;
  turnsStore: AgentTurnsStore;
  state: AgentRuntimeStateStore;
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

/** Entity-owned serialization for provider admission and durable Turn work. */
export class EntityTurnCoordinator {
  private readonly pendingAdmissions = new Set<Promise<unknown>>();
  private admissionContinuationTail: Promise<void> = Promise.resolve();
  private currentTurn: EntityTurn | null = null;
  private readonly retainedTurns = new Set<EntityTurn>();
  private turnPersistenceTail: Promise<void> = Promise.resolve();

  constructor(private readonly opts: EntityTurnCoordinatorOptions) {}

  hasUnpersistedCurrent(): boolean {
    return this.currentTurn !== null && !this.currentTurn.isPersisted();
  }

  submitRuntimeTurn(
    operation: () => Promise<RuntimeAdmission>,
    input: EntityTurnInput,
  ): Promise<TurnAdmission> {
    if (!this.opts.isActive()) {
      return Promise.resolve({ status: 'stopped' });
    }
    const captured = this.capture(input);
    let admission: Promise<RuntimeAdmission>;
    try {
      admission = operation();
    } catch (error) {
      return Promise.resolve({
        status: 'ambiguous',
        error: asError(error),
      });
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
      const turn = this.attachRuntimeTurn(result.admission.turn, captured);
      if (!this.opts.isActive()) turn.trySettle({ status: 'stopped' });
      return { status: 'submitted', turn };
    });
  }

  submitCompletion(
    operation: () => Promise<RuntimeAdmission>,
    input: EntityTurnInput,
  ): Promise<CompletionDeliveryResult> {
    if (!this.opts.isActive()) {
      return Promise.resolve({
        status: 'unsupported',
        reason: 'runtime stopped',
      });
    }
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
        return turnAdmissionToCompletionDelivery(
          admissionWithoutTurn(result.admission),
        );
      }
      const turn = this.attachRuntimeTurn(result.admission.turn, captured);
      if (!this.opts.isActive()) turn.trySettle({ status: 'stopped' });
      return { status: 'accepted' };
    });
  }

  selectStoppedForCurrent(): void {
    this.currentTurn?.trySettle({ status: 'stopped' });
  }

  async drainAdmissions(): Promise<void> {
    while (this.pendingAdmissions.size > 0) {
      await Promise.allSettled([...this.pendingAdmissions]);
    }
  }

  async persistAndDeliverRetained(): Promise<void> {
    const turns = [...this.retainedTurns];
    for (const turn of turns) {
      if (!turn.isOutcomeSelected()) turn.trySettle({ status: 'stopped' });
      await turn.ensurePersisted();
    }
    for (const turn of turns) await turn.ensureDelivery();
  }

  private enqueueAdmissionContinuation<T>(
    task: () => Promise<T>,
  ): Promise<T> {
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

  private attachRuntimeTurn(
    runtimeTurn: RuntimeTurn,
    input: CapturedEntityTurnInput,
  ): EntityTurn {
    const current = this.currentTurn;
    if (current !== null && current.runtime === runtimeTurn) {
      current.attachDelivery(input.deliverCompletion ?? null);
      return current;
    }
    if (current !== null) {
      void current.ensureDelivery().then(
        () => this.retainedTurns.delete(current),
        () => undefined,
      );
    }
    const turn = new EntityTurn(
      runtimeTurn,
      input.turnOrigin,
      input.prompt,
      input.intent,
      input.submittedAt,
      this.opts.name(),
      this.opts.turnsStore,
      this.opts.state,
      input.deliverCompletion ?? null,
      this.opts.onAutomaticPersistenceFailure,
      this.turnPersistenceTail,
    );
    this.currentTurn = turn;
    this.retainedTurns.add(turn);
    this.turnPersistenceTail = turn.persistence;
    return turn;
  }

  private capture(input: EntityTurnInput): CapturedEntityTurnInput {
    return {
      ...input,
      intent: this.opts.intent(),
      submittedAt: Date.now(),
    };
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
      return {
        status: 'failed',
        error: new Error('completion delivery unexpectedly skipped'),
      };
  }
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
