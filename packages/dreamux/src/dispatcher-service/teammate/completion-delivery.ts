import type {
  AgentRuntime,
  CompletionEnvelope,
  DreamuxLogger,
  TurnSettledSignal,
} from '@excitedjs/dreamux-types';

import type { TeamMateIdentity, TeamMateTurnOrigin } from './types.js';

export type TeamMateCompletionSink = (
  dispatcherId: string,
  identity: TeamMateIdentity,
  completion: CompletionEnvelope,
  origin: TeamMateTurnOrigin | null,
) => void | Promise<void>;

export interface DeliverTeamMateTurnSettledInput {
  dispatcherId: string;
  name: string;
  identity: TeamMateIdentity;
  runtime: AgentRuntime;
  settled: TurnSettledSignal;
  turnOrigins: ReadonlyMap<string, TeamMateTurnOrigin>;
  sink: TeamMateCompletionSink;
  log: DreamuxLogger;
  recordSettledTurn: (input: {
    turnId: string | null;
    assistant: string | null;
    settleStatus: 'completed' | 'failed' | 'stopped' | null;
  }) => Promise<void>;
}

export async function deliverTeamMateTurnSettled(
  input: DeliverTeamMateTurnSettledInput,
): Promise<void> {
  try {
    if (input.settled.turnId === null) {
      input.log.warn(
        {
          dispatcher_id: input.dispatcherId,
          teammate: input.name,
          status: input.settled.status,
        },
        'dropping teammate completion: settled turn has no turn id',
      );
      return;
    }
    let result = '';
    try {
      const last = await input.runtime.getLast();
      result = last?.text ?? '';
    } catch (err) {
      input.log.warn(
        {
          dispatcher_id: input.dispatcherId,
          teammate: input.name,
          err: errInfo(err),
        },
        'teammate completion getLast failed',
      );
    }
    const envelope: CompletionEnvelope = {
      source: input.name,
      id: `${input.name}:${input.settled.turnId}`,
      status: input.settled.status,
      result,
    };
    try {
      await input.sink(
        input.dispatcherId,
        input.identity,
        envelope,
        input.turnOrigins.get(input.settled.turnId) ?? null,
      );
    } catch (err) {
      input.log.warn(
        {
          dispatcher_id: input.dispatcherId,
          teammate: input.name,
          err: errInfo(err),
        },
        'teammate completion delivery failed',
      );
    }
    await input.recordSettledTurn({
      turnId: input.settled.turnId,
      assistant: result,
      settleStatus: input.settled.status,
    });
  } catch (err) {
    input.log.warn(
      {
        dispatcher_id: input.dispatcherId,
        teammate: input.name,
        err: errInfo(err),
      },
      'teammate settled-turn capture failed',
    );
  }
}

function errInfo(err: unknown): Record<string, unknown> {
  if (err instanceof Error) {
    return { type: err.name, message: err.message, stack: err.stack };
  }
  return { value: String(err) };
}
