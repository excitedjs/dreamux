import type { DreamuxLogger } from '@excitedjs/dreamux-types';
import {
  errorInfo,
  errorMessage,
  isUnsupportedFeatureError,
} from '@excitedjs/dreamux-utils';
import { ForkedWorkflowRunner } from './runner-process.js';

import { InFlightWork } from '../../platform/in-flight-work.js';
import { workflowRunJournalPath } from '../../platform/paths.js';
import { throwSettledFailures } from '../../platform/shutdown-errors.js';
import type { LockedTeammate } from '../agent/service-types.js';
import type { Turn, TurnAdmission } from '../agent/turn.js';
import type {
  CompletionDeliveryPolicy,
  CompletionInitiator,
} from '../completion-router/index.js';
import { AGENT_TASK_SOURCE } from '../submission-sources.js';
import { WorkflowPersistenceError } from './errors.js';
import {
  WorkflowJournal,
  type WorkflowAgentResultJournalEvent,
} from './journal.js';
import { MAX_AGENTS } from './limits.js';
import {
  isWorkflowRunnerChildMessage,
  normalizeAgentOptions,
  type WorkflowAgentOptions,
  type WorkflowAgentStartMessage,
  type WorkflowRunnerChildMessage,
} from './protocol.js';
import type { WorkflowRunnerHandle } from './runner-process.js';
import { WorkflowSemaphore } from './semaphore.js';
import { WorkflowRunStore } from './store.js';
import type {
  WorkflowAgentRecord,
  WorkflowAgentStatus,
  WorkflowRunRecord,
  WorkflowTeammateFactory,
  WorkflowTerminalStatus,
} from './types.js';

/** Appended to every agent's system prompt: this call's output is consumed
 * by the workflow, not shown to a human. */
export const WORKFLOW_AGENT_SYSTEM_PROMPT =
  'You are executing one agent call inside a Dreamux workflow. Your final ' +
  'response is the return value consumed by the workflow, not a human-facing ' +
  'progress message. Return only the requested value. When an output schema is ' +
  "provided, use the runtime's structured-output mechanism and satisfy the " +
  'schema exactly.';

/** `value` when it is a non-empty (after trimming) string, otherwise `null`. */
function nonEmpty(value: string | undefined): string | null {
  if (value === undefined || value.trim() === '') return null;
  return value;
}

export interface WorkflowRunDeps {
  record: WorkflowRunRecord;
  store: WorkflowRunStore;
  teammates: WorkflowTeammateFactory;
  runnerEntryPath: string;
  completionDelivery: CompletionDeliveryPolicy;
  recipient: CompletionInitiator;
  log: DreamuxLogger;
}

interface AgentCall {
  record: WorkflowAgentRecord;
  options: WorkflowAgentOptions;
  materialization: Promise<LockedTeammate> | null;
  handle: LockedTeammate | null;
  turn: Turn | null;
  resultCandidate: WorkflowAgentResultJournalEvent | null;
  completed: boolean;
}

/** What a stop, a runner report, or an internal failure asked this run to
 * become, reserved once before {@link WorkflowRun.finalize} makes it
 * durable. */
interface TerminalIntent {
  status: WorkflowTerminalStatus;
  result: unknown;
  error: string | null;
}

/** One live Workflow entity with direct locked TeamMate and Turn ownership. */
export class WorkflowRun {
  private readonly record: WorkflowRunRecord;
  /** This run's own durability journal, bound from its own scope and run id
   * — no owner hands one in. */
  private readonly journal: WorkflowJournal;
  private readonly runner: WorkflowRunnerHandle;
  private readonly semaphore: WorkflowSemaphore;
  private readonly calls = new Map<number, AgentCall>();
  private readonly materializations = new InFlightWork();
  private readonly runnerMessageTasks = new InFlightWork();
  private readonly agentTasks = new InFlightWork();
  private readonly unlockedHandles = new Set<LockedTeammate>();
  private runnerMessageTail: Promise<void> = Promise.resolve();
  /** Flips at *receipt* of a `run_result` message, before it is queued behind
   * `runnerMessageTail` — distinct from `terminalIntent`, which is set only
   * once that queued message is actually processed. Guards the receive-time
   * window between the two: a second `run_result` or an `onExit` racing in
   * it must still be dropped. */
  private runnerTerminalMessageSeen = false;
  /** The full record {@link finalize} will commit, computed once after
   * teardown and memoized so a retried finalize reuses the same `ended_at`
   * instead of recomputing a different one — unlike `terminalIntent`, which
   * is reserved before teardown even starts. */
  private terminalCandidate: WorkflowRunRecord | null = null;
  /**
   * The terminal report this run still owes its initiator; `null` once it is
   * delivered, or once a stop made it not news: the initiator or its own scope
   * fence asked for the stop, so the party that ended the run would read it.
   */
  private recipient: CompletionInitiator | null;
  /** Set once, by whichever of {@link reserveStop}/{@link requestTerminal}
   * wins. */
  private terminalIntent: TerminalIntent | null = null;
  /** Memoized {@link finalize} task; cleared on failure so a retry re-runs
   * it. */
  private terminalTask: Promise<void> | null = null;
  private announceSettled!: () => void;
  /**
   * Resolves once this run is durably over: terminal record written, terminal
   * completion delivered, nothing left to retry.
   *
   * It is a fact the run states about itself, not an instruction. The owner
   * that holds the run decides what being over means for its own bookkeeping;
   * the run does not reach up and remove itself from a collection it is not
   * allowed to know about.
   */
  readonly settled: Promise<void>;

  constructor(private readonly deps: WorkflowRunDeps) {
    this.record = deps.record;
    this.journal = new WorkflowJournal(
      workflowRunJournalPath({
        dispatcherId: deps.record.dispatcher_id,
        teamId: deps.record.team_id,
        runId: deps.record.run_id,
      }),
    );
    this.recipient = deps.recipient;
    this.semaphore = new WorkflowSemaphore(deps.record.max_concurrency);
    this.settled = new Promise<void>((resolve) => {
      this.announceSettled = resolve;
    });
    this.runner = new ForkedWorkflowRunner(deps.runnerEntryPath, {
      onMessage: (message) => this.receiveRunnerMessage(message),
      onExit: (exit) => {
        deps.log.info(
          {
            run_id: this.record.run_id,
            code: exit.code,
            signal: exit.signal,
          },
          'workflow runner exited',
        );
        if (
          !this.runnerTerminalMessageSeen &&
          this.terminalRequested === null
        ) {
          this.observeTerminal(
            'failed',
            null,
            `workflow runner exited before reporting a result (code=${String(exit.code)}, signal=${String(exit.signal)})`,
          );
        }
      },
      onError: (error) => {
        deps.log.error(
          { run_id: this.record.run_id, err: errorInfo(error) },
          'workflow runner error',
        );
        if (this.terminalRequested === null) {
          this.observeTerminal('failed', null, error.message);
        }
      },
    });
  }

  /**
   * The run's last *committed* value — what `workflow_status`/`workflow_list`
   * read — never the in-progress draft `this.record` becomes between a
   * mutation and the {@link persist} call that publishes it. Reachable only
   * after `initialize()` has published this run's first committed record
   * (the owner does not register this `WorkflowRun` until then), so the
   * handle is always loaded here.
   */
  snapshot(): WorkflowRunRecord {
    const current = this.deps.store.handle(this.record.run_id).current;
    if (current === null) {
      throw new Error(
        `workflow run ${JSON.stringify(this.record.run_id)} has no committed record`,
      );
    }
    return structuredClone(current);
  }

  async initialize(): Promise<void> {
    await this.journal.create({
      kind: 'run',
      version: 1,
      run_id: this.record.run_id,
      script_hash: this.record.script_hash,
      caller: { kind: this.record.caller_kind },
      dispatcher_id: this.record.dispatcher_id,
      team_id: this.record.team_id,
      created_at: this.record.created_at,
    });
    await this.deps.store.create(this.record);
  }

  async start(script: string, args: unknown): Promise<void> {
    try {
      if (this.terminalRequested !== null) {
        await this.stop();
        return;
      }
      await this.runner.start();
      if (this.terminalRequested !== null) {
        await this.stop();
        return;
      }
      await this.runner.send({ type: 'run_start', script, args });
    } catch (error) {
      await this.requestTerminal('failed', null, errorMessage(error));
    }
  }

  async stop(): Promise<WorkflowTerminalStatus> {
    this.reserveStop();
    const intent = this.terminalIntent!;
    await this.ensureTerminalTask(intent);
    return intent.status;
  }

  requestStop(): void {
    this.reserveStop();
  }

  private get terminalRequested(): WorkflowTerminalStatus | null {
    return this.terminalIntent?.status ?? null;
  }

  /** A live run accepts agent/emit messages until terminal intent is reserved. */
  private get terminalAccepting(): boolean {
    return this.terminalIntent === null;
  }

  private get terminalSuppressDelivery(): boolean {
    return this.terminalIntent !== null;
  }

  /** Reserve the `stopped` intent and signal the runner; a no-op once an
   * intent is already reserved. */
  private reserveStop(): void {
    if (this.terminalIntent !== null) {
      return;
    }
    this.terminalIntent = { status: 'stopped', result: null, error: null };
    this.closeOnTerminalIntent('stopped');
    this.deps.log.info({ run_id: this.record.run_id }, 'stopping workflow run');
    void this.runner.send({ type: 'abort' }).catch((error: unknown) => {
      this.deps.log.warn(
        { run_id: this.record.run_id, err: errorInfo(error) },
        'workflow abort IPC failed; killing runner',
      );
    });
  }

  /** Reserve an already-known status/result/error, then return the shared
   * {@link finalize} task; a no-op reservation once an intent exists, but the
   * task is still returned so every caller converges on the same wait. */
  private requestTerminal(
    status: WorkflowTerminalStatus,
    result: unknown,
    error: string | null,
  ): Promise<void> {
    if (this.terminalIntent === null) {
      this.terminalIntent = { status, result, error };
      this.closeOnTerminalIntent(status);
    }
    return this.ensureTerminalTask(this.terminalIntent);
  }

  /** Fire-and-forget {@link requestTerminal}, for an observed terminal fact
   * (a runner exit) rather than one the caller itself caused. */
  private observeTerminal(
    status: WorkflowTerminalStatus,
    result: unknown,
    error: string | null,
  ): void {
    void this.requestTerminal(status, result, error).catch(
      (terminalError: unknown) => {
        this.deps.log.error(
          { run_id: this.record.run_id, err: errorInfo(terminalError) },
          'workflow terminal transition failed',
        );
      },
    );
  }

  /** Reached once, when the first terminal intent is reserved: no further
   * Agent may acquire a concurrency slot, and — only for a stop — the
   * initiator no longer gets a completion push, since the party that ended
   * the run would read it itself. A completed or failed intent that won the
   * race keeps its report. */
  private closeOnTerminalIntent(status: WorkflowTerminalStatus): void {
    this.semaphore.close(new Error(`workflow ${status}`));
    if (status === 'stopped') this.recipient = null;
  }

  /** The one retryable {@link finalize} task, shared by every caller. */
  private ensureTerminalTask(intent: TerminalIntent): Promise<void> {
    if (this.terminalTask !== null) return this.terminalTask;
    const task = this.finalize(intent.status, intent.result, intent.error)
      .then(() => {
        this.announceSettled();
      })
      .catch((error: unknown) => {
        if (this.terminalTask === task) this.terminalTask = null;
        throw error;
      });
    this.terminalTask = task;
    return task;
  }

  private receiveRunnerMessage(message: unknown): void {
    if (!isWorkflowRunnerChildMessage(message)) {
      this.deps.log.warn(
        { run_id: this.record.run_id },
        'ignoring malformed workflow runner message',
      );
      return;
    }
    if (this.runnerTerminalMessageSeen || this.terminalRequested !== null)
      return;
    if (message.type === 'run_result') this.runnerTerminalMessageSeen = true;
    const task = this.runnerMessageTail
      .then(() => this.handleRunnerMessage(message))
      .catch((error: unknown) => {
        this.observeTerminal('failed', null, errorMessage(error));
      });
    this.runnerMessageTail = task;
    if (message.type !== 'run_result') this.runnerMessageTasks.track(task);
  }

  private async handleRunnerMessage(
    message: WorkflowRunnerChildMessage,
  ): Promise<void> {
    switch (message.type) {
      case 'agent_start':
        await this.handleAgentStart(message);
        return;
      case 'emit':
        if (!this.terminalAccepting) return;
        if (message.kind === 'phase') this.record.phase = message.message;
        else this.record.last_log = message.message;
        this.record.updated_at = Date.now();
        await this.persist(async () => {
          await this.journal.append({
            kind: message.kind,
            message: message.message,
            created_at: this.record.updated_at,
          });
          await this.deps.store.write(this.record);
        });
        return;
      case 'run_result':
        if (this.terminalRequested !== null) return;
        await this.requestTerminal(
          message.status === 'completed' ? 'completed' : 'failed',
          message.status === 'completed' ? (message.result ?? null) : null,
          message.status === 'completed' ? null : message.error,
        );
        return;
    }
  }

  private async handleAgentStart(
    message: WorkflowAgentStartMessage,
  ): Promise<void> {
    if (!this.terminalAccepting) {
      await this.sendAgentError(message.index, 'workflow is no longer running');
      return;
    }
    if (this.calls.has(message.index)) {
      await this.sendAgentError(
        message.index,
        'duplicate workflow agent index',
      );
      return;
    }
    if (this.calls.size >= MAX_AGENTS) {
      await this.sendAgentError(
        message.index,
        `workflow agent lifecycle limit of ${MAX_AGENTS} exceeded`,
      );
      return;
    }

    let options: WorkflowAgentOptions;
    try {
      options = normalizeAgentOptions(message.options);
    } catch (error) {
      await this.sendAgentError(message.index, errorMessage(error));
      return;
    }
    const createdAt = Date.now();
    const record: WorkflowAgentRecord = {
      index: message.index,
      name: null,
      label: options.label ?? null,
      phase: options.phase ?? this.record.phase,
      status: 'queued',
      result: null,
      error: null,
      created_at: createdAt,
      settled_at: null,
    };
    const call: AgentCall = {
      record,
      options,
      materialization: null,
      handle: null,
      turn: null,
      resultCandidate: null,
      completed: false,
    };
    this.calls.set(message.index, call);
    this.record.agents.push(record);
    this.record.updated_at = createdAt;
    await this.persist(() => this.deps.store.write(this.record));

    this.deps.log.info(
      {
        run_id: this.record.run_id,
        index: message.index,
        phase: record.phase,
      },
      'workflow agent_start',
    );
    if (this.semaphore.isFull()) {
      this.deps.log.info(
        { run_id: this.record.run_id, index: message.index },
        'workflow agent queued by concurrency limit',
      );
    }
    this.agentTasks.track(this.executeAgent(call, message.prompt));
  }

  private async executeAgent(call: AgentCall, prompt: string): Promise<void> {
    let releaseSlot: (() => void) | null = null;
    try {
      releaseSlot = await this.semaphore.acquire();
      if (this.terminalRequested !== null) {
        await this.completeAgent(call, 'stopped', null, null);
        return;
      }
      call.record.status = 'running';
      call.record.phase = call.options.phase ?? this.record.phase;
      this.record.updated_at = Date.now();
      await this.persist(() => this.deps.store.write(this.record));
      if (this.terminalRequested !== null) {
        await this.completeAgent(call, 'stopped', null, null);
        return;
      }

      const materialization = this.deps.teammates.createLocked(
        {
          name:
            nonEmpty(call.options.label) ??
            `workflow-${this.record.run_id}-${call.record.index + 1}`,
          prompt,
          intent:
            call.options.intent ??
            `Workflow ${this.record.run_id} agent ${call.record.index + 1}`,
          agentRuntime: call.options.agentType,
          identity: call.options.identity,
        },
        {
          systemPromptAppend: [WORKFLOW_AGENT_SYSTEM_PROMPT],
          outputSchema: call.options.schema,
        },
      );
      call.materialization = materialization;
      this.materializations.track(materialization);
      const handle = await materialization;
      call.handle = handle;

      call.record.name = handle.name;
      const submittedAt = Date.now();
      this.record.updated_at = submittedAt;
      await this.persist(async () => {
        await this.journal.append({
          kind: 'submit',
          index: call.record.index,
          name: handle.name,
          created_at: submittedAt,
        });
        await this.deps.store.write(this.record);
      });
      if (this.terminalRequested !== null) {
        await this.completeAgent(call, 'stopped', null, null);
        return;
      }

      const admission = await handle.submit({
        prompt,
        // A Workflow step is work one Agent handed to another, exactly like an
        // MCP spawn; who scheduled it is already the turn's own identity.
        // The step's output schema is already bound at creation time (above,
        // via CreateLockedTeammateOptions) and cannot vary per submission —
        // WorkflowTeammateSubmitInput carries no outputSchema field.
        source: AGENT_TASK_SOURCE,
      });
      this.deps.log.info(
        {
          run_id: this.record.run_id,
          index: call.record.index,
          producer: handle.name,
          status: admission.status,
        },
        'workflow agent submitted',
      );
      await this.observeAdmission(call, admission);
    } catch (error) {
      if (error instanceof WorkflowPersistenceError) {
        this.observeTerminal('failed', null, error.message);
        return;
      }
      if (!call.completed) {
        const stopped = this.terminalRequested !== null;
        const publicError = errorMessage(error);
        await this.completeAgent(
          call,
          stopped ? 'stopped' : 'failed',
          null,
          stopped ? null : publicError,
          !stopped && isUnsupportedFeatureError(error, 'outputSchema')
            ? publicError
            : undefined,
        ).catch((persistenceError: unknown) => {
          this.observeTerminal('failed', null, errorMessage(persistenceError));
        });
      }
    } finally {
      releaseSlot?.();
    }
  }

  private async observeAdmission(
    call: AgentCall,
    admission: TurnAdmission,
  ): Promise<void> {
    if (admission.status !== 'submitted') {
      const stopped =
        admission.status === 'stopped' || admission.status === 'skipped';
      const error =
        admission.status === 'failed' || admission.status === 'ambiguous'
          ? admission.error.message
          : stopped
            ? null
            : `workflow agent submission ${admission.status}`;
      const runnerError =
        (admission.status === 'failed' || admission.status === 'ambiguous') &&
        isUnsupportedFeatureError(admission.error, 'outputSchema')
          ? admission.error.message
          : undefined;
      await this.completeAgent(
        call,
        stopped ? 'stopped' : 'failed',
        null,
        error,
        runnerError,
      );
      return;
    }
    call.turn = admission.turn;
    // Never rejects: EntityTurn.settled folds every rejection into a
    // `{status: 'failed', ...}` outcome (service/agent/turn.ts) before it
    // resolves.
    const outcome = await admission.turn.settled;
    if (outcome.status !== 'completed') {
      await this.completeAgent(
        call,
        outcome.status,
        null,
        outcome.status === 'failed' ? outcome.error.message : null,
      );
      return;
    }

    let result: unknown = outcome.resultText;
    let error: string | null = null;
    let runnerError: string | undefined;
    if (call.options.schema !== undefined) {
      if (outcome.resultText === null) {
        result = null;
        error = 'runtime reported successful structured output that was empty';
        runnerError = error;
      } else {
        try {
          result = JSON.parse(outcome.resultText) as unknown;
        } catch {
          result = null;
          error =
            'runtime reported successful structured output that was not valid JSON';
          runnerError = error;
        }
      }
    }
    await this.completeAgent(
      call,
      error === null ? 'completed' : 'failed',
      result,
      error,
      runnerError,
    );
  }

  private async completeAgent(
    call: AgentCall,
    status: Extract<WorkflowAgentStatus, 'completed' | 'failed' | 'stopped'>,
    result: unknown,
    error: string | null,
    runnerError?: string,
  ): Promise<void> {
    if (call.completed) return;
    call.resultCandidate ??= {
      kind: 'result',
      index: call.record.index,
      status,
      result: status === 'completed' ? result : null,
      error,
      settled_at: call.record.settled_at ?? Date.now(),
    };
    const candidate = call.resultCandidate;
    call.record.status = candidate.status;
    call.record.result = candidate.result;
    call.record.error = candidate.error;
    call.record.settled_at = candidate.settled_at;
    this.record.updated_at = candidate.settled_at;
    await this.persist(async () => {
      await this.journal.ensureAgentResult(candidate);
      await this.deps.store.write(this.record);
    });
    call.completed = true;
    this.deps.log.info(
      {
        run_id: this.record.run_id,
        index: call.record.index,
        producer: call.record.name,
        status: candidate.status,
      },
      'workflow agent settled',
    );
    if (this.terminalSuppressDelivery) return;
    if (runnerError !== undefined) {
      await this.runner.send({
        type: 'agent_result',
        index: call.record.index,
        error: runnerError,
      });
    } else {
      await this.runner.send({
        type: 'agent_result',
        index: call.record.index,
        result: call.record.result,
      });
    }
  }

  private async sendAgentError(index: number, error: string): Promise<void> {
    if (this.terminalSuppressDelivery) return;
    await this.runner.send({ type: 'agent_result', index, error });
  }

  private async finalize(
    requestedStatus: WorkflowTerminalStatus,
    result: unknown,
    requestedError: string | null,
  ): Promise<void> {
    const runnerStopResults = await Promise.allSettled([this.runner.stop()]);
    // Admission-bookkeeping convergence, not a wait on an Agent's own turn:
    // this waits only for createLocked() (registering the locked handle) to
    // resolve, so the `handles` list read just below is complete before the
    // close pass runs, not for a still-running turn to finish naturally.
    await this.materializations.drain();

    const handles = [
      ...new Set(
        [...this.calls.values()]
          .map((call) => call.handle)
          .filter((handle): handle is LockedTeammate => handle !== null),
      ),
    ].filter((handle) => !this.unlockedHandles.has(handle));
    const closeResults = await Promise.allSettled(
      handles.map(async (handle) =>
        handle.close({
          note: `Workflow ${this.record.run_id} ${requestedStatus}`,
        }),
      ),
    );
    if (closeResults.some((close) => close.status === 'rejected')) {
      throwSettledFailures(
        [...runnerStopResults, ...closeResults],
        `workflow ${JSON.stringify(this.record.run_id)} runner or TeamMates failed to stop`,
      );
    }

    // Each of these three waits for this run's own already-admitted write
    // (a queued runner message, a completeAgent call, a store write) to land
    // truthfully — never for an Agent's own turn to finish naturally, which
    // a stop must never wait on.
    await this.runnerMessageTasks.drain();
    await this.agentTasks.drain();
    await this.deps.store.handle(this.record.run_id).drain();
    for (const call of this.calls.values()) {
      if (!call.completed) {
        await this.completeAgent(call, 'stopped', null, requestedError);
      }
    }
    await this.deps.store.handle(this.record.run_id).drain();
    throwSettledFailures(
      runnerStopResults,
      `workflow ${JSON.stringify(this.record.run_id)} runner failed to stop`,
    );

    if (this.terminalCandidate === null) {
      const endedAt = Date.now();
      this.terminalCandidate = {
        ...structuredClone(this.record),
        status: requestedStatus,
        result: requestedStatus === 'completed' ? result : null,
        error: requestedError,
        ended_at: endedAt,
        updated_at: endedAt,
      };
    }
    const candidate = this.terminalCandidate;
    await this.journal.ensureTerminal({
      kind: 'end',
      status: candidate.status as WorkflowTerminalStatus,
      result: candidate.result,
      error: candidate.error,
      ended_at: candidate.ended_at!,
    });
    await this.deps.store.write(candidate);
    Object.assign(this.record, structuredClone(candidate));

    for (const handle of handles) {
      if (this.unlockedHandles.has(handle)) continue;
      handle.unlock();
      this.unlockedHandles.add(handle);
    }

    const recipient = this.recipient;
    if (recipient !== null) {
      await this.deps.completionDelivery.deliver(recipient, {
        kind: 'workflow',
        source: 'workflow',
        runId: this.record.run_id,
        status: candidate.status as WorkflowTerminalStatus,
        result: JSON.stringify(
          {
            run_id: candidate.run_id,
            status: candidate.status,
            result: candidate.result,
            error: candidate.error,
            agents: candidate.agents
              .filter((agent) => agent.name !== null)
              .map((agent) => ({ index: agent.index, name: agent.name })),
          },
          null,
          2,
        ),
      });
      this.recipient = null;
    }
    this.deps.log.info(
      {
        run_id: this.record.run_id,
        status: candidate.status,
        agent_count: candidate.agents.length,
        err:
          candidate.error === null ? undefined : { message: candidate.error },
      },
      'workflow run terminal',
    );
  }

  /**
   * Run a durable write (journal append and/or `store.write`) and reclassify
   * any failure as a {@link WorkflowPersistenceError}. Ordering between two
   * durable writes from this same `WorkflowRun` instance comes from awaiting
   * them in sequence, not from a queue here: each per-run `TransactionalStore`
   * already serializes concurrent writers on its own file.
   * Result- and terminal-bearing writes await their matching journal fact
   * before the corresponding store write is enqueued.
   * `executeAgent`'s catch depends on this classification to tell "this run's
   * own storage failed" (a terminal failure) apart from "this Agent's runtime
   * work failed" (an ordinary agent failure another write can still record).
   */
  private async persist<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (error) {
      throw new WorkflowPersistenceError(errorMessage(error));
    }
  }
}
