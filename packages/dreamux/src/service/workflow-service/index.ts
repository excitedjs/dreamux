import { createHash, randomUUID } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import type { WorkAdmission } from '../../platform/work-fence.js';

import type { DreamuxLogger } from '@excitedjs/dreamux-types';

import { RuleViolation, throwCallerMistake } from '../../command/errors.js';
import { deduplicate } from '../../platform/deduplicate.js';
import { ServerShuttingDownError } from '../../platform/errors.js';
import { InFlightWork } from '../../platform/in-flight-work.js';
import {
  canonicalJsonValue,
  JSON_VALUE_UNBOUNDED,
} from '../../platform/json-value.js';
import {
  validateWorkflowRunId,
  workflowRunJournalPath,
  workflowRunnerEntryPath,
  type WorkflowScopePathInput,
} from '../../platform/paths.js';
import { throwSettledFailures } from '../../platform/shutdown-errors.js';
import {
  type CompletionDeliveryPolicy,
  type CompletionOwner,
} from '../completion-router/index.js';
import { WorkflowRunNotFoundError } from './errors.js';
import { WorkflowJournal } from './journal.js';
import {
  assertWorkflowMaxConcurrency,
  DEFAULT_WORKFLOW_MAX_CONCURRENCY,
  MAX_SCRIPT_BYTES,
} from './limits.js';
import { WorkflowRun } from './run.js';
import { WorkflowRunStore } from './store.js';
import type {
  WorkflowCallerKind,
  WorkflowListResult,
  WorkflowRunAccepted,
  WorkflowRunInput,
  WorkflowRunRecord,
  WorkflowStatusInput,
  WorkflowStopInput,
  WorkflowStopResult,
  WorkflowTeammateFactory,
} from './types.js';

export interface WorkflowServiceOptions extends WorkflowScopePathInput {
  teammates: WorkflowTeammateFactory;
  completionDelivery: CompletionDeliveryPolicy;
  completionOwner: CompletionOwner;
  /**
   * The owner's own admission gate, crossed by every public verb below
   * (`run`/`status`/`stop`/`list`) — the same shape `SchedulerService` takes.
   */
  fence: WorkAdmission;
  log: DreamuxLogger;
}

export interface WorkflowOps {
  run(input: WorkflowRunInput): Promise<WorkflowRunAccepted>;
  status(input: WorkflowStatusInput): Promise<WorkflowRunRecord>;
  stop(input: WorkflowStopInput): Promise<WorkflowStopResult>;
  list(): Promise<WorkflowListResult>;
}

/** Scope-owned collection of live WorkflowRun entities and durable records. */
export class WorkflowService implements WorkflowOps {
  private readonly scope: WorkflowScopePathInput;
  private readonly store: WorkflowRunStore;
  private readonly runs = new Map<string, WorkflowRun>();
  private readonly runCreations = new InFlightWork();
  private readonly callerKind: WorkflowCallerKind;
  private accepting = false;

  constructor(private readonly opts: WorkflowServiceOptions) {
    this.scope = {
      dispatcherId: opts.dispatcherId,
      teamId: opts.teamId,
    };
    // A dispatcher-scoped run has no team; a Team-scoped run always has one —
    // the caller kind is the scope, not a fact a caller could get wrong.
    this.callerKind = opts.teamId === null ? 'dispatcher' : 'team_leader';
    this.store = new WorkflowRunStore(this.scope);
  }

  async start(): Promise<void> {
    await this.recover();
    this.accepting = true;
  }

  async recover(): Promise<void> {
    await this.initialize();
  }

  requestStopAll(): void {
    this.accepting = false;
    for (const run of this.runs.values()) run.requestStop();
  }

  run(input: WorkflowRunInput): Promise<WorkflowRunAccepted> {
    return this.opts.fence.admit(() =>
      this.runCreations.track(this.createRun(input)),
    );
  }

  private async createRun(
    input: WorkflowRunInput,
  ): Promise<WorkflowRunAccepted> {
    await this.initialize();
    if (!this.accepting) {
      throw new ServerShuttingDownError('workflow admission is closed');
    }
    // Every caller-driven validation for a run request, in one place: the
    // reader (`requests.ts`) only shapes the input, so the bound and the
    // script/scriptPath rule are each checked here exactly once, and any
    // `RuleViolation` this preamble raises is reclassified identically as
    // the caller's mistake.
    let maxConcurrency: number;
    let script: string;
    try {
      maxConcurrency =
        input.max_concurrency ?? DEFAULT_WORKFLOW_MAX_CONCURRENCY;
      assertWorkflowMaxConcurrency(maxConcurrency);
      if (Object.hasOwn(input, 'args')) {
        canonicalJsonValue(input.args, JSON_VALUE_UNBOUNDED);
      }
      script = await resolveWorkflowScript(input);
      if (script.trim() === '') {
        throw new RuleViolation('workflow script must be non-empty');
      }
    } catch (error) {
      throwCallerMistake(error);
    }

    const runId = validateWorkflowRunId(`run-${randomUUID()}`);
    const initiator = this.opts.completionOwner.completionRecipient();
    const now = Date.now();
    const record: WorkflowRunRecord = {
      version: 1,
      run_id: runId,
      dispatcher_id: this.scope.dispatcherId,
      team_id: this.scope.teamId,
      caller_kind: this.callerKind,
      script_hash: createHash('sha256').update(script).digest('hex'),
      status: 'running',
      max_concurrency: maxConcurrency,
      phase: null,
      last_log: null,
      agents: [],
      result: null,
      error: null,
      created_at: now,
      updated_at: now,
      ended_at: null,
    };
    const run = new WorkflowRun({
      record,
      store: this.store,
      teammates: this.opts.teammates,
      runnerEntryPath: workflowRunnerEntryPath(),
      recipient: initiator,
      completionDelivery: this.opts.completionDelivery,
      log: this.opts.log,
    });
    await run.initialize();
    this.runs.set(runId, run);
    void run.settled.then(() => {
      this.evict(runId, run);
    });
    if (!this.accepting) run.requestStop();
    this.opts.log.info(
      {
        run_id: runId,
        dispatcher_id: this.scope.dispatcherId,
        team_id: this.scope.teamId,
        caller_kind: this.callerKind,
        max_concurrency: record.max_concurrency,
      },
      'workflow run created',
    );
    await run.start(script, input.args);
    return { run_id: runId };
  }

  async status(input: WorkflowStatusInput): Promise<WorkflowRunRecord> {
    return this.opts.fence.admit(() => this.doStatus(input));
  }

  private async doStatus(
    input: WorkflowStatusInput,
  ): Promise<WorkflowRunRecord> {
    await this.initialize();
    const runId = validateWorkflowRunId(input.run_id);
    const active = this.runs.get(runId);
    if (active !== undefined) return active.snapshot();
    const record = await this.store.get(runId);
    if (record === null) {
      throw new WorkflowRunNotFoundError(
        `workflow run ${JSON.stringify(runId)} does not exist`,
      );
    }
    return record;
  }

  async stop(input: WorkflowStopInput): Promise<WorkflowStopResult> {
    return this.opts.fence.admit(() => this.doStop(input));
  }

  private async doStop(input: WorkflowStopInput): Promise<WorkflowStopResult> {
    await this.initialize();
    const runId = validateWorkflowRunId(input.run_id);
    const active = this.runs.get(runId);
    if (active === undefined) {
      const record = await this.doStatus({ run_id: runId });
      return { run_id: runId, status: record.status };
    }
    return { run_id: runId, status: await active.stop() };
  }

  async list(): Promise<WorkflowListResult> {
    return this.opts.fence.admit(() => this.doList());
  }

  private async doList(): Promise<WorkflowListResult> {
    await this.initialize();
    const records = new Map(
      (await this.store.list()).map((record) => [record.run_id, record]),
    );
    for (const [runId, run] of this.runs) records.set(runId, run.snapshot());
    return {
      runs: [...records.values()].sort(
        (a, b) =>
          b.created_at - a.created_at || a.run_id.localeCompare(b.run_id),
      ),
    };
  }

  async stopAll(): Promise<void> {
    this.requestStopAll();
    await this.recover();
    await this.runCreations.drain();
    const results = await Promise.allSettled(
      [...this.runs.values()].map((run) => run.stop()),
    );
    throwSettledFailures(results, 'multiple workflow runs failed to stop');
  }

  /**
   * Reconcile the durable records once, before this scope answers anything.
   *
   * Every public operation enters through it, so recovery happens exactly once
   * per scope; a failed attempt is released, so the next caller retries rather
   * than inheriting a broken view.
   */
  @deduplicate
  private async initialize(): Promise<void> {
    await this.recoverRunningRecords();
  }

  private async recoverRunningRecords(): Promise<void> {
    for (const stored of await this.store.list()) {
      if (stored.status !== 'running') continue;
      // `stored` came from a one-shot disk read. Mutating it in place here
      // would make a retry after a failed `store.write` below see this
      // attempt's already-'stopped' in-memory draft instead of re-reading
      // the still-'running' file, and silently skip recovering it. Recover a
      // clone; only a successful `store.write` may replace the committed
      // value.
      const record = structuredClone(stored);
      const journal = new WorkflowJournal(
        workflowRunJournalPath({ ...this.scope, runId: record.run_id }),
      );
      const backfilled = await journal.recover(record, Date.now());
      await this.store.write(record);
      // This correction has no `WorkflowRun` owner to settle and release the
      // store later — the record is already terminal, so release it now.
      this.store.release(record.run_id);
      this.opts.log.warn(
        { run_id: record.run_id, status: record.status },
        backfilled
          ? 'recovered running workflow as stopped'
          : 'completed workflow record from terminal journal',
      );
    }
  }

  /**
   * Drop the exact instance that reported itself over.
   *
   * The identity check is the whole safety property: by the time a run is
   * durably terminal the id may already name a different run, and a run that
   * ended must never evict its successor.
   */
  private evict(runId: string, expected: WorkflowRun): void {
    if (this.runs.get(runId) === expected) {
      this.runs.delete(runId);
      this.store.release(runId);
    }
  }
}

async function resolveWorkflowScript(input: WorkflowRunInput): Promise<string> {
  const hasScript =
    typeof input.script === 'string' && input.script.trim() !== '';
  const hasScriptPath =
    typeof input.scriptPath === 'string' && input.scriptPath.trim() !== '';
  if (!hasScript && !hasScriptPath) {
    throw new RuleViolation('workflow script or scriptPath must be provided');
  }
  if (hasScript) return input.script as string;
  const path = input.scriptPath as string;
  const fileStat = await stat(path);
  if (!fileStat.isFile()) {
    throw new RuleViolation(
      `workflow scriptPath is not a regular file: ${path}`,
    );
  }
  if (fileStat.size > MAX_SCRIPT_BYTES) {
    throw new RuleViolation(
      `workflow scriptPath exceeds ${MAX_SCRIPT_BYTES} bytes: ${path}`,
    );
  }
  return await readFile(path, 'utf8');
}
