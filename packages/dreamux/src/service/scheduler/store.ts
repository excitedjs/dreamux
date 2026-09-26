import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import { errorMessage, TransactionalStore } from '@excitedjs/dreamux-utils';

import { LegacyStateError } from '../../platform/errors.js';
import { isNotFound } from '../../platform/fs-errors.js';
import { validateCronSchedule } from './cron-validation.js';

const STORE_VERSION = 1;

export interface CronPromptAgentAction {
  kind: 'prompt-agent';
  prompt: string;
}

/**
 * What a cron job does when it fires, and the only thing it has ever done.
 *
 * A job injects its prompt into the Dispatcher or TeamLeader that owns the
 * schedule. It does not spawn an agent and it does not address a Channel: those
 * were declared shapes with no execution behind them, so the union is the one
 * action Dreamux actually performs.
 */
export type CronJobAction = CronPromptAgentAction;

export interface CronJob {
  id: string;
  title?: string | undefined;
  cron: string;
  tz: string;
  recurring: boolean;
  action: CronJobAction;
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
  title?: string | undefined;
  cron: string;
  tz: string;
  recurring: boolean;
  action: CronJobAction;
  nextRunAt: number | null;
}

export interface CronJobUpdateInput {
  id: string;
  title?: string | null | undefined;
  cron?: string;
  tz?: string;
  recurring?: boolean;
  action?: CronJobAction;
  enabled?: boolean | undefined;
  nextRunAt?: number | null;
}

export interface CronJobStoreOptions {
  cronJobsPath: string;
  dispatcherId: string;
}

export class CronJobStore {
  private readonly store: TransactionalStore<CronJobFile>;

  constructor(private readonly opts: CronJobStoreOptions) {
    this.store = new TransactionalStore<CronJobFile>({
      path: opts.cronJobsPath,
      load: () => this.load(),
    });
  }

  async assertCurrent(): Promise<void> {
    await this.store.load();
  }

  async list(): Promise<CronJob[]> {
    return (await this.store.load()).jobs.map(cloneJob);
  }

  async get(id: string): Promise<CronJob | null> {
    return cloneOptional(
      (await this.store.load()).jobs.find((job) => job.id === id) ?? null,
    );
  }

  async create(input: CronJobCreateInput): Promise<CronJob> {
    const now = Date.now();
    const job: CronJob = {
      id: `job-${randomUUID().slice(0, 8)}`,
      title: input.title,
      cron: input.cron,
      tz: input.tz,
      recurring: input.recurring,
      action: input.action,
      enabled: true,
      created_at: now,
      updated_at: now,
      next_run_at: input.nextRunAt,
      last_fired_at: null,
    };
    await this.store.update((current) => ({
      version: current.version,
      jobs: [...current.jobs, job],
    }));
    return cloneJob(job);
  }

  async update(input: CronJobUpdateInput): Promise<CronJob> {
    const file = await this.store.update((current) => {
      const index = current.jobs.findIndex((job) => job.id === input.id);
      if (index === -1) {
        throw new Error(`cron job '${input.id}' does not exist`);
      }
      const existing = current.jobs[index]!;
      const next: CronJob = { ...existing, updated_at: Date.now() };
      if (input.title !== undefined) {
        if (input.title === null) delete next.title;
        else next.title = input.title;
      }
      if (input.cron !== undefined) next.cron = input.cron;
      if (input.tz !== undefined) next.tz = input.tz;
      if (input.recurring !== undefined) next.recurring = input.recurring;
      if (input.action !== undefined) next.action = input.action;
      if (input.enabled !== undefined) next.enabled = input.enabled;
      if (input.nextRunAt !== undefined) next.next_run_at = input.nextRunAt;
      const jobs = [...current.jobs];
      jobs[index] = next;
      return { version: current.version, jobs };
    });
    const updated = file.jobs.find((job) => job.id === input.id);
    // `change` above always either throws (id not found) or splices a
    // rebuilt job for this exact id into the returned file, so this is
    // never undefined.
    if (updated === undefined) {
      throw new Error(`cron job '${input.id}' update lost its result`);
    }
    return cloneJob(updated);
  }

  async delete(id: string): Promise<boolean> {
    // Whether this call is the one that removed the job can only be decided
    // from `current` inside `change` — the store's own serialized read at the
    // moment this update runs. A file already missing the id (never present,
    // or removed by a `delete` that already ran ahead of this one in the
    // queue) is indistinguishable from "this call removed it" once looked at
    // from the resolved file alone.
    let deleted = false;
    await this.store.update((current) => {
      const jobs = current.jobs.filter((job) => job.id !== id);
      if (jobs.length === current.jobs.length) return current;
      deleted = true;
      return { version: current.version, jobs };
    });
    return deleted;
  }

  async setFired(input: {
    id: string;
    firedAt: number;
    nextRunAt: number | null;
    enabled: boolean;
  }): Promise<CronJob | null> {
    const file = await this.store.update((current) => {
      const index = current.jobs.findIndex((job) => job.id === input.id);
      if (index === -1) return current;
      const existing = current.jobs[index]!;
      const next: CronJob = {
        ...existing,
        last_fired_at: input.firedAt,
        next_run_at: input.nextRunAt,
        enabled: input.enabled,
        updated_at: input.firedAt,
      };
      const jobs = [...current.jobs];
      jobs[index] = next;
      return { version: current.version, jobs };
    });
    const job = file.jobs.find((entry) => entry.id === input.id);
    return job === undefined ? null : cloneJob(job);
  }

  /**
   * Remove the store file and commit the empty default as this store's
   * in-memory value, so a `setFired` queued behind this delete on the same
   * store (the store's own tail already serializes the two) finds no job
   * and writes nothing.
   *
   * `TransactionalStore.remove()` loads the file first, so this now throws
   * if `cron-jobs.json` fails the version check or job parsing at the moment
   * a Team dissolve tries to clean it up — a direct `unlink()` would have
   * succeeded regardless of file content. A corrupt cron file is already
   * this store's designed failure mode everywhere else it is read (`load()`,
   * `assertCurrent()`), so failing here too is consistent rather than a new
   * failure class.
   */
  async deleteStoreFile(): Promise<void> {
    await this.store.remove({ version: STORE_VERSION, jobs: [] });
  }

  /**
   * This store's whole validation contract: a missing file is the empty
   * default, a version mismatch or malformed document is `LegacyStateError`,
   * and every parsed job is schedule-valid — composed here because this is
   * the complete `assertCurrent`, not a separate pass a caller runs after.
   */
  private async load(): Promise<CronJobFile> {
    const path = this.opts.cronJobsPath;
    let raw: string;
    try {
      raw = await readFile(path, 'utf8');
    } catch (err) {
      if (isNotFound(err)) return { version: STORE_VERSION, jobs: [] };
      throw err;
    }
    let file: CronJobFile;
    try {
      const value = JSON.parse(raw) as unknown;
      if (!isRecord(value) || value['version'] !== STORE_VERSION) {
        throw new LegacyStateError(
          `JSON document ${path} is not version ${STORE_VERSION}. ` +
            'Dreamux 0.x does not migrate old state; delete the file to rebuild it.',
        );
      }
      file = parseCronJobFile(value, { path });
    } catch (err) {
      if (err instanceof LegacyStateError) throw err;
      throw new LegacyStateError(
        `JSON document ${path} is malformed or incompatible. Dreamux 0.x does ` +
          `not migrate old state; delete the file to rebuild it. Cause: ${errorMessage(err)}`,
      );
    }
    // Outside the parse try/catch on purpose, matching today's `assertCurrent`
    // composition: a schedule-validity break is already a `LegacyStateError`
    // with its own wording, and anything else the validator rethrows (e.g. a
    // platform failure that is not the deliberately-caught unknown-timezone
    // case) is a real failure, not "this document is malformed JSON" — it must
    // propagate as itself, not get relabeled by the parse catch above.
    for (const job of file.jobs) assertValidCron(job, path);
    return file;
  }
}

export async function detectLegacyCronJobStore(
  cronJobsPath: string,
  dispatcherId: string,
): Promise<string | null> {
  try {
    await new CronJobStore({ cronJobsPath, dispatcherId }).assertCurrent();
    return null;
  } catch (err) {
    if (err instanceof LegacyStateError) return err.message;
    throw err;
  }
}

function parseCronJobFile(raw: unknown, ctx: { path: string }): CronJobFile {
  if (!isRecord(raw) || !Array.isArray(raw['jobs'])) {
    throw new LegacyStateError(
      `cron job store ${ctx.path} must contain a jobs array`,
    );
  }
  return {
    version: STORE_VERSION,
    jobs: raw['jobs'].map((job) => parseCronJob(job, ctx)),
  };
}

function parseCronJob(raw: unknown, ctx: { path: string }): CronJob {
  if (!isRecord(raw)) {
    throw new LegacyStateError(
      `cron job store ${ctx.path} contains a non-object job`,
    );
  }
  const id = requiredString(raw, 'id', ctx);
  // `dispatcher_id` is no longer part of `CronJob`; a leftover value on an
  // old file is an ordinary unknown field under the persisted-shape policy
  // (tolerate unknown fields, reject only wrong types and missing fields) —
  // it is ignored, never checked against this store's own dispatcher id.
  const action = parseAction(raw['action'], ctx);
  const title = optionalString(raw, 'title', ctx);
  if (raw['deliver'] !== undefined) {
    throw new LegacyStateError(
      `cron job store ${ctx.path} job '${id}' carries the removed deliver ` +
        'field. Cron jobs inject a prompt into their owning agent and address ' +
        'no Channel. Delete the job or the store file and recreate the ' +
        'schedule.',
    );
  }
  return {
    id,
    title,
    cron: requiredString(raw, 'cron', ctx),
    tz: requiredString(raw, 'tz', ctx),
    recurring: requiredBoolean(raw, 'recurring', ctx),
    action,
    enabled: requiredBoolean(raw, 'enabled', ctx),
    created_at: requiredNumber(raw, 'created_at', ctx),
    updated_at: requiredNumber(raw, 'updated_at', ctx),
    next_run_at: optionalNumberOrNull(raw, 'next_run_at', ctx),
    last_fired_at: optionalNumberOrNull(raw, 'last_fired_at', ctx),
  };
}

/**
 * The raw file boundary is where a removed shape stops.
 *
 * `spawn-teammate` is refused here rather than downstream, so it can never
 * become a domain object that some later branch has to keep apologising for.
 */
function parseAction(raw: unknown, ctx: { path: string }): CronJobAction {
  if (!isRecord(raw)) {
    throw new LegacyStateError(
      `cron job store ${ctx.path} has a non-object action`,
    );
  }
  const kind = requiredString(raw, 'kind', ctx);
  if (kind === 'prompt-agent') {
    return {
      kind,
      prompt: requiredString(raw, 'prompt', ctx),
    };
  }
  if (kind === 'spawn-teammate') {
    throw new LegacyStateError(
      `cron job store ${ctx.path} carries a removed spawn-teammate action. ` +
        'Cron only injects a prompt into its owning agent. Delete the job or ' +
        'the store file and recreate the schedule.',
    );
  }
  throw new LegacyStateError(
    `cron job store ${ctx.path} has unknown action kind '${kind}'`,
  );
}

function assertValidCron(job: CronJob, path: string): void {
  // Same rules as the command path, different verdict: a schedule that is
  // already on disk cannot be a caller's mistake, so a break here is corrupt
  // state for an operator to resolve.
  validateCronSchedule(job, (message) => {
    throw new LegacyStateError(
      `cron job store ${path} contains invalid job '${job.id}': ${message}`,
    );
  });
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
    throw new LegacyStateError(
      `cron job store ${ctx.path} field '${key}' must be a non-empty string`,
    );
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
    throw new LegacyStateError(
      `cron job store ${ctx.path} field '${key}' must be a non-empty string`,
    );
  }
  return value;
}

function requiredBoolean(
  raw: Record<string, unknown>,
  key: string,
  ctx: { path: string },
): boolean {
  const value = raw[key];
  if (typeof value !== 'boolean') {
    throw new LegacyStateError(
      `cron job store ${ctx.path} field '${key}' must be a boolean`,
    );
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
    throw new LegacyStateError(
      `cron job store ${ctx.path} field '${key}' must be a finite number`,
    );
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
    throw new LegacyStateError(
      `cron job store ${ctx.path} field '${key}' must be a finite number or null`,
    );
  }
  return value;
}

/**
 * The canonical public value of one cron job.
 *
 * Field by field rather than handed out whole, and it lives beside the record
 * it copies: both caller-facing surfaces declare a closed result schema, so a
 * field added to the stored job must be a deliberate addition here instead of
 * silently widening one wire and failing the other.
 */
export function cronJobResult(job: CronJob): CronJob {
  return {
    id: job.id,
    ...(job.title !== undefined ? { title: job.title } : {}),
    cron: job.cron,
    tz: job.tz,
    recurring: job.recurring,
    action: job.action,
    enabled: job.enabled,
    created_at: job.created_at,
    updated_at: job.updated_at,
    next_run_at: job.next_run_at,
    last_fired_at: job.last_fired_at,
  };
}

/** The canonical public value of one cron job list. */
export function cronListResult(result: { jobs: CronJob[] }): {
  jobs: CronJob[];
} {
  return { jobs: result.jobs.map(cronJobResult) };
}
