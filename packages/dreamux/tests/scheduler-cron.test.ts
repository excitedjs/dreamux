import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createLogger } from '../src/platform/logger.js';
import { LegacyStateError } from '../src/platform/errors.js';
import { WorkFence } from '../src/platform/work-fence.js';
import {
  SchemaViolation,
  validateJsonSchema,
} from '../src/command/validate.js';
import { CronJobStore } from '../src/service/scheduler/store.js';
import { SchedulerService } from '../src/service/scheduler/index.js';
import { schedulerCommands } from '../src/service/scheduler/commands.js';
import type { CronJob } from '../src/service/scheduler/types.js';
import type { TeammateSubmitInput } from '../src/service/agent/submission.js';
import type { TurnAdmission } from '../src/service/agent/turn.js';
import { deferred } from './helpers/controlled-runtime-provider.js';
let root: string;
const scopes: Array<{ service: SchedulerService; fence: WorkFence }> = [];
const releases: Array<() => void> = [];
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'dreamux-cron-'));
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
  vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
});
afterEach(async () => {
  for (const release of releases.splice(0)) release();
  for (const { service } of scopes) service.stop();
  try {
    for (const { fence } of scopes.splice(0)) await fence.drain();
  } finally {
    vi.restoreAllMocks();
    vi.useRealTimers();
    await rm(root, { recursive: true, force: true });
  }
});
const path = () => join(root, 'cron-jobs.json');
const store = () => new CronJobStore(path());
const submitted = (): TurnAdmission => ({
  status: 'submitted',
  turn: {
    id: 'scheduled',
    settled: Promise.resolve({ status: 'completed', resultText: null }),
  },
});
function job(overrides: Partial<CronJob> = {}): CronJob {
  return {
    id: 'job-a',
    cron: '* * * * *',
    tz: 'UTC',
    recurring: true,
    action: { kind: 'prompt-agent', prompt: 'do the thing' },
    enabled: true,
    created_at: 1,
    updated_at: 1,
    next_run_at: Date.now() + 30,
    last_fired_at: null,
    ...overrides,
  };
}
async function seed(...jobs: unknown[]) {
  await writeFile(path(), JSON.stringify({ version: 1, jobs }), {
    mode: 0o600,
  });
}
function scheduler(
  submitInput: (input: TeammateSubmitInput) => Promise<TurnAdmission>,
) {
  const fence = new WorkFence('dispatcher-1');
  const service = new SchedulerService({
    ownerId: 'dispatcher-1',
    cronJobsPath: path(),
    fence,
    recipient: { submitInput },
    log: createLogger({ destination: { write() {} } }),
  });
  scopes.push({ service, fence });
  return { service, fence };
}
async function waitUntil(predicate: () => boolean | Promise<boolean>) {
  const end = performance.now() + 2000;
  while (!(await predicate())) {
    if (performance.now() > end) throw new Error('condition did not settle');
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}
async function fire(service: SchedulerService) {
  await service.start();
  await vi.advanceTimersByTimeAsync(30);
}
function createSchema() {
  const definition = schedulerCommands({} as never).find(
    (item) => item.name === 'scheduler.cron.create',
  );
  if (!definition) throw new Error('missing cron create');
  return definition.input;
}
describe('cron persistence and command boundaries', () => {
  it('rejects a persisted job carrying the removed spawn-teammate action kind', async () => {
    await seed({
      ...job(),
      action: { kind: 'spawn-teammate', name: 'x', prompt: 'go' },
    });
    await expect(store().list()).rejects.toThrow(LegacyStateError);
    await expect(store().list()).rejects.toThrow(
      /removed spawn-teammate action/,
    );
  });
  it('ignores the removed persisted deliver and dispatcher_id fields under R21', async () => {
    await seed({
      ...job(),
      deliver: { target: 'some-chat' },
      dispatcher_id: 'legacy-owner',
    });
    const [found] = await store().list();
    expect(found).toEqual(job());
    expect(found).not.toHaveProperty('deliver');
    expect(found).not.toHaveProperty('dispatcher_id');
  });
  it('accepts a persisted prompt-agent job and ignores its removed intent field', async () => {
    await seed({
      ...job(),
      action: { kind: 'prompt-agent', prompt: 'go', intent: 'daily check' },
    });
    expect((await store().list())[0]?.action).toEqual({
      kind: 'prompt-agent',
      prompt: 'go',
    });
  });
  it('rejects top-level deliver on the cron create command with a valid control', () => {
    expect(() =>
      validateJsonSchema(
        { cron: '*/5 * * * *', prompt: 'go', deliver: { target: 'chat' } },
        createSchema(),
      ),
    ).toThrow(SchemaViolation);
    expect(() =>
      validateJsonSchema({ cron: '*/5 * * * *', prompt: 'go' }, createSchema()),
    ).not.toThrow();
  });
  it('rejects a caller-supplied spawn action at the current command boundary before any durable write', async () => {
    expect(() =>
      validateJsonSchema(
        {
          cron: '*/5 * * * *',
          prompt: 'go',
          action: { kind: 'spawn-teammate', name: 'x' },
        },
        createSchema(),
      ),
    ).toThrow(SchemaViolation);
    expect(await store().list()).toEqual([]);
  });
});
describe('timer generation and durable revalidation', () => {
  it('drops a fire whose generation was captured before stop bumped it', async () => {
    await seed(job());
    const submit = vi.fn(async () => submitted());
    const { service, fence } = scheduler(submit);
    const entered = deferred<void>(),
      release = deferred<void>();
    releases.push(() => release.resolve());
    const original = CronJobStore.prototype.get;
    vi.spyOn(CronJobStore.prototype, 'get').mockImplementationOnce(
      async function (this: CronJobStore, id: string) {
        entered.resolve();
        await release.promise;
        return original.call(this, id);
      },
    );
    await fire(service);
    await entered.promise;
    service.stop();
    release.resolve();
    await fence.drain();
    expect(submit).not.toHaveBeenCalled();
  });
  it('never submits a job disabled before its single current store read resolves', async () => {
    await seed(job());
    const submit = vi.fn(async () => submitted());
    const { service, fence } = scheduler(submit);
    const entered = deferred<void>(),
      release = deferred<void>();
    releases.push(() => release.resolve());
    const original = CronJobStore.prototype.get;
    vi.spyOn(CronJobStore.prototype, 'get').mockImplementationOnce(
      async function (this: CronJobStore, id: string) {
        entered.resolve();
        await release.promise;
        return original.call(this, id);
      },
    );
    await fire(service);
    await entered.promise;
    await service.update({ id: 'job-a', enabled: false });
    release.resolve();
    await fence.drain();
    expect(submit).not.toHaveBeenCalled();
    expect((await store().get('job-a'))?.enabled).toBe(false);
  });
  it('rearms a missed recurring occurrence strictly into the future without replay', async () => {
    const missedAt = Date.now() - 60000;
    await seed(job({ next_run_at: missedAt }));
    const submit = vi.fn(async () => submitted());
    const { service, fence } = scheduler(submit);
    await service.start();
    await vi.advanceTimersByTimeAsync(150);
    await fence.drain();
    expect(submit).not.toHaveBeenCalled();
    const current = await store().get('job-a');
    expect(current?.last_fired_at).toBeNull();
    expect(current?.next_run_at).toBeGreaterThan(Date.now());
    expect(current?.next_run_at).toBeGreaterThan(missedAt);
  });
});
describe('ordinary input admission without a scheduler queue', () => {
  it('submits exactly the ordinary source text and sourceId fields', async () => {
    await seed(job({ action: { kind: 'prompt-agent', prompt: 'the prompt' } }));
    const submit = vi.fn(async (_input: TeammateSubmitInput) => submitted());
    const { service, fence } = scheduler(submit);
    await fire(service);
    await fence.drain();
    expect(submit).toHaveBeenCalledTimes(1);
    const input = submit.mock.calls[0]![0];
    expect(Object.keys(input).sort()).toEqual(['source', 'sourceId', 'text']);
    expect(input.source).toBe('cron');
    expect(input.text).toBe('the prompt');
    expect(typeof input.sourceId).toBe('string');
    expect((await store().get('job-a'))?.last_fired_at).not.toBeNull();
  });
  it('fires a second due job while the first awaits submission', async () => {
    await seed(
      job({ action: { kind: 'prompt-agent', prompt: 'first' } }),
      job({ id: 'job-b', action: { kind: 'prompt-agent', prompt: 'second' } }),
    );
    const release = deferred<void>();
    releases.push(() => release.resolve());
    const submit = vi.fn(async (input: TeammateSubmitInput) => {
      if (input.text === 'first') await release.promise;
      return submitted();
    });
    const { service, fence } = scheduler(submit);
    await fire(service);
    await waitUntil(
      async () =>
        ((await store().get('job-b'))?.last_fired_at ?? null) !== null,
    );
    expect(submit.mock.calls.map((call) => call[0].text)).toEqual([
      'first',
      'second',
    ]);
    expect((await store().get('job-a'))?.last_fired_at).toBeNull();
    release.resolve();
    await fence.drain();
    expect((await store().get('job-a'))?.last_fired_at).not.toBeNull();
  });
  it('does not retry a proven pre-admission failure and records no fire', async () => {
    const dueAt = Date.now() + 30;
    await seed(job({ next_run_at: dueAt }));
    const submit = vi.fn(async (): Promise<TurnAdmission> => ({
      status: 'failed',
      error: new Error('runtime unavailable'),
    }));
    const { service, fence } = scheduler(submit);
    await fire(service);
    await fence.drain();
    await vi.advanceTimersByTimeAsync(150);
    await fence.drain();
    expect(submit).toHaveBeenCalledTimes(1);
    const current = await store().get('job-a');
    expect(current?.last_fired_at).toBeNull();
    expect(current?.next_run_at).toBeGreaterThan(dueAt);
  });
  it('records an ambiguous admission as a fire without retry', async () => {
    const dueAt = Date.now() + 30;
    await seed(job({ next_run_at: dueAt }));
    const submit = vi.fn(async (): Promise<TurnAdmission> => ({
      status: 'ambiguous',
      error: new Error('unknown admission'),
    }));
    const { service, fence } = scheduler(submit);
    await fire(service);
    await fence.drain();
    await vi.advanceTimersByTimeAsync(150);
    await fence.drain();
    expect(submit).toHaveBeenCalledTimes(1);
    const current = await store().get('job-a');
    expect(current?.last_fired_at).toBeGreaterThanOrEqual(dueAt);
    expect(current?.next_run_at).toBeGreaterThan(dueAt);
  });
});
describe('cron store deletion ordering', () => {
  it('a scheduler started after destroy rearms nothing', async () => {
    await seed(job());
    const submit = vi.fn(async () => submitted());
    const first = scheduler(submit);
    await first.service.destroy();
    await expect(readFile(path())).rejects.toMatchObject({ code: 'ENOENT' });
    const second = scheduler(submit);
    await fire(second.service);
    await second.fence.drain();
    expect(submit).not.toHaveBeenCalled();
    expect((await second.service.list()).jobs).toEqual([]);
  });
  it('setFired queued before deleteStoreFile leaves the store deleted', async () => {
    await seed(job());
    const current = store();
    const write = current.setFired({
      id: 'job-a',
      firedAt: 1,
      nextRunAt: null,
      enabled: false,
    });
    const remove = current.deleteStoreFile();
    const [written] = await Promise.all([write, remove]);
    expect(written?.id).toBe('job-a');
    await expect(readFile(path())).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await current.list()).toEqual([]);
  });
  it('deleteStoreFile queued before setFired leaves setFired a durable no-op', async () => {
    await seed(job());
    const current = store();
    const remove = current.deleteStoreFile();
    const write = current.setFired({
      id: 'job-a',
      firedAt: 1,
      nextRunAt: null,
      enabled: false,
    });
    const [, written] = await Promise.all([remove, write]);
    expect(written).toBeNull();
    await expect(readFile(path())).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await current.list()).toEqual([]);
  });
});
it.each([
  { name: 'disable', patch: { enabled: false } },
  { name: 'reschedule', patch: { cron: '*/5 * * * *' } },
  { name: 'one-shot conversion', patch: { recurring: false } },
])('missed rearm preserves a concurrent $name', async ({ patch }) => {
  await seed(job());
  const entered = deferred<void>(),
    result = deferred<TurnAdmission>();
  releases.push(() =>
    result.resolve({ status: 'failed', error: new Error('cleanup') }),
  );
  const submit = vi.fn(async () => {
    entered.resolve();
    return result.promise;
  });
  const { service, fence } = scheduler(submit);
  await fire(service);
  await entered.promise;
  const committed = await service.update({ id: 'job-a', ...patch });
  result.resolve({
    status: 'failed',
    error: new Error('pre-admission failure'),
  });
  await fence.drain();
  expect(await store().get('job-a')).toEqual(committed);
  expect(submit).toHaveBeenCalledTimes(1);
});
