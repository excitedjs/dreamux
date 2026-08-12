import { createHash, randomUUID } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';

import type { DreamuxLogger } from '@excitedjs/dreamux-types';

import {
  completionKey,
  type CompletionInitiator,
  type CompletionRouter,
} from '../completion-router/index.js';
import type { OwnedTeammateOps } from '../teammate-collection/owned-teammates.js';
import { throwSettledFailures } from '../shutdown-errors.js';
import { errorInfo } from '../../platform/error-info.js';
import {
  validateWorkflowRunId,
  workflowRunJournalPath,
  workflowRunnerEntryPath,
  type WorkflowScopePathInput,
} from '../../platform/paths.js';
import { validateWorkflowArgs } from './json-args.js';
import { WorkflowJournal } from './journal.js';
import { parseWorkflowMaxConcurrency } from './limits.js';
import { WorkflowRun } from './run.js';
import {
  type WorkflowShutdownTakeoverKind,
  WorkflowStopInterruptedError,
} from './run-terminal.js';
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

const MAX_SCRIPT_BYTES = 1024 * 1024;

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
  /** Natural-settle grace after the first stop intent (test seam). */
  stopGraceMs?: number;
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
  /**
   * Run ids whose terminal finalization was taken over by shutdown, keyed by
   * which part of the terminal barrier remains unproven. A public stop that
   * lands on such a durable-only record rejects; a run that terminalized
   * truthfully before the broadcast is never recorded here and keeps its
   * idempotent already-terminal read contract.
   */
  private readonly shutdownTakeovers = new Map<
    string,
    WorkflowShutdownTakeoverKind
  >();

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
    const maxConcurrency = parseWorkflowMaxConcurrency(input.max_concurrency);
    if (Object.hasOwn(input, 'args')) validateWorkflowArgs(input.args);
    const script = await resolveWorkflowScript(input);
    if (script.trim() === '') {
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
      evict: (terminal, takeover, detachedSettle) =>
        this.evict(runId, terminal, takeover, detachedSettle),
      log: this.opts.log,
      ...(this.opts.now !== undefined ? { now: this.opts.now } : {}),
      ...(this.opts.stopGraceMs !== undefined
        ? { stopGraceMs: this.opts.stopGraceMs }
        : {}),
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
    await run.start(script, input.args);
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
      // A durable-only stop rejects only for a run whose shutdown finalization
      // actually evicted it as a takeover: frozen before owner release (its
      // release was skipped for the collection-wide sweep), or detached at
      // terminal routing. A run that terminalized truthfully before the
      // broadcast keeps its idempotent already-terminal read contract.
      if (this.shutdownTakeovers.has(runId)) {
        throw new WorkflowStopInterruptedError();
      }
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

  /**
   * Owner-completion seam: resolve per-run shutdown takeover records after
   * the owning collection-wide owned-TeamMate sweep succeeds. The sweep
   * proves owned release, so `frozen` takeovers resolve and later idempotent
   * stops return the durable terminal status. `routing-detached` takeovers
   * keep rejecting: the sweep cannot prove the outcome of a terminal routing
   * settle that had already started. Never called on sweep failure — the
   * records keep delayed public stops rejecting loudly.
   */
  clearShutdownTakeovers(): void {
    for (const [runId, kind] of this.shutdownTakeovers) {
      if (kind === 'frozen') this.shutdownTakeovers.delete(runId);
    }
  }

  /**
   * Wake every live run's terminal publication/grace waits for shutdown
   * takeover. This is the narrow per-run signal broadcast before the accepted
   * admin drain, not an early full stop: not-yet-started finalization is left
   * to the shutdown sweep's `stopAllForShutdown`. Runs whose finalization is
   * taken over record that fact at eviction, so a delayed public stop on the
   * frozen durable record rejects instead of reporting an unproven barrier.
   */
  interruptForShutdown(): void {
    for (const run of this.runs.values()) run.signalShutdown();
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
    throwSettledFailures(results, 'multiple workflow runs failed to stop');
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

  private evict(
    runId: string,
    expected: WorkflowRun,
    takeover: WorkflowShutdownTakeoverKind | null,
    detachedSettle: Promise<void> | null,
  ): void {
    if (this.runs.get(runId) !== expected) return;
    this.runs.delete(runId);
    if (takeover !== null) this.shutdownTakeovers.set(runId, takeover);
    if (takeover !== 'routing-detached' || detachedSettle === null) return;
    // The router contract guarantees settle() resolves with a terminal
    // outcome; once this detached settle resolves, the routing barrier is
    // proven and only this matching tombstone clears. The chaining happens
    // after the tombstone is recorded, so an already-resolved settle cannot
    // race ahead of it. A rejection (outside the router contract) stays loud
    // and does not prove terminal, so the tombstone remains.
    void detachedSettle
      .then(() => {
        if (this.shutdownTakeovers.get(runId) === 'routing-detached') {
          this.shutdownTakeovers.delete(runId);
        }
      })
      .catch((settleError: unknown) => {
        this.opts.log.error(
          { run_id: runId, err: errorInfo(settleError) },
          'workflow detached routing settle rejected; takeover entry retained',
        );
      });
  }

  private now(): number {
    return this.opts.now?.() ?? Date.now();
  }
}

export function workflowCompletionKey(runId: string): string {
  return completionKey('workflow', validateWorkflowRunId(runId));
}

async function resolveWorkflowScript(input: WorkflowRunInput): Promise<string> {
  const hasScript = typeof input.script === 'string' && input.script.trim() !== '';
  const hasScriptPath = typeof input.scriptPath === 'string' && input.scriptPath.trim() !== '';
  if (!hasScript && !hasScriptPath) {
    throw new Error('workflow script or scriptPath must be provided');
  }
  if (hasScript) return input.script as string;
  const path = input.scriptPath as string;
  const fileStat = await stat(path);
  if (!fileStat.isFile()) {
    throw new Error(`workflow scriptPath is not a regular file: ${path}`);
  }
  if (fileStat.size > MAX_SCRIPT_BYTES) {
    throw new Error(
      `workflow scriptPath exceeds ${MAX_SCRIPT_BYTES} bytes: ${path}`,
    );
  }
  return await readFile(path, 'utf8');
}
