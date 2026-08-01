import { createHash, randomUUID } from 'node:crypto';

import type { DreamuxLogger } from '@excitedjs/dreamux-types';

import {
  completionKey,
  type CompletionInitiator,
  type CompletionRouter,
} from '../completion-router/index.js';
import type { OwnedTeammateOps } from '../teammate-collection/owned-teammates.js';
import {
  validateWorkflowRunId,
  workflowRunJournalPath,
  workflowRunnerEntryPath,
  type WorkflowScopePathInput,
} from '../../platform/paths.js';
import { WorkflowJournal } from './journal.js';
import { WorkflowRun } from './run.js';
import {
  ForkedWorkflowRunner,
  type WorkflowRunnerFactory,
} from './runner-process.js';
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
} from './types.js';

const DEFAULT_MAX_CONCURRENCY = 8;
const MIN_MAX_CONCURRENCY = 1;
const MAX_MAX_CONCURRENCY = 8;

export interface WorkflowServiceOptions extends WorkflowScopePathInput {
  callerKind: WorkflowCallerKind;
  ownedTeammates: Pick<OwnedTeammateOps, 'spawnOwned' | 'releaseAllOwned'>;
  router: CompletionRouter;
  completionInitiator: () => CompletionInitiator;
  log: DreamuxLogger;
  createRunner?: WorkflowRunnerFactory;
  runnerEntryPath?: string;
  generateRunId?: () => string;
  now?: () => number;
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
  private readonly runCreations = new Set<Promise<WorkflowRunAccepted>>();
  private initializeTask: Promise<void> | null = null;
  private initialized = false;
  private accepting = false;

  constructor(private readonly opts: WorkflowServiceOptions) {
    this.scope = {
      dispatcherId: opts.dispatcherId,
      teamId: opts.teamId,
    };
    if (
      (opts.callerKind === 'dispatcher' && opts.teamId !== null) ||
      (opts.callerKind === 'team_leader' && opts.teamId === null)
    ) {
      throw new Error('workflow caller kind does not match its scope');
    }
    this.store = new WorkflowRunStore(this.scope);
  }

  /** Recover durable records once, then admit new runs for this owner lifetime. */
  async start(): Promise<void> {
    await this.recover();
    this.accepting = true;
  }

  /** Recover stale records without opening admission. */
  async recover(): Promise<void> {
    await this.initialize();
  }

  closeAdmission(): void {
    this.accepting = false;
    for (const run of this.runs.values()) run.closeAdmission();
  }

  run(input: WorkflowRunInput): Promise<WorkflowRunAccepted> {
    const creation = this.createRun(input);
    this.runCreations.add(creation);
    void creation
      .finally(() => this.runCreations.delete(creation))
      .catch(() => {});
    return creation;
  }

  private async createRun(input: WorkflowRunInput): Promise<WorkflowRunAccepted> {
    await this.initialize();
    if (!this.accepting) throw new Error('workflow admission is closed');
    if (typeof input.script !== 'string' || input.script.trim() === '') {
      throw new Error('workflow script must be non-empty');
    }

    const runId = validateWorkflowRunId(
      this.opts.generateRunId?.() ?? `run-${randomUUID()}`,
    );
    const initiator = this.opts.completionInitiator();
    const now = this.now();
    const record: WorkflowRunRecord = {
      version: 1,
      run_id: runId,
      dispatcher_id: this.scope.dispatcherId,
      team_id: this.scope.teamId,
      caller_kind: this.opts.callerKind,
      script_hash: createHash('sha256').update(input.script).digest('hex'),
      status: 'running',
      max_concurrency: clampMaxConcurrency(input.max_concurrency),
      phase: null,
      last_log: null,
      agents: [],
      result: null,
      error: null,
      created_at: now,
      updated_at: now,
      ended_at: null,
    };
    const key = workflowCompletionKey(runId);
    const createRunner = this.opts.createRunner ?? ((handlers) =>
      new ForkedWorkflowRunner(
        this.opts.runnerEntryPath ?? workflowRunnerEntryPath(),
        handlers,
      ));
    const run = new WorkflowRun({
      record,
      store: this.store,
      journal: new WorkflowJournal(
        workflowRunJournalPath({ ...this.scope, runId }),
      ),
      ownedTeammates: this.opts.ownedTeammates,
      createRunner,
      settleTerminal: (completion) => this.opts.router.settle(key, completion),
      discardTerminal: () => this.opts.router.discard(key),
      evict: (terminal) => this.evict(runId, terminal),
      log: this.opts.log,
      ...(this.opts.now !== undefined ? { now: this.opts.now } : {}),
    });
    await run.initialize();
    this.opts.router.register(key, initiator);
    this.runs.set(runId, run);
    if (!this.accepting) run.closeAdmission();
    this.opts.log.info(
      {
        run_id: runId,
        dispatcher_id: this.scope.dispatcherId,
        team_id: this.scope.teamId,
        caller_kind: this.opts.callerKind,
        max_concurrency: record.max_concurrency,
      },
      'workflow run created',
    );
    await run.start(input.script, input.args);
    return { run_id: runId };
  }

  async status(input: WorkflowStatusInput): Promise<WorkflowRunRecord> {
    await this.initialize();
    const runId = validateWorkflowRunId(input.run_id);
    const active = this.runs.get(runId);
    if (active !== undefined) return active.snapshot();
    const record = await this.store.get(runId);
    if (record === null) {
      throw new Error(`workflow run ${JSON.stringify(runId)} does not exist`);
    }
    return record;
  }

  async stop(input: WorkflowStopInput): Promise<WorkflowStopResult> {
    await this.initialize();
    const runId = validateWorkflowRunId(input.run_id);
    const active = this.runs.get(runId);
    if (active === undefined) {
      const record = await this.status({ run_id: runId });
      return { run_id: runId, status: record.status };
    }
    return { run_id: runId, status: await active.stop() };
  }

  async list(): Promise<WorkflowListResult> {
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

  stopAll(): Promise<void> {
    return this.stopRuns(async (run) => {
      await run.stopAndWait();
    });
  }

  /** Stop runners and persist terminal records without waiting on agent turns. */
  stopAllForShutdown(): Promise<void> {
    return this.stopRuns((run) => run.stopForShutdown());
  }

  private async stopRuns(
    stop: (run: WorkflowRun) => Promise<void>,
  ): Promise<void> {
    this.closeAdmission();
    await this.recover();
    await Promise.allSettled([...this.runCreations]);
    const results = await Promise.allSettled(
      [...this.runs.values()].map(stop),
    );
    const errors = results
      .filter(
        (result): result is PromiseRejectedResult => result.status === 'rejected',
      )
      .map((result) => result.reason);
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) {
      throw new AggregateError(errors, 'multiple workflow runs failed to stop');
    }
  }

  private initialize(): Promise<void> {
    if (this.initialized) return Promise.resolve();
    this.initializeTask ??= this.recoverRunningRecords().then(() => {
      this.initialized = true;
    }).finally(() => {
      this.initializeTask = null;
    });
    return this.initializeTask;
  }

  private async recoverRunningRecords(): Promise<void> {
    for (const record of await this.store.list()) {
      if (record.status !== 'running') continue;
      const endedAt = this.now();
      record.status = 'stopped';
      record.error = 'Dreamux stopped before the workflow reached a terminal result';
      record.ended_at = endedAt;
      record.updated_at = endedAt;
      for (const agent of record.agents) {
        if (agent.status !== 'queued' && agent.status !== 'running') continue;
        agent.status = 'stopped';
        agent.settled_at = endedAt;
      }
      await new WorkflowJournal(
        workflowRunJournalPath({ ...this.scope, runId: record.run_id }),
      ).append({ kind: 'end', status: 'stopped', ended_at: endedAt });
      await this.store.write(record);
      this.opts.log.warn(
        { run_id: record.run_id },
        'recovered running workflow as stopped',
      );
    }
  }

  private evict(runId: string, expected: WorkflowRun): void {
    if (this.runs.get(runId) === expected) this.runs.delete(runId);
  }

  private now(): number {
    return this.opts.now?.() ?? Date.now();
  }
}

export function workflowCompletionKey(runId: string): string {
  return completionKey('workflow', validateWorkflowRunId(runId));
}

function clampMaxConcurrency(value: number | undefined): number {
  if (value === undefined) return DEFAULT_MAX_CONCURRENCY;
  if (!Number.isFinite(value)) {
    throw new Error('workflow max_concurrency must be a finite number');
  }
  return Math.min(
    MAX_MAX_CONCURRENCY,
    Math.max(MIN_MAX_CONCURRENCY, Math.trunc(value)),
  );
}
