import type { DreamuxLogger } from '@excitedjs/dreamux-types';

import type { CompletionEnvelope } from '../completion-router/index.js';
import {
  createOwnedTeammateOwner,
  type OwnedTeammateOps,
} from '../teammate-collection/owned-teammates.js';
import { WorkflowJournal } from './journal.js';
import type {
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
  deferred,
  errorInfo,
  errorMessage,
  nonEmpty,
  normalizeAgentOptions,
  WorkflowPersistenceError,
  WorkflowSemaphore,
  type Deferred,
  type NormalizedWorkflowAgentOptions,
} from './run-support.js';

const MAX_AGENTS = 200;

export interface WorkflowRunDeps {
  record: WorkflowRunRecord;
  store: WorkflowRunStore;
  journal: WorkflowJournal;
  ownedTeammates: OwnedTeammateOps;
  createRunner: WorkflowRunnerFactory;
  settleTerminal: (completion: CompletionEnvelope) => Promise<void>;
  evict: (run: WorkflowRun) => void;
  log: DreamuxLogger;
  now?: () => number;
}

interface AgentCall {
  record: WorkflowAgentRecord;
  options: NormalizedWorkflowAgentOptions;
  submissionReady: Deferred<void>;
  settled: Deferred<void>;
  completed: boolean;
}

/** One live workflow entity: durable state, journal, child and owned agents. */
export class WorkflowRun {
  private readonly record: WorkflowRunRecord;
  private readonly runner: WorkflowRunnerHandle;
  private readonly semaphore: WorkflowSemaphore;
  private readonly calls = new Map<number, AgentCall>();
  private readonly runnerMessageTasks = new Set<Promise<void>>();
  private readonly agentTasks = new Set<Promise<void>>();
  private readonly teammateOwner = createOwnedTeammateOwner();
  private mutationTail: Promise<void> = Promise.resolve();
  private runnerMessageTail: Promise<void> = Promise.resolve();
  private terminalTask: Promise<void> | null = null;
  private terminalRequested: WorkflowTerminalStatus | null = null;
  private runnerTerminalMessageSeen = false;
  private suppressAgentDelivery = false;
  private acceptingAgents = true;

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
          this.terminalRequested === null
        ) {
          this.requestTerminalObserved(
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
          this.requestTerminalObserved('failed', null, error.message);
        }
      },
    });
  }

  get id(): string {
    return this.record.run_id;
  }

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
      await this.runner.start();
      await this.runner.send({ type: 'run_start', script, args });
    } catch (error) {
      await this.requestTerminal('failed', null, errorMessage(error));
    }
  }

  async stop(): Promise<WorkflowRunRecord> {
    if (this.terminalTask !== null) {
      await this.terminalTask;
      return this.snapshot();
    }
    if (this.record.status !== 'running') return this.snapshot();
    // Reserve the terminal outcome before abort IPC: the runner may report its
    // abort-induced failure before the send callback resumes this task.
    this.reserveStop();
    this.deps.log.info({ run_id: this.record.run_id }, 'stopping workflow run');
    await this.runner.send({ type: 'abort' }).catch((error: unknown) => {
      this.deps.log.warn(
        { run_id: this.record.run_id, err: errorInfo(error) },
        'workflow abort IPC failed; killing runner',
      );
    });
    await this.requestTerminal('stopped', null, null);
    return this.snapshot();
  }

  closeAdmission(): void {
    this.reserveStop();
  }

  private reserveStop(): void {
    if (
      this.terminalRequested !== null ||
      this.record.status !== 'running'
    ) return;
    this.terminalRequested = 'stopped';
    this.suppressAgentDelivery = true;
    this.acceptingAgents = false;
    this.semaphore.close(new Error('workflow stopped'));
  }

  private receiveRunnerMessage(message: unknown): void {
    if (!isWorkflowRunnerChildMessage(message)) {
      this.deps.log.warn(
        { run_id: this.record.run_id },
        'ignoring malformed workflow runner message',
      );
      return;
    }
    if (message.type === 'run_result') this.runnerTerminalMessageSeen = true;
    const task = this.runnerMessageTail
      .then(() => this.handleRunnerMessage(message))
      .catch((error: unknown) => {
        this.requestTerminalObserved('failed', null, errorMessage(error));
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
          this.terminalRequested !== null
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
        if (this.terminalRequested !== null) return;
        if (message.status === 'completed') {
          await this.requestTerminal('completed', message.result ?? null, null);
        } else {
          await this.requestTerminal('failed', null, message.error);
        }
        return;
    }
  }

  private async handleAgentStart(message: WorkflowAgentStartMessage): Promise<void> {
    if (
      !this.acceptingAgents ||
      this.record.status !== 'running' ||
      this.terminalRequested !== null
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

    let options: NormalizedWorkflowAgentOptions;
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
      turn_id: null,
      status: 'queued',
      created_at: createdAt,
      settled_at: null,
    };
    const call: AgentCall = {
      record,
      options,
      submissionReady: deferred(),
      settled: deferred(),
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
      if (this.terminalRequested !== null) {
        await this.completeAgent(call, 'stopped', null);
        return;
      }
      call.record.status = 'running';
      call.record.phase = call.options.phase ?? this.record.phase;
      this.record.updated_at = this.now();
      await this.mutate(() => this.deps.store.write(this.record));
      if (this.terminalRequested !== null) {
        await this.completeAgent(call, 'stopped', null);
        return;
      }

      const spawned = await this.deps.ownedTeammates.spawnOwned(
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
          owner: this.teammateOwner,
          routeSettledCompletion: (producerName, turnId, completion) =>
            this.handleAgentCompletion(
              call,
              producerName,
              turnId,
              completion,
            ),
          ...(call.options.schema !== undefined
            ? { outputSchema: call.options.schema }
            : {}),
        },
      );
      call.record.name = spawned.teammate.name;
      call.record.turn_id = spawned.turn.status === 'submitted'
        ? spawned.turn.turnId
        : null;
      const submittedAt = this.now();
      this.record.updated_at = submittedAt;
      await this.mutate(async () => {
        await this.deps.journal.append({
          kind: 'submit',
          index: call.record.index,
          name: spawned.teammate.name,
          turn_id: call.record.turn_id,
          created_at: submittedAt,
        });
        await this.deps.store.write(this.record);
      });
      call.submissionReady.resolve();

      this.deps.log.info(
        {
          run_id: this.record.run_id,
          index: call.record.index,
          producer: spawned.teammate.name,
          turn_id: call.record.turn_id,
        },
        'workflow agent submitted',
      );

      if (spawned.turn.status !== 'submitted') {
        const status =
          spawned.turn.status === 'stopped' || spawned.turn.status === 'skipped'
            ? 'stopped'
            : 'failed';
        const runnerError =
          spawned.turn.status === 'failed' &&
            isUnsupportedAgentRuntimeFeatureError(spawned.turn.error)
            ? spawned.turn.error.message
            : undefined;
        await this.completeAgent(call, status, null, runnerError);
        await this.deps.ownedTeammates.release(
          spawned.teammate.name,
          this.teammateOwner,
        );
        return;
      }
      await call.settled.promise;
    } catch (error) {
      call.submissionReady.resolve();
      if (error instanceof WorkflowPersistenceError) {
        this.requestTerminalObserved('failed', null, error.message);
        return;
      }
      if (!call.completed) {
        const stopped = this.terminalRequested === 'stopped';
        await this.completeAgent(
          call,
          stopped ? 'stopped' : 'failed',
          null,
        ).catch((persistenceError: unknown) => {
          this.requestTerminalObserved(
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

  private async handleAgentCompletion(
    call: AgentCall,
    producerName: string,
    turnId: string,
    completion: CompletionEnvelope,
  ): Promise<void> {
    await call.submissionReady.promise;
    if (call.completed) return;
    if (
      call.record.name !== producerName ||
      call.record.turn_id !== turnId
    ) {
      this.deps.log.warn(
        {
          run_id: this.record.run_id,
          index: call.record.index,
          producer: producerName,
          turn_id: turnId,
        },
        'ignoring unexpected turn from workflow-owned agent',
      );
      return;
    }

    let result: unknown = completion.status === 'completed'
      ? completion.result
      : null;
    if (
      completion.status === 'completed' &&
      call.options.schema !== undefined &&
      completion.result !== null
    ) {
      try {
        result = JSON.parse(completion.result) as unknown;
      } catch (error) {
        result = null;
        this.deps.log.warn(
          {
            run_id: this.record.run_id,
            index: call.record.index,
            producer: producerName,
            turn_id: turnId,
            err: errorInfo(error),
          },
          'workflow structured output was not valid JSON',
        );
      }
    }
    try {
      await this.completeAgent(call, completion.status, result);
    } catch (error) {
      // Let the producer's settle route unwind before terminal auto-close.
      // Entity release drains that same route, so awaiting finalization here
      // would create a persistence-failure cleanup cycle.
      this.requestTerminalObserved('failed', null, errorMessage(error));
    }
  }

  private async completeAgent(
    call: AgentCall,
    status: Extract<WorkflowAgentStatus, 'completed' | 'failed' | 'stopped'>,
    result: unknown,
    runnerError?: string,
  ): Promise<void> {
    if (call.completed) return;
    call.completed = true;
    call.record.status = status;
    call.record.settled_at = this.now();
    this.record.updated_at = call.record.settled_at;
    try {
      await this.mutate(async () => {
        await this.deps.journal.append({
          kind: 'result',
          index: call.record.index,
          status,
          settled_at: call.record.settled_at ?? this.now(),
        });
        await this.deps.store.write(this.record);
      });
      this.deps.log.info(
        {
          run_id: this.record.run_id,
          index: call.record.index,
          producer: call.record.name,
          turn_id: call.record.turn_id,
          status,
        },
        'workflow agent settled',
      );
      if (!this.suppressAgentDelivery && this.terminalRequested === null) {
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
            result,
          });
        }
      }
    } catch (error) {
      if (error instanceof WorkflowPersistenceError) throw error;
      if (this.terminalRequested === null) {
        this.requestTerminalObserved('failed', null, errorMessage(error));
      }
    } finally {
      call.settled.resolve();
    }
  }

  private async sendAgentError(index: number, error: string): Promise<void> {
    if (this.suppressAgentDelivery || this.terminalRequested !== null) return;
    await this.runner.send({ type: 'agent_result', index, error });
  }

  private requestTerminal(
    status: WorkflowTerminalStatus,
    result: unknown,
    error: string | null,
  ): Promise<void> {
    if (this.terminalTask !== null) return this.terminalTask;
    const terminalStatus = this.terminalRequested ?? status;
    this.terminalRequested = terminalStatus;
    this.acceptingAgents = false;
    this.suppressAgentDelivery = true;
    this.semaphore.close(new Error(`workflow ${terminalStatus}`));
    const task = this.finalize(
      terminalStatus,
      terminalStatus === status ? result : null,
      terminalStatus === status ? error : null,
    );
    this.terminalTask = task;
    return task;
  }

  private requestTerminalObserved(
    status: WorkflowTerminalStatus,
    result: unknown,
    error: string | null,
  ): void {
    void this.requestTerminal(status, result, error).catch((terminalError: unknown) => {
      this.deps.log.error(
        { run_id: this.record.run_id, err: errorInfo(terminalError) },
        'workflow terminal transition failed',
      );
    });
  }

  private async finalize(
    requestedStatus: WorkflowTerminalStatus,
    result: unknown,
    requestedError: string | null,
  ): Promise<void> {
    let status = requestedStatus;
    let error = requestedError;
    const cleanupErrors: unknown[] = [];
    await this.runner.stop().catch((runnerError: unknown) => {
      cleanupErrors.push(runnerError);
    });
    while (this.runnerMessageTasks.size > 0) {
      await Promise.allSettled([...this.runnerMessageTasks]);
    }
    await this.drainAgentTasks();
    await this.mutationTail;

    const releases = await Promise.allSettled([
      this.deps.ownedTeammates.releaseAllOwned(this.teammateOwner),
    ]);
    cleanupErrors.push(
      ...releases
        .filter(
          (release): release is PromiseRejectedResult =>
            release.status === 'rejected',
        )
        .map((release) => release.reason),
    );
    if (cleanupErrors.length > 0) {
      this.deps.log.warn(
        {
          run_id: this.record.run_id,
          errors: cleanupErrors.map(errorInfo),
        },
        'workflow terminal cleanup had failures',
      );
      if (status !== 'stopped') status = 'failed';
      error ??= cleanupErrors.map(errorMessage).join('; ');
    }

    const endedAt = this.now();
    this.record.status = status;
    this.record.result = status === 'completed' ? result : null;
    this.record.error = error;
    this.record.ended_at = endedAt;
    this.record.updated_at = endedAt;
    try {
      await this.deps.journal.append({
        kind: 'end',
        status,
        ended_at: endedAt,
      });
    } catch (journalError) {
      status = 'failed';
      error = `workflow journal append failed: ${errorMessage(journalError)}`;
      this.record.status = status;
      this.record.result = null;
      this.record.error = error;
    }
    await this.deps.store.write(this.record);

    const completionResult = JSON.stringify(
      {
        run_id: this.record.run_id,
        status,
        result: this.record.result,
        error: this.record.error,
        agents: this.record.agents
          .filter((agent) => agent.name !== null)
          .map((agent) => ({ index: agent.index, name: agent.name })),
      },
      null,
      2,
    );
    try {
      await this.deps.settleTerminal({
        kind: 'workflow',
        source: 'workflow',
        id: this.record.run_id,
        status,
        result: completionResult,
      });
    } finally {
      this.deps.log.info(
        {
          run_id: this.record.run_id,
          status,
          agent_count: this.record.agents.length,
          err: error === null ? undefined : { message: error },
        },
        'workflow run terminal',
      );
      this.deps.evict(this);
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

function isUnsupportedAgentRuntimeFeatureError(error: Error): boolean {
  return error.name === 'UnsupportedAgentRuntimeFeatureError';
}
