import { Cron } from 'croner';
import type { WorkAdmission } from '../../platform/work-fence.js';
import type { TeammateSubmitInput } from '../agent/submission.js';
import { SCHEDULED_SOURCE } from '../submission-sources.js';

import type { DreamuxLogger } from '@excitedjs/dreamux-types';

import { errorInfo, RuleViolation } from '@excitedjs/dreamux-utils';
import { throwCallerMistake } from '../../command/errors.js';
import type { TurnAdmission } from '../agent/turn.js';
import { CronJobNotFoundError } from './errors.js';

import { validateCronSchedule } from './cron-validation.js';
import { CronJobStore } from './store.js';
import type {
  CronCreateRequest,
  CronJob,
  CronJobAction,
  CronJobUpdateInput,
  CronUpdateRequest,
  SchedulerCommands,
} from './types.js';

const MAX_TIMEOUT_MS = 2_147_483_647;

interface TimerSlot {
  dueAt: number;
  timer: NodeJS.Timeout;
}

/**
 * What `SchedulerService` is constructed from.
 *
 * Declared here rather than in `types.ts`: it configures a concrete
 * `SchedulerService` (a cron store path, an owner fence, and a submission
 * recipient) rather than describing a domain value, so it is a
 * constructor-options bag rather than a data type.
 */
export interface SchedulerServiceOptions {
  ownerId: string;
  /** Where this scheduler's own `CronJobStore` reads and writes its file. */
  cronJobsPath: string;
  fence: WorkAdmission;
  /**
   * Submit one due fire as an ordinary admitted input.
   *
   * No cancellation crosses this call, and no idle question either. The owner
   * supplies the same submission path any other caller uses; whether the
   * runtime folds the input into an active turn or starts a new one is the
   * runtime's decision, made where it is already made.
   */
  recipient: {
    submitInput(input: TeammateSubmitInput): Promise<TurnAdmission>;
  };
  log: DreamuxLogger;
}

export class SchedulerService implements SchedulerCommands {
  private readonly ownerId: string;
  private readonly store: CronJobStore;
  private readonly log: DreamuxLogger;
  private readonly timers = new Map<string, TimerSlot>();
  private fireSeq = 0;
  private running = false;
  private lifecycleGeneration = 0;

  constructor(private readonly opts: SchedulerServiceOptions) {
    this.ownerId = opts.ownerId;
    this.store = new CronJobStore(opts.cronJobsPath);
    this.log = opts.log;
  }

  async start(): Promise<void> {
    if (this.running) return;
    // `assertCurrent` already validated every persisted job: it runs the same
    // schedule rules this service would, and the store's own parser rejects an
    // empty action prompt before a job is ever handed back. A third pass here
    // could only re-derive the same verdict.
    await this.store.assertCurrent();
    const jobs = await this.store.list();
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

  /**
   * Stop, then remove this scheduler's own persisted cron store.
   *
   * `stop()` runs first, clearing every armed timer and bumping the
   * lifecycle generation so no new fire submits after this call starts. A
   * fire already past that point (mid-submission, about to `rearm`) is not
   * blocked by the generation bump — `rearm`'s 'fired' branch writes
   * unconditionally — but is still resolved correctly: `store.deleteStoreFile`
   * shares this store's own serialized update queue, so that write and this
   * delete are ordered against each other rather than racing, and a write
   * queued behind the delete finds no job and writes nothing (see
   * `CronJobStore.deleteStoreFile`). A delete that fails throws and leaves
   * the store file in place; the owner that called this is responsible for
   * what that means for its own close.
   */
  async destroy(): Promise<void> {
    this.stop();
    await this.store.deleteStoreFile();
  }

  /** Gated like every other admitted verb: a read is still operational access on a scope that may be closing. */
  async list(): Promise<{ jobs: CronJob[] }> {
    return this.opts.fence.admit(async () => ({
      jobs: await this.store.list(),
    }));
  }

  async create(input: CronCreateRequest): Promise<CronJob> {
    return this.opts.fence.admit(() => this.doCreate(input));
  }

  private async doCreate(input: CronCreateRequest): Promise<CronJob> {
    const normalized = this.normalizeCreate(input);
    const nextRunAt = nextRunAfter(normalized.cron, normalized.tz, Date.now());
    const job = await this.store.create({
      ...normalized,
      nextRunAt,
    });
    this.log.info(
      { owner_id: this.ownerId, job_id: job.id },
      'cron job created',
    );
    if (this.running) this.arm(job);
    return job;
  }

  async update(input: CronUpdateRequest): Promise<CronJob> {
    return this.opts.fence.admit(() => this.doUpdate(input));
  }

  private async doUpdate(input: CronUpdateRequest): Promise<CronJob> {
    const current = await this.mustJob(input.id);
    const normalized = this.normalizeUpdate(current, input);
    // Use the EFFECTIVE enabled state (an omitted `enabled` keeps the current
    // one), so a prompt-only update of an already-disabled job does not persist
    // a misleading next_run_at for a job that will never fire.
    const effectiveEnabled = input.enabled ?? current.enabled;
    const nextRunAt = effectiveEnabled
      ? nextRunAfter(normalized.cron, normalized.tz, Date.now())
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
    return this.opts.fence.admit(() => this.doDelete(id));
  }

  private async doDelete(
    id: string,
  ): Promise<{ id: string; deleted: boolean }> {
    this.clearTimer(id);
    const deleted = await this.store.delete(id);
    this.log.info(
      { owner_id: this.ownerId, job_id: id, deleted },
      'cron job deleted',
    );
    return { id, deleted };
  }

  private async reconcile(job: CronJob): Promise<CronJob | null> {
    if (!job.enabled) return null;
    const now = Date.now();
    if (!job.recurring && job.next_run_at !== null && job.next_run_at <= now) {
      this.log.warn(
        { owner_id: this.ownerId, job_id: job.id },
        'cron one-shot missed while scheduler was stopped',
      );
      await this.store.update({ id: job.id, ...this.advanceJob(job, now) });
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
    const delay = Math.max(0, dueAt - Date.now());
    const segment = Math.min(delay, MAX_TIMEOUT_MS);
    const timer = setTimeout(() => {
      if (dueAt - Date.now() > 0) {
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

  /**
   * Read once, submit, record.
   *
   * A cron job is a scheduled instruction, not a polite request for a quiet
   * moment: when it is due it goes through the same submission path a person
   * would use, and the runtime folds or steers it into whatever is running.
   * Nothing here asks whether the agent is busy, holds a fire for later, or
   * keeps a second queue beside the one the runtime already owns.
   *
   * What it does check is its own side of the boundary, immediately before
   * submitting: the lifecycle generation that a `stop()` invalidates, and the
   * durable job as it stands right now — a single read placed immediately
   * before the submission call, so anything read earlier would be stale by
   * the time it mattered. Both checks below are the scheduler's own facts —
   * neither reaches into the submission path to cancel anything.
   */
  private async dispatch(jobId: string, generation: number): Promise<void> {
    let job: CronJob | null = null;
    try {
      job = await this.store.get(jobId);
      if (generation !== this.lifecycleGeneration) return;
      if (job === null || !job.enabled) return;
      const result = await this.opts.recipient.submitInput({
        source: SCHEDULED_SOURCE,
        text: job.action.prompt,
        sourceId: this.nextFireSourceId(job.id),
      });
      const now = Date.now();
      if (result.status !== 'submitted' && result.status !== 'ambiguous') {
        this.log.warn(
          {
            owner_id: this.ownerId,
            job_id: job.id,
            reason: `scheduled submission returned ${result.status}`,
          },
          'cron job fire missed',
        );
        try {
          await this.rearm(job, 'missed', now, generation);
        } catch (err) {
          this.log.error(
            { owner_id: this.ownerId, job_id: job.id, err: errorInfo(err) },
            'cron job missed rearm failed',
          );
        }
        return;
      }
      if (result.status === 'ambiguous') {
        this.log.warn(
          { owner_id: this.ownerId, job_id: job.id },
          'cron submission was admission-ambiguous; recording the fire without retry',
        );
      }
      await this.rearm(job, 'fired', now, generation);
      this.log.info(
        { owner_id: this.ownerId, job_id: job.id, fired_at: now },
        'cron job fired',
      );
    } catch (err) {
      this.log.error(
        { owner_id: this.ownerId, job_id: jobId, err: errorInfo(err) },
        'cron job dispatch failed',
      );
      // No job in hand means the read itself threw — there is nothing to
      // rearm from, so there is no second read to retry it with either.
      if (job === null) return;
      try {
        await this.rearm(job, 'missed', Date.now(), generation);
      } catch (rearmErr) {
        this.log.error(
          { owner_id: this.ownerId, job_id: jobId, err: errorInfo(rearmErr) },
          'cron job re-arm after dispatch error failed',
        );
      }
    }
  }

  private async dispatchAdmitted(jobId: string): Promise<void> {
    // Capture synchronously. An owner can stop the scheduler after a timer has
    // fired but before Dispatcher admission starts this async task; that
    // stopped generation must not submit.
    const generation = this.lifecycleGeneration;
    await this.opts.fence.admit(() =>
      generation === this.lifecycleGeneration
        ? this.dispatch(jobId, generation)
        : Promise.resolve(),
    );
  }

  /**
   * The `{ enabled, nextRunAt }` a job settles into after this instant passes,
   * whether it just fired or was just missed — recurring and one-shot each
   * resolve to one shape either way, so the outcome plays no part in the
   * formula. A one-shot's `enabled: false` is a real value a caller must
   * write; a recurring job's `enabled` is deliberately absent rather than
   * `true`, so a partial-update write (`rearm`'s 'missed' branch) never
   * re-enables a job a concurrent `cron.update` disabled in the same window —
   * `setFired`'s required `enabled` field is supplied by `rearm` itself.
   */
  private advanceJob(
    job: CronJob,
    now: number,
  ): { enabled?: boolean; nextRunAt: number | null } {
    return job.recurring
      ? { nextRunAt: nextRunAfter(job.cron, job.tz, now) }
      : { enabled: false, nextRunAt: null };
  }

  /**
   * What a missed fire settles the row into, evaluated against the row as it
   * stands right now — never against the snapshot `dispatch` captured before
   * submitting.
   *
   * `null` means this settlement has nothing to write, mirroring
   * `reconcile()`'s own two conditions for "nothing to do": a `current` that
   * is already disabled needs no missed-outcome write (writing a fresh
   * `next_run_at` onto it would be exactly the misleading value `doUpdate`
   * already takes care not to persist), and a `current` whose `next_run_at`
   * already sits in the future is not advanced again by this stale fire.
   * Arming is decided by the caller, not here. Called from inside
   * `store.applyMissed`'s serialized update, so `current` is read at the
   * exact moment this settlement is about to write, closing the window a
   * concurrent `cron.update` could otherwise race.
   */
  private missedOutcome(
    current: CronJob,
    now: number,
  ): { enabled?: boolean; nextRunAt: number | null } | null {
    if (!current.enabled) return null;
    if (current.next_run_at !== null && current.next_run_at > now) return null;
    return this.advanceJob(current, now);
  }

  /**
   * The one durable write a fire produces, plus the re-arm it earns.
   *
   * `generation` is the value `dispatch` captured before submitting: a
   * 'fired' outcome is recorded unconditionally (a submission the runtime
   * already accepted must never end up looking, on disk, like one that never
   * happened), but it is armed again only if this scheduler is still the one
   * that submitted it. A 'missed' outcome carries no such durable-fact
   * obligation — a job whose miss-rearm is skipped here for a stale
   * generation is picked back up by the next `start()`'s `reconcile()`, which
   * re-derives the same schedule from the persisted job — so a stale
   * generation skips the write entirely.
   *
   * The `job` parameter is a snapshot from before the fire; the 'missed'
   * branch never applies it directly. `store.applyMissed` runs
   * `missedOutcome` against the persisted row inside its own serialized
   * update, so a `cron.update` the owner committed while the submission was
   * in flight — a reschedule, a disable, a re-enable — is what the missed
   * outcome is projected onto or deferred to, never overwritten by a stale
   * `recurring`/`enabled`/`next_run_at`. Whether to write and whether to arm
   * are decided separately: a row `missedOutcome` left alone is still armed
   * as it stands, because a future `next_run_at` does not prove anyone armed
   * it — a wall clock stepped backward while the submission was in flight
   * leaves this fire's own, already-consumed schedule in the future. `arm()`
   * clears first, so re-arming a row a concurrent update already armed is
   * harmless. `updated` is `null` only when the job was deleted.
   */
  private async rearm(
    job: CronJob,
    outcome: 'fired' | 'missed',
    now: number,
    generation: number,
  ): Promise<void> {
    if (outcome === 'fired') {
      const updated = await this.store.setFired({
        id: job.id,
        firedAt: now,
        nextRunAt: this.advanceJob(job, now).nextRunAt,
        enabled: job.recurring,
      });
      if (updated !== null && generation === this.lifecycleGeneration) {
        this.arm(updated);
      }
      return;
    }
    if (generation !== this.lifecycleGeneration) return;
    const updated = await this.store.applyMissed(job.id, (current) =>
      this.missedOutcome(current, now),
    );
    if (updated !== null) this.arm(updated);
  }

  private normalizeCreate(input: CronCreateRequest): {
    title?: string | undefined;
    cron: string;
    tz: string;
    recurring: boolean;
    action: CronJobAction;
  } {
    const tz = input.tz ?? localTimeZone();
    const action = asRequestValidation(() => {
      const normalized = normalizeAction(input.prompt);
      assertTitle(input.title);
      validateCron(input.cron, tz, input.recurring ?? true);
      validateAction(normalized);
      return normalized;
    });
    return {
      title: input.title,
      cron: input.cron,
      tz,
      recurring: input.recurring ?? true,
      action,
    };
  }

  private normalizeUpdate(
    current: CronJob,
    input: CronUpdateRequest,
  ): CronJobUpdateInput & { cron: string; tz: string } {
    const cron = input.cron ?? current.cron;
    const tz = input.tz ?? current.tz;
    const recurring = input.recurring ?? current.recurring;
    const action = asRequestValidation(() => {
      const normalized =
        input.prompt !== undefined
          ? { ...current.action, prompt: input.prompt }
          : current.action;
      assertTitle(input.title);
      validateCron(cron, tz, recurring);
      validateAction(normalized);
      return normalized;
    });
    return {
      id: input.id,
      title: input.title,
      cron,
      tz,
      recurring,
      action,
      enabled: input.enabled,
    };
  }

  private async mustJob(id: string): Promise<CronJob> {
    const job = await this.store.get(id);
    if (job === null) {
      throw new CronJobNotFoundError(`cron job '${id}' does not exist`);
    }
    return job;
  }

  private nextFireSourceId(jobId: string): string {
    return `scheduled:${jobId}:${++this.fireSeq}`;
  }
}

/**
 * Run one caller-request validation.
 *
 * The validators below are the scheduler's own rules and are used on two
 * genuinely different paths: normalizing a request a caller just sent, and
 * checking a job already persisted. Only the first is the caller's mistake, so
 * only a broken rule — a `RuleViolation` and nothing else — is re-typed as one;
 * a persisted job that fails the same rule stays a loud unclassified failure,
 * because nothing the caller can send would fix it. Anything else raised while
 * validating is an implementation failure and leaves untouched. The rules keep
 * their own wording — a caller needs to read exactly which one it broke.
 */
function asRequestValidation<T>(validate: () => T): T {
  try {
    return validate();
  } catch (error) {
    throwCallerMistake(error);
  }
}

function normalizeAction(prompt: string): CronJobAction {
  if (prompt === '') {
    throw new RuleViolation('cron prompt must be a non-empty string');
  }
  return { kind: 'prompt-agent', prompt };
}

function validateAction(action: CronJobAction): void {
  if (action.prompt === '') {
    throw new RuleViolation('cron action prompt must be non-empty');
  }
}

function assertTitle(title: string | null | undefined): void {
  // An empty string would be persisted then rejected by the store parser
  // (`optionalString` requires non-empty) on the next reload — fail loud on the
  // write path so a job can never become un-reloadable. `null` clears the title.
  if (typeof title === 'string' && title.length === 0) {
    throw new RuleViolation('cron title must be a non-empty string');
  }
}

/**
 * Check a caller-supplied schedule. The rules live in the scheduler's one
 * validator; this names the verdict for the command path — a break is the
 * caller's mistake, so it is a {@link RuleViolation} they can act on.
 */
function validateCron(pattern: string, tz: string, recurring: boolean): void {
  validateCronSchedule({ cron: pattern, tz, recurring }, (message) => {
    throw new RuleViolation(message);
  });
}

function nextRunAfter(
  pattern: string,
  tz: string,
  afterMs: number,
): number | null {
  const next = cronFor(pattern, tz).nextRun(new Date(afterMs));
  return next?.getTime() ?? null;
}

/**
 * Build the cron for a pattern that has already passed validation, so a throw
 * here would be a real failure rather than a broken rule. Parsing a pattern
 * that has *not* been validated yet belongs to `./cron-validation.ts`.
 */
function cronFor(pattern: string, tz: string): Cron {
  return new Cron(pattern, {
    timezone: tz,
    mode: '5-part',
    paused: true,
  });
}

function localTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
}
