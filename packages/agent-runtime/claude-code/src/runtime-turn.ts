import type {
  RuntimeTurn,
  RuntimeTurnOutcome,
} from '@excitedjs/dreamux-types';

/** Create one stable logical Turn object with an exactly-once outcome latch. */
export function createRuntimeTurn(): {
  turn: RuntimeTurn;
  settle: (outcome: RuntimeTurnOutcome) => boolean;
} {
  let resolve!: (outcome: RuntimeTurnOutcome) => void;
  let settled = false;
  const turn = Object.freeze({
    settled: new Promise<RuntimeTurnOutcome>((value) => {
      resolve = value;
    }),
  });
  return {
    turn,
    settle(outcome): boolean {
      if (settled) return false;
      settled = true;
      resolve(outcome);
      return true;
    },
  };
}
