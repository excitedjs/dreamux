import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { resetRuntimeConfig } from '../src/platform/paths.js';
import { SchedulerService } from '../src/service/scheduler/service.js';
import {
  CronJobStore,
  detectLegacyCronJobStore,
  type CronJob,
} from '../src/service/scheduler/store.js';
import { dispatcherCronJobsPath } from '../src/platform/paths.js';
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
    const store = new CronJobStore();
    await expect(store.list('flow')).resolves.toEqual([]);

    const path = dispatcherCronJobsPath('flow');
    await mkdir(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({ version: 99, jobs: [] }), {
      mode: 0o600,
    });
    await expect(detectLegacyCronJobStore('flow')).resolves.toMatch(
      /not version 1/,
    );
  });

  it('preflights persisted cron semantics before scheduler start', async () => {
    const path = dispatcherCronJobsPath('flow');
    await mkdir(dirname(path), { recursive: true });
    writeFileSync(path, cronStoreJson({ cron: 'not a cron' }), { mode: 0o600 });
    await expect(detectLegacyCronJobStore('flow')).resolves.toMatch(
      /invalid job 'job-1'/,
    );

    writeFileSync(path, cronStoreJson({ tz: 'Mars/Base' }), { mode: 0o600 });
    await expect(detectLegacyCronJobStore('flow')).resolves.toMatch(
      /invalid job 'job-1'/,
    );
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
});

function service(
  runtime: AgentRuntime,
  submitScheduled: (input: {
    jobId: string;
    prompt: string;
  }) => Promise<AgentRuntimeTurnResult>,
  store?: CronJobStore,
): SchedulerService {
  return new SchedulerService({
    dispatcherId: 'flow',
    getRuntime: () => runtime,
    submitScheduled,
    ...(store !== undefined ? { store } : {}),
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
  override async get(dispatcherId: string, id: string): Promise<CronJob | null> {
    const result = await super.get(dispatcherId, id);
    const hook = this.stopHook;
    this.stopHook = null;
    hook?.();
    return result;
  }
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
    getThreadId() {
      return 'thread';
    },
    wasThreadResumed() {
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
        systemPrompt: { mode: 'replace' },
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
