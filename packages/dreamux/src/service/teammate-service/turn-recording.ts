import type {
  RuntimeAdmission,
  RuntimeTurn,
  RuntimeTurnOutcome,
} from '@excitedjs/dreamux-types';

import type {
  AgentEntitySubmissionResult,
  AgentEntityTurnOrigin,
} from '../agent-entity/types.js';
import type { PreparedCompletionFact } from '../completion-router/index.js';

export type TurnOutcome = RuntimeTurnOutcome;
export type TurnCompletionDelivery = (
  fact: PreparedCompletionFact,
) => Promise<void>;

export interface Turn {
  readonly runtime: RuntimeTurn;
  readonly origin: AgentEntityTurnOrigin | null;
  readonly prompt: string | null;
  readonly intent: string | null;
  readonly submittedAt: number;
  readonly settled: Promise<TurnOutcome>;
  readonly delivery: Promise<void>;
}

export type TurnAdmission =
  | { status: 'submitted'; turn: Turn }
  | { status: 'duplicate' | 'stopped' | 'skipped' }
  | { status: 'failed' | 'ambiguous'; error: Error };

export class EntityTurn implements Turn {
  readonly settled: Promise<TurnOutcome>;

  private selectedOutcome: TurnOutcome | null = null;
  private deliveryClosure: TurnCompletionDelivery | null;
  private deliveryTask: Promise<void> | null = null;
  private resolveSettled!: (outcome: TurnOutcome) => void;

  constructor(
    readonly runtime: RuntimeTurn,
    readonly origin: AgentEntityTurnOrigin | null,
    readonly prompt: string | null,
    readonly intent: string | null,
    readonly submittedAt: number,
    private readonly sourceName: string,
    delivery: TurnCompletionDelivery | null,
  ) {
    this.deliveryClosure = delivery;
    this.settled = new Promise((resolve) => {
      this.resolveSettled = resolve;
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

  attachDelivery(delivery: TurnCompletionDelivery | null): void {
    if (delivery === null || this.deliveryClosure !== null) return;
    this.deliveryClosure = delivery;
    this.startDeliveryIfReady();
  }

  trySettle(outcome: TurnOutcome): boolean {
    if (this.selectedOutcome !== null) return false;
    this.selectedOutcome = snapshotOutcome(outcome);
    this.resolveSettled(this.selectedOutcome);
    this.startDeliveryIfReady();
    return true;
  }

  async ensureDelivery(): Promise<void> {
    await this.settled;
    this.startDeliveryIfReady();
    await (this.deliveryTask ?? Promise.resolve());
  }

  private startDeliveryIfReady(): void {
    if (
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
