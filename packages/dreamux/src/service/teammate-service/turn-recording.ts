import type {
  RuntimeAdmission,
  RuntimeTurn,
  RuntimeTurnOutcome,
} from '@excitedjs/dreamux-types';

import type { AgentRuntimeStateStore } from '../agent-entity/runtime-state.js';
import {
  preview,
  turnsScopeOf,
  type AgentTurnsStore,
} from '../agent-entity/turns-store.js';
import type {
  AgentEntitySubmissionResult,
  AgentEntityTurnOrigin,
  AgentEntityTurnRecord,
} from '../agent-entity/types.js';
import type { PreparedCompletionFact } from '../completion-router/index.js';

export type TurnOutcome = RuntimeTurnOutcome;
export type TurnCompletionDelivery = (
  fact: PreparedCompletionFact,
) => Promise<void>;

export interface Turn {
  readonly runtime: RuntimeTurn;
  readonly origin: AgentEntityTurnOrigin | null;
  readonly promptPreview: string | null;
  readonly intent: string | null;
  readonly submittedAt: number;
  readonly settled: Promise<TurnOutcome>;
  readonly persistence: Promise<void>;
  readonly delivery: Promise<void>;
}

export type TurnAdmission =
  | { status: 'submitted'; turn: Turn }
  | { status: 'duplicate' | 'stopped' | 'skipped' }
  | { status: 'failed' | 'ambiguous'; error: Error };

export class EntityTurn implements Turn {
  readonly promptPreview: string | null;
  readonly settled: Promise<TurnOutcome>;
  readonly persistence: Promise<void>;

  private selectedOutcome: TurnOutcome | null = null;
  private selectedAt: number | null = null;
  private terminalRow: AgentEntityTurnRecord | null = null;
  private projectionCommitted = false;
  private persistenceAttempt: Promise<void> | null = null;
  private deliveryClosure: TurnCompletionDelivery | null;
  private deliveryTask: Promise<void> | null = null;
  private automaticPersistenceFailureReported = false;
  private resolveSettled!: (outcome: TurnOutcome) => void;
  private rejectSettled!: (error: Error) => void;
  private resolvePersistence!: () => void;

  constructor(
    readonly runtime: RuntimeTurn,
    readonly origin: AgentEntityTurnOrigin | null,
    private readonly prompt: string | null,
    readonly intent: string | null,
    readonly submittedAt: number,
    private readonly sourceName: string,
    private readonly turnsStore: AgentTurnsStore,
    private readonly state: AgentRuntimeStateStore,
    delivery: TurnCompletionDelivery | null,
    private readonly onAutomaticPersistenceFailure: (error: Error) => void,
    private readonly priorPersistence: Promise<void> = Promise.resolve(),
  ) {
    this.promptPreview = prompt === null ? null : preview(prompt);
    this.deliveryClosure = delivery;
    this.settled = new Promise((resolve, reject) => {
      this.resolveSettled = resolve;
      this.rejectSettled = reject;
    });
    // Public sends do not expose their Turn object. Keep the owner-visible
    // rejection observable without making an unobserved ordinary Turn an
    // unhandled rejection.
    void this.settled.catch(() => undefined);
    this.persistence = new Promise((resolve) => {
      this.resolvePersistence = resolve;
    });
    void runtime.settled.then(
      (outcome) => this.trySettle(outcome),
      (error) =>
        this.trySettle({
          status: 'failed',
          error: error instanceof Error ? error : new Error(String(error)),
        }),
    );
  }

  get delivery(): Promise<void> {
    return this.ensureDelivery();
  }

  isOutcomeSelected(): boolean {
    return this.selectedOutcome !== null;
  }

  isPersisted(): boolean {
    return this.projectionCommitted;
  }

  attachDelivery(delivery: TurnCompletionDelivery | null): void {
    if (delivery === null || this.deliveryClosure !== null) return;
    this.deliveryClosure = delivery;
    this.startDeliveryIfReady();
  }

  trySettle(outcome: TurnOutcome): boolean {
    if (this.selectedOutcome !== null) return false;
    this.selectedOutcome = snapshotOutcome(outcome);
    this.selectedAt = Date.now();
    void this.ensurePersisted()
      .catch((error: unknown) => {
        this.reportAutomaticPersistenceFailure(asError(error));
      })
      .catch(() => undefined);
    return true;
  }

  async ensurePersisted(): Promise<void> {
    if (this.projectionCommitted) return;
    if (this.selectedOutcome === null) return this.persistence;
    if (this.persistenceAttempt !== null) return this.persistenceAttempt;
    const attempt = this.persistSelectedOutcome();
    this.persistenceAttempt = attempt;
    try {
      await attempt;
    } finally {
      if (!this.projectionCommitted && this.persistenceAttempt === attempt) {
        this.persistenceAttempt = null;
      }
    }
  }

  async ensureDelivery(): Promise<void> {
    await this.ensurePersisted();
    this.startDeliveryIfReady();
    await (this.deliveryTask ?? Promise.resolve());
  }

  private async persistSelectedOutcome(): Promise<void> {
    const outcome = this.selectedOutcome;
    if (outcome === null) return;
    const settledAt = this.selectedAt;
    if (settledAt === null) {
      throw new Error('selected Turn outcome has no settlement timestamp');
    }
    await this.priorPersistence;
    if (this.terminalRow === null) {
      this.terminalRow = await this.turnsStore.appendTerminal(
        turnsScopeOf(this.state.current()),
        {
          submittedAt: this.submittedAt,
          settledAt,
          turnOrigin: this.origin,
          prompt: this.prompt,
          intent: this.intent,
          settleStatus: outcome.status,
          assistant: outcome.status === 'completed' ? outcome.resultText : null,
          assistantTruncated:
            outcome.status === 'completed' ? outcome.truncated : false,
        },
      );
    }
    await this.state.recordTerminalTurn(this.terminalRow);
    this.projectionCommitted = true;
    this.resolvePersistence();
    this.resolveSettled(outcome);
    this.startDeliveryIfReady();
  }

  private reportAutomaticPersistenceFailure(error: Error): void {
    if (this.automaticPersistenceFailureReported) return;
    this.automaticPersistenceFailureReported = true;
    try {
      this.onAutomaticPersistenceFailure(error);
    } finally {
      this.rejectSettled(error);
    }
  }

  private startDeliveryIfReady(): void {
    if (
      !this.projectionCommitted ||
      this.deliveryTask !== null ||
      this.deliveryClosure === null ||
      this.selectedOutcome === null
    ) {
      return;
    }
    const outcome = this.selectedOutcome;
    const fact: PreparedCompletionFact = {
      kind: 'teammate',
      source: this.sourceName,
      status: outcome.status,
      result: outcome.status === 'completed' ? outcome.resultText : null,
    };
    const delivery = this.deliveryClosure;
    this.deliveryTask = Promise.resolve().then(() => delivery(fact));
    void this.deliveryTask.catch(() => undefined);
  }
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
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

export function admissionWithoutTurn(
  admission: Exclude<RuntimeAdmission, { status: 'submitted' }>,
): TurnAdmission {
  return admission;
}

function snapshotOutcome(outcome: TurnOutcome): TurnOutcome {
  switch (outcome.status) {
    case 'completed':
      return Object.freeze({
        status: 'completed',
        resultText: outcome.resultText,
        truncated: outcome.truncated,
      });
    case 'failed':
      return Object.freeze({
        status: 'failed',
        error: snapshotError(outcome.error),
      });
    case 'stopped':
      return Object.freeze({ status: 'stopped' });
  }
}

function snapshotError(error: Error): Error {
  const snapshot = new Error(error.message);
  snapshot.name = error.name;
  if (error.stack !== undefined) snapshot.stack = error.stack;
  return Object.freeze(snapshot);
}
