import { describe, expect, it } from 'vitest';

import {
  awaitTeamMateCompletion,
  clampWaitTimeout,
  lastEventId,
  reachedWaitState,
  TEAMMATE_WAIT_DEFAULT_MS,
  TEAMMATE_WAIT_MAX_MS,
  TeamMateWaitBroker,
  type TeamMateWaitToken,
} from '../src/teammate/wait-broker.js';
import type { TeamMateTaskRecord } from '../src/teammate/ledger.js';

function task(
  overrides: Partial<TeamMateTaskRecord> = {},
): TeamMateTaskRecord {
  return {
    version: 2,
    task_id: 'tmtsk_1_w',
    dispatcher_id: 'flow',
    lifecycle_status: 'accepted',
    delivery_status: 'none',
    title: 'Wait',
    prompt: 'wait',
    teammate_id: null,
    intent: null,
    target: null,
    target_mode: null,
    provider_ref: null,
    operation_id: null,
    origin: 'dispatcher',
    branch: null,
    team: null,
    scheduled_by: { kind: 'dispatcher' },
    events: [{ event_id: 1, type: 'accepted', at: 1000 }],
    inputs: [],
    runtime: null,
    result: null,
    delivery: null,
    close: null,
    created_at: 1000,
    updated_at: 1000,
    ...overrides,
  };
}

const TERMINAL: ReadonlySet<TeamMateWaitToken> = new Set([
  'completed',
  'failed',
  'cancelled',
]);

describe('TeamMate wait broker', () => {
  it('returns immediately when a matching event already exists', async () => {
    const broker = new TeamMateWaitBroker();
    const done = task({
      lifecycle_status: 'completed',
      delivery_status: 'pending',
      events: [
        { event_id: 1, type: 'accepted', at: 1000 },
        { event_id: 2, type: 'completed', at: 2000 },
      ],
    });
    const outcome = await awaitTeamMateCompletion(broker, {
      dispatcherId: 'flow',
      taskId: 'tmtsk_1_w',
      afterEventId: 0,
      until: TERMINAL,
      timeoutMs: 50,
      loadTask: () => Promise.resolve(done),
    });
    expect(outcome.status).toBe('reached');
    if (outcome.status === 'reached') {
      expect(outcome.last_event_id).toBe(2);
    }
  });

  it('does not resolve on an event at or before the cursor', async () => {
    const broker = new TeamMateWaitBroker();
    const done = task({
      lifecycle_status: 'completed',
      events: [
        { event_id: 1, type: 'accepted', at: 1000 },
        { event_id: 2, type: 'completed', at: 2000 },
      ],
    });
    const outcome = await awaitTeamMateCompletion(broker, {
      dispatcherId: 'flow',
      taskId: 'tmtsk_1_w',
      afterEventId: 2,
      until: TERMINAL,
      timeoutMs: 20,
      loadTask: () => Promise.resolve(done),
    });
    expect(outcome.status).toBe('still_running');
  });

  it('wakes on a future event without polling', async () => {
    const broker = new TeamMateWaitBroker();
    let current = task();
    const outcome = awaitTeamMateCompletion(broker, {
      dispatcherId: 'flow',
      taskId: 'tmtsk_1_w',
      afterEventId: 1,
      until: TERMINAL,
      timeoutMs: 1_000,
      loadTask: () => Promise.resolve(current),
    });
    // Land a completion and notify; the waiter must wake from the notify, not a
    // poll loop.
    await delay(20);
    current = task({
      lifecycle_status: 'completed',
      delivery_status: 'pending',
      events: [
        { event_id: 1, type: 'accepted', at: 1000 },
        { event_id: 2, type: 'completed', at: 2000 },
      ],
    });
    broker.notify('flow', 'tmtsk_1_w');
    const resolved = await outcome;
    expect(resolved.status).toBe('reached');
  });

  it('does not lose a wakeup fired concurrently with the wait (race-safe)', async () => {
    const broker = new TeamMateWaitBroker();
    let current = task();
    // Fire the completion + notify in the same tick the wait is registered.
    const waiting = awaitTeamMateCompletion(broker, {
      dispatcherId: 'flow',
      taskId: 'tmtsk_1_w',
      afterEventId: 1,
      until: TERMINAL,
      timeoutMs: 1_000,
      loadTask: () => Promise.resolve(current),
    });
    current = task({
      lifecycle_status: 'completed',
      events: [
        { event_id: 1, type: 'accepted', at: 1000 },
        { event_id: 2, type: 'completed', at: 2000 },
      ],
    });
    broker.notify('flow', 'tmtsk_1_w');
    const resolved = await waiting;
    expect(resolved.status).toBe('reached');
  });

  it('returns still_running with the latest snapshot on timeout', async () => {
    const broker = new TeamMateWaitBroker();
    const running = task({ lifecycle_status: 'running' });
    const outcome = await awaitTeamMateCompletion(broker, {
      dispatcherId: 'flow',
      taskId: 'tmtsk_1_w',
      afterEventId: 1,
      until: TERMINAL,
      timeoutMs: 20,
      loadTask: () => Promise.resolve(running),
    });
    expect(outcome.status).toBe('still_running');
    if (outcome.status === 'still_running') {
      expect(outcome.task.lifecycle_status).toBe('running');
      expect(outcome.last_event_id).toBe(1);
    }
  });

  it('returns not_found when the task is missing', async () => {
    const broker = new TeamMateWaitBroker();
    const outcome = await awaitTeamMateCompletion(broker, {
      dispatcherId: 'flow',
      taskId: 'tmtsk_1_missing',
      afterEventId: 0,
      until: TERMINAL,
      timeoutMs: 20,
      loadTask: () => Promise.resolve(null),
    });
    expect(outcome.status).toBe('not_found');
  });

  it('matches a delivery state token', () => {
    const failed = task({
      lifecycle_status: 'completed',
      delivery_status: 'delivery_failed',
    });
    expect(
      reachedWaitState(failed, new Set<TeamMateWaitToken>(['delivery_failed'])),
    ).toBe(true);
    expect(reachedWaitState(failed, TERMINAL)).toBe(true);
    expect(lastEventId(failed)).toBe(1);
  });

  it('clamps the wait timeout to the bounded window', () => {
    expect(clampWaitTimeout(undefined)).toBe(TEAMMATE_WAIT_DEFAULT_MS);
    expect(clampWaitTimeout(10_000_000)).toBe(TEAMMATE_WAIT_MAX_MS);
    expect(clampWaitTimeout(-5)).toBe(0);
  });
});

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
