/**
 * Coverage cell E — scheduler half.
 *
 * Behavioral proof, against the real `CronJobStore` where the contract lives
 * at the file boundary, and against `SchedulerService` (with a hand-built
 * `CronJobStore` double only where precise call-timing control is the point)
 * where the contract is about ordering and generation, not persistence shape.
 */
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CronJobStore } from '../src/service/scheduler/store.js';
import { SchedulerService } from '../src/service/scheduler/service.js';
import { schedulerCommands } from '../src/service/scheduler/commands.js';
import type { SchedulerServiceOptions } from '../src/service/scheduler/types.js';
import { LegacyStateError } from '../src/service/legacy-state.js';
import type { CoreCommandHost } from '../src/command/host.js';
import { validateJsonSchema, SchemaViolation } from '../src/command/validate.js';
import {
  fakeCronStore,
  gate,
  silentLog,
  testCronJob,
  waitUntil,
} from './helpers/workflow-harness.js';

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'dreamux-cron-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function cronJobsPath(): string {
  return join(root, 'cron-jobs.json');
}

async function writeRawStoreFile(body: unknown): Promise<void> {
  const fs = await import('node:fs/promises');
  await fs.writeFile(cronJobsPath(), `${JSON.stringify(body, null, 2)}\n`, {
    mode: 0o600,
  });
}

function passthroughAdmit(): SchedulerServiceOptions['admit'] {
  return (task) => task();
}

describe('cron job store — prompt-agent-only schema, fail loud on the removed shapes', () => {
  it('rejects a persisted job carrying the removed spawn-teammate action kind', async () => {
    await writeRawStoreFile({
      version: 1,
      jobs: [
        {
          id: 'job-legacy',
          dispatcher_id: 'dispatcher-1',
          cron: '*/5 * * * *',
          tz: 'UTC',
          recurring: true,
          action: { kind: 'spawn-teammate', name: 'x', prompt: 'go' },
          enabled: true,
          created_at: 1,
          updated_at: 1,
          next_run_at: null,
          last_fired_at: null,
        },
      ],
    });
    const store = new CronJobStore({
      cronJobsPath: cronJobsPath(),
      dispatcherId: 'dispatcher-1',
    });

    await expect(store.list()).rejects.toThrow(LegacyStateError);
    await expect(store.list()).rejects.toThrow(/removed spawn-teammate action/);
  });

  it('rejects a persisted job carrying the removed top-level deliver field', async () => {
    await writeRawStoreFile({
      version: 1,
      jobs: [
        {
          id: 'job-legacy',
          dispatcher_id: 'dispatcher-1',
          cron: '*/5 * * * *',
          tz: 'UTC',
          recurring: true,
          action: { kind: 'prompt-agent', prompt: 'go' },
          deliver: { target: 'some-chat' },
          enabled: true,
          created_at: 1,
          updated_at: 1,
          next_run_at: null,
          last_fired_at: null,
        },
      ],
    });
    const store = new CronJobStore({
      cronJobsPath: cronJobsPath(),
      dispatcherId: 'dispatcher-1',
    });

    await expect(store.list()).rejects.toThrow(LegacyStateError);
    await expect(store.list()).rejects.toThrow(/removed deliver field/);
  });

  it('accepts a persisted prompt-agent job unchanged, as a control for the two rejections above', async () => {
    await writeRawStoreFile({
      version: 1,
      jobs: [
        {
          id: 'job-ok',
          dispatcher_id: 'dispatcher-1',
          cron: '*/5 * * * *',
          tz: 'UTC',
          recurring: true,
          action: { kind: 'prompt-agent', prompt: 'go', intent: 'daily check' },
          enabled: true,
          created_at: 1,
          updated_at: 1,
          next_run_at: null,
          last_fired_at: null,
        },
      ],
    });
    const store = new CronJobStore({
      cronJobsPath: cronJobsPath(),
      dispatcherId: 'dispatcher-1',
    });

    const jobs = await store.list();
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.action).toEqual({ kind: 'prompt-agent', prompt: 'go', intent: 'daily check' });
  });

  it('rejects a top-level removed deliver field on the scheduler.cron.create command payload itself', () => {
    // `SchedulerService.create()`'s own TS input type has no `deliver` field
    // (it never reads one), and the nested `action` DTO is deliberately an
    // open OBJECT (per `command/schema.ts`'s own doc comment) so field-level
    // rejection inside `action` is not this layer's job. The one place a
    // caller-supplied top-level `deliver` sibling is provably rejected before
    // it can reach the service is the closed (`additionalProperties: false`)
    // JSON Schema the create Command declares — the actual external "create
    // payload" boundary a Channel/MCP caller submits through.
    const definitions = schedulerCommands({} as unknown as CoreCommandHost);
    const create = definitions.find((def) => def.name === 'scheduler.cron.create');
    expect(create).toBeDefined();

    const payloadWithDeliver = {
      cron: '*/5 * * * *',
      prompt: 'go',
      deliver: { target: 'some-chat' },
    };
    expect(() => validateJsonSchema(payloadWithDeliver, create!.input)).toThrow(SchemaViolation);

    // Control: the same payload without the removed field validates cleanly.
    const { deliver: _unused, ...payloadWithoutDeliver } = payloadWithDeliver;
    expect(() => validateJsonSchema(payloadWithoutDeliver, create!.input)).not.toThrow();
  });
});

describe('SchedulerService.create — prompt-agent-only payload, fail loud before any durable write', () => {
  it('rejects an action.kind other than prompt-agent', async () => {
    const store = new CronJobStore({
      cronJobsPath: cronJobsPath(),
      dispatcherId: 'dispatcher-1',
    });
    const service = new SchedulerService({
      ownerId: 'dispatcher-1',
      store,
      admit: passthroughAdmit(),
      submitScheduled: vi.fn(async () => ({ status: 'submitted' as const })),
      log: silentLog(),
    });
    await service.start();

    await expect(
      service.create({
        cron: '*/5 * * * *',
        prompt: 'go',
        action: { kind: 'spawn-teammate', name: 'x' },
      }),
    ).rejects.toThrow(/action\.kind must be 'prompt-agent'/);

    // Fail-loud before any write: nothing durable was created.
    expect((await store.list())).toHaveLength(0);
  });
});

// A recurring cron is real 5-field granularity (>= 1 real minute apart), so
// `reconcile()` on `start()` treats any persisted `next_run_at` that is not
// strictly in the future as a miss and reschedules it a full cron period
// ahead rather than firing it (see "no missed-fire replay" below) — a fire
// can only be observed quickly by seeding `next_run_at` a few milliseconds
// ahead of the real clock, so `reconcile()` preserves it unchanged and the
// timer's own real-time recheck converges normally.
function dueSoon(): number {
  return Date.now() + 30;
}

describe('timer generation: a stopped timer cannot fire', () => {
  it('drops a fire whose generation was captured before stop() bumped it', async () => {
    const job = testCronJob({ id: 'job-a', next_run_at: dueSoon() });
    const fake = fakeCronStore([job]);
    const submitScheduled = vi.fn(async () => ({ status: 'submitted' as const }));
    const service = new SchedulerService({
      ownerId: 'dispatcher-1',
      store: fake.store,
      admit: passthroughAdmit(),
      submitScheduled,
      log: silentLog(),
    });

    // Hold the store.get() inside dispatch() open so the test can stop() the
    // scheduler in the window between "timer fired" and "generation checked".
    const hold = gate();
    fake.queueGetGate(hold.promise);

    await service.start();
    await waitUntil(() => fake.getCalls >= 1);
    service.stop(); // bumps lifecycleGeneration while dispatch() is paused on get()
    hold.release();

    // Give the resumed dispatch() a moment to observe the stale generation
    // and return without submitting.
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(submitScheduled).not.toHaveBeenCalled();
  });
});

describe('timer generation: durable revalidation immediately before submission', () => {
  it('never submits a job that was disabled during the window between the two store reads', async () => {
    const job = testCronJob({ id: 'job-a', next_run_at: dueSoon() });
    const fake = fakeCronStore([job]);
    const submitScheduled = vi.fn(async () => ({ status: 'submitted' as const }));
    const service = new SchedulerService({
      ownerId: 'dispatcher-1',
      store: fake.store,
      admit: passthroughAdmit(),
      submitScheduled,
      log: silentLog(),
    });

    // First get() (inside dispatch()) resolves immediately; second get()
    // (inside submitDue(), the read "immediately before submission") is held
    // open so the test can durably disable the job in that exact window.
    fake.queueGetGate(Promise.resolve());
    const hold = gate();
    fake.queueGetGate(hold.promise);

    await service.start();
    await waitUntil(() => fake.getCalls >= 2);
    const current = fake.jobs.get('job-a')!;
    fake.jobs.set('job-a', { ...current, enabled: false });
    hold.release();

    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(submitScheduled).not.toHaveBeenCalled();
  });
});

describe('no missed-fire replay: a past-due next_run_at on start() re-arms, it does not fire', () => {
  it('reconcile() treats a next_run_at already in the past as a miss and reschedules strictly ahead, never submitting for it', async () => {
    const missedAt = Date.now() - 60_000; // a whole recurring period in the past
    const job = testCronJob({ id: 'job-a', next_run_at: missedAt });
    const store = new CronJobStore({ cronJobsPath: cronJobsPath(), dispatcherId: 'dispatcher-1' });
    await writeRawStoreFile({ version: 1, jobs: [job] });
    const submitScheduled = vi.fn(async () => ({ status: 'submitted' as const }));
    const service = new SchedulerService({
      ownerId: 'dispatcher-1',
      store,
      admit: passthroughAdmit(),
      submitScheduled,
      log: silentLog(),
    });

    await service.start();
    // Give the timer loop several ticks worth of wall-clock time to prove
    // this is a durable "never fires for the missed occurrence", not merely
    // "hasn't fired yet".
    await new Promise((resolve) => setTimeout(resolve, 150));
    service.stop();

    expect(submitScheduled).not.toHaveBeenCalled();
    const after = await store.get('job-a');
    expect(after?.last_fired_at).toBeNull();
    // Re-armed strictly into the future, not left pointing at the missed
    // instant and not replayed as an immediate fire.
    expect(after?.next_run_at).not.toBeNull();
    expect(after?.next_run_at).toBeGreaterThan(Date.now() - 1);
    expect(after?.next_run_at).toBeGreaterThan(missedAt);
  });
});

describe('immediate fire and fold: no busy check, no held fire, no scheduler-specific signal', () => {
  it('submits with exactly {jobId, prompt, sourceId} and nothing else', async () => {
    const job = testCronJob({
      id: 'job-a',
      next_run_at: dueSoon(),
      action: { kind: 'prompt-agent', prompt: 'the prompt', intent: 'the intent' },
    });
    const store = new CronJobStore({ cronJobsPath: cronJobsPath(), dispatcherId: 'dispatcher-1' });
    await writeRawStoreFile({ version: 1, jobs: [job] });
    const submitScheduled = vi.fn(
      async (_input: { jobId: string; prompt: string; sourceId: string }) => ({
        status: 'submitted' as const,
      }),
    );
    const service = new SchedulerService({
      ownerId: 'dispatcher-1',
      store,
      admit: passthroughAdmit(),
      submitScheduled,
      log: silentLog(),
    });

    await service.start();
    await waitUntil(() => submitScheduled.mock.calls.length >= 1);
    await waitUntil(async () => (await store.get('job-a'))?.last_fired_at !== null);
    service.stop();

    expect(submitScheduled).toHaveBeenCalledTimes(1);
    const call = submitScheduled.mock.calls[0]![0] as Record<string, unknown>;
    expect(Object.keys(call).sort()).toEqual(['jobId', 'prompt', 'sourceId']);
    expect(call['jobId']).toBe('job-a');
    expect(call['prompt']).toBe('the prompt');
    expect(typeof call['sourceId']).toBe('string');
  });

  it('fires a second due job while the first is still awaiting submission — no serialization', async () => {
    const dueAt = dueSoon();
    const jobA = testCronJob({ id: 'job-a', next_run_at: dueAt });
    const jobB = testCronJob({ id: 'job-b', next_run_at: dueAt });
    const store = new CronJobStore({ cronJobsPath: cronJobsPath(), dispatcherId: 'dispatcher-1' });
    await writeRawStoreFile({ version: 1, jobs: [jobA, jobB] });

    const aHold = gate();
    const submitScheduled = vi.fn(async (input: { jobId: string }) => {
      if (input.jobId === 'job-a') await aHold.promise;
      return { status: 'submitted' as const };
    });
    const service = new SchedulerService({
      ownerId: 'dispatcher-1',
      store,
      admit: passthroughAdmit(),
      submitScheduled,
      log: silentLog(),
    });

    await service.start();
    // job-b must reach submitScheduled (and this scheduler must record its
    // fire) even though job-a's own submitScheduled call is still pending —
    // proof there is no shared queue or busy gate at the scheduler.
    await waitUntil(() =>
      submitScheduled.mock.calls.some((call) => call[0].jobId === 'job-b'));
    await waitUntil(async () => (await store.get('job-b'))?.last_fired_at !== null);
    const jobBAfter = await store.get('job-b');
    expect(jobBAfter?.last_fired_at).not.toBeNull();

    aHold.release();
    await waitUntil(() =>
      submitScheduled.mock.calls.some((call) => call[0].jobId === 'job-a'));
    // Let job-a's own setFired write settle before the test (and its
    // afterEach temp-dir removal) proceeds, so a concurrent atomic-write temp
    // file can never race the directory cleanup.
    await waitUntil(async () => (await store.get('job-a'))?.last_fired_at !== null);
    service.stop();
  });
});

describe('pre-admission failure and ambiguous admission keep generic semantics', () => {
  it('a failed submission is not retried and records no fire', async () => {
    const dueAt = dueSoon();
    const job = testCronJob({ id: 'job-a', next_run_at: dueAt });
    const store = new CronJobStore({ cronJobsPath: cronJobsPath(), dispatcherId: 'dispatcher-1' });
    await writeRawStoreFile({ version: 1, jobs: [job] });
    const submitScheduled = vi.fn(async () => ({
      status: 'failed' as const,
      error: new Error('runtime unavailable'),
    }));
    const service = new SchedulerService({
      ownerId: 'dispatcher-1',
      store,
      admit: passthroughAdmit(),
      submitScheduled,
      log: silentLog(),
    });

    await service.start();
    await waitUntil(() => submitScheduled.mock.calls.length >= 1);
    // Give the miss-rearm a moment to land, then confirm no retry ever fires.
    await new Promise((resolve) => setTimeout(resolve, 150));
    service.stop();

    expect(submitScheduled).toHaveBeenCalledTimes(1);
    const after = await store.get('job-a');
    expect(after?.last_fired_at).toBeNull();
    // Recurring job: missed fire re-arms a later occurrence rather than
    // disabling the schedule.
    expect(after?.next_run_at).not.toBeNull();
    expect(after?.next_run_at).toBeGreaterThan(dueAt);
  });

  it('an ambiguous submission is recorded as a fire and is not retried', async () => {
    const dueAt = dueSoon();
    const job = testCronJob({ id: 'job-a', next_run_at: dueAt });
    const store = new CronJobStore({ cronJobsPath: cronJobsPath(), dispatcherId: 'dispatcher-1' });
    await writeRawStoreFile({ version: 1, jobs: [job] });
    const submitScheduled = vi.fn(async () => ({
      status: 'ambiguous' as const,
      error: new Error('duplicate admission window'),
    }));
    const service = new SchedulerService({
      ownerId: 'dispatcher-1',
      store,
      admit: passthroughAdmit(),
      submitScheduled,
      log: silentLog(),
    });

    await service.start();
    await waitUntil(() => submitScheduled.mock.calls.length >= 1);
    await new Promise((resolve) => setTimeout(resolve, 150));
    service.stop();

    expect(submitScheduled).toHaveBeenCalledTimes(1);
    const after = await store.get('job-a');
    expect(after?.last_fired_at).not.toBeNull();
    expect(after?.last_fired_at).toBeGreaterThanOrEqual(dueAt);
    expect(after?.next_run_at).toBeGreaterThan(dueAt);
  });
});

describe('store deletion ordering (scheduler side of Team dissolve)', () => {
  it('a scheduler started after deleteStoreFile re-arms nothing because the store is gone', async () => {
    const job = testCronJob({ id: 'job-a', next_run_at: dueSoon() });
    const store = new CronJobStore({ cronJobsPath: cronJobsPath(), dispatcherId: 'dispatcher-1' });
    await writeRawStoreFile({ version: 1, jobs: [job] });

    const submitScheduled = vi.fn(async () => ({ status: 'submitted' as const }));
    const service = new SchedulerService({
      ownerId: 'dispatcher-1',
      store,
      admit: passthroughAdmit(),
      submitScheduled,
      log: silentLog(),
    });
    service.stop(); // dissolve stops the scheduler before deleting its store
    await service.deleteStoreFile();
    await expect(readFile(cronJobsPath())).rejects.toMatchObject({ code: 'ENOENT' });

    // A later start() (e.g. reopenAdmission() after a failed dissolve commit)
    // reads the now-empty store and arms nothing.
    const restarted = new SchedulerService({
      ownerId: 'dispatcher-1',
      store: new CronJobStore({ cronJobsPath: cronJobsPath(), dispatcherId: 'dispatcher-1' }),
      admit: passthroughAdmit(),
      submitScheduled,
      log: silentLog(),
    });
    await restarted.start();
    await new Promise((resolve) => setTimeout(resolve, 100));
    restarted.stop();

    expect(submitScheduled).not.toHaveBeenCalled();
    expect((await restarted.list()).jobs).toHaveLength(0);
  });

  it('setFired enqueued before deleteStoreFile still leaves the store deleted', async () => {
    const store = new CronJobStore({ cronJobsPath: cronJobsPath(), dispatcherId: 'dispatcher-1' });
    await writeRawStoreFile({ version: 1, jobs: [testCronJob({ id: 'job-a' })] });

    // No await between the two calls: `runExclusive` enqueues synchronously
    // at call time, so this ordering is deterministic — setFired's write
    // lands, then the delete removes what it just wrote.
    const setFired = store.setFired({ id: 'job-a', firedAt: 1, nextRunAt: null, enabled: false });
    const deleted = store.deleteStoreFile();
    const [setFiredResult] = await Promise.all([setFired, deleted]);

    expect(setFiredResult?.id).toBe('job-a');
    await expect(readFile(cronJobsPath())).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await store.list()).toEqual([]);
  });

  it('deleteStoreFile enqueued before setFired leaves setFired a durable no-op', async () => {
    const store = new CronJobStore({ cronJobsPath: cronJobsPath(), dispatcherId: 'dispatcher-1' });
    await writeRawStoreFile({ version: 1, jobs: [testCronJob({ id: 'job-a' })] });

    const deleted = store.deleteStoreFile();
    const setFired = store.setFired({ id: 'job-a', firedAt: 1, nextRunAt: null, enabled: false });
    const [, setFiredResult] = await Promise.all([deleted, setFired]);

    expect(setFiredResult).toBeNull();
    await expect(readFile(cronJobsPath())).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await store.list()).toEqual([]);
  });
});
