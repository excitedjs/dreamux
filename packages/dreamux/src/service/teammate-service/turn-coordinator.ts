import type {
  DreamuxLogger,
  RuntimeActivityEvent,
  RuntimeAdmission,
  RuntimeSubmission,
} from '@excitedjs/dreamux-types';

import type { ConversationProjection } from '../../channel/conversation-projection.js';
import { errorInfo } from '../../platform/error-info.js';
import type { AgentEntityIdentity, AgentEntityTurnOrigin } from '../agent-entity/types.js';
import type { CompletionDeliveryResult } from '../completion-router/index.js';
import {
  admissionWithoutTurn,
  EntityTurn,
  type TurnAdmission,
  type TurnCompletionDelivery,
} from './turn-recording.js';

interface EntityTurnCoordinatorOptions {
  identity: () => AgentEntityIdentity;
  intent: () => string | null;
  isActive: () => boolean;
  conversationProjection?: ConversationProjection;
  log: DreamuxLogger;
}

export const EARLY_ACTIVITY_EVENTS_MAX = 512;

export interface EntityTurnInput {
  turnOrigin: AgentEntityTurnOrigin | null;
  prompt: string;
  deliverCompletion?: TurnCompletionDelivery;
}

interface CapturedEntityTurnInput extends EntityTurnInput {
  intent: string | null;
  sourceName: string;
  submittedAt: number;
}

type ObservedRuntimeAdmission =
  | { status: 'fulfilled'; admission: RuntimeAdmission }
  | { status: 'rejected'; error: Error };

interface EarlyActivityBuffer {
  readonly events: RuntimeActivityEvent[];
  warned: boolean;
}

type ConversationProjectionEntryPoint =
  | 'submitted'
  | 'early_activity'
  | 'live_activity'
  | 'settled';

/** Entity-owned serialization for provider admission and in-process display work. */
export class EntityTurnCoordinator {
  private readonly pendingAdmissions = new Set<Promise<unknown>>();
  private admissionContinuationTail: Promise<void> = Promise.resolve();
  private readonly retainedTurns = new Set<EntityTurn>();
  private readonly turnsBySubmission = new WeakMap<RuntimeSubmission, EntityTurn>();
  private readonly earlyActivity =
    new WeakMap<RuntimeSubmission, EarlyActivityBuffer>();

  constructor(private readonly opts: EntityTurnCoordinatorOptions) {}

  readonly activitySink = (event: RuntimeActivityEvent): void => {
    if (this.opts.conversationProjection === undefined) return;
    const turn = this.turnsBySubmission.get(event.submission);
    if (turn === undefined) {
      let buffered = this.earlyActivity.get(event.submission);
      if (buffered === undefined) {
        buffered = { events: [], warned: false };
        this.earlyActivity.set(event.submission, buffered);
      }
      if (buffered.events.length >= EARLY_ACTIVITY_EVENTS_MAX) {
        if (!buffered.warned) {
          buffered.warned = true;
          this.warnEarlyActivityFull();
        }
        return;
      }
      buffered.events.push(event);
      return;
    }
    if (turn.isSettled()) return;
    this.projectDisplay(turn, 'live_activity', (projection, identity) => {
      projection.projectActivity(identity, turn, event);
    });
  };

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
        `${this.opts.identity().name}: ${unsettled.map((turn) => turn.id).join(', ')}`,
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
      input.sourceName,
      input.deliverCompletion ?? null,
    );
    this.turnsBySubmission.set(submission, turn);
    this.retainedTurns.add(turn);
    void turn.settled.then((settlement) => {
      this.projectDisplay(turn, 'settled', (projection, identity) => {
        projection.projectSettled({ identity, turn, settlement });
      });
    }).catch(() => undefined);
    void turn.ensureDelivery().finally(() => {
      this.retainedTurns.delete(turn);
    }).catch(() => undefined);
    const earlyActivity = this.earlyActivity.get(submission)?.events ?? [];
    this.earlyActivity.delete(submission);
    this.projectDisplay(turn, 'submitted', (projection, identity) => {
      projection.projectSubmitted(identity, turn);
    });
    for (const event of earlyActivity) {
      this.projectDisplay(turn, 'early_activity', (projection, identity) => {
        projection.projectActivity(identity, turn, event);
      });
    }
    return turn;
  }

  private projectDisplay(
    turn: EntityTurn,
    entryPoint: ConversationProjectionEntryPoint,
    operation: (
      projection: ConversationProjection,
      identity: AgentEntityIdentity,
    ) => void,
  ): void {
    const projection = this.opts.conversationProjection;
    if (projection === undefined) return;
    let identity: AgentEntityIdentity | undefined;
    try {
      identity = this.opts.identity();
      operation(projection, identity);
    } catch (error) {
      this.warnProjectionFailure(identity, turn, entryPoint, error);
    }
  }

  private warnProjectionFailure(
    identity: AgentEntityIdentity | undefined,
    turn: EntityTurn,
    entryPoint: ConversationProjectionEntryPoint,
    error: unknown,
  ): void {
    try {
      this.opts.log.warn(
        {
          ...(identity === undefined
            ? {}
            : {
                dispatcher_id: identity.dispatcher_id,
                agent_name: identity.name,
                role: identity.role,
              }),
          turn_id: turn.id,
          entry_point: entryPoint,
          err: errorInfo(error),
        },
        'Conversation projection failed; continuing the turn without this display update',
      );
    } catch {
      // Display diagnostics are non-authoritative for turn execution.
    }
  }

  private warnEarlyActivityFull(): void {
    try {
      const identity = this.opts.identity();
      this.opts.log.warn(
        {
          dispatcher_id: identity.dispatcher_id,
          agent_name: identity.name,
          role: identity.role,
          maximum: EARLY_ACTIVITY_EVENTS_MAX,
        },
        'Conversation projection early activity buffer is full; dropping newest activity',
      );
    } catch {
      // Display diagnostics are non-authoritative for turn execution.
    }
  }

  private capture(input: EntityTurnInput): CapturedEntityTurnInput {
    return {
      ...input,
      intent: this.opts.intent(),
      sourceName: this.opts.identity().name,
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
      return { status: 'failed', error: new Error('completion delivery unexpectedly skipped') };
  }
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
