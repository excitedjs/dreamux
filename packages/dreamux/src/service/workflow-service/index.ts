import { createHash, randomUUID } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';

import type { DreamuxLogger } from '@excitedjs/dreamux-types';

import {
  type CompletionDeliveryPolicy,
  type CompletionInitiator,
} from '../completion-router/index.js';
import { throwSettledFailures } from '../shutdown-errors.js';
import type {
  CreateLockedTeammateOptions,
} from '../teammate-collection/index.js';
import type { SpawnTeamMateRequest } from '../teammate-collection/types.js';
import type { LockedTeammate } from '../teammate-service/types.js';
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

export interface WorkflowTeammateFactory {
  createLocked(
    input: SpawnTeamMateRequest,
    options?: CreateLockedTeammateOptions,
  ): Promise<LockedTeammate>;
}

export interface WorkflowServiceOptions extends WorkflowScopePathInput {
  callerKind: WorkflowCallerKind;
  teammates: WorkflowTeammateFactory;
  completionDelivery: CompletionDeliveryPolicy;
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

  async start(): Promise<void> {
    await this.recover();
    this.accepting = true;
  }

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
      createLocked: (spawnInput, options) =>
        this.opts.teammates.createLocked(spawnInput, options),
      createRunner,
      deliverTerminal: (fact) =>
        this.opts.completionDelivery.deliver(initiator, fact),
      evict: (terminal) => this.evict(runId, terminal),
      log: this.opts.log,
      ...(this.opts.now !== undefined ? { now: this.opts.now } : {}),
    });
    await run.initialize();
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

  async stopAll(): Promise<void> {
    this.closeAdmission();
    await this.recover();
    await Promise.allSettled([...this.runCreations]);
    const results = await Promise.allSettled(
      [...this.runs.values()].map((run) => run.stop()),
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
      const journal = new WorkflowJournal(
        workflowRunJournalPath({ ...this.scope, runId: record.run_id }),
      );
      for (const result of await journal.resultEvents()) {
        const agent = record.agents.find((item) => item.index === result.index);
        if (agent === undefined) {
          throw new Error(
            `workflow ${JSON.stringify(record.run_id)} journal has a result for unknown Agent ${result.index}`,
          );
        }
        if (
          agent.status !== 'queued' &&
          agent.status !== 'running' &&
          !agentMatchesJournalResult(agent, result)
        ) {
          throw new Error(
            `workflow ${JSON.stringify(record.run_id)} record conflicts with journal result for Agent ${result.index}`,
          );
        }
        agent.status = result.status;
        agent.result = result.result;
        agent.error = result.error;
        agent.settled_at = result.settled_at;
      }
      const committedTerminal = await journal.terminal();
      if (committedTerminal === null) {
        const endedAt = this.now();
        record.status = 'stopped';
        record.result = null;
        record.error =
          'Dreamux stopped before the workflow reached a terminal result';
        record.ended_at = endedAt;
        record.updated_at = endedAt;
        for (const agent of record.agents) {
          if (agent.status !== 'queued' && agent.status !== 'running') continue;
          const result = await journal.ensureAgentResult({
            kind: 'result',
            index: agent.index,
            status: 'stopped',
            result: null,
            error: record.error,
            settled_at: endedAt,
          });
          agent.status = result.status;
          agent.result = result.result;
          agent.error = result.error;
          agent.settled_at = result.settled_at;
        }
        await journal.ensureTerminal({
          kind: 'end',
          status: 'stopped',
          result: null,
          error: record.error,
          ended_at: endedAt,
        });
      } else {
        const activeAgent = record.agents.find(
          (agent) => agent.status === 'queued' || agent.status === 'running',
        );
        if (activeAgent !== undefined) {
          throw new Error(
            `workflow ${JSON.stringify(record.run_id)} terminal journal conflicts with active Agent ${activeAgent.index}`,
          );
        }
        record.status = committedTerminal.status;
        record.result = committedTerminal.result;
        record.error = committedTerminal.error;
        record.ended_at = committedTerminal.ended_at;
        record.updated_at = committedTerminal.ended_at;
      }
      await this.store.write(record);
      this.opts.log.warn(
        { run_id: record.run_id, status: record.status },
        committedTerminal === null
          ? 'recovered running workflow as stopped'
          : 'completed workflow record from terminal journal',
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

function agentMatchesJournalResult(
  agent: WorkflowRunRecord['agents'][number],
  result: Awaited<ReturnType<WorkflowJournal['resultEvents']>>[number],
): boolean {
  return (
    agent.status === result.status &&
    agent.settled_at === result.settled_at &&
    agent.error === result.error &&
    JSON.stringify(agent.result) === JSON.stringify(result.result)
  );
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
