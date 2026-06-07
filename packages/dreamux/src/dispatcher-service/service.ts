import type {
  AgentRuntime,
  AgentRuntimeProviderCatalog,
} from '../agent-runtime/index.js';
import type { ClaudeCodeSessionFactory } from '../agent-runtime/claude-code-session.js';
import type { CodexProcess, CodexProcessOptions } from '../codex/supervisor.js';
import type { CodexWsClient } from '../codex/rpc.js';
import type { DreamuxConfig } from '../runtime/config.js';
import type { DispatcherStore } from '../runtime/dispatcher-store.js';
import type { DreamuxLogger } from '../runtime/logger.js';
import {
  NestedTeamMateDispatchError,
  resolveTeammateTarget,
  TEAMMATE_INPUT_MODES,
  TEAMMATE_TARGET_MODES,
  TeamMateTaskLedger,
  type TeamMateScheduleCallerKind,
  type TeamMateTaskRecord,
} from '../teammate/ledger.js';
import {
  TeamMateDeliveryService,
  type TeamMateDeliveryReport,
} from '../teammate/delivery.js';
import {
  TeamMateWorkerExecutionService,
  type TeamMateExecutionOutcome,
} from '../teammate/worker-execution.js';
import {
  readTeamMateWorkerLogs,
} from '../teammate/worker-logs.js';
import { TeamMateWorkerProviderCatalog } from '../teammate/worker/catalog.js';
import type { TeamMateWorkerProvider } from '../teammate/worker/types.js';
import {
  awaitTeamMateCompletion,
  clampWaitTimeout,
  lastEventId,
  TEAMMATE_WAIT_DEFAULT_MS,
  TEAMMATE_WAIT_MAX_MS,
  TeamMateWaitBroker,
} from '../teammate/wait-broker.js';
import {
  isTerminalLifecycle,
  parseWaitUntil,
  toExecutionResult,
  toProviderCapability,
  toTeamMatePullResult,
  toTeamMateTaskSummary,
} from './teammate-presenters.js';
import type {
  ServerMcpAwaitTeamMateCompletionInput,
  ServerMcpAwaitTeamMateCompletionResult,
  ServerMcpCancelTeamMateTaskInput,
  ServerMcpCancelTeamMateTaskResult,
  ServerMcpExecuteTeamMateTaskInput,
  ServerMcpRunTeamMateTaskInput,
  ServerMcpRunTeamMateTaskResult,
  ServerMcpScheduleTeamMateInput,
  ServerMcpScheduleTeamMateResult,
  ServerMcpSendTeamMateInputInput,
  ServerMcpSendTeamMateInputResult,
  ServerMcpTeamMateTaskLogsInput,
  ServerMcpTeamMateTaskLogsResult,
  ServerTeamMateCapabilities,
  ServerTeamMateCompletionInput,
  ServerTeamMateProviderCapability,
  ServerTeamMatePullResult,
  ServerTeamMateTaskSummary,
  WorkerBinaryProbe,
} from './teammate-types.js';
import {
  createDefaultTeamMateWorkerCatalog,
  createDefaultWorkerBinaryProbe,
} from './worker-factory.js';

export interface DispatcherServiceOptions {
  config: DreamuxConfig;
  dispatchers: DispatcherStore;
  agentRuntimeProviders: AgentRuntimeProviderCatalog;
  resolveRuntime: (dispatcherId: string) => AgentRuntime | null;
  codexBinPath?: string;
  codexProcessFactory?: (opts: CodexProcessOptions) => CodexProcess;
  codexClientFactory?: (socketPath: string) => CodexWsClient;
  claudeCodeWorkerSessionFactory?: ClaudeCodeSessionFactory;
  teamMateWorkerProviders?: TeamMateWorkerProviderCatalog;
  workerBinaryProbe?: WorkerBinaryProbe;
  teamMateDeliveryMaxAttempts?: number;
  teamMateDeliveryBackoffMs?: (attempt: number) => number;
  log: DreamuxLogger;
}

/**
 * Dispatcher Service owns server-side teammate orchestration for dispatchers.
 *
 * The stdio MCP shim and admin method layer should only map tool/admin calls
 * into this service. Ledger writes, wait-broker notifications, worker
 * lifecycle, completion delivery, and capability probing live here.
 */
export class DispatcherService {
  private readonly teamMateLedgers = new Map<string, TeamMateTaskLedger>();
  private readonly teamMateWaitBroker = new TeamMateWaitBroker();
  private readonly teamMateDelivery: TeamMateDeliveryService;
  private readonly teamMateWorkers: TeamMateWorkerProviderCatalog;
  private readonly workerBinaryProbe: WorkerBinaryProbe;
  private readonly teamMateWorkerExecution: TeamMateWorkerExecutionService;

  constructor(private readonly opts: DispatcherServiceOptions) {
    this.teamMateDelivery = new TeamMateDeliveryService({
      ledger: (dispatcherId) => this.teamMateLedger(dispatcherId),
      resolveRuntime: (dispatcherId) => this.opts.resolveRuntime(dispatcherId),
      notifyEvent: (dispatcherId, taskId) =>
        this.teamMateWaitBroker.notify(dispatcherId, taskId),
      log: (level, message, fields) => this.opts.log[level](fields ?? {}, message),
      ...(opts.teamMateDeliveryMaxAttempts !== undefined
        ? { maxAttempts: opts.teamMateDeliveryMaxAttempts }
        : {}),
      ...(opts.teamMateDeliveryBackoffMs !== undefined
        ? { backoffMs: opts.teamMateDeliveryBackoffMs }
        : {}),
    });
    this.teamMateWorkers =
      opts.teamMateWorkerProviders ??
      createDefaultTeamMateWorkerCatalog({
        config: opts.config,
        dispatchers: opts.dispatchers,
        ...(opts.codexBinPath !== undefined
          ? { codexBinPath: opts.codexBinPath }
          : {}),
        ...(opts.codexProcessFactory !== undefined
          ? { codexProcessFactory: opts.codexProcessFactory }
          : {}),
        ...(opts.codexClientFactory !== undefined
          ? { codexClientFactory: opts.codexClientFactory }
          : {}),
        ...(opts.claudeCodeWorkerSessionFactory !== undefined
          ? { claudeCodeWorkerSessionFactory: opts.claudeCodeWorkerSessionFactory }
          : {}),
        log: opts.log,
      });
    this.workerBinaryProbe =
      opts.workerBinaryProbe ?? createDefaultWorkerBinaryProbe(opts.codexBinPath);
    this.teamMateWorkerExecution = new TeamMateWorkerExecutionService({
      ledger: (dispatcherId) => this.teamMateLedger(dispatcherId),
      workers: () => this.teamMateWorkers,
      reportCompletion: (report) =>
        this.teamMateDelivery.reportCompletion(report),
      notifyEvent: (dispatcherId, taskId) =>
        this.teamMateWaitBroker.notify(dispatcherId, taskId),
      log: (level, message, fields) => this.opts.log[level](fields ?? {}, message),
    });
  }

  async scheduleTeamMate(
    input: ServerMcpScheduleTeamMateInput,
  ): Promise<ServerMcpScheduleTeamMateResult> {
    this.assertTeamMateSchedulingAuthority(input.callerKind);
    const task = await this.teamMateLedger(input.dispatcherId).acceptTask({
      title: input.title,
      prompt: input.prompt,
      callerKind: input.callerKind,
      ...(input.teammateId !== undefined
        ? { teammateId: input.teammateId }
        : {}),
    });
    this.teamMateWaitBroker.notify(input.dispatcherId, task.task_id);
    this.opts.log.info(
      {
        dispatcher_id: input.dispatcherId,
        task_id: task.task_id,
        caller_kind: input.callerKind,
      },
      'teammate task accepted',
    );
    return {
      status: 'accepted',
      task_id: task.task_id,
      dispatcher_id: task.dispatcher_id,
      created_at: task.created_at,
      ...(task.teammate_id !== null ? { teammate_id: task.teammate_id } : {}),
    };
  }

  async runTeamMateTask(
    input: ServerMcpRunTeamMateTaskInput,
  ): Promise<ServerMcpRunTeamMateTaskResult> {
    this.assertTeamMateSchedulingAuthority(input.callerKind);
    const target = resolveTeammateTarget(
      input.targetPath,
      this.mustDispatcherDir(input.dispatcherId),
    );
    const accepted = await this.teamMateLedger(input.dispatcherId).acceptTask({
      title: input.title,
      prompt: input.prompt,
      callerKind: input.callerKind,
      target,
      origin: 'dispatcher',
      ...(input.teammateId !== undefined ? { teammateId: input.teammateId } : {}),
      ...(input.intent !== undefined ? { intent: input.intent } : {}),
      ...(input.targetMode !== undefined ? { targetMode: input.targetMode } : {}),
      ...(input.providerRef !== undefined
        ? { providerRef: input.providerRef }
        : {}),
      ...(input.operationId !== undefined
        ? { operationId: input.operationId }
        : {}),
    });
    this.teamMateWaitBroker.notify(input.dispatcherId, accepted.task_id);
    this.opts.log.info(
      {
        dispatcher_id: input.dispatcherId,
        task_id: accepted.task_id,
        caller_kind: input.callerKind,
      },
      'teammate task run requested',
    );
    const execution = await this.teamMateWorkerExecution.execute({
      dispatcherId: input.dispatcherId,
      taskId: accepted.task_id,
      ...(input.providerRef !== undefined ? { providerRef: input.providerRef } : {}),
    });
    return this.teamMateExecutionResult(input.dispatcherId, accepted, execution);
  }

  async executeTeamMateTask(
    input: ServerMcpExecuteTeamMateTaskInput,
  ): Promise<ServerMcpRunTeamMateTaskResult> {
    const task = await this.teamMateLedger(input.dispatcherId).getTask(
      input.taskId,
    );
    if (task === null) {
      throw new Error(`TeamMate task ${JSON.stringify(input.taskId)} does not exist`);
    }
    const execution = await this.teamMateWorkerExecution.execute({
      dispatcherId: input.dispatcherId,
      taskId: input.taskId,
      ...(input.providerRef !== undefined ? { providerRef: input.providerRef } : {}),
    });
    return this.teamMateExecutionResult(input.dispatcherId, task, execution);
  }

  async sendTeamMateInput(
    input: ServerMcpSendTeamMateInputInput,
  ): Promise<ServerMcpSendTeamMateInputResult> {
    const ledger = this.teamMateLedger(input.dispatcherId);
    const { task, input: recorded } = await ledger.appendInput(input.taskId, {
      text: input.prompt,
      mode: input.mode ?? 'steer',
    });
    this.teamMateWaitBroker.notify(input.dispatcherId, task.task_id);
    const routed = await this.teamMateWorkerExecution.sendInput({
      dispatcherId: input.dispatcherId,
      taskId: input.taskId,
      inputId: recorded.input_id,
      text: recorded.text,
      mode: recorded.mode,
    });
    let status: 'queued' | 'submitted' = 'queued';
    let latest = task;
    if (routed.delivered && routed.disposition?.status === 'accepted') {
      latest = await ledger.markInputSubmitted(input.taskId, recorded.input_id);
      this.teamMateWaitBroker.notify(input.dispatcherId, input.taskId);
      status = 'submitted';
    }
    return {
      input_id: recorded.input_id,
      mode: recorded.mode,
      status,
      after_event_id: lastEventId(latest),
      task: toTeamMateTaskSummary(latest),
    };
  }

  async cancelTeamMateTask(
    input: ServerMcpCancelTeamMateTaskInput,
  ): Promise<ServerMcpCancelTeamMateTaskResult> {
    const ledger = this.teamMateLedger(input.dispatcherId);
    const task = await ledger.getTask(input.taskId);
    if (task === null) {
      throw new Error(
        `TeamMate task ${JSON.stringify(input.taskId)} does not exist`,
      );
    }
    if (isTerminalLifecycle(task.lifecycle_status)) {
      return {
        task_id: task.task_id,
        status: 'already_terminal',
        lifecycle_status: task.lifecycle_status,
        cancelled_live_session: false,
        after_event_id: lastEventId(task),
        task: toTeamMateTaskSummary(task),
      };
    }
    const reason = input.note ?? null;
    const cancelled = await this.teamMateWorkerExecution.cancel({
      dispatcherId: input.dispatcherId,
      taskId: input.taskId,
      reason,
    });
    if (!cancelled.cancelledLiveSession) {
      const fresh = await ledger.getTask(input.taskId);
      if (fresh !== null && isTerminalLifecycle(fresh.lifecycle_status)) {
        return {
          task_id: fresh.task_id,
          status: 'already_terminal',
          lifecycle_status: fresh.lifecycle_status,
          cancelled_live_session: false,
          after_event_id: lastEventId(fresh),
          task: toTeamMateTaskSummary(fresh),
        };
      }
      await ledger.recordClose(input.taskId, {
        status: 'cancelled',
        ...(reason !== null && reason !== '' ? { note: reason } : {}),
      });
      this.teamMateWaitBroker.notify(input.dispatcherId, input.taskId);
    }
    const latest = (await ledger.getTask(input.taskId)) ?? task;
    return {
      task_id: latest.task_id,
      status:
        latest.lifecycle_status === 'cancelled' ? 'cancelled' : 'already_terminal',
      lifecycle_status: latest.lifecycle_status,
      cancelled_live_session: cancelled.cancelledLiveSession,
      after_event_id: lastEventId(latest),
      task: toTeamMateTaskSummary(latest),
    };
  }

  async getTeamMateTaskLogs(
    input: ServerMcpTeamMateTaskLogsInput,
  ): Promise<ServerMcpTeamMateTaskLogsResult> {
    const task = await this.teamMateLedger(input.dispatcherId).getTask(
      input.taskId,
    );
    if (task === null) {
      throw new Error(
        `TeamMate task ${JSON.stringify(input.taskId)} does not exist`,
      );
    }
    const effectiveRef =
      this.teamMateWorkers.resolve(task.provider_ref)?.ref ?? task.provider_ref;
    const logs = await readTeamMateWorkerLogs({
      dispatcherId: input.dispatcherId,
      taskId: input.taskId,
      providerRef: effectiveRef,
      ...(input.maxBytes !== undefined ? { maxBytes: input.maxBytes } : {}),
      ...(input.stream !== undefined ? { stream: input.stream } : {}),
    });
    return {
      task_id: task.task_id,
      provider_ref: effectiveRef,
      lifecycle_status: task.lifecycle_status,
      logs_supported: logs.logs_supported,
      streams: logs.streams,
    };
  }

  async awaitTeamMateCompletion(
    input: ServerMcpAwaitTeamMateCompletionInput,
  ): Promise<ServerMcpAwaitTeamMateCompletionResult> {
    const ledger = this.teamMateLedger(input.dispatcherId);
    const until = parseWaitUntil(input.until);
    const afterEventId =
      input.afterEventId !== undefined && Number.isFinite(input.afterEventId)
        ? Math.max(0, Math.floor(input.afterEventId))
        : 0;
    const outcome = await awaitTeamMateCompletion(this.teamMateWaitBroker, {
      dispatcherId: input.dispatcherId,
      taskId: input.taskId,
      afterEventId,
      until,
      timeoutMs: clampWaitTimeout(input.timeoutMs),
      loadTask: () => ledger.getTask(input.taskId),
    });
    if (outcome.status === 'not_found') {
      throw new Error(
        `TeamMate task ${JSON.stringify(input.taskId)} does not exist`,
      );
    }
    if (outcome.status === 'still_running') {
      return {
        status: 'still_running',
        task_id: input.taskId,
        after_event_id: outcome.last_event_id,
        task: toTeamMateTaskSummary(outcome.task),
      };
    }
    const task = outcome.task;
    const status: ServerMcpAwaitTeamMateCompletionResult['status'] =
      task.lifecycle_status === 'completed' ||
      task.lifecycle_status === 'failed' ||
      task.lifecycle_status === 'cancelled'
        ? task.lifecycle_status
        : 'reached';
    return {
      status,
      task_id: input.taskId,
      after_event_id: outcome.last_event_id,
      task: toTeamMateTaskSummary(task),
      result: task.result === null ? null : toTeamMatePullResult(task),
    };
  }

  async getTeamMateCapabilities(): Promise<ServerTeamMateCapabilities> {
    const workers = this.teamMateWorkers;
    const workerByRef = new Map(
      workers.list().map((worker) => [worker.ref, worker] as const),
    );
    const providers: ServerTeamMateProviderCapability[] = [];
    const seen = new Set<string>();
    for (const runtime of this.opts.agentRuntimeProviders.list()) {
      providers.push(
        await this.toProviderCapabilityProbed(
          runtime.ref,
          workerByRef.get(runtime.ref),
        ),
      );
      seen.add(runtime.ref);
    }
    for (const worker of workers.list()) {
      if (seen.has(worker.ref)) continue;
      providers.push(await this.toProviderCapabilityProbed(worker.ref, worker));
      seen.add(worker.ref);
    }
    return {
      execution_available: providers.some((p) => p.worker_available),
      wait: { default_ms: TEAMMATE_WAIT_DEFAULT_MS, max_ms: TEAMMATE_WAIT_MAX_MS },
      target_modes: [...TEAMMATE_TARGET_MODES],
      input_modes: [...TEAMMATE_INPUT_MODES],
      default_input_mode: 'steer',
      providers,
    };
  }

  async reportTeamMateCompletion(
    input: ServerTeamMateCompletionInput,
  ): Promise<TeamMateDeliveryReport> {
    return this.teamMateDelivery.reportCompletion({
      dispatcherId: input.dispatcherId,
      taskId: input.taskId,
      outcome: input.outcome,
      finalText: input.finalText,
    });
  }

  async listTeamMateTasks(
    dispatcherId: string,
  ): Promise<ServerTeamMateTaskSummary[]> {
    const tasks = await this.teamMateLedger(dispatcherId).listTasks({
      onCorrupt: (taskId, err) =>
        this.opts.log.warn(
          { dispatcher_id: dispatcherId, task_id: taskId, err: errInfo(err) },
          'skipping corrupt TeamMate task file',
        ),
    });
    return tasks.map(toTeamMateTaskSummary);
  }

  async getTeamMateTask(
    dispatcherId: string,
    taskId: string,
  ): Promise<TeamMateTaskRecord | null> {
    return this.teamMateLedger(dispatcherId).getTask(taskId);
  }

  async pullTeamMateResult(
    dispatcherId: string,
    taskId?: string,
  ): Promise<ServerTeamMatePullResult | null> {
    const ledger = this.teamMateLedger(dispatcherId);
    const task =
      taskId !== undefined
        ? await ledger.getTask(taskId)
        : await ledger.latestResultTask();
    if (task === null || task.result === null) return null;
    return toTeamMatePullResult(task);
  }

  async reapAllTeamMateWorkers(): Promise<void> {
    await this.teamMateWorkerExecution.reapAll();
  }

  private async teamMateExecutionResult(
    dispatcherId: string,
    fallback: TeamMateTaskRecord,
    execution: TeamMateExecutionOutcome,
  ): Promise<ServerMcpRunTeamMateTaskResult> {
    const latest =
      (await this.teamMateLedger(dispatcherId).getTask(fallback.task_id)) ??
      fallback;
    return {
      task: toTeamMateTaskSummary(latest),
      execution: toExecutionResult(execution),
    };
  }

  private async toProviderCapabilityProbed(
    ref: string,
    worker: TeamMateWorkerProvider | undefined,
  ): Promise<ServerTeamMateProviderCapability> {
    if (worker === undefined) return toProviderCapability(ref, undefined, null);
    const availability = await this.workerBinaryProbe(ref);
    return toProviderCapability(ref, worker, availability);
  }

  private assertTeamMateSchedulingAuthority(
    callerKind: TeamMateScheduleCallerKind,
  ): void {
    if (callerKind === 'teammate') {
      throw new NestedTeamMateDispatchError();
    }
  }

  private mustDispatcherDir(dispatcherId: string): string {
    const dir = this.opts.dispatchers.get(dispatcherId)?.codex_cwd ?? null;
    if (dir === null || dir === '') {
      throw new Error(
        `dispatcher '${dispatcherId}' has no configured working directory; ` +
          'a path target cannot be resolved',
      );
    }
    return dir;
  }

  private teamMateLedger(dispatcherId: string): TeamMateTaskLedger {
    const existing = this.teamMateLedgers.get(dispatcherId);
    if (existing !== undefined) return existing;
    const created = new TeamMateTaskLedger(dispatcherId);
    this.teamMateLedgers.set(dispatcherId, created);
    return created;
  }
}

function errInfo(err: unknown): Record<string, unknown> {
  if (err instanceof Error) {
    return { type: err.name, message: err.message, stack: err.stack };
  }
  return { value: String(err) };
}
