import type {
  RuntimeTurn,
  RuntimeTurnOutcome,
} from '@excitedjs/dreamux-types';

export interface ControllableRuntimeTurn {
  readonly turn: RuntimeTurn;
  settle(outcome: RuntimeTurnOutcome): boolean;
}

export function controllableRuntimeTurn(): ControllableRuntimeTurn {
  let selected = false;
  let resolve!: (outcome: RuntimeTurnOutcome) => void;
  const settled = new Promise<RuntimeTurnOutcome>((accept) => {
    resolve = accept;
  });
  return {
    turn: Object.freeze({ settled }),
    settle(outcome) {
      if (selected) return false;
      selected = true;
      resolve(outcome);
      return true;
    },
  };
}

export function completedRuntimeTurn(resultText: string | null = null): RuntimeTurn {
  return Object.freeze({
    settled: Promise.resolve({
      status: 'completed' as const,
      resultText,
      truncated: false,
    }),
  });
}
