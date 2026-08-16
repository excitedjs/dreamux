import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { mkdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  dispatcherCronJobsPath,
  dispatcherTeamCronJobsPath,
  resetRuntimeConfig,
} from '../src/platform/paths.js';
import { SchedulerService } from '../src/service/scheduler/service.js';
import {
  CronJobStore,
  detectLegacyCronJobStore,
  type CronJob,
} from '../src/service/scheduler/store.js';
import type {
  AgentRuntime,
  AgentRuntimeCapabilities,
  AgentRuntimeStatus,
  InboundDeliveryResult,
} from '@excitedjs/dreamux-types';

describe('CronJobStore', () => {
  let root: string;
  let previousHome: string | undefined;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'dreamux-scheduler-'));
    previousHome = process.env['HOME'];
    process.env['HOME'] = join(root, 'home');
    process.env['DREAMUX_ROOT'] = join(root, 'dreamux');
    resetRuntimeConfig();
  });

  afterEach(() => {
    if (previousHome === undefined) delete process.env['HOME'];
    else process.env['HOME'] = previousHome;
    delete process.env['DREAMUX_ROOT'];
    resetRuntimeConfig();
    rmSync(root, { recursive: true, force: true });
  });

  it('treats a missing cron store as empty and fails loud on a bad version', async () => {
    const store = cronStore('flow', dispatcherCronJobsPath('flow'));
    await expect(store.list()).resolves.toEqual([]);

    const path = dispatcherCronJobsPath('flow');
    await mkdir(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({ version: 99, jobs: [] }), {
      mode: 0o600,
    });
    await expect(detectLegacyCronJobStore(path, 'flow')).resolves.toMatch(
      /not version 1/,
    );
  });

  it('preflights persisted cron semantics before scheduler start', async () => {
    const path = dispatcherCronJobsPath('flow');
    await mkdir(dirname(path), { recursive: true });
    writeFileSync(path, cronStoreJson({ cron: 'not a cron' }), { mode: 0o600 });
    await expect(detectLegacyCronJobStore(path, 'flow')).resolves.toMatch(
      /invalid job 'job-1'/,
    );

    writeFileSync(path, cronStoreJson({ tz: 'Mars/Base' }), { mode: 0o600 });
    await expect(detectLegacyCronJobStore(path, 'flow')).resolves.toMatch(
      /invalid job 'job-1'/,
    );
  });

  it('isolates dispatcher and team stores by path while keeping dispatcher_id unchanged', async () => {
    const dispatcher = cronStore('flow', dispatcherCronJobsPath('flow'));
    const team = cronStore('flow', dispatcherTeamCronJobsPath('flow', 'alpha'));

    const dispatcherJob = await dispatcher.create(
      cronCreateInput('dispatcher job'),
      128,
    );
    const teamJob = await team.create(cronCreateInput('team job'), 128);

    expect(dispatcherJob.dispatcher_id).toBe('flow');
    expect(teamJob.dispatcher_id).toBe('flow');
    expect((await dispatcher.list()).map((job) => job.action.prompt)).toEqual([
      'dispatcher job',
    ]);
    expect((await team.list()).map((job) => job.action.prompt)).toEqual([
      'team job',
    ]);
  });

  it('stays deleted when deleteStoreFile races an in-flight fire (dissolve)', async () => {
    const path = dispatcherTeamCronJobsPath('flow', 'alpha');
    const store = cronStore('flow', path);
    const job = await store.create(cronCreateInput('team job'), 128);

    // dissolve's deleteStoreFile and a scheduled fire's setFired run concurrently;
    // both go through the store's exclusive queue, so no in-flight write can
    // recreate the file after the unlink.
    const fired = store.setFired({
      id: job.id,
      firedAt: Date.now(),
      nextRunAt: null,
      enabled: false,
    });
    const deleted = store.deleteStoreFile();
    await Promise.all([fired, deleted]);
    await expect(stat(path)).rejects.toMatchObject({ code: 'ENOENT' });

    // A fire that lands AFTER the delete reads the missing file, finds no job,
    // and returns null without recreating it.
    const late = await store.setFired({
      id: job.id,
      firedAt: Date.now(),
      nextRunAt: null,
      enabled: true,
    });
    expect(late).toBeNull();
    await expect(stat(path)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

describe('SchedulerService timer dispatch', () => {
  let root: string;
  let previousHome: string | undefined;

  beforeEach(() => {
    // Fake timers make the minute-boundary cron fire deterministic without any
    // real minute wait. Real fs I/O in the store still settles when a captured
    // dispatch promise (or the idle "reached" signal) is awaited, so no helper
    // polls a real `setTimeout`.
    vi.useFakeTimers();
    root = mkdtempSync(join(tmpdir(), 'dreamux-scheduler-'));
    previousHome = process.env['HOME'];
    process.env['HOME'] = join(root, 'home');
    process.env['DREAMUX_ROOT'] = join(root, 'dreamux');
    resetRuntimeConfig();
  });

  afterEach(() => {
    if (previousHome === undefined) delete process.env['HOME'];
    else process.env['HOME'] = previousHome;
    delete process.env['DREAMUX_ROOT'];
    resetRuntimeConfig();
    vi.useRealTimers();
    rmSync(root, { recursive: true, force: true });
  });

  it('waits for idle and advances last_fired_at only after submitted', async () => {
    const idle = controllableIdle();
    const submitted: string[] = [];
    const captured = new CapturedAdmissions();
    const scheduler = service(idle.runtime, async (input) => {
      submitted.push(input.prompt);
      return { status: 'submitted' };
    }, { captured });
    await scheduler.start();
    await scheduler.create({
      cron: '* * * * *',
      prompt: 'run report',
      tz: 'UTC',
    });

    await captured.advanceMinute();
    const fire = captured.lastDispatch();
    await idle.whenReached();
    expect(submitted).toEqual([]);

    idle.resolve();
    await fire;
    expect(submitted).toEqual(['run report']);
    const jobs = (await scheduler.list()).jobs;
    expect(jobs[0]?.last_fired_at).toEqual(expect.any(Number));
    scheduler.stop();
  });

  it('uses a fresh sourceId for each fire of the same recurring job', async () => {
    const idle = controllableIdle();
    const submitted: Array<{ jobId: string; prompt: string; sourceId: string }> = [];
    const captured = new CapturedAdmissions();
    const scheduler = service(idle.runtime, async (input) => {
      submitted.push(input);
      return { status: 'submitted' };
    }, { captured });
    await scheduler.start();
    const job = await scheduler.create({
      cron: '* * * * *',
      prompt: 'run report',
      tz: 'UTC',
    });

    await captured.advanceMinute();
    const first = captured.lastDispatch();
    await idle.whenReached();
    idle.resolve();
    await first;

    await captured.advanceMinute();
    const second = captured.lastDispatch();
    await idle.whenReached();
    idle.resolve();
    await second;

    expect(submitted.map((input) => input.sourceId)).toEqual([
      `scheduled:${job.id}:1`,
      `scheduled:${job.id}:2`,
    ]);
    scheduler.stop();
  });

  it('does not advance last_fired_at when submission is not submitted', async () => {
    const idle = controllableIdle();
    const captured = new CapturedAdmissions();
    const scheduler = service(idle.runtime, async () => ({ status: 'stopped' }), {
      captured,
    });
    await scheduler.start();
    await scheduler.create({
      cron: '* * * * *',
      prompt: 'run report',
      tz: 'UTC',
    });

    await captured.advanceMinute();
    const fire = captured.lastDispatch();
    await idle.whenReached();
    idle.resolve();
    await fire;
    const persisted = (await scheduler.list()).jobs[0];
    expect(persisted?.last_fired_at).toBeNull();
    expect(persisted?.enabled).toBe(true);
    expect(persisted?.next_run_at).toEqual(expect.any(Number));
    expect(persisted!.next_run_at).toBeGreaterThan(Date.now());
    scheduler.stop();
  });

  it('does not resurrect a job deleted while held for idle', async () => {
    const idle = controllableIdle();
    const submitted: string[] = [];
    const captured = new CapturedAdmissions();
    const scheduler = service(idle.runtime, async (input) => {
      submitted.push(input.prompt);
      return { status: 'submitted' };
    }, { captured });
    await scheduler.start();
    const job = await scheduler.create({
      cron: '* * * * *',
      prompt: 'run report',
      tz: 'UTC',
    });

    await captured.advanceMinute();
    const fire = captured.lastDispatch();
    await idle.whenReached();
    await scheduler.delete(job.id);
    idle.resolve();

    await fire;
    expect(submitted).toEqual([]);
    expect((await scheduler.list()).jobs).toEqual([]);
    scheduler.stop();
  });

  it('re-arms a recurring job after a transient dispatch error and fires it next', async () => {
    // The dispatch-error re-arm is now unconditional timer behavior: a transient
    // submit failure must not silently kill a recurring schedule until the next
    // daemon restart.
    let calls = 0;
    const submitted: string[] = [];
    const captured = new CapturedAdmissions();
    const scheduler = service(
      () => null,
      async (input) => {
        calls += 1;
        if (calls === 1) throw new Error('transient submit failure');
        submitted.push(input.prompt);
        return { status: 'submitted' };
      },
      { captured, absentRuntimeStrategy: 'submit' },
    );
    await scheduler.start();
    await scheduler.create({
      cron: '* * * * *',
      prompt: 'run report',
      tz: 'UTC',
    });

    await captured.advanceMinute();
    const failed = captured.lastDispatch();
    await failed;
    expect(submitted).toEqual([]);
    expect((await scheduler.list()).jobs[0]?.last_fired_at).toBeNull();
    expect((await scheduler.list()).jobs[0]?.enabled).toBe(true);

    await captured.advanceMinute();
    const recovered = captured.lastDispatch();
    await recovered;
    expect(submitted).toEqual(['run report']);
    expect((await scheduler.list()).jobs[0]?.last_fired_at).toEqual(
      expect.any(Number),
    );
    scheduler.stop();
  });

  it('preserves action metadata when update only changes prompt', async () => {
    const idle = controllableIdle();
    const scheduler = service(idle.runtime, async () => ({ status: 'stopped' }));
    const job = await scheduler.create({
      cron: '* * * * *',
      prompt: 'run report',
      tz: 'UTC',
      action: { kind: 'prompt-agent', prompt: 'run report', intent: 'report' },
    });

    const updated = await scheduler.update({
      id: job.id,
      prompt: 'run revised report',
    });

    expect(updated.action).toEqual({
      kind: 'prompt-agent',
      prompt: 'run revised report',
      intent: 'report',
    });
  });

  it('keeps next_run_at null when a prompt-only update leaves a job disabled', async () => {
    const idle = controllableIdle();
    const scheduler = service(idle.runtime, async () => ({ status: 'stopped' }));
    const job = await scheduler.create({
      cron: '* * * * *',
      prompt: 'run report',
      tz: 'UTC',
    });

    const disabled = await scheduler.update({ id: job.id, enabled: false });
    expect(disabled.next_run_at).toBeNull();

    const renamed = await scheduler.update({
      id: job.id,
      prompt: 'run revised report',
    });
    expect(renamed.enabled).toBe(false);
    expect(renamed.next_run_at).toBeNull();
  });

  it('stop cancels a held fire before idle and does not submit', async () => {
    const idle = controllableIdle();
    const submitted: string[] = [];
    const captured = new CapturedAdmissions();
    const scheduler = service(idle.runtime, async (input) => {
      submitted.push(input.prompt);
      return { status: 'submitted' };
    }, { captured });
    await scheduler.start();
    await scheduler.create({
      cron: '* * * * *',
      prompt: 'run report',
      tz: 'UTC',
    });

    await captured.advanceMinute();
    const fire = captured.lastDispatch();
    await idle.whenReached();
    scheduler.stop();

    await fire;
    expect(submitted).toEqual([]);
    idle.resolve();
    expect(submitted).toEqual([]);
  });

  it('does not submit when stop() races in during the pre-submit store read', async () => {
    const idle = controllableIdle();
    const submitted: string[] = [];
    const store = new HookOnGetStore();
    const captured = new CapturedAdmissions();
    const scheduler = service(
      idle.runtime,
      async (input) => {
        submitted.push(input.prompt);
        return { status: 'submitted' };
      },
      { store, captured },
    );
    await scheduler.start();
    await scheduler.create({
      cron: '* * * * *',
      prompt: 'run report',
      tz: 'UTC',
    });

    await captured.advanceMinute();
    const fire = captured.lastDispatch();
    await idle.whenReached();
    // The dispatch-entry read already happened; arm the hook so the NEXT read
    // (the pre-submit one) stops the scheduler inside its async gap.
    store.stopHook = () => scheduler.stop();
    idle.resolve();

    await fire;
    expect(submitted).toEqual([]);
  });

  it('does not complete a fire when stop() races after lazy submit starts', async () => {
    let finishSubmit: (() => void) | null = null;
    const submitStarted = deferred<void>();
    const submitted: string[] = [];
    const captured = new CapturedAdmissions();
    const scheduler = service(
      () => null,
      async (input) => {
        submitted.push(input.prompt);
        scheduler.stop();
        submitStarted.resolve();
        await new Promise<void>((resolve) => {
          finishSubmit = resolve;
        });
        return { status: 'submitted' };
      },
      { captured, absentRuntimeStrategy: 'submit' },
    );
    await scheduler.start();
    await scheduler.create({
      cron: '* * * * *',
      prompt: 'run report',
      tz: 'UTC',
    });

    await captured.advanceMinute();
    const fire = captured.lastDispatch();
    await submitStarted.promise;
    finishSubmit!();

    await fire;
    expect(submitted).toEqual(['run report']);
    const jobs = (await scheduler.list()).jobs;
    expect(jobs[0]?.last_fired_at).toBeNull();
  });

  it('drops a queued timer admission after stop changes the lifecycle generation', async () => {
    const store = new CountingGetStore();
    const admission = new CapturedAdmissions();
    let runtimeLookups = 0;
    const idle = controllableIdle();
    const submitted: string[] = [];
    const scheduler = service(
      () => {
        runtimeLookups += 1;
        return idle.runtime;
      },
      async (input) => {
        submitted.push(input.prompt);
        return { status: 'submitted' };
      },
      { store, captured: admission },
    );
    await scheduler.start();
    await scheduler.create({
      cron: '* * * * *',
      prompt: 'run report',
      tz: 'UTC',
    });
    const queued = admission.queueNext();

    await admission.advanceMinute();
    const fire = admission.lastDispatch();
    await queued.whenAdmitted;
    expect(store.getCalls).toBe(0);

    scheduler.stop();
    queued.release();
    await fire;

    expect(store.getCalls).toBe(0);
    expect(runtimeLookups).toBe(0);
    expect(idle.waitCalls()).toBe(0);
    expect(submitted).toEqual([]);
    expect((await scheduler.list()).jobs[0]).toMatchObject({
      enabled: true,
      last_fired_at: null,
    });
  });

  it('collapses a re-armed fire for the same job while its first fire is held', async () => {
    const idle = controllableIdle();
    const submitted: Array<{ prompt: string; sourceId: string }> = [];
    const captured = new CapturedAdmissions();
    const scheduler = service(idle.runtime, async (input) => {
      submitted.push({ prompt: input.prompt, sourceId: input.sourceId });
      return { status: 'submitted' };
    }, { captured });
    await scheduler.start();
    const job = await scheduler.create({
      cron: '* * * * *',
      prompt: 'first prompt',
      tz: 'UTC',
    });

    await captured.advanceMinute();
    const firstFire = captured.lastDispatch();
    await idle.whenReached();
    await scheduler.update({ id: job.id, prompt: 'updated prompt' });

    await captured.advanceMinute();
    const collapsedFire = captured.lastDispatch();
    await collapsedFire;
    expect(idle.waitCalls()).toBe(1);
    expect(submitted).toEqual([]);

    idle.resolve();
    await firstFire;
    expect(submitted).toEqual([
      {
        prompt: 'updated prompt',
        sourceId: `scheduled:${job.id}:1`,
      },
    ]);
    expect((await scheduler.list()).jobs[0]?.last_fired_at).toEqual(
      expect.any(Number),
    );
    scheduler.stop();
  });

  it('rejects an empty title on create and update so a job stays reloadable', async () => {
    const idle = controllableIdle();
    const scheduler = service(idle.runtime, async () => ({ status: 'stopped' }));
    await expect(
      scheduler.create({ cron: '* * * * *', prompt: 'run report', tz: 'UTC', title: '' }),
    ).rejects.toThrow(/title must be a non-empty string/);

    const job = await scheduler.create({
      cron: '* * * * *',
      prompt: 'run report',
      tz: 'UTC',
    });
    await expect(
      scheduler.update({ id: job.id, title: '' }),
    ).rejects.toThrow(/title must be a non-empty string/);
  });

  it('rejects deliver and spawn-teammate in this milestone', async () => {
    const idle = controllableIdle();
    const scheduler = service(idle.runtime, async () => ({ status: 'stopped' }));
    await expect(
      scheduler.create({
        cron: '* * * * *',
        prompt: 'run report',
        tz: 'UTC',
        deliver: { channel_id: 'primary', target_key: 'chat-x' },
      }),
    ).rejects.toThrow(/deliver is not implemented/);
    await expect(
      scheduler.create({
        cron: '* * * * *',
        prompt: 'run report',
        tz: 'UTC',
        action: { kind: 'spawn-teammate', agent_runtime: 'codex' },
      }),
    ).rejects.toThrow(/spawn-teammate action is not implemented/);
  });

  it('marks null-runtime dispatcher fires missed but submits leader fires', async () => {
    const dispatcherCaptured = new CapturedAdmissions();
    const dispatcher = service(
      () => null,
      async () => ({ status: 'submitted' }),
      {
        captured: dispatcherCaptured,
        absentRuntimeStrategy: 'miss',
        cronJobsPath: dispatcherCronJobsPath('flow'),
      },
    );
    await dispatcher.start();
    const dispatcherJob = await dispatcher.create({
      cron: '* * * * *',
      prompt: 'dispatcher report',
      tz: 'UTC',
      recurring: false,
    });
    await dispatcherCaptured.advanceMinute();
    const dispatcherFire = dispatcherCaptured.lastDispatch();
    await dispatcherFire;
    expect((await dispatcher.list()).jobs[0]).toMatchObject({
      id: dispatcherJob.id,
      enabled: false,
      next_run_at: null,
      last_fired_at: null,
    });
    dispatcher.stop();

    const submitted: string[] = [];
    const leaderCaptured = new CapturedAdmissions();
    const leader = service(
      () => null,
      async (input) => {
        submitted.push(input.prompt);
        return { status: 'submitted' };
      },
      {
        captured: leaderCaptured,
        absentRuntimeStrategy: 'submit',
        cronJobsPath: dispatcherTeamCronJobsPath('flow', 'alpha'),
      },
    );
    await leader.start();
    await leader.create({
      cron: '* * * * *',
      prompt: 'leader report',
      tz: 'UTC',
    });
    await leaderCaptured.advanceMinute();
    const leaderFire = leaderCaptured.lastDispatch();
    await leaderFire;
    expect(submitted).toEqual(['leader report']);
    expect((await leader.list()).jobs[0]?.last_fired_at).toEqual(expect.any(Number));
    leader.stop();
  });

  it('records an admission-ambiguous timer fire without retrying it', async () => {
    const captured = new CapturedAdmissions();
    let submissions = 0;
    const scheduler = service(
      () => null,
      async () => {
        submissions += 1;
        return {
          status: 'ambiguous',
          error: new Error('native admission response was lost'),
        };
      },
      {
        captured,
        absentRuntimeStrategy: 'submit',
        cronJobsPath: dispatcherTeamCronJobsPath('flow', 'alpha'),
      },
    );
    await scheduler.start();
    await scheduler.create({
      cron: '* * * * *',
      prompt: 'leader report',
      tz: 'UTC',
      recurring: false,
    });

    await captured.advanceMinute();
    await captured.lastDispatch();

    expect(submissions).toBe(1);
    expect((await scheduler.list()).jobs[0]).toMatchObject({
      enabled: false,
      next_run_at: null,
      last_fired_at: expect.any(Number),
    });
    scheduler.stop();
  });

  it('stopping one live owner scheduler leaves another held fire intact', async () => {
    const firstIdle = controllableIdle();
    const secondIdle = controllableIdle();
    const firstSubmitted: string[] = [];
    const secondSubmitted: string[] = [];
    const firstCaptured = new CapturedAdmissions();
    const secondCaptured = new CapturedAdmissions();
    const first = service(
      () => firstIdle.runtime,
      async (input) => {
        firstSubmitted.push(input.prompt);
        return { status: 'submitted' };
      },
      {
        captured: firstCaptured,
        absentRuntimeStrategy: 'miss',
        cronJobsPath: dispatcherTeamCronJobsPath('flow', 'alpha'),
      },
    );
    const second = service(
      () => secondIdle.runtime,
      async (input) => {
        secondSubmitted.push(input.prompt);
        return { status: 'submitted' };
      },
      {
        captured: secondCaptured,
        absentRuntimeStrategy: 'miss',
        cronJobsPath: dispatcherTeamCronJobsPath('flow', 'beta'),
      },
    );
    await first.start();
    await second.start();
    const firstJob = await first.create({ cron: '* * * * *', prompt: 'alpha', tz: 'UTC' });
    const secondJob = await second.create({ cron: '* * * * *', prompt: 'beta', tz: 'UTC' });

    // Both schedulers share the fake clock, so a single advance fires both timers.
    await vi.advanceTimersByTimeAsync(60_000);
    const firstFire = firstCaptured.lastDispatch();
    const secondFire = secondCaptured.lastDispatch();
    await Promise.all([firstIdle.whenReached(), secondIdle.whenReached()]);
    first.stop();
    secondIdle.resolve();

    await firstFire;
    await secondFire;
    expect(firstSubmitted).toEqual([]);
    expect(secondSubmitted).toEqual(['beta']);
    expect((await first.list()).jobs[0]).toMatchObject({
      id: firstJob.id,
      last_fired_at: null,
    });
    expect((await second.list()).jobs[0]).toMatchObject({
      id: secondJob.id,
      last_fired_at: expect.any(Number),
    });
    second.stop();
  });
});

interface ServiceOptions {
  store?: CronJobStore;
  captured?: CapturedAdmissions;
  absentRuntimeStrategy?: 'miss' | 'submit';
  cronJobsPath?: string;
}

function service(
  runtime: AgentRuntime | (() => AgentRuntime | null),
  submitScheduled: (input: {
    jobId: string;
    prompt: string;
    sourceId: string;
  }) => Promise<InboundDeliveryResult>,
  options: ServiceOptions = {},
): SchedulerService {
  const captured = options.captured;
  const cronJobsPath = options.cronJobsPath ?? dispatcherCronJobsPath('flow');
  return new SchedulerService({
    ownerId: 'flow',
    store: options.store ?? cronStore('flow', cronJobsPath),
    absentRuntimeStrategy: options.absentRuntimeStrategy ?? 'miss',
    admit: (task) => (captured === undefined ? task() : captured.admit(task)),
    getWriter: () => {
      const current = typeof runtime === 'function' ? runtime() : runtime;
      return current === null
        ? null
        : { waitIdle: () => current.waitIdle?.() ?? Promise.resolve() };
    },
    submitScheduled,
    log: {
      error() {},
      warn() {},
      info() {},
      debug() {},
      trace() {},
    },
  });
}

/** Records the promises the scheduler admits so a test can await a timer-driven
 *  dispatch to completion (including the store's `setFired` write) without
 *  polling a real timer. Public mutations (`create` / `update` / `delete`) also
 *  enter the same gate, so a cron fire is the most-recently-admitted promise
 *  right after the fake clock crosses a minute boundary. */
class CapturedAdmissions {
  private readonly pending: Array<Promise<unknown>> = [];
  private queued:
    | {
        admitted: ReturnType<typeof deferred<void>>;
        release: ReturnType<typeof deferred<void>>;
      }
    | undefined;

  admit<T>(task: () => Promise<T>): Promise<T> {
    const queued = this.queued;
    this.queued = undefined;
    const run =
      queued === undefined
        ? task()
        : (async () => {
            queued.admitted.resolve();
            await queued.release.promise;
            return task();
          })();
    this.pending.push(run as Promise<unknown>);
    return run;
  }

  queueNext(): { whenAdmitted: Promise<void>; release(): void } {
    if (this.queued !== undefined) {
      throw new Error('an admission is already queued');
    }
    const admitted = deferred<void>();
    const release = deferred<void>();
    this.queued = { admitted, release };
    return {
      whenAdmitted: admitted.promise,
      release: () => release.resolve(),
    };
  }

  /** Advance the fake clock past the next minute boundary. The fired timer
   *  callback synchronously admits the cron dispatch, so `lastDispatch()`
   *  called immediately after (before any further mutation) returns it. */
  async advanceMinute(): Promise<void> {
    await vi.advanceTimersByTimeAsync(60_000);
  }

  /** The most-recently-admitted promise. Call right after `advanceMinute()` and
   *  before any subsequent mutation so it is the cron dispatch. Return it
   *  un-awaited so a test can observe the parked (held) state before releasing
   *  idle, then await the same handle once. */
  lastDispatch(): Promise<void> {
    const dispatch = this.pending.at(-1);
    if (dispatch === undefined) throw new Error('no admitted dispatch');
    return dispatch as Promise<void>;
  }
}

/** A store that runs a one-shot hook right after a `get()` resolves — used to
 *  inject a `stop()` into the pre-submit store-read gap deterministically. */
class HookOnGetStore extends CronJobStore {
  stopHook: (() => void) | null = null;
  constructor() {
    super({ dispatcherId: 'flow', cronJobsPath: dispatcherCronJobsPath('flow') });
  }
  override async get(id: string): Promise<CronJob | null> {
    const result = await super.get(id);
    const hook = this.stopHook;
    this.stopHook = null;
    hook?.();
    return result;
  }
}

class CountingGetStore extends CronJobStore {
  getCalls = 0;

  constructor() {
    super({ dispatcherId: 'flow', cronJobsPath: dispatcherCronJobsPath('flow') });
  }

  override async get(id: string): Promise<CronJob | null> {
    this.getCalls += 1;
    return super.get(id);
  }
}

function cronStore(dispatcherId: string, cronJobsPath: string): CronJobStore {
  return new CronJobStore({ dispatcherId, cronJobsPath });
}

function cronCreateInput(prompt: string) {
  return {
    cron: '* * * * *',
    tz: 'UTC',
    recurring: true,
    action: { kind: 'prompt-agent' as const, prompt },
    nextRunAt: Date.now() + 60_000,
  };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function controllableIdle(): {
  runtime: AgentRuntime;
  whenReached(): Promise<void>;
  resolve(): void;
  waitCalls(): number;
} {
  let resolveIdle: (() => void) | null = null;
  let reachedResolve: (() => void) | null = null;
  let reachedFlag = false;
  let waitCalls = 0;
  const runtime: AgentRuntime = {
    providerRef: 'test',
    async start() {},
    async resume() {},
    async stop() {},
    async channelInput() {
      return { status: 'stopped' };
    },
    async completionInput() {
      return { status: 'stopped' };
    },
    waitIdle() {
      waitCalls += 1;
      return new Promise<void>((resolve) => {
        resolveIdle = resolve;
        reachedFlag = true;
        reachedResolve?.();
        reachedResolve = null;
      });
    },
    getStatus(): AgentRuntimeStatus {
      return 'ready';
    },
    getCheckpoint() {
      return { id: 'thread' };
    },
    wasCheckpointResumed() {
      return false;
    },
    async getLast() {
      return null;
    },
    async getContext() {
      return null;
    },
    getCapabilities(): AgentRuntimeCapabilities {
      return {
        resume: { supported: false },
      };
    },
  };
  return {
    runtime,
    // Resolves once the dispatch has installed its idle wait. Awaiting a real
    // promise lets the preceding real fs reads settle deterministically.
    async whenReached() {
      if (reachedFlag) return;
      await new Promise<void>((resolve) => {
        reachedResolve = resolve;
      });
    },
    resolve() {
      resolveIdle?.();
      resolveIdle = null;
      reachedFlag = false;
    },
    waitCalls() {
      return waitCalls;
    },
  };
}

function cronStoreJson(overrides: Record<string, unknown>): string {
  const now = Date.now();
  return `${JSON.stringify({
    version: 1,
    jobs: [
      {
        id: 'job-1',
        dispatcher_id: 'flow',
        cron: '* * * * *',
        tz: 'UTC',
        recurring: true,
        action: { kind: 'prompt-agent', prompt: 'run report' },
        enabled: true,
        created_at: now,
        updated_at: now,
        next_run_at: now + 60_000,
        last_fired_at: null,
        ...overrides,
      },
    ],
  })}\n`;
}
