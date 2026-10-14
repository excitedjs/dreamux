import { randomUUID } from 'node:crypto';

export function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

export type TurnOutcome =
  | { status: 'completed'; resultText: string | null }
  | { status: 'failed'; error: Error }
  | { status: 'stopped' };

/**
 * One submission this entity is waiting on.
 *
 * Its receipt id and selected outcome remain available to request consumers.
 * Reporting and runtime settlement observation belong to AgentService; this
 * record holds only the accepted input's value and convergence fact.
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
  private resolveSettled!: (outcome: TurnOutcome) => void;

  constructor() {
    this.settled = new Promise((resolve) => {
      this.resolveSettled = resolve;
    });
  }

  isSettled(): boolean {
    return this.selectedOutcome !== null;
  }

  /** AgentService selects once, in the accepted runtime input's reaction. */
  settle(outcome: TurnOutcome): void {
    this.selectedOutcome = outcome;
    this.resolveSettled(outcome);
  }
}
