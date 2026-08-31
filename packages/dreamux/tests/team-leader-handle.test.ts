import { describe, expect, it, vi } from 'vitest';

import { teamLeaderHandle } from '../src/service/dispatcher-service/team-leader-handle.js';
import { KeyedAsyncQueue } from '../src/service/serial-queue.js';
import type { TeamService } from '../src/service/team-service/index.js';
import type { WorkflowOps } from '../src/service/workflow-service/index.js';

describe('TeamLeaderHandle', () => {
  // `teamLeaderHandle` currently takes a bare `teamId` plus the two service
  // accessors directly (the `lease` object this file used to build was
  // removed from the production signature); these tests exercise the current
  // shape instead of the retired one.
  it('releases the Team lease before waiting for workflow startup', async () => {
    const queue = new KeyedAsyncQueue();
    const teamId = 'alpha';
    const agentLeaseEntered = deferred();
    const workflows = {
      run: vi.fn(() =>
        queue.run(teamId, async () => {
          agentLeaseEntered.resolve();
          return { run_id: 'run-1' };
        }),
      ),
    } as unknown as WorkflowOps;
    const service = { workflows } as unknown as TeamService;
    const handle = teamLeaderHandle({
      teamId,
      withMutationService: (_teamId, task) =>
        queue.run(teamId, () => task(service)),
      withReadService: async (_teamId, task) => task(service),
    });

    const starting = handle.workflows.run({
      script:
        'export const meta = { name: "x", description: "x" }; return null;',
    });

    await expect(withTimeout(agentLeaseEntered.promise)).resolves.toBeUndefined();
    await expect(starting).resolves.toEqual({ run_id: 'run-1' });
  });

  it('releases the Team lease before waiting for workflow stop cleanup', async () => {
    const queue = new KeyedAsyncQueue();
    const teamId = 'alpha';
    const agentLeaseEntered = deferred();
    const workflows = {
      stop: vi.fn(() =>
        queue.run(teamId, async () => {
          agentLeaseEntered.resolve();
          return { run_id: 'run-1', status: 'stopped' as const };
        }),
      ),
    } as unknown as WorkflowOps;
    const service = { workflows } as unknown as TeamService;
    const handle = teamLeaderHandle({
      teamId,
      withMutationService: (_teamId, task) =>
        queue.run(teamId, () => task(service)),
      withReadService: async (_teamId, task) => task(service),
    });

    const stopping = handle.workflows.stop({ run_id: 'run-1' });

    await expect(withTimeout(agentLeaseEntered.promise)).resolves.toBeUndefined();
    await expect(stopping).resolves.toEqual({
      run_id: 'run-1',
      status: 'stopped',
    });
  });

  it('routes a mutating teammate op through withMutationService and a read op through withReadService', async () => {
    const calls: string[] = [];
    const service = {
      teammates: {
        send: vi.fn(async () => ({ status: 'submitted' as const, turn_id: 't1' })),
        list: vi.fn(async () => []),
      },
    } as unknown as TeamService;
    const handle = teamLeaderHandle({
      teamId: 'alpha',
      withMutationService: async (teamId, task) => {
        calls.push(`mutate:${teamId}`);
        return task(service);
      },
      withReadService: async (teamId, task) => {
        calls.push(`read:${teamId}`);
        return task(service);
      },
    });

    await handle.teammates.send({ name: 'mate-1', prompt: 'hi', intent: 'x' });
    await handle.teammates.list();

    // `send` mutates the Team's roster/turn state, so it must acquire the
    // Team's own work fence; `list` only reads and must not.
    expect(calls).toEqual(['mutate:alpha', 'read:alpha']);
  });

  it('routes spawnTeamMate through withMutationService, not withReadService', async () => {
    const service = {
      spawnTeamMate: vi.fn(async () => ({ name: 'mate-1', status: 'starting' })),
    } as unknown as TeamService;
    let mutateCalls = 0;
    let readCalls = 0;
    const handle = teamLeaderHandle({
      teamId: 'alpha',
      withMutationService: async (_teamId, task) => {
        mutateCalls += 1;
        return task(service);
      },
      withReadService: async (_teamId, task) => {
        readCalls += 1;
        return task(service);
      },
    });

    await handle.spawnTeamMate({ name: 'mate-1', prompt: 'hi', intent: 'x' });

    expect(mutateCalls).toBe(1);
    expect(readCalls).toBe(0);
  });
});

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function withTimeout(promise: Promise<void>): Promise<void> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      promise,
      new Promise<void>((_resolve, reject) => {
        timeout = setTimeout(
          () => reject(new Error('Team lease re-entry timed out')),
          1_000,
        );
      }),
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}
