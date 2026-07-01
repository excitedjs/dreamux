import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { mkdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

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
  AgentRuntimeTurnResult,
} from '@excitedjs/dreamux-types';

describe('CronJobStore', () => {
  let root: string;
  let previousHome: string | undefined;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'dreamux-scheduler-'));
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

describe('SchedulerService dispatch', () => {
  let root: string;
  let previousHome: string | undefined;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'dreamux-scheduler-'));
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

  it('waits for idle and advances last_fired_at only after submitted', async () => {
    const idle = controllableIdle();
    const submitted: string[] = [];
    const scheduler = service(idle.runtime, async (input) => {
      submitted.push(input.prompt);
      return { status: 'submitted', turnId: 'turn-1' };
    });
    const job = await scheduler.create({
      cron: '* * * * *',
      prompt: 'run report',
      tz: 'UTC',
    });

    const run = scheduler.runNow(job.id);
    await waitFor(() => idle.pending());
    expect(submitted).toEqual([]);

    idle.resolve();
    await expect(run).resolves.toEqual({ id: job.id, status: 'submitted' });
    expect(submitted).toEqual(['run report']);
    const jobs = (await scheduler.list()).jobs;
    expect(jobs[0]?.last_fired_at).toEqual(expect.any(Number));
  });

  it('does not advance last_fired_at when submission is not submitted', async () => {
    const idle = controllableIdle();
    const scheduler = service(idle.runtime, async () => ({ status: 'stopped' }));
    const job = await scheduler.create({
      cron: '* * * * *',
      prompt: 'run report',
      tz: 'UTC',
    });

    const run = scheduler.runNow(job.id);
    await waitFor(() => idle.pending());
    idle.resolve();
    await expect(run).resolves.toEqual({ id: job.id, status: 'stopped' });
    const jobs = (await scheduler.list()).jobs;
    expect(jobs[0]?.last_fired_at).toBeNull();
  });

  it('does not resurrect a job deleted while held for idle', async () => {
    const idle = controllableIdle();
    const submitted: string[] = [];
    const scheduler = service(idle.runtime, async (input) => {
      submitted.push(input.prompt);
      return { status: 'submitted', turnId: 'turn-1' };
    });
    const job = await scheduler.create({
      cron: '* * * * *',
      prompt: 'run report',
      tz: 'UTC',
    });

    const run = scheduler.runNow(job.id);
    await waitFor(() => idle.pending());
    await scheduler.delete(job.id);
    idle.resolve();

    await expect(run).resolves.toEqual({ id: job.id, status: 'skipped' });
    expect(submitted).toEqual([]);
    expect((await scheduler.list()).jobs).toEqual([]);
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
    const scheduler = service(idle.runtime, async (input) => {
      submitted.push(input.prompt);
      return { status: 'submitted', turnId: 'turn-1' };
    });
    const job = await scheduler.create({
      cron: '* * * * *',
      prompt: 'run report',
      tz: 'UTC',
    });

    const run = scheduler.runNow(job.id);
    await waitFor(() => idle.pending());
    scheduler.stop();

    await expect(run).resolves.toEqual({ id: job.id, status: 'skipped' });
    expect(submitted).toEqual([]);
    idle.resolve();
    expect(submitted).toEqual([]);
  });

  it('does not submit when stop() races in during the pre-submit store read', async () => {
    const idle = controllableIdle();
    const submitted: string[] = [];
    const store = new HookOnGetStore();
    const scheduler = service(
      idle.runtime,
      async (input) => {
        submitted.push(input.prompt);
        return { status: 'submitted', turnId: 'turn-1' };
      },
      store,
    );
    const job = await scheduler.create({
      cron: '* * * * *',
      prompt: 'run report',
      tz: 'UTC',
    });

    const run = scheduler.runNow(job.id);
    await waitFor(() => idle.pending());
    // The dispatch-entry read already happened; arm the hook so the NEXT read
    // (the pre-submit one) stops the scheduler inside its async gap.
    store.stopHook = () => scheduler.stop();
    idle.resolve();

    await expect(run).resolves.toEqual({ id: job.id, status: 'skipped' });
    expect(submitted).toEqual([]);
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
    const dispatcher = service(
      () => null,
      async () => ({ status: 'submitted', turnId: 'turn-unexpected' }),
      undefined,
      'miss',
      dispatcherCronJobsPath('flow'),
    );
    const dispatcherJob = await dispatcher.create({
      cron: '* * * * *',
      prompt: 'dispatcher report',
      tz: 'UTC',
      recurring: false,
    });
    await expect(dispatcher.runNow(dispatcherJob.id)).resolves.toEqual({
      id: dispatcherJob.id,
      status: 'missed',
    });
    expect((await dispatcher.list()).jobs[0]?.last_fired_at).toBeNull();

    const submitted: string[] = [];
    const leader = service(
      () => null,
      async (input) => {
        submitted.push(input.prompt);
        return { status: 'submitted', turnId: 'turn-1' };
      },
      undefined,
      'submit',
      dispatcherTeamCronJobsPath('flow', 'alpha'),
    );
    const leaderJob = await leader.create({
      cron: '* * * * *',
      prompt: 'leader report',
      tz: 'UTC',
    });
    await expect(leader.runNow(leaderJob.id)).resolves.toEqual({
      id: leaderJob.id,
      status: 'submitted',
    });
    expect(submitted).toEqual(['leader report']);
    expect((await leader.list()).jobs[0]?.last_fired_at).toEqual(expect.any(Number));
  });

  it('stopping one live owner scheduler leaves another held fire intact', async () => {
    const firstIdle = controllableIdle();
    const secondIdle = controllableIdle();
    const firstSubmitted: string[] = [];
    const secondSubmitted: string[] = [];
    const first = service(
      () => firstIdle.runtime,
      async (input) => {
        firstSubmitted.push(input.prompt);
        return { status: 'submitted', turnId: 'turn-1' };
      },
      undefined,
      'miss',
      dispatcherTeamCronJobsPath('flow', 'alpha'),
    );
    const second = service(
      () => secondIdle.runtime,
      async (input) => {
        secondSubmitted.push(input.prompt);
        return { status: 'submitted', turnId: 'turn-2' };
      },
      undefined,
      'miss',
      dispatcherTeamCronJobsPath('flow', 'beta'),
    );
    const firstJob = await first.create({ cron: '* * * * *', prompt: 'alpha', tz: 'UTC' });
    const secondJob = await second.create({ cron: '* * * * *', prompt: 'beta', tz: 'UTC' });

    const firstRun = first.runNow(firstJob.id);
    const secondRun = second.runNow(secondJob.id);
    await waitFor(() => firstIdle.pending() && secondIdle.pending());
    first.stop();
    secondIdle.resolve();

    await expect(firstRun).resolves.toEqual({ id: firstJob.id, status: 'skipped' });
    await expect(secondRun).resolves.toEqual({ id: secondJob.id, status: 'submitted' });
    expect(firstSubmitted).toEqual([]);
    expect(secondSubmitted).toEqual(['beta']);
  });
});

function service(
  runtime: AgentRuntime | (() => AgentRuntime | null),
  submitScheduled: (input: {
    jobId: string;
    prompt: string;
  }) => Promise<AgentRuntimeTurnResult>,
  store?: CronJobStore,
  absentRuntimeStrategy: 'miss' | 'submit' = 'miss',
  cronJobsPath = dispatcherCronJobsPath('flow'),
): SchedulerService {
  return new SchedulerService({
    ownerId: 'flow',
    store: store ?? cronStore('flow', cronJobsPath),
    absentRuntimeStrategy,
    getRuntime: typeof runtime === 'function' ? runtime : () => runtime,
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

function controllableIdle(): {
  runtime: AgentRuntime;
  pending(): boolean;
  resolve(): void;
} {
  let resolveIdle: (() => void) | null = null;
  const runtime: AgentRuntime = {
    providerRef: 'test',
    async start() {},
    async resume() {},
    async stop() {},
    async channelInput() {
      return { status: 'stopped' };
    },
    async systemInput() {
      return { status: 'stopped' };
    },
    waitIdle() {
      return new Promise<void>((resolve) => {
        resolveIdle = resolve;
      });
    },
    getStatus(): AgentRuntimeStatus {
      return 'ready';
    },
    getCheckpoint() {
      return { kind: 'fakeThread', id: 'thread' };
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
        steer: { supported: false },
        events: { kind: 'push' },
        last: { supported: false },
        context: { supported: false },
        teammateCompletion: [],
      };
    },
  };
  return {
    runtime,
    pending() {
      return resolveIdle !== null;
    },
    resolve() {
      resolveIdle?.();
      resolveIdle = null;
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

async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('waitFor timed out');
}
