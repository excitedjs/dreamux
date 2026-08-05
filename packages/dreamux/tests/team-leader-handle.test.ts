import { describe, expect, it, vi } from 'vitest';

import { teamLeaderHandle } from '../src/service/dispatcher-service/team-leader-handle.js';
import { KeyedAsyncQueue } from '../src/service/serial-queue.js';
import type { TeamService } from '../src/service/team-service/index.js';
import type { WorkflowOps } from '../src/service/workflow-service/index.js';

describe('TeamLeaderHandle', () => {
  it('releases the Team lease before waiting for workflow startup', async () => {
    const queue = new KeyedAsyncQueue();
    const lease = { teamId: 'alpha', leaderName: 'leader-alpha' };
    const agentLeaseEntered = deferred();
    const workflows = {
      run: vi.fn(() =>
        queue.run(lease.teamId, async () => {
          agentLeaseEntered.resolve();
          return { run_id: 'run-1' };
        }),
      ),
    } as unknown as WorkflowOps;
    const service = { workflows } as unknown as TeamService;
    const handle = teamLeaderHandle({
      lease,
      withMutationService: (_lease, task) =>
        queue.run(lease.teamId, () => task(service)),
      withReadService: async (_lease, task) => task(service),
    });

    const starting = handle.workflows.run({
      script: 'export default async function run() {}',
    });

    await expect(withTimeout(agentLeaseEntered.promise)).resolves.toBeUndefined();
    await expect(starting).resolves.toEqual({ run_id: 'run-1' });
  });

  it('releases the Team lease before waiting for workflow stop cleanup', async () => {
    const queue = new KeyedAsyncQueue();
    const lease = { teamId: 'alpha', leaderName: 'leader-alpha' };
    const agentLeaseEntered = deferred();
    const workflows = {
      stop: vi.fn(() =>
        queue.run(lease.teamId, async () => {
          agentLeaseEntered.resolve();
          return { run_id: 'run-1', status: 'stopped' as const };
        }),
      ),
    } as unknown as WorkflowOps;
    const service = { workflows } as unknown as TeamService;
    const handle = teamLeaderHandle({
      lease,
      withMutationService: (_lease, task) =>
        queue.run(lease.teamId, () => task(service)),
      withReadService: async (_lease, task) => task(service),
    });

    const stopping = handle.workflows.stop({ run_id: 'run-1' });

    await expect(withTimeout(agentLeaseEntered.promise)).resolves.toBeUndefined();
    await expect(stopping).resolves.toEqual({
      run_id: 'run-1',
      status: 'stopped',
    });
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
