import type { AgentRuntimeTurnResult } from '@excitedjs/dreamux-types';

import type { TeamMateRuntimeStateStore } from '../teammate-collection/runtime-state.js';
import { turnsScopeOf, type TeamMateTurnsStore } from '../teammate-collection/turns-store.js';
import type {
  TeamMateTurnOrigin,
  TeamMateTurnResult,
} from '../teammate-collection/types.js';

export async function recordSubmittedTurn(
  turnsStore: TeamMateTurnsStore,
  live: { state: TeamMateRuntimeStateStore },
  input: {
    turnId: string | null;
    turnOrigin: TeamMateTurnOrigin | null;
    prompt: string;
  },
): Promise<void> {
  const current = live.state.current();
  await turnsStore.appendSubmit(turnsScopeOf(current), {
    turnId: input.turnId,
    turnOrigin: input.turnOrigin,
    prompt: input.prompt,
    intent: current.intent,
  });
  await live.state.recordSubmittedTurn(input.prompt);
}

export async function recordSettledTurn(
  turnsStore: TeamMateTurnsStore,
  state: TeamMateRuntimeStateStore,
  input: {
    turnId: string | null;
    assistant: string | null;
    settleStatus: 'completed' | 'failed' | 'stopped' | null;
  },
): Promise<void> {
  await turnsStore.appendSettled(turnsScopeOf(state.current()), {
    turnId: input.turnId,
    assistant: input.assistant,
    settleStatus: input.settleStatus,
  });
  await state.recordSettledTurn(input.assistant);
}

export function toTurnResult(
  result: AgentRuntimeTurnResult,
): TeamMateTurnResult {
  switch (result.status) {
    case 'submitted':
      return { status: 'submitted', turn_id: result.turnId };
    case 'duplicate':
    case 'stopped':
      return { status: result.status };
    case 'failed':
      return { status: 'failed', error: result.error.message };
    case 'skipped':
      return { status: 'stopped', error: 'turn skipped' };
  }
}
