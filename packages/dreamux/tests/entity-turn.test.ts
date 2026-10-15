import { describe, expect, it } from 'vitest';
import { EntityTurn } from '../src/service/agent/turn.js';

describe('accepted input value record', () => {
  it('keeps a distinct stable receipt id and selects its result without delivery work', async () => {
    const first = new EntityTurn();
    const second = new EntityTurn();
    const id = first.id;
    expect(first.isSettled()).toBe(false);
    expect(first.id).not.toBe(second.id);
    first.settle({ status: 'completed', resultText: 'done' });
    expect(first.isSettled()).toBe(true);
    expect(first.id).toBe(id);
    expect(await first.settled).toEqual({
      status: 'completed',
      resultText: 'done',
    });
  });
  it('preserves the selected failure object and null successful output', async () => {
    const failed = new EntityTurn();
    const error = new Error('provider failure');
    failed.settle({ status: 'failed', error });
    expect(await failed.settled).toEqual({ status: 'failed', error });
    const empty = new EntityTurn();
    empty.settle({ status: 'completed', resultText: null });
    expect(await empty.settled).toEqual({
      status: 'completed',
      resultText: null,
    });
  });
  it('selects stopped without manufacturing a completion', async () => {
    const turn = new EntityTurn();
    turn.settle({ status: 'stopped' });
    expect(await turn.settled).toEqual({ status: 'stopped' });
  });
});
