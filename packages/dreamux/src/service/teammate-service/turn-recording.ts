import { randomUUID } from 'node:crypto';

import type {
  RuntimeAdmission,
  RuntimeCompletion,
  RuntimeSubmission,
} from '@excitedjs/dreamux-types';

import type {
  AgentEntitySubmissionResult,
  AgentEntityTurnOrigin,
} from '../agent-entity/types.js';
import type { PreparedCompletionFact } from '../completion-router/index.js';

export type TurnOutcome =
  | { status: 'completed'; resultText: string | null; truncated: boolean }
  | { status: 'failed'; error: Error }
  | { status: 'stopped' };

export type TurnCompletionDelivery = (
  completion: RuntimeCompletion,
  fact: PreparedCompletionFact,
) => Promise<void>;

export interface Turn {
  readonly id: string;
  readonly runtime: RuntimeSubmission;
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
  readonly id = randomUUID();
  readonly settled: Promise<TurnOutcome>;

  private selectedOutcome: TurnOutcome | null = null;
  private selectedCompletion: RuntimeCompletion | null = null;
  private deliveryTask: Promise<void> | null = null;

  constructor(
    readonly runtime: RuntimeSubmission,
    readonly origin: AgentEntityTurnOrigin | null,
    readonly prompt: string | null,
    readonly intent: string | null,
    readonly submittedAt: number,
    private readonly sourceName: string,
    private readonly deliveryClosure: TurnCompletionDelivery | null,
  ) {
    this.settled = runtime.settled.then((settlement): TurnOutcome => {
      if (settlement.kind === 'completion') {
        this.selectedCompletion = settlement.completion;
        const outcome = settlement.completion.status === 'completed'
          ? {
              status: 'completed' as const,
              resultText: settlement.completion.resultText,
              truncated: settlement.completion.truncated,
            }
          : { status: 'failed' as const, error: settlement.completion.error };
        this.selectedOutcome = outcome;
        this.startDeliveryIfReady();
        return outcome;
      }
      const outcome = settlement.kind === 'failed'
        ? { status: 'failed' as const, error: settlement.error }
        : { status: 'stopped' as const };
      this.selectedOutcome = outcome;
      return outcome;
    }, (error: unknown): TurnOutcome => {
      const outcome = { status: 'failed' as const, error: asError(error) };
      this.selectedOutcome = outcome;
      return outcome;
    });
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

  private startDeliveryIfReady(): void {
    if (
      this.deliveryTask !== null ||
      this.deliveryClosure === null ||
      this.selectedCompletion === null
    ) {
      return;
    }
    const completion = this.selectedCompletion;
    const fact: PreparedCompletionFact = {
      kind: 'teammate',
      source: this.sourceName,
      status: completion.status,
      result: completion.status === 'completed' ? completion.resultText : null,
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

export function admissionWithoutTurn(
  admission: Exclude<RuntimeAdmission, { status: 'submitted' }>,
): TurnAdmission {
  return admission;
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
