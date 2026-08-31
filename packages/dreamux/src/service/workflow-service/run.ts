import type { DreamuxLogger } from '@excitedjs/dreamux-types';
import { isUnsupportedFeatureError } from '@excitedjs/dreamux-utils';

import { errorInfo, errorMessage } from '../../platform/error-info.js';
import type { WorkflowCompletionFact } from '../completion-router/index.js';
import { throwSettledFailures } from '../shutdown-errors.js';
import { AGENT_TASK_SOURCE } from '../submission-sources.js';
import type { SpawnTeamMateRequest } from '../teammate-collection/types.js';
import type {
  CreateLockedTeammateOptions,
} from '../teammate-collection/index.js';
import type { Turn, TurnAdmission } from '../teammate-service/turn-recording.js';
import type { LockedTeammate } from '../teammate-service/types.js';
import { WORKFLOW_AGENT_SYSTEM_PROMPT } from './agent-policy.js';
import {
  WorkflowJournal,
  type WorkflowAgentResultJournalEvent,
} from './journal.js';
import type {
  WorkflowAgentOptions,
  WorkflowAgentStartMessage,
  WorkflowRunnerChildMessage,
} from './protocol.js';
import {
  isWorkflowRunnerChildMessage,
  type WorkflowRunnerFactory,
  type WorkflowRunnerHandle,
} from './runner-process.js';
import { WorkflowRunStore } from './store.js';
import type {
  WorkflowAgentRecord,
  WorkflowAgentStatus,
  WorkflowRunRecord,
  WorkflowTerminalStatus,
} from './types.js';
import {
  nonEmpty,
  normalizeAgentOptions,
  WorkflowPersistenceError,
  WorkflowSemaphore,
} from './run-support.js';
import { WorkflowRunTerminal } from './run-terminal.js';

const MAX_AGENTS = 1000;
export interface WorkflowRunDeps {
  record: WorkflowRunRecord;
  store: WorkflowRunStore;
  journal: WorkflowJournal;
  createLocked(
    input: SpawnTeamMateRequest,
    options: CreateLockedTeammateOptions,
  ): Promise<LockedTeammate>;
  createRunner: WorkflowRunnerFactory;
  deliverTerminal: (completion: WorkflowCompletionFact) => Promise<void>;
  log: DreamuxLogger;
  now?: () => number;
}

interface AgentCall {
  record: WorkflowAgentRecord;
  options: WorkflowAgentOptions;
  materialization: Promise<LockedTeammate> | null;
  handle: LockedTeammate | null;
  turn: Turn | null;
  resultCandidate: WorkflowAgentResultJournalEvent | null;
  resultJournalCommitted: boolean;
  completed: boolean;
}
/** One live Workflow entity with direct locked TeamMate and Turn ownership. */
export class WorkflowRun {
  private readonly record: WorkflowRunRecord;
  private readonly runner: WorkflowRunnerHandle;
  private readonly semaphore: WorkflowSemaphore;
  private readonly terminal: WorkflowRunTerminal;
  private readonly calls = new Map<number, AgentCall>();
  private readonly materializations = new Set<Promise<LockedTeammate>>();
  private readonly runnerMessageTasks = new Set<Promise<void>>();
  private readonly agentTasks = new Set<Promise<void>>();
  private readonly unlockedHandles = new Set<LockedTeammate>();
  private mutationTail: Promise<void> = Promise.resolve();
  private runnerMessageTail: Promise<void> = Promise.resolve();
  private runnerTerminalMessageSeen = false;
  private terminalCandidate: WorkflowRunRecord | null = null;
  private terminalJournalCommitted = false;
  private terminalDeliveryCommitted = false;
  private terminalLogged = false;

  constructor(private readonly deps: WorkflowRunDeps) {
    this.record = deps.record;
    this.semaphore = new WorkflowSemaphore(deps.record.max_concurrency);
    this.runner = deps.createRunner({
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
          this.terminal.requested === null
        ) {
          this.terminal.observe(
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
        if (this.terminal.requested === null) {
          this.terminal.observe('failed', null, error.message);
        }
      },
    });
    this.terminal = new WorkflowRunTerminal({
      runId: this.record.run_id,
      status: () => this.record.status,
      abortRunner: () => this.runner.send({ type: 'abort' }),
      closeAdmission: (status) =>
        this.semaphore.close(new Error(`workflow ${status}`)),
      finalize: (status, result, error) => this.finalize(status, result, error),
      log: deps.log,
    });
  }

  /** Resolves once this run is durably terminal; the owner reads it to evict. */
  get settled(): Promise<void> { return this.terminal.settled; }

  snapshot(): WorkflowRunRecord {
    return structuredClone(this.record);
  }

  async initialize(): Promise<void> {
    await this.deps.journal.create({
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
      if (this.terminal.requested !== null) {
        await this.terminal.stop();
        return;
      }
      await this.runner.start();
      if (this.terminal.requested !== null) {
        await this.terminal.stop();
        return;
      }
      await this.runner.send({ type: 'run_start', script, args });
    } catch (error) {
      await this.terminal.request('failed', null, errorMessage(error));
    }
  }

  async stop(): Promise<WorkflowTerminalStatus> {
    return this.terminal.stop();
  }

  closeAdmission(): void {
    this.terminal.reserveStop();
  }

  private receiveRunnerMessage(message: unknown): void {
    if (!isWorkflowRunnerChildMessage(message)) {
      this.deps.log.warn(
        { run_id: this.record.run_id },
        'ignoring malformed workflow runner message',
      );
      return;
    }
    if (
      this.runnerTerminalMessageSeen ||
      this.terminal.requested !== null
    ) return;
    if (message.type === 'run_result') this.runnerTerminalMessageSeen = true;
    const task = this.runnerMessageTail
      .then(() => this.handleRunnerMessage(message))
      .catch((error: unknown) => {
        this.terminal.observe('failed', null, errorMessage(error));
      });
    this.runnerMessageTail = task;
    if (message.type !== 'run_result') {
      this.runnerMessageTasks.add(task);
      void task.finally(() => this.runnerMessageTasks.delete(task));
    }
  }

  private async handleRunnerMessage(
    message: WorkflowRunnerChildMessage,
  ): Promise<void> {
    switch (message.type) {
      case 'agent_start':
        await this.handleAgentStart(message);
        return;
      case 'emit':
        if (
          this.record.status !== 'running' ||
          this.terminal.requested !== null
        ) return;
        await this.mutate(async () => {
          if (message.kind === 'phase') this.record.phase = message.message;
          else this.record.last_log = message.message;
          this.record.updated_at = this.now();
          await this.deps.journal.append({
            kind: message.kind,
            message: message.message,
            created_at: this.record.updated_at,
          });
          await this.deps.store.write(this.record);
        });
        return;
      case 'run_result':
        if (this.terminal.requested !== null) return;
        await this.terminal.request(
          message.status === 'completed' ? 'completed' : 'failed',
          message.status === 'completed' ? message.result ?? null : null,
          message.status === 'completed' ? null : message.error,
        );
        return;
    }
  }

  private async handleAgentStart(message: WorkflowAgentStartMessage): Promise<void> {
    if (
      !this.terminal.accepting ||
      this.record.status !== 'running' ||
      this.terminal.requested !== null
    ) {
      await this.sendAgentError(message.index, 'workflow is no longer running');
      return;
    }
    if (this.calls.has(message.index)) {
      await this.sendAgentError(message.index, 'duplicate workflow agent index');
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
    const createdAt = this.now();
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
      resultJournalCommitted: false,
      completed: false,
    };
    this.calls.set(message.index, call);
    this.record.agents.push(record);
    this.record.updated_at = createdAt;
    await this.mutate(() => this.deps.store.write(this.record));

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
    const task = this.executeAgent(call, message.prompt);
    this.agentTasks.add(task);
    void task.finally(() => this.agentTasks.delete(task)).catch(() => {});
  }

  private async executeAgent(call: AgentCall, prompt: string): Promise<void> {
    let releaseSlot: (() => void) | null = null;
    try {
      releaseSlot = await this.semaphore.acquire();
      if (this.terminal.requested !== null) {
        await this.completeAgent(call, 'stopped', null, null);
        return;
      }
      call.record.status = 'running';
      call.record.phase = call.options.phase ?? this.record.phase;
      this.record.updated_at = this.now();
      await this.mutate(() => this.deps.store.write(this.record));
      if (this.terminal.requested !== null) {
        await this.completeAgent(call, 'stopped', null, null);
        return;
      }

      const materialization = this.deps.createLocked(
        {
          name: nonEmpty(call.options.label) ??
            `workflow-${this.record.run_id}-${call.record.index + 1}`,
          prompt,
          intent:
            call.options.intent ??
            `Workflow ${this.record.run_id} agent ${call.record.index + 1}`,
          ...(call.options.agentType !== undefined
            ? { agentRuntime: call.options.agentType }
            : {}),
          ...(call.options.identity !== undefined
            ? { identity: call.options.identity }
            : {}),
        },
        {
          systemPromptAppend: [WORKFLOW_AGENT_SYSTEM_PROMPT],
          outputSchema: call.options.schema,
        },
      );
      call.materialization = materialization;
      this.materializations.add(materialization);
      void materialization
        .finally(() => this.materializations.delete(materialization))
        .catch(() => {});
      const handle = await materialization;
      call.handle = handle;

      call.record.name = handle.name;
      const submittedAt = this.now();
      this.record.updated_at = submittedAt;
      await this.mutate(async () => {
        await this.deps.journal.append({
          kind: 'submit',
          index: call.record.index,
          name: handle.name,
          created_at: submittedAt,
        });
        await this.deps.store.write(this.record);
      });
      if (this.terminal.requested !== null) {
        await this.completeAgent(call, 'stopped', null, null);
        return;
      }

      const admission = await handle.submit({
        prompt,
        // A Workflow step is work one Agent handed to another, exactly like an
        // MCP spawn; who scheduled it is already the turn's own identity.
        source: AGENT_TASK_SOURCE,
        ...(call.options.schema !== undefined
          ? { outputSchema: call.options.schema }
          : {}),
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
        this.terminal.observe('failed', null, error.message);
        return;
      }
      if (!call.completed) {
        const stopped = this.terminal.requested !== null;
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
          this.terminal.observe(
            'failed',
            null,
            errorMessage(persistenceError),
          );
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
      const error = admission.status === 'failed' || admission.status === 'ambiguous'
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
    let outcome: Awaited<typeof admission.turn.settled>;
    try {
      outcome = await admission.turn.settled;
    } catch (error) {
      const persistenceError = errorMessage(error);
      await this.terminal.failAfterNotification(persistenceError, () =>
        this.completeAgent(call, 'failed', null, persistenceError, persistenceError, true));
      return;
    }
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
    runnerError?: string, deliverWhileTerminal = false,
  ): Promise<void> {
    if (call.completed) return;
    call.resultCandidate ??= {
      kind: 'result',
      index: call.record.index,
      status,
      result: status === 'completed' ? result : null,
      error,
      settled_at: call.record.settled_at ?? this.now(),
    };
    const candidate = call.resultCandidate;
    call.record.status = candidate.status;
    call.record.result = candidate.result;
    call.record.error = candidate.error;
    call.record.settled_at = candidate.settled_at;
    this.record.updated_at = candidate.settled_at;
    await this.mutate(async () => {
      if (!call.resultJournalCommitted) {
        await this.deps.journal.ensureAgentResult(candidate);
        call.resultJournalCommitted = true;
      }
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
    if (this.terminal.suppressDelivery && !deliverWhileTerminal) return;
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
    if (this.terminal.suppressDelivery) return;
    await this.runner.send({ type: 'agent_result', index, error });
  }

  private async finalize(
    requestedStatus: WorkflowTerminalStatus,
    result: unknown,
    requestedError: string | null,
  ): Promise<void> {
    const runnerStopResults = await Promise.allSettled([this.runner.stop()]);
    await this.joinMaterializations();

    const handles = [...new Set(
      [...this.calls.values()]
        .map((call) => call.handle)
        .filter((handle): handle is LockedTeammate => handle !== null),
    )].filter((handle) => !this.unlockedHandles.has(handle));
    const closeResults = await Promise.allSettled(
      handles.map(async (handle) =>
        handle.close({
          note: `Workflow ${this.record.run_id} ${requestedStatus}`,
        })),
    );
    if (closeResults.some((close) => close.status === 'rejected')) {
      throwSettledFailures(
        [...runnerStopResults, ...closeResults],
        `workflow ${JSON.stringify(this.record.run_id)} runner or TeamMates failed to stop`,
      );
    }

    await this.drainRunnerMessageTasks();
    await this.drainAgentTasks();
    await this.mutationTail;
    for (const call of this.calls.values()) {
      if (!call.completed) {
        await this.completeAgent(call, 'stopped', null, requestedError);
      }
    }
    await this.mutationTail;
    throwSettledFailures(
      runnerStopResults,
      `workflow ${JSON.stringify(this.record.run_id)} runner failed to stop`,
    );

    if (this.terminalCandidate === null) {
      const endedAt = this.now();
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
    if (!this.terminalJournalCommitted) {
      await this.deps.journal.ensureTerminal({
        kind: 'end',
        status: candidate.status as WorkflowTerminalStatus,
        result: candidate.result,
        error: candidate.error,
        ended_at: candidate.ended_at!,
      });
      this.terminalJournalCommitted = true;
    }
    await this.deps.store.write(candidate);
    Object.assign(this.record, structuredClone(candidate));

    for (const handle of handles) {
      if (this.unlockedHandles.has(handle)) continue;
      handle.unlock();
      this.unlockedHandles.add(handle);
    }

    if (!this.terminalDeliveryCommitted) {
      await this.deps.deliverTerminal({
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
      this.terminalDeliveryCommitted = true;
    }
    if (!this.terminalLogged) {
      this.terminalLogged = true;
      this.deps.log.info(
        {
          run_id: this.record.run_id,
          status: candidate.status,
          agent_count: candidate.agents.length,
          err: candidate.error === null
            ? undefined
            : { message: candidate.error },
        },
        'workflow run terminal',
      );
    }
  }

  private async joinMaterializations(): Promise<void> {
    while (this.materializations.size > 0) {
      await Promise.allSettled([...this.materializations]);
    }
    await Promise.resolve();
  }

  private async drainRunnerMessageTasks(): Promise<void> {
    while (this.runnerMessageTasks.size > 0) {
      await Promise.allSettled([...this.runnerMessageTasks]);
    }
  }

  private async drainAgentTasks(): Promise<void> {
    while (this.agentTasks.size > 0) {
      await Promise.allSettled([...this.agentTasks]);
    }
  }

  private mutate<T>(task: () => Promise<T>): Promise<T> {
    const next = this.mutationTail.then(task, task);
    this.mutationTail = next.then(
      () => undefined,
      () => undefined,
    );
    return next.catch((error: unknown) => {
      throw new WorkflowPersistenceError(errorMessage(error));
    });
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }
}
