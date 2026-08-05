import type {
  AgentRuntimeTurnResult,
  TurnSettledSignal,
} from '@excitedjs/dreamux-types';
import { describe, expect, it } from 'vitest';

import { TurnSubmissionReadiness } from '../src/service/teammate-service/submission-readiness.js';

describe('TurnSubmissionReadiness', () => {
  it('keeps a folded turn settle behind every active submit for that entity', async () => {
    const events: string[] = [];
    let readiness!: TurnSubmissionReadiness;
    readiness = new TurnSubmissionReadiness((settled) => {
      void readiness.persist(async () => {
        events.push(`settled:${settled.turnId}`);
      });
    });
    const sharedTurn: AgentRuntimeTurnResult = {
      status: 'submitted',
      turnId: 'turn-shared',
    };
    const releaseSteer = deferred<void>();

    await readiness.submit(
      async () => sharedTurn,
      async () => {
        events.push('submit:first');
      },
    );
    const steering = readiness.submit(
      async () => {
        readiness.capture(settled('turn-shared'));
        await releaseSteer.promise;
        return sharedTurn;
      },
      async () => {
        events.push('submit:steer');
      },
    );

    await Promise.resolve();
    expect(events).toEqual(['submit:first']);
    releaseSteer.resolve();
    await steering;
    await readiness.drain();
    expect(events).toEqual([
      'submit:first',
      'submit:steer',
      'settled:turn-shared',
    ]);
  });
});

function settled(turnId: string): TurnSettledSignal {
  return {
    turnId,
    status: 'completed',
    result: { text: 'done' },
  };
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
