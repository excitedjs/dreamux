import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { TeamMateTaskLedger } from '../src/teammate/ledger.js';
import { TeamMateDeliveryService } from '../src/teammate/delivery.js';
import {
  TeamMateWorkerExecutionService,
  type TeamMateExecutionOutcome,
} from '../src/teammate/worker-execution.js';
import { TeamMateWorkerProviderCatalog } from '../src/teammate/worker/catalog.js';
import {
  FakeTeamMateWorkerProvider,
  FAKE_TEAMMATE_WORKER_REF,
} from '../src/teammate/worker/fake-provider.js';
import { TeamMateWaitBroker } from '../src/teammate/wait-broker.js';
import { resetRuntimeConfig } from '../src/runtime/paths.js';

const DISPATCHER = 'flow';

interface Harness {
  ledger: TeamMateTaskLedger;
  broker: TeamMateWaitBroker;
  execution: TeamMateWorkerExecutionService;
  notifications: number;
}

/**
 * Build an execution service over a real ledger and the PR1 delivery service
 * (with no runtime, so delivery ends `delivery_failed` while the result stays
 * pull-able — exactly the "result is the source of truth" guarantee we assert).
 */
function buildHarness(
  workers: TeamMateWorkerProviderCatalog,
): Harness {
  const ledger = new TeamMateTaskLedger(DISPATCHER);
  const broker = new TeamMateWaitBroker();
  const state = { notifications: 0 };
  const delivery = new TeamMateDeliveryService({
    ledger: () => ledger,
    resolveRuntime: () => null,
    backoffMs: () => 0,
    notifyEvent: (d, t) => broker.notify(d, t),
  });
  const execution = new TeamMateWorkerExecutionService({
    ledger: () => ledger,
    workers: () => workers,
    reportCompletion: (report) => delivery.reportCompletion(report),
    notifyEvent: (d, t) => {
      state.notifications++;
      broker.notify(d, t);
    },
  });
  return {
    ledger,
    broker,
    execution,
    get notifications() {
      return state.notifications;
    },
  } as Harness;
}

async function acceptTask(
  ledger: TeamMateTaskLedger,
  overrides: Partial<{ providerRef: string; taskId: string }> = {},
): Promise<string> {
  const task = await ledger.acceptTask({
    title: 'Run task',
    prompt: 'Investigate the failing test.',
    callerKind: 'dispatcher',
    target: { kind: 'path', path: '/tmp/work' },
    ...(overrides.providerRef !== undefined
      ? { providerRef: overrides.providerRef }
      : {}),
    ...(overrides.taskId !== undefined ? { taskId: overrides.taskId } : {}),
  });
  return task.task_id;
}

describe('TeamMate worker execution', () => {
  let root: string;
  let previousHome: string | undefined;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'dreamux-teammate-worker-'));
    previousHome = process.env['HOME'];
    process.env['HOME'] = join(root, 'home');
    resetRuntimeConfig();
  });

  afterEach(() => {
    if (previousHome === undefined) delete process.env['HOME'];
    else process.env['HOME'] = previousHome;
    resetRuntimeConfig();
    rmSync(root, { recursive: true, force: true });
  });

  it('drives accepted -> running -> completed with a pull-able result', async () => {
    const fake = new FakeTeamMateWorkerProvider();
    const { ledger, execution } = buildHarness(
      new TeamMateWorkerProviderCatalog({ providers: [fake] }),
    );
    const taskId = await acceptTask(ledger);

    const started = await execution.execute({ dispatcherId: DISPATCHER, taskId });
    expect(started).toEqual({
      status: 'running',
      provider_ref: FAKE_TEAMMATE_WORKER_REF,
    });

    // onRunning landed during startSession, so the event stream is accepted ->
    // running with no terminal event yet.
    let task = await ledger.getTask(taskId);
    expect(task?.lifecycle_status).toBe('running');
    expect(task?.events.map((e) => e.type)).toEqual(['accepted', 'running']);

    await fake.emitCompleted(taskId, 'the work is done');

    task = await ledger.getTask(taskId);
    expect(task?.lifecycle_status).toBe('completed');
    expect(task?.result).toMatchObject({
      outcome: 'completed',
      text: 'the work is done',
    });
    // The ledger is the source of truth: the result is retained and pull-able
    // even though delivery failed (no runtime to deliver into).
    expect(task?.delivery_status).toBe('delivery_failed');
    const latest = await ledger.latestResultTask();
    expect(latest?.task_id).toBe(taskId);
    expect(latest?.result?.text).toBe('the work is done');
    expect(execution.hasLiveSession(DISPATCHER, taskId)).toBe(false);
  });

  it('reports provider_unavailable and leaves the task accepted when no worker is wired', async () => {
    const { ledger, execution } = buildHarness(
      new TeamMateWorkerProviderCatalog(),
    );
    const taskId = await acceptTask(ledger);

    const outcome = await execution.execute({ dispatcherId: DISPATCHER, taskId });
    expect(outcome).toEqual({
      status: 'provider_unavailable',
      reason: expect.any(String),
      code: 'TEAMMATE_PROVIDER_UNAVAILABLE',
      retryable: true,
    });

    const task = await ledger.getTask(taskId);
    // The task stays accepted so execute_task can retry once a worker exists.
    expect(task?.lifecycle_status).toBe('accepted');
    expect(task?.events.map((e) => e.type)).toEqual(['accepted']);
  });

  it('reports provider_unavailable when the worker advertises itself unavailable', async () => {
    const fake = new FakeTeamMateWorkerProvider({
      available: false,
      unavailableReason: 'fake worker is down',
    });
    const { ledger, execution } = buildHarness(
      new TeamMateWorkerProviderCatalog({ providers: [fake] }),
    );
    const taskId = await acceptTask(ledger);

    const outcome = await execution.execute({ dispatcherId: DISPATCHER, taskId });
    expect(outcome.status).toBe('provider_unavailable');

    expect((await ledger.getTask(taskId))?.lifecycle_status).toBe('accepted');
  });

  it('records a worker-reported failure as a pull-able failed result', async () => {
    const fake = new FakeTeamMateWorkerProvider();
    const { ledger, execution } = buildHarness(
      new TeamMateWorkerProviderCatalog({ providers: [fake] }),
    );
    const taskId = await acceptTask(ledger);
    await execution.execute({ dispatcherId: DISPATCHER, taskId });

    await fake.emitFailed(taskId, 'the worker hit an unrecoverable error');

    const task = await ledger.getTask(taskId);
    expect(task?.lifecycle_status).toBe('failed');
    expect(task?.result).toMatchObject({
      outcome: 'failed',
      text: 'the worker hit an unrecoverable error',
    });
    // Source of truth after failure: the result is retained and pull-able.
    const latest = await ledger.latestResultTask();
    expect(latest?.task_id).toBe(taskId);
    expect(execution.hasLiveSession(DISPATCHER, taskId)).toBe(false);
  });

  it('closes the task as cancelled when the worker cancels', async () => {
    const fake = new FakeTeamMateWorkerProvider();
    const { ledger, execution } = buildHarness(
      new TeamMateWorkerProviderCatalog({ providers: [fake] }),
    );
    const taskId = await acceptTask(ledger);
    await execution.execute({ dispatcherId: DISPATCHER, taskId });

    await fake.emitCancelled(taskId, 'operator asked to stop');

    const task = await ledger.getTask(taskId);
    expect(task?.lifecycle_status).toBe('cancelled');
    expect(task?.close).toMatchObject({
      status: 'cancelled',
      note: 'operator asked to stop',
    });
    expect(task?.events.map((e) => e.type)).toContain('closed');
  });

  it('is idempotent: a second execute does not start a second session', async () => {
    const fake = new FakeTeamMateWorkerProvider();
    const { ledger, execution } = buildHarness(
      new TeamMateWorkerProviderCatalog({ providers: [fake] }),
    );
    const taskId = await acceptTask(ledger);

    const first = await execution.execute({ dispatcherId: DISPATCHER, taskId });
    const second = await execution.execute({ dispatcherId: DISPATCHER, taskId });
    expect(first).toEqual(second);

    // Only one running event — the second execute short-circuited on the live
    // session instead of re-running the worker.
    const task = await ledger.getTask(taskId);
    expect(task?.events.filter((e) => e.type === 'running')).toHaveLength(1);
  });

  it('does not re-execute a terminal task', async () => {
    const fake = new FakeTeamMateWorkerProvider();
    const { ledger, execution } = buildHarness(
      new TeamMateWorkerProviderCatalog({ providers: [fake] }),
    );
    const taskId = await acceptTask(ledger);
    await execution.execute({ dispatcherId: DISPATCHER, taskId });
    await fake.emitCompleted(taskId, 'done');

    const outcome = await execution.execute({ dispatcherId: DISPATCHER, taskId });
    expect(outcome).toMatchObject({ status: 'completed' });
    // No second running transition was attempted.
    const task = await ledger.getTask(taskId);
    expect(task?.events.filter((e) => e.type === 'running')).toHaveLength(1);
  });

  it('routes follow-up input to a live session and leaves it queued without one', async () => {
    const fake = new FakeTeamMateWorkerProvider();
    const workers = new TeamMateWorkerProviderCatalog({ providers: [fake] });
    const { ledger, execution } = buildHarness(workers);
    const taskId = await acceptTask(ledger);

    // No session yet: the input is not delivered to a worker.
    const beforeStart = await execution.sendInput({
      dispatcherId: DISPATCHER,
      taskId,
      inputId: 'input_1',
      text: 'early steer',
      mode: 'steer',
    });
    expect(beforeStart.delivered).toBe(false);

    await execution.execute({ dispatcherId: DISPATCHER, taskId });
    const delivered = await execution.sendInput({
      dispatcherId: DISPATCHER,
      taskId,
      inputId: 'input_2',
      text: 'steer the worker',
      mode: 'steer',
    });
    expect(delivered).toEqual({
      delivered: true,
      disposition: { status: 'accepted' },
    });
    expect(fake.inputsFor(taskId)).toEqual([
      { inputId: 'input_2', text: 'steer the worker', mode: 'steer' },
    ]);
  });

  it('surfaces a worker input rejection disposition', async () => {
    const fake = new FakeTeamMateWorkerProvider({
      inputDisposition: (input) =>
        input.mode === 'interrupt'
          ? { status: 'rejected', reason: 'interrupt not supported mid-turn' }
          : { status: 'accepted' },
    });
    const { ledger, execution } = buildHarness(
      new TeamMateWorkerProviderCatalog({ providers: [fake] }),
    );
    const taskId = await acceptTask(ledger);
    await execution.execute({ dispatcherId: DISPATCHER, taskId });

    const rejected = await execution.sendInput({
      dispatcherId: DISPATCHER,
      taskId,
      inputId: 'input_1',
      text: 'stop now',
      mode: 'interrupt',
    });
    expect(rejected).toEqual({
      delivered: true,
      disposition: { status: 'rejected', reason: 'interrupt not supported mid-turn' },
    });
    // A rejected input is not recorded by the fake worker.
    expect(fake.inputsFor(taskId)).toEqual([]);
  });

  it('selects the provider pinned on the task', async () => {
    const codexLike = new FakeTeamMateWorkerProvider({ ref: 'builtin:codex' });
    const other = new FakeTeamMateWorkerProvider({ ref: FAKE_TEAMMATE_WORKER_REF });
    const { ledger, execution } = buildHarness(
      new TeamMateWorkerProviderCatalog({
        providers: [other, codexLike],
        defaultRef: FAKE_TEAMMATE_WORKER_REF,
      }),
    );
    const taskId = await acceptTask(ledger, { providerRef: 'builtin:codex' });

    const outcome = (await execution.execute({
      dispatcherId: DISPATCHER,
      taskId,
    })) as Extract<TeamMateExecutionOutcome, { status: 'running' }>;
    expect(outcome.provider_ref).toBe('builtin:codex');
  });

  it('wakes a waiter when the worker completes mid-wait', async () => {
    const fake = new FakeTeamMateWorkerProvider();
    const { ledger, broker, execution } = buildHarness(
      new TeamMateWorkerProviderCatalog({ providers: [fake] }),
    );
    const { awaitTeamMateCompletion } = await import(
      '../src/teammate/wait-broker.js'
    );
    const taskId = await acceptTask(ledger);
    await execution.execute({ dispatcherId: DISPATCHER, taskId });
    const running = await ledger.getTask(taskId);

    const waiting = awaitTeamMateCompletion(broker, {
      dispatcherId: DISPATCHER,
      taskId,
      afterEventId: running!.events[running!.events.length - 1]!.event_id,
      until: new Set(['completed', 'failed', 'cancelled'] as const),
      timeoutMs: 3000,
      loadTask: () => ledger.getTask(taskId),
    });

    await fake.emitCompleted(taskId, 'finished while waiting');
    const outcome = await waiting;
    expect(outcome.status).toBe('reached');
  });
});
