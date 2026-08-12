import type { DreamuxLogger } from '@excitedjs/dreamux-types';
import { isUnsupportedFeatureError } from '@excitedjs/dreamux-utils';

import { errorInfo, errorMessage } from '../../platform/error-info.js';
import type { CompletionEnvelope } from '../completion-router/index.js';
import {
  createOwnedTeammateOwner,
  type OwnedTeammateOps,
} from '../teammate-collection/owned-teammates.js';
import { WORKFLOW_AGENT_SYSTEM_PROMPT } from './agent-policy.js';
import { WorkflowJournal } from './journal.js';
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
  deferred,
  nonEmpty,
  normalizeAgentOptions,
  WorkflowPersistenceError,
  WorkflowSemaphore,
} from './run-support.js';
import {
  type WorkflowShutdownTakeoverKind,
  WorkflowOwnerReleaseError,
  WorkflowRunTerminal,
  WORKFLOW_STOP_GRACE_MS,
} from './run-terminal.js';
import {
  type AgentCall,
  WorkflowRunFinalizer,
} from './run-finalization.js';
const MAX_AGENTS = 1000;
export interface WorkflowRunDeps {
  record: WorkflowRunRecord;
  store: WorkflowRunStore;
  journal: WorkflowJournal;
  ownedTeammates: Pick<OwnedTeammateOps, 'spawnOwned' | 'releaseAllOwned'>;
  createRunner: WorkflowRunnerFactory;
  settleTerminal: (completion: CompletionEnvelope) => Promise<void>;
  discardTerminal: () => void;
  evict: (
    run: WorkflowRun,
    takeover: WorkflowShutdownTakeoverKind | null,
    detachedSettle: Promise<void> | null,
  ) => void;
  log: DreamuxLogger;
  now?: () => number;
  /** Natural-settle grace after the first stop intent (test seam). */
  stopGraceMs?: number;
}

/** One live workflow entity: durable state, journal, child and owned agents. */
export class WorkflowRun {
  private readonly record: WorkflowRunRecord;
  private readonly runner: WorkflowRunnerHandle;
  private readonly semaphore: WorkflowSemaphore;
  private readonly terminal: WorkflowRunTerminal;
  private readonly finalizer: WorkflowRunFinalizer;
  private readonly calls = new Map<number, AgentCall>();
  private readonly runnerMessageTasks = new Set<Promise<void>>();
  private readonly agentTasks = new Set<Promise<void>>();
  private readonly teammateOwner = createOwnedTeammateOwner();
  private mutationTail: Promise<void> = Promise.resolve();
  private runnerMessageTail: Promise<void> = Promise.resolve();
  private runnerTerminalMessageSeen = false;

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
      finalize: (status, result, error) =>
        this.finalizer.finalize(status, result, error),
      log: deps.log,
      now: this.now.bind(this),
      stopGraceMs: deps.stopGraceMs ?? WORKFLOW_STOP_GRACE_MS,
    });
    this.finalizer = new WorkflowRunFinalizer({
      record: this.record,
      journal: deps.journal,
      store: deps.store,
      ownedTeammates: deps.ownedTeammates,
      owner: this.teammateOwner,
      stopRunner: () => this.runner.stop(),
      terminal: this.terminal,
      calls: this.calls,
      runnerMessageTasks: this.runnerMessageTasks,
      agentTasks: this.agentTasks,
      mutationTail: () => this.mutationTail,
      mutate: (task) => this.mutate(task),
      now: this.now.bind(this),
      settleTerminal: deps.settleTerminal,
      discardTerminal: deps.discardTerminal,
      evict: (takeover, detachedSettle) =>
        deps.evict(this, takeover, detachedSettle),
      log: deps.log,
    });
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
      await this.terminal.request('failed', null, errorMessage(error));
    }
  }

  async stop(): Promise<WorkflowTerminalStatus> {
    return this.terminal.stop();
  }

  /** Stop through the public contract, then wait for natural settle/auto-close. */
  async stopAndWait(): Promise<WorkflowRunRecord> {
    await this.terminal.stopAndWait();
    return this.snapshot();
  }

  /**
   * Bound process shutdown: persist a terminal run after killing the runner,
   * but hand owned runtime cleanup to the collection-wide force-stop sweep.
   */
  async stopForShutdown(): Promise<void> {
    await this.terminal.stopForShutdown();
  }

  /** Wake terminal publication/grace waits for shutdown takeover. */
  signalShutdown(): void {
    this.terminal.signalShutdown();
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
        try {
          if (message.status === 'completed') {
            await this.terminal.request('completed', message.result ?? null, null);
          } else {
            await this.terminal.request('failed', null, message.error);
          }
        } catch (error) {
          // A pre-terminal owner-release failure already left the run loud,
          // durably running, and retryable. Re-observing the same terminal
          // message would start an invisible immediate retry; keep the
          // failure pre-terminal until an explicit stop or owner-close retry.
          if (error instanceof WorkflowOwnerReleaseError) {
            this.deps.log.error(
              { run_id: this.record.run_id, err: errorInfo(error) },
              'workflow terminal transition failed; run remains retryable',
            );
            return;
          }
          throw error;
        }
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
    const priorUpdatedAt = this.record.updated_at;
    // Publish the call and roll back its first durable write inside the one
    // serialized mutation: a rejection restores calls/agents/updated_at
    // before the tail admits any later queued write, so no later mutation can
    // snapshot this not-yet-durable agent and persist a durable phantom. The
    // call never executes on failure.
    await this.mutate(() => {
      this.calls.set(message.index, call);
      this.record.agents.push(record);
      this.record.updated_at = createdAt;
      return this.deps.store.write(this.record).catch((writeError: unknown) => {
        this.calls.delete(message.index);
        this.record.agents.pop();
        this.record.updated_at = priorUpdatedAt;
        throw writeError;
      });
    });

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
        await this.completeAgent(call, 'stopped', null);
        return;
      }
      call.record.status = 'running';
      call.record.phase = call.options.phase ?? this.record.phase;
      this.record.updated_at = this.now();
      await this.mutate(() => this.deps.store.write(this.record));
      if (this.terminal.requested !== null) {
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
          systemPromptAppend: [WORKFLOW_AGENT_SYSTEM_PROMPT],
          outputSchema: call.options.schema,
        },
      );
      if (call.completed) {
        call.submissionReady.resolve();
        return;
      }
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
          spawned.turn.status === 'stopped' || spawned.turn.status === 'skipped' ? 'stopped' : 'failed';
        if (spawned.turn.status === 'failed') {
          this.deps.log.warn(
            {
              run_id: this.record.run_id,
              index: call.record.index,
              name: call.options.label,
              err: spawned.turn.error
                ? { name: spawned.turn.error.name, message: spawned.turn.error.message, stack: spawned.turn.error.stack }
                : undefined,
            },
            'workflow agent turn failed at submission',
          );
        }
        const runnerError =
          spawned.turn.status === 'failed' &&
          isUnsupportedFeatureError(spawned.turn.error, 'outputSchema')
            ? spawned.turn.error.message
            : undefined;
        await this.completeAgent(call, status, null, runnerError);
        return;
      }
      await call.settled.promise;
    } catch (error) {
      call.submissionReady.resolve();
      if (error instanceof WorkflowPersistenceError) {
        // Fail-loud persistence deliberately enters terminal cleanup, which may
        // stop this owned runtime mid-turn because its settle cannot be recorded.
        this.terminal.observe('failed', null, error.message);
        return;
      }
      if (!call.completed) {
        const stopped = this.terminal.requested === 'stopped';
        const runnerError =
          !stopped && isUnsupportedFeatureError(error, 'outputSchema')
            ? errorMessage(error)
            : undefined;
        await this.completeAgent(
          call,
          stopped ? 'stopped' : 'failed',
          null,
          runnerError,
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

    let status = completion.status;
    let result: unknown = completion.status === 'completed'
      ? completion.result
      : null;
    let runnerError: string | undefined;
    if (completion.status === 'completed' && call.options.schema !== undefined) {
      status = 'failed';
      result = null;
      if (completion.result === null) {
        runnerError =
          'runtime reported successful structured output that was empty';
        this.deps.log.warn(
          { run_id: this.record.run_id, index: call.record.index, producer: producerName, turn_id: turnId },
          'workflow structured output was empty',
        );
      } else {
        try {
          result = JSON.parse(completion.result) as unknown;
          status = 'completed';
        } catch {
          runnerError =
            'runtime reported successful structured output that was not valid JSON';
          this.deps.log.warn(
            { run_id: this.record.run_id, index: call.record.index, producer: producerName, turn_id: turnId },
            'workflow structured output was not valid JSON',
          );
        }
      }
    }
    if (completion.status !== 'completed') {
      this.deps.log.warn(
        { run_id: this.record.run_id, index: call.record.index, producer: producerName, turn_id: turnId, status: completion.status },
        'workflow agent did not complete successfully',
      );
    }
    try {
      await this.completeAgent(call, status, result, runnerError);
    } catch (error) {
      // Let the producer's settle route unwind before terminal auto-close.
      // Entity release drains that same route, so awaiting finalization here
      // would create a persistence-failure cleanup cycle.
      this.terminal.observe('failed', null, errorMessage(error));
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
      if (!this.terminal.suppressDelivery) {
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
      if (this.terminal.requested === null) {
        this.terminal.observe('failed', null, errorMessage(error));
      }
    } finally {
      call.settled.resolve();
    }
  }

  private async sendAgentError(index: number, error: string): Promise<void> {
    if (this.terminal.suppressDelivery) return;
    await this.runner.send({ type: 'agent_result', index, error });
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
