import { Cron } from 'croner';

import type { DreamuxLogger } from '@excitedjs/dreamux-types';

import { errorInfo } from '../../platform/error-info.js';

import {
  type CronJobStore,
  type CronJob,
  type CronJobAction,
  type CronJobUpdateInput,
  MIN_CRON_INTERVAL_MS,
} from './store.js';
import type {
  CronCreateRequest,
  CronUpdateRequest,
  SchedulerCommands,
  SchedulerServiceOptions,
} from './types.js';

const MAX_TIMEOUT_MS = 2_147_483_647;
const MAX_JOBS_PER_OWNER = 128;

interface TimerSlot {
  dueAt: number;
  timer: NodeJS.Timeout;
}

export class SchedulerService {
  readonly commands: SchedulerCommands;
  private readonly ownerId: string;
  private readonly store: CronJobStore;
  private readonly log: DreamuxLogger;
  private readonly now: () => number;
  private readonly timers = new Map<string, TimerSlot>();
  private fireSeq = 0;
  private running = false;
  private lifecycleGeneration = 0;

  constructor(private readonly opts: SchedulerServiceOptions) {
    this.ownerId = opts.ownerId;
    this.store = opts.store;
    this.log = opts.log;
    this.now = opts.now ?? (() => Date.now());
    this.commands = {
      list: () => this.list(),
      create: (input) => this.create(input),
      update: (input) => this.update(input),
      delete: (id) => this.delete(id),
    };
  }

  async start(): Promise<void> {
    if (this.running) return;
    await this.store.assertCurrent();
    const jobs = await this.store.list();
    for (const job of jobs) this.validatePersistedJob(job);
    // Reconcile durable state for every job BEFORE arming any timer, so a
    // mid-reconcile store I/O failure leaves the scheduler fully un-started
    // (running stays false, no timers armed) rather than partially live.
    const armable: CronJob[] = [];
    for (const job of jobs) {
      const reconciled = await this.reconcile(job);
      if (reconciled !== null) armable.push(reconciled);
    }
    this.running = true;
    for (const job of armable) this.arm(job);
  }

  stop(): void {
    this.running = false;
    this.lifecycleGeneration += 1;
    for (const slot of this.timers.values()) clearTimeout(slot.timer);
    this.timers.clear();
  }

  async list(): Promise<{ jobs: CronJob[] }> {
    return { jobs: await this.store.list() };
  }

  async create(input: CronCreateRequest): Promise<CronJob> {
    return this.admit(() => this.doCreate(input));
  }

  private async doCreate(input: CronCreateRequest): Promise<CronJob> {
    const normalized = this.normalizeCreate(input);
    const nextRunAt = nextRunAfter(normalized.cron, normalized.tz, this.now());
    const job = await this.store.create(
      {
        ...normalized,
        nextRunAt,
      },
      MAX_JOBS_PER_OWNER,
    );
    this.log.info(
      { owner_id: this.ownerId, job_id: job.id },
      'cron job created',
    );
    if (this.running) this.arm(job);
    return job;
  }

  async update(input: CronUpdateRequest): Promise<CronJob> {
    return this.admit(() => this.doUpdate(input));
  }

  private async doUpdate(input: CronUpdateRequest): Promise<CronJob> {
    const current = await this.mustJob(input.id);
    const normalized = this.normalizeUpdate(current, input);
    // Use the EFFECTIVE enabled state (an omitted `enabled` keeps the current
    // one), so a prompt-only update of an already-disabled job does not persist
    // a misleading next_run_at for a job that will never fire.
    const effectiveEnabled = input.enabled ?? current.enabled;
    const nextRunAt = effectiveEnabled
      ? nextRunAfter(normalized.cron, normalized.tz, this.now())
      : null;
    const job = await this.store.update({
      ...normalized,
      nextRunAt,
    });
    this.clearTimer(job.id);
    this.log.info(
      { owner_id: this.ownerId, job_id: job.id },
      'cron job updated',
    );
    if (this.running) this.arm(job);
    return job;
  }

  async delete(id: string): Promise<{ id: string; deleted: boolean }> {
    return this.admit(() => this.doDelete(id));
  }

  private async doDelete(id: string): Promise<{ id: string; deleted: boolean }> {
    this.clearTimer(id);
    const deleted = await this.store.delete(id);
    this.log.info(
      { owner_id: this.ownerId, job_id: id, deleted },
      'cron job deleted',
    );
    return { id, deleted };
  }

  async deleteStoreFile(): Promise<void> {
    await this.store.deleteStoreFile();
  }

  private async reconcile(job: CronJob): Promise<CronJob | null> {
    if (!job.enabled) return null;
    const now = this.now();
    if (!job.recurring && job.next_run_at !== null && job.next_run_at <= now) {
      this.log.warn(
        { owner_id: this.ownerId, job_id: job.id },
        'cron one-shot missed while scheduler was stopped',
      );
      await this.store.update({
        id: job.id,
        enabled: false,
        nextRunAt: null,
      });
      return null;
    }
    const nextRunAt =
      job.next_run_at !== null && job.next_run_at > now
        ? job.next_run_at
        : nextRunAfter(job.cron, job.tz, now);
    return nextRunAt === job.next_run_at
      ? job
      : await this.store.update({
          id: job.id,
          nextRunAt,
        });
  }

  private arm(job: CronJob): void {
    this.clearTimer(job.id);
    if (!this.running || !job.enabled || job.next_run_at === null) return;
    this.armSegment(job.id, job.next_run_at);
  }

  private armSegment(jobId: string, dueAt: number): void {
    if (!this.running) return;
    const delay = Math.max(0, dueAt - this.now());
    const segment = Math.min(delay, MAX_TIMEOUT_MS);
    const timer = setTimeout(() => {
      if (dueAt - this.now() > 0) {
        this.armSegment(jobId, dueAt);
        return;
      }
      this.timers.delete(jobId);
      void this.dispatchAdmitted(jobId).catch((err) => {
        this.log.debug(
          { owner_id: this.ownerId, job_id: jobId, err: errorInfo(err) },
          'cron job dispatch rejected by owner admission',
        );
      });
    }, segment);
    timer.unref();
    this.timers.set(jobId, { dueAt, timer });
  }

  private clearTimer(jobId: string): void {
    const slot = this.timers.get(jobId);
    if (slot === undefined) return;
    clearTimeout(slot.timer);
    this.timers.delete(jobId);
  }

  private async dispatch(jobId: string, generation: number): Promise<void> {
    try {
      const job = await this.store.get(jobId);
      if (generation !== this.lifecycleGeneration) return;
      if (job === null || !job.enabled) return;
      await this.submitDue(job, generation);
    } catch (err) {
      this.log.error(
        { owner_id: this.ownerId, job_id: jobId, err: errorInfo(err) },
        'cron job dispatch failed',
      );
      await this.rearmAfterDispatchError(jobId);
    }
  }

  private async dispatchAdmitted(jobId: string): Promise<void> {
    // Capture synchronously. An owner can stop the scheduler after a timer has
    // fired but before Dispatcher admission starts this async task; that
    // stopped generation must not submit.
    const generation = this.lifecycleGeneration;
    await this.admit(() =>
      generation === this.lifecycleGeneration
        ? this.dispatch(jobId, generation)
        : Promise.resolve(),
    );
  }

  private admit<T>(task: () => Promise<T>): Promise<T> {
    return this.opts.admit(task);
  }

  private async rearmAfterDispatchError(jobId: string): Promise<void> {
    // A transient store/runtime error must not silently kill a recurring
    // schedule until the next daemon restart: best-effort re-arm the next
    // occurrence from the persisted job. Swallow secondary errors — the timer
    // is rebuilt from persisted state on the next start().
    try {
      if (!this.running) return;
      const job = await this.store.get(jobId);
      if (job === null || !job.enabled || !job.recurring) return;
      await this.rearmAfterMiss(job);
    } catch (err) {
      this.log.error(
        { owner_id: this.ownerId, job_id: jobId, err: errorInfo(err) },
        'cron job re-arm after dispatch error failed',
      );
    }
  }

  /**
   * Submit a due fire, now.
   *
   * A cron job is a scheduled instruction, not a polite request for a quiet
   * moment: when it is due it goes through the same submission path a person
   * would use, and the runtime folds or steers it into whatever is running.
   * Nothing here asks whether the agent is busy, holds a fire for later, or
   * keeps a second queue beside the one the runtime already owns.
   *
   * What it does check is its own side of the boundary, immediately before
   * submitting: the lifecycle generation that a `stop()` invalidates, and the
   * durable job as it stands right now. Both are the scheduler's own facts —
   * neither reaches into the submission path to cancel anything.
   */
  private async submitDue(job: CronJob, generation: number): Promise<void> {
    const current = await this.store.get(job.id);
    if (generation !== this.lifecycleGeneration) return;
    if (current === null || !current.enabled) return;
    const result = await this.opts.submitScheduled({
      jobId: current.id,
      prompt: current.action.prompt,
      sourceId: this.nextFireSourceId(current.id),
    });
    if (result.status !== 'submitted' && result.status !== 'ambiguous') {
      await this.armMissed(current, `scheduled submission returned ${result.status}`);
      return;
    }
    if (result.status === 'ambiguous') {
      this.log.warn(
        { owner_id: this.ownerId, job_id: current.id },
        'cron submission was admission-ambiguous; recording the fire without retry',
      );
    }
    const firedAt = this.now();
    const nextRunAt = current.recurring
      ? nextRunAfter(current.cron, current.tz, firedAt)
      : null;
    const enabled = current.recurring;
    const updated = await this.store.setFired({
      id: current.id,
      firedAt,
      nextRunAt,
      enabled,
    });
    this.log.info(
      { owner_id: this.ownerId, job_id: current.id, fired_at: firedAt },
      'cron job fired',
    );
    // The fire is recorded either way; only re-arming belongs to a scheduler
    // that is still the current one.
    if (
      updated !== null &&
      this.running &&
      generation === this.lifecycleGeneration
    ) {
      this.arm(updated);
    }
  }

  private async armMissed(job: CronJob, reason: string): Promise<void> {
    this.log.warn(
      { owner_id: this.ownerId, job_id: job.id, reason },
      'cron job fire missed',
    );
    try {
      await this.rearmAfterMiss(job);
    } catch (err) {
      this.log.error(
        { owner_id: this.ownerId, job_id: job.id, err: errorInfo(err) },
        'cron job missed rearm failed',
      );
    }
  }

  private async rearmAfterMiss(job: CronJob): Promise<void> {
    const update: CronJobUpdateInput = job.recurring
      ? {
          id: job.id,
          nextRunAt: nextRunAfter(job.cron, job.tz, this.now()),
        }
      : { id: job.id, enabled: false, nextRunAt: null };
    const updated = await this.store.update(update);
    this.arm(updated);
  }

  private validatePersistedJob(job: CronJob): void {
    validateCron(job.cron, job.tz);
    validateAction(job.action);
  }

  private normalizeCreate(input: CronCreateRequest): {
    title?: string;
    cron: string;
    tz: string;
    recurring: boolean;
    action: CronJobAction;
  } {
    const tz = input.tz ?? localTimeZone();
    const action = normalizeAction(input.prompt, input.action);
    assertTitle(input.title);
    validateCron(input.cron, tz);
    validateAction(action);
    assertMinimumInterval(input.cron, tz, input.recurring ?? true);
    return {
      ...(input.title !== undefined ? { title: input.title } : {}),
      cron: input.cron,
      tz,
      recurring: input.recurring ?? true,
      action,
    };
  }

  private normalizeUpdate(
    current: CronJob,
    input: CronUpdateRequest,
  ): CronJobUpdateInput & { cron: string; tz: string; enabled?: boolean } {
    const cron = input.cron ?? current.cron;
    const tz = input.tz ?? current.tz;
    const recurring = input.recurring ?? current.recurring;
    const action =
      input.action !== undefined
        ? normalizeAction(input.prompt ?? current.action.prompt, input.action)
        : input.prompt !== undefined
          ? { ...current.action, prompt: input.prompt }
        : current.action;
    assertTitle(input.title);
    validateCron(cron, tz);
    validateAction(action);
    assertMinimumInterval(cron, tz, recurring);
    return {
      id: input.id,
      ...(input.title !== undefined ? { title: input.title } : {}),
      cron,
      tz,
      recurring,
      action,
      ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
    };
  }

  private async mustJob(id: string): Promise<CronJob> {
    const job = await this.store.get(id);
    if (job === null) throw new Error(`cron job '${id}' does not exist`);
    return job;
  }

  private nextFireSourceId(jobId: string): string {
    return `scheduled:${jobId}:${++this.fireSeq}`;
  }
}

function normalizeAction(
  prompt: string,
  raw: Record<string, unknown> | undefined,
): CronJobAction {
  if (prompt === '') throw new Error('cron prompt must be a non-empty string');
  if (raw === undefined) return { kind: 'prompt-agent', prompt };
  const kind = raw['kind'];
  if (kind !== undefined && kind !== 'prompt-agent') {
    throw new Error("cron action.kind must be 'prompt-agent'");
  }
  const actionPrompt =
    typeof raw['prompt'] === 'string' && raw['prompt'] !== ''
      ? raw['prompt']
      : prompt;
  const intent = raw['intent'];
  return {
    kind: 'prompt-agent',
    prompt: actionPrompt,
    ...(typeof intent === 'string' && intent !== '' ? { intent } : {}),
  };
}

function validateAction(action: CronJobAction): void {
  if (action.prompt === '') throw new Error('cron action prompt must be non-empty');
}

function assertTitle(title: string | null | undefined): void {
  // An empty string would be persisted then rejected by the store parser
  // (`optionalString` requires non-empty) on the next reload — fail loud on the
  // write path so a job can never become un-reloadable. `null` clears the title.
  if (typeof title === 'string' && title.length === 0) {
    throw new Error('cron title must be a non-empty string');
  }
}

function validateCron(pattern: string, tz: string): void {
  if (pattern.trim().split(/\s+/).length !== 5) {
    throw new Error('cron must be a standard 5-field expression');
  }
  validateTimeZone(tz);
  if (cronFor(pattern, tz).nextRun(new Date()) === null) {
    throw new Error('cron has no future run');
  }
}

function assertMinimumInterval(
  pattern: string,
  tz: string,
  recurring: boolean,
): void {
  if (!recurring) return;
  const runs = cronFor(pattern, tz).nextRuns(2, new Date());
  if (runs.length < 2) return;
  const gap = runs[1]!.getTime() - runs[0]!.getTime();
  if (gap < MIN_CRON_INTERVAL_MS) {
    throw new Error('cron interval must be at least one minute');
  }
}

function nextRunAfter(pattern: string, tz: string, afterMs: number): number | null {
  const next = cronFor(pattern, tz).nextRun(new Date(afterMs));
  return next?.getTime() ?? null;
}

function cronFor(pattern: string, tz: string): Cron {
  return new Cron(pattern, {
    timezone: tz,
    mode: '5-part',
    paused: true,
  });
}

function validateTimeZone(tz: string): void {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz }).format(new Date());
  } catch {
    throw new Error(`invalid timezone '${tz}'`);
  }
}

function localTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
}
