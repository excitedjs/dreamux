import { randomUUID } from 'node:crypto';

import { Cron } from 'croner';

import { JsonDocumentStore } from '../../platform/json-document-store.js';
import { dispatcherCronJobsPath } from '../../platform/paths.js';
import { LegacyStateError } from '../legacy-state.js';

const STORE_VERSION = 1;
const MIN_INTERVAL_MS = 60_000;

export interface CronDeliverTarget {
  channel_id: string;
  target_key: string;
}

export interface CronPromptAgentAction {
  kind: 'prompt-agent';
  prompt: string;
  intent?: string;
}

export interface CronSpawnTeammateAction {
  kind: 'spawn-teammate';
  prompt: string;
  intent?: string;
  agent_runtime: string;
}

export type CronJobAction = CronPromptAgentAction | CronSpawnTeammateAction;

export interface CronJob {
  id: string;
  dispatcher_id: string;
  title?: string;
  cron: string;
  tz: string;
  recurring: boolean;
  action: CronJobAction;
  deliver?: CronDeliverTarget;
  enabled: boolean;
  created_at: number;
  updated_at: number;
  next_run_at: number | null;
  last_fired_at: number | null;
}

interface CronJobFile {
  version: typeof STORE_VERSION;
  jobs: CronJob[];
}

export interface CronJobCreateInput {
  dispatcherId: string;
  title?: string;
  cron: string;
  tz: string;
  recurring: boolean;
  action: CronJobAction;
  deliver?: CronDeliverTarget;
  nextRunAt: number | null;
}

export interface CronJobUpdateInput {
  id: string;
  title?: string | null;
  cron?: string;
  tz?: string;
  recurring?: boolean;
  action?: CronJobAction;
  deliver?: CronDeliverTarget | null;
  enabled?: boolean;
  nextRunAt?: number | null;
}

export class CronJobStore {
  private readonly base = new JsonDocumentStore<CronJobFile>({
    version: STORE_VERSION,
    empty: () => ({ version: STORE_VERSION, jobs: [] }),
    parse: parseCronJobFile,
  });
  private writes: Promise<void> = Promise.resolve();

  async assertCurrent(dispatcherId: string): Promise<void> {
    const path = dispatcherCronJobsPath(dispatcherId);
    const file = await this.base.read(path);
    assertCronJobSemantics(dispatcherId, file.jobs, path);
  }

  async list(dispatcherId: string): Promise<CronJob[]> {
    return (await this.read(dispatcherId)).jobs.map(cloneJob);
  }

  async get(dispatcherId: string, id: string): Promise<CronJob | null> {
    return cloneOptional(
      (await this.read(dispatcherId)).jobs.find((job) => job.id === id) ?? null,
    );
  }

  async create(input: CronJobCreateInput, maxJobs: number): Promise<CronJob> {
    return this.runExclusive(async () => {
      const file = await this.read(input.dispatcherId);
      if (file.jobs.length >= maxJobs) {
        throw new Error(
          `dispatcher '${input.dispatcherId}' already has the maximum ${maxJobs} cron jobs`,
        );
      }
      const now = Date.now();
      const job: CronJob = {
        id: `job-${randomUUID().slice(0, 8)}`,
        dispatcher_id: input.dispatcherId,
        ...(input.title !== undefined ? { title: input.title } : {}),
        cron: input.cron,
        tz: input.tz,
        recurring: input.recurring,
        action: input.action,
        ...(input.deliver !== undefined ? { deliver: input.deliver } : {}),
        enabled: true,
        created_at: now,
        updated_at: now,
        next_run_at: input.nextRunAt,
        last_fired_at: null,
      };
      file.jobs.push(job);
      await this.write(input.dispatcherId, file);
      return cloneJob(job);
    });
  }

  async update(
    dispatcherId: string,
    input: CronJobUpdateInput,
  ): Promise<CronJob> {
    return this.runExclusive(async () => {
      const file = await this.read(dispatcherId);
      const index = file.jobs.findIndex((job) => job.id === input.id);
      if (index === -1) throw new Error(`cron job '${input.id}' does not exist`);
      const current = file.jobs[index]!;
      const next: CronJob = { ...current, updated_at: Date.now() };
      if (input.title !== undefined) {
        if (input.title === null) delete next.title;
        else next.title = input.title;
      }
      if (input.cron !== undefined) next.cron = input.cron;
      if (input.tz !== undefined) next.tz = input.tz;
      if (input.recurring !== undefined) next.recurring = input.recurring;
      if (input.action !== undefined) next.action = input.action;
      if (input.deliver !== undefined) {
        if (input.deliver === null) delete next.deliver;
        else next.deliver = input.deliver;
      }
      if (input.enabled !== undefined) next.enabled = input.enabled;
      if (input.nextRunAt !== undefined) next.next_run_at = input.nextRunAt;
      file.jobs[index] = next;
      await this.write(dispatcherId, file);
      return cloneJob(next);
    });
  }

  async delete(dispatcherId: string, id: string): Promise<boolean> {
    return this.runExclusive(async () => {
      const file = await this.read(dispatcherId);
      const next = file.jobs.filter((job) => job.id !== id);
      if (next.length === file.jobs.length) return false;
      file.jobs = next;
      await this.write(dispatcherId, file);
      return true;
    });
  }

  async setFired(input: {
    dispatcherId: string;
    id: string;
    firedAt: number;
    nextRunAt: number | null;
    enabled: boolean;
  }): Promise<CronJob | null> {
    return this.runExclusive(async () => {
      const file = await this.read(input.dispatcherId);
      const job = file.jobs.find((entry) => entry.id === input.id);
      if (job === undefined) return null;
      job.last_fired_at = input.firedAt;
      job.next_run_at = input.nextRunAt;
      job.enabled = input.enabled;
      job.updated_at = input.firedAt;
      await this.write(input.dispatcherId, file);
      return cloneJob(job);
    });
  }

  private async read(dispatcherId: string): Promise<CronJobFile> {
    return this.base.read(dispatcherCronJobsPath(dispatcherId));
  }

  private async write(dispatcherId: string, file: CronJobFile): Promise<void> {
    await this.base.write(dispatcherCronJobsPath(dispatcherId), file);
  }

  private runExclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.writes.then(fn, fn);
    this.writes = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }
}

export async function detectLegacyCronJobStore(
  dispatcherId: string,
): Promise<string | null> {
  try {
    await new CronJobStore().assertCurrent(dispatcherId);
    return null;
  } catch (err) {
    if (err instanceof LegacyStateError) return err.message;
    throw err;
  }
}

function parseCronJobFile(raw: unknown, ctx: { path: string }): CronJobFile {
  if (!isRecord(raw) || !Array.isArray(raw['jobs'])) {
    throw new LegacyStateError(`cron job store ${ctx.path} must contain a jobs array`);
  }
  return {
    version: STORE_VERSION,
    jobs: raw['jobs'].map((job) => parseCronJob(job, ctx)),
  };
}

function parseCronJob(raw: unknown, ctx: { path: string }): CronJob {
  if (!isRecord(raw)) {
    throw new LegacyStateError(`cron job store ${ctx.path} contains a non-object job`);
  }
  const id = requiredString(raw, 'id', ctx);
  const dispatcherId = requiredString(raw, 'dispatcher_id', ctx);
  const action = parseAction(raw['action'], ctx);
  const title = optionalString(raw, 'title', ctx);
  const deliver = parseOptionalDeliver(raw['deliver'], ctx);
  return {
    id,
    dispatcher_id: dispatcherId,
    ...(title !== undefined ? { title } : {}),
    cron: requiredString(raw, 'cron', ctx),
    tz: requiredString(raw, 'tz', ctx),
    recurring: requiredBoolean(raw, 'recurring', ctx),
    action,
    ...(deliver !== undefined ? { deliver } : {}),
    enabled: requiredBoolean(raw, 'enabled', ctx),
    created_at: requiredNumber(raw, 'created_at', ctx),
    updated_at: requiredNumber(raw, 'updated_at', ctx),
    next_run_at: optionalNumberOrNull(raw, 'next_run_at', ctx),
    last_fired_at: optionalNumberOrNull(raw, 'last_fired_at', ctx),
  };
}

function parseAction(raw: unknown, ctx: { path: string }): CronJobAction {
  if (!isRecord(raw)) {
    throw new LegacyStateError(`cron job store ${ctx.path} has a non-object action`);
  }
  const kind = requiredString(raw, 'kind', ctx);
  if (kind === 'prompt-agent') {
    return {
      kind,
      prompt: requiredString(raw, 'prompt', ctx),
      ...optionalStringRecord(raw, 'intent', ctx),
    };
  }
  if (kind === 'spawn-teammate') {
    return {
      kind,
      prompt: requiredString(raw, 'prompt', ctx),
      agent_runtime: requiredString(raw, 'agent_runtime', ctx),
      ...optionalStringRecord(raw, 'intent', ctx),
    };
  }
  throw new LegacyStateError(`cron job store ${ctx.path} has unknown action kind '${kind}'`);
}

function parseOptionalDeliver(
  raw: unknown,
  ctx: { path: string },
): CronDeliverTarget | undefined {
  if (raw === undefined) return undefined;
  if (!isRecord(raw)) {
    throw new LegacyStateError(`cron job store ${ctx.path} has a non-object deliver`);
  }
  return {
    channel_id: requiredString(raw, 'channel_id', ctx),
    target_key: requiredString(raw, 'target_key', ctx),
  };
}

function assertCronJobSemantics(
  dispatcherId: string,
  jobs: CronJob[],
  path: string,
): void {
  for (const job of jobs) {
    if (job.dispatcher_id !== dispatcherId) {
      throw new LegacyStateError(
        `cron job store ${path} contains job '${job.id}' for dispatcher ` +
          `'${job.dispatcher_id}', expected '${dispatcherId}'`,
      );
    }
    if (job.deliver !== undefined) {
      throw new LegacyStateError(
        `cron job store ${path} contains job '${job.id}' with deliver, ` +
          'which is not implemented in this milestone',
      );
    }
    if (job.action.kind === 'spawn-teammate') {
      throw new LegacyStateError(
        `cron job store ${path} contains job '${job.id}' with spawn-teammate, ` +
          'which is not implemented in this milestone',
      );
    }
    assertValidCron(job, path);
  }
}

function assertValidCron(job: CronJob, path: string): void {
  try {
    if (job.cron.trim().split(/\s+/).length !== 5) {
      throw new Error('cron must be a standard 5-field expression');
    }
    new Intl.DateTimeFormat('en-US', { timeZone: job.tz }).format(new Date());
    const cron = new Cron(job.cron, {
      timezone: job.tz,
      mode: '5-part',
      paused: true,
    });
    if (cron.nextRun(new Date()) === null) {
      throw new Error('cron has no future run');
    }
    if (job.recurring) {
      const runs = cron.nextRuns(2, new Date());
      if (runs.length >= 2) {
        const gap = runs[1]!.getTime() - runs[0]!.getTime();
        if (gap < MIN_INTERVAL_MS) {
          throw new Error('cron interval must be at least one minute');
        }
      }
    }
  } catch (err) {
    throw new LegacyStateError(
      `cron job store ${path} contains invalid job '${job.id}': ${errorMessage(err)}`,
    );
  }
}

function cloneOptional(job: CronJob | null): CronJob | null {
  return job === null ? null : cloneJob(job);
}

function cloneJob(job: CronJob): CronJob {
  return JSON.parse(JSON.stringify(job)) as CronJob;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requiredString(
  raw: Record<string, unknown>,
  key: string,
  ctx: { path: string },
): string {
  const value = raw[key];
  if (typeof value !== 'string' || value === '') {
    throw new LegacyStateError(`cron job store ${ctx.path} field '${key}' must be a non-empty string`);
  }
  return value;
}

function optionalString(
  raw: Record<string, unknown>,
  key: string,
  ctx: { path: string },
): string | undefined {
  const value = raw[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value === '') {
    throw new LegacyStateError(`cron job store ${ctx.path} field '${key}' must be a non-empty string`);
  }
  return value;
}

function optionalStringRecord(
  raw: Record<string, unknown>,
  key: string,
  ctx: { path: string },
): Record<string, string> {
  const value = optionalString(raw, key, ctx);
  return value === undefined ? {} : { [key]: value };
}

function requiredBoolean(
  raw: Record<string, unknown>,
  key: string,
  ctx: { path: string },
): boolean {
  const value = raw[key];
  if (typeof value !== 'boolean') {
    throw new LegacyStateError(`cron job store ${ctx.path} field '${key}' must be a boolean`);
  }
  return value;
}

function requiredNumber(
  raw: Record<string, unknown>,
  key: string,
  ctx: { path: string },
): number {
  const value = raw[key];
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new LegacyStateError(`cron job store ${ctx.path} field '${key}' must be a finite number`);
  }
  return value;
}

function optionalNumberOrNull(
  raw: Record<string, unknown>,
  key: string,
  ctx: { path: string },
): number | null {
  const value = raw[key];
  if (value === null || value === undefined) return null;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new LegacyStateError(`cron job store ${ctx.path} field '${key}' must be a finite number or null`);
  }
  return value;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
