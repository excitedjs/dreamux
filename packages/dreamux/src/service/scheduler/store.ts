import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import {
  errorMessage,
  isPlainObject,
  TransactionalStore,
} from '@excitedjs/dreamux-utils';

import { LegacyStateError } from '../../platform/errors.js';
import { isNotFound } from '../../platform/fs-errors.js';
import { validateCronSchedule } from './cron-validation.js';
import type {
  CronJob,
  CronJobAction,
  CronJobCreateInput,
  CronJobUpdateInput,
} from './types.js';

const STORE_VERSION = 1;

interface CronJobFile {
  version: typeof STORE_VERSION;
  jobs: CronJob[];
}

export class CronJobStore {
  private readonly store: TransactionalStore<CronJobFile>;

  constructor(private readonly cronJobsPath: string) {
    this.store = new TransactionalStore<CronJobFile>({
      path: cronJobsPath,
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
    let next!: CronJob;
    await this.store.update((current) => {
      const index = current.jobs.findIndex((job) => job.id === input.id);
      if (index === -1) {
        throw new Error(`cron job '${input.id}' does not exist`);
      }
      const existing = current.jobs[index]!;
      next = { ...existing, updated_at: Date.now() };
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
    return cloneJob(next);
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
   * Settle a missed fire against the row as it stands right now, not against
   * whatever the caller read before the fire.
   *
   * `advance` is evaluated inside this store's own serialized update against
   * the current persisted job, so a schedule change (or re-enable, or
   * disable) a concurrent `update()` already committed since the fire is what
   * a missed outcome is projected onto — a stale caller-held snapshot can
   * never overwrite it. `advance` returning `null` means this settlement has
   * nothing to write (the caller decides why, e.g. the row already moved past
   * the fire being settled). Either way the row as it now stands is returned,
   * because arming is a separate question from writing; `null` means only
   * that the job was deleted concurrently.
   */
  async applyMissed(
    id: string,
    advance: (
      current: CronJob,
    ) => { enabled?: boolean; nextRunAt: number | null } | null,
  ): Promise<CronJob | null> {
    const file = await this.store.update((current) => {
      const index = current.jobs.findIndex((job) => job.id === id);
      if (index === -1) return current;
      const existing = current.jobs[index]!;
      const derived = advance(existing);
      if (derived === null) return current;
      const next: CronJob = {
        ...existing,
        next_run_at: derived.nextRunAt,
        updated_at: Date.now(),
      };
      if (derived.enabled !== undefined) next.enabled = derived.enabled;
      const jobs = [...current.jobs];
      jobs[index] = next;
      return { version: current.version, jobs };
    });
    const job = file.jobs.find((entry) => entry.id === id);
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
    const path = this.cronJobsPath;
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
      if (!isPlainObject(value) || value['version'] !== STORE_VERSION) {
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
): Promise<string | null> {
  try {
    await new CronJobStore(cronJobsPath).assertCurrent();
    return null;
  } catch (err) {
    if (err instanceof LegacyStateError) return err.message;
    throw err;
  }
}

function parseCronJobFile(raw: unknown, ctx: { path: string }): CronJobFile {
  if (!isPlainObject(raw) || !Array.isArray(raw['jobs'])) {
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
  if (!isPlainObject(raw)) {
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
  // `deliver` is no longer part of `CronJob`; a leftover value on an old file
  // is an ordinary unknown field under the persisted-shape policy (tolerate
  // unknown fields, reject only wrong types and missing fields), same as
  // `dispatcher_id` above — it is ignored, and the field-by-field object
  // below already drops it, so the next rewrite stops carrying it forward.
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
  if (!isPlainObject(raw)) {
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
