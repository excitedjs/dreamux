import type {
  AgentRuntime,
  AgentRuntimeDurableSubmissionDelivery,
  AgentRuntimeDurableSubmissionRecord,
  AgentRuntimeTurnResult,
  DreamuxLogger,
} from '@excitedjs/dreamux-types';
import type { TeamCollection } from '../team-collection/index.js';
import type {
  PreparedTaskRuntimeSubmission,
  TaskOperationInvocation,
  TaskRuntimeHandle,
} from '../task-runtime-submission.js';
import { TaskRuntimeCapabilityUnavailableError } from '../task-runtime-submission.js';
import {
  durableSubmissionInputDigest,
  taskOperationId,
} from './identity.js';
import { RuntimeSubmissionIndex } from './runtime-submission-index.js';
import {
  activeTargetForTeam,
  assertInvocation,
  assertParentAllowsOperation,
  assertRuntimeSubmission,
  boundedCode,
  completionText,
  DurabilityNamespaceChangedError,
  durableCapability,
  errorInfo,
  findSubmissionsByTurn,
  requiredSubmission,
  requiredTarget,
  rootOperationId,
  settlementKey,
  shouldDeliverChildCompletion,
  submissionFingerprint,
  targetForTeam,
  taskMemberName,
  textDelivery,
  validatedLeaderParent,
} from './runtime-support.js';
import type { SettlementSignal } from './runtime-support.js';
import type { TaskHostStore } from './store.js';
import type {
  RuntimeSubmissionRecord,
  TaskTargetRecord,
} from './types.js';

export class TaskRuntimeExecutor {
  private readonly index: RuntimeSubmissionIndex;
  private readonly pendingSettlementSignals = new Map<
    string,
    SettlementSignal
  >();
  private readonly settlementRetryTimers = new Map<
    string,
    ReturnType<typeof setTimeout>
  >();
  private readonly settlementRetryAttempts = new Map<string, number>();
  private readonly settlementWork = new Map<string, Promise<void>>();
  private stopped = false;

  constructor(private readonly opts: {
    store: TaskHostStore;
    teams: TeamCollection;
    log: DreamuxLogger;
    runExclusive: <T>(targetId: string, task: () => Promise<T>) => Promise<T>;
    onSettlementProgress: (targetId: string) => void;
    settlementRetryDelayMs?: (attempt: number) => number;
    runtimeCallTimeoutMs?: number;
  }) {
    this.index = new RuntimeSubmissionIndex(opts.store);
  }

  resume(): void {
    this.stopped = false;
  }

  stop(): void {
    this.stopped = true;
    for (const timer of this.settlementRetryTimers.values()) clearTimeout(timer);
    this.settlementRetryTimers.clear();
  }

  async drain(): Promise<void> {
    while (this.settlementWork.size > 0) {
      await Promise.allSettled([...this.settlementWork.values()]);
    }
  }

  async executeRoot(targetId: string): Promise<void> {
    const target = requiredTarget(this.opts.store, targetId);
    if (target.turn === null || target.terminal !== null) return;
    const delivery = { kind: 'channel' as const, input: target.turn };
    const operationId = rootOperationId(target);
    await this.index.recordIntent({
      targetId,
      kind: 'root',
      operationId,
      inputDigest: durableSubmissionInputDigest(delivery),
      parentOperationId: null,
      toolCallId: 'root',
      toolCallOrdinal: 0,
      runtimeId: null,
      runtimeRole: 'leader',
      durabilityNamespace: null,
      delivery,
      effect: { kind: 'root' },
    });
    const current = requiredSubmission(requiredTarget(this.opts.store, targetId), operationId);
    await this.submitOperation(target, current, await this.runtimeFor(target, current));
  }

  async prepareSpawn(input: {
    teamId: string;
    invocation: TaskOperationInvocation;
    requestedName: string;
    prompt: string;
    agentRuntime: string;
    intent: string;
    identity: string | null;
    skillSources: readonly import('@excitedjs/dreamux-types').AgentRuntimeSkillSource[];
  }): Promise<PreparedTaskRuntimeSubmission & { teammateName: string }> {
    assertInvocation(input.invocation);
    const target = activeTargetForTeam(this.opts.store, input.teamId);
    const parent = validatedLeaderParent(target, input.invocation);
    const operationId = taskOperationId({
      targetId: target.target_id,
      parentOperationId: parent,
      toolCallId: input.invocation.callId,
      toolCallOrdinal: input.invocation.ordinal,
      kind: 'spawn',
    });
    assertParentAllowsOperation(target, parent, operationId);
    const teammateName = taskMemberName(input.requestedName, operationId);
    const delivery = textDelivery(operationId, input.prompt);
    await this.index.recordIntent({
      targetId: target.target_id,
      kind: 'spawn',
      operationId,
      inputDigest: durableSubmissionInputDigest(delivery),
      parentOperationId: parent,
      toolCallId: input.invocation.callId,
      toolCallOrdinal: input.invocation.ordinal,
      runtimeId: null,
      runtimeRole: 'member',
      durabilityNamespace: null,
      delivery,
      effect: {
        kind: 'spawn',
        teammate_name: teammateName,
        agent_runtime: input.agentRuntime,
        intent: input.intent,
        identity: input.identity,
        skill_sources: [...input.skillSources],
      },
    });
    return { operationId, teammateName };
  }

  async prepareSend(input: {
    teamId: string;
    invocation: TaskOperationInvocation;
    prompt: string;
    intent: string | null;
    runtimeRole: TaskRuntimeHandle['role'];
    teammateName: string | null;
  }): Promise<PreparedTaskRuntimeSubmission> {
    assertInvocation(input.invocation);
    const target = activeTargetForTeam(this.opts.store, input.teamId);
    const parent = validatedLeaderParent(target, input.invocation);
    const operationId = taskOperationId({
      targetId: target.target_id,
      parentOperationId: parent,
      toolCallId: input.invocation.callId,
      toolCallOrdinal: input.invocation.ordinal,
      kind: 'send',
    });
    assertParentAllowsOperation(target, parent, operationId);
    const delivery = textDelivery(operationId, input.prompt);
    await this.index.recordIntent({
      targetId: target.target_id,
      kind: 'send',
      operationId,
      inputDigest: durableSubmissionInputDigest(delivery),
      parentOperationId: parent,
      toolCallId: input.invocation.callId,
      toolCallOrdinal: input.invocation.ordinal,
      runtimeId: null,
      runtimeRole: input.runtimeRole,
      durabilityNamespace: null,
      delivery,
      effect: {
        kind: 'send',
        teammate_name: input.teammateName,
        intent: input.intent,
      },
    });
    return { operationId };
  }

  async submitPrepared(
    teamId: string,
    prepared: PreparedTaskRuntimeSubmission,
  ): Promise<AgentRuntimeTurnResult> {
    const candidate = targetForTeam(this.opts.store, teamId);
    return this.opts.runExclusive(candidate.target_id, async () => {
      const target = targetForTeam(this.opts.store, teamId);
      if (
        target.phase === 'finalized' ||
        target.terminal?.outcome === 'cancelled'
      ) {
        throw new Error('task attempt is already terminal');
      }
      const before = this.index.lookup(target.target_id, prepared.operationId);
      if (before === null) throw new Error('unknown prepared task submission');
      try {
        const handle = await this.runtimeFor(target, before);
        await this.submitOperation(target, before, handle);
      } catch (error) {
        if (!(error instanceof TaskRuntimeCapabilityUnavailableError)) throw error;
        await this.index.recordInDoubt({
          targetId: target.target_id,
          operationId: before.operation_id,
          code: 'RUNTIME_CAPABILITY_UNAVAILABLE',
        });
      }
      const current = this.index.lookup(target.target_id, prepared.operationId);
      if (current === null || current.state === 'intent') {
        return { status: 'failed', error: new Error('task submission was not accepted') };
      }
      if (current.state === 'in_doubt') {
        return {
          status: 'failed',
          error: new Error('task submission outcome is in doubt'),
        };
      }
      if (current.turn_id === null) {
        return {
          status: 'failed',
          error: new Error('task submission has no durable turn'),
        };
      }
      return before.turn_id === null
        ? { status: 'submitted', turnId: current.turn_id }
        : { status: 'duplicate' };
    });
  }

  async reconcileExisting(targetId: string): Promise<void> {
    let priorFingerprint = '';
    for (;;) {
      const target = requiredTarget(this.opts.store, targetId);
      if (
        target.submissions.length === 0 ||
        target.phase === 'finalized' ||
        target.terminal?.outcome === 'cancelled'
      ) {
        return;
      }
      const fingerprint = submissionFingerprint(target);
      if (fingerprint === priorFingerprint) return;
      priorFingerprint = fingerprint;
      for (const snapshot of target.submissions) {
      if (
        snapshot.state === 'in_doubt' ||
        (snapshot.settlement !== null &&
          snapshot.settlement_acknowledged_revision >= snapshot.settlement.revision)
      ) {
        continue;
      }
      const currentTarget = requiredTarget(this.opts.store, targetId);
      const current = requiredSubmission(currentTarget, snapshot.operation_id);
      let handle: TaskRuntimeHandle;
      try {
        handle = await this.runtimeFor(currentTarget, current);
      } catch (error) {
        if (error instanceof DurabilityNamespaceChangedError) {
          await this.index.recordInDoubt({
            targetId,
            operationId: current.operation_id,
            code: 'DURABILITY_NAMESPACE_CHANGED',
          });
        } else if (error instanceof TaskRuntimeCapabilityUnavailableError) {
          await this.index.recordInDoubt({
            targetId,
            operationId: current.operation_id,
            code: 'RUNTIME_CAPABILITY_UNAVAILABLE',
          });
        } else {
          // No runtime side effect has been attempted yet. Propagate the
          // preparation failure so lifecycle recovery records retryable
          // blocked/degraded state instead of silently stranding the intent.
          throw error;
        }
        continue;
      }
      const durable = durableCapability(handle.runtime);
      if (
        current.durability_namespace !== null &&
        current.durability_namespace !== durable.namespace
      ) {
        await this.index.recordInDoubt({
          targetId,
          operationId: current.operation_id,
          code: 'DURABILITY_NAMESPACE_CHANGED',
        });
        continue;
      }
      await this.submitOperation(currentTarget, current, handle);
      }
    }
  }

  async notifySettlement(input: {
    teamId: string;
    runtimeId: string;
    durabilityNamespace: string;
    turnId: string;
  }): Promise<void> {
    if (this.stopped) return;
    const key = settlementKey(input);
    this.pendingSettlementSignals.set(key, input);
    await this.dispatchSettlementSignal(key);
  }

  private async submitOperation(
    target: TaskTargetRecord,
    submission: RuntimeSubmissionRecord,
    handle: TaskRuntimeHandle,
  ): Promise<void> {
    const durable = durableCapability(handle.runtime);
    await this.index.bindRuntime({
      targetId: target.target_id,
      operationId: submission.operation_id,
      runtimeId: handle.runtimeId,
      runtimeRole: handle.role,
      durabilityNamespace: durable.namespace,
    });
    await this.reconcile(
      target.target_id,
      submission.operation_id,
      submission.delivery,
      handle.runtime,
    );
  }

  private async reconcile(
    targetId: string,
    operationId: string,
    delivery: AgentRuntimeDurableSubmissionDelivery,
    runtime: AgentRuntime,
  ): Promise<void> {
    const target = requiredTarget(this.opts.store, targetId);
    const durable = durableCapability(runtime);
    const known = await this.runtimeCall(
      durable.lookupSubmission(operationId),
      'lookup',
    );
    if (known.status === 'in_doubt') {
      await this.index.recordInDoubt({
        targetId,
        operationId,
        code: boundedCode(known.code),
      });
      return;
    }
    if (known.status === 'found') {
      await this.acceptAndAcknowledge(target, runtime, known.submission, operationId);
      return;
    }
    const intent = this.index.lookup(targetId, operationId);
    if (intent === null) return;
    if (intent.state === 'accepted') {
      await this.index.recordInDoubt({
        targetId,
        operationId,
        code: 'ACCEPTED_SUBMISSION_DISAPPEARED',
      });
      return;
    }
    if (intent.state !== 'intent') return;
    let submitted;
    try {
      submitted = await this.runtimeCall(durable.submitOnce({
        operation_id: operationId,
        input_digest: intent.input_digest,
        delivery,
      }), 'submit');
    } catch (error) {
      if (!(error instanceof RuntimeCallTimedOutError)) throw error;
      await this.index.recordInDoubt({
        targetId,
        operationId,
        code: 'RUNTIME_SUBMISSION_TIMEOUT',
      });
      return;
    }
    if (submitted.status === 'in_doubt') {
      await this.index.recordInDoubt({
        targetId,
        operationId,
        code: boundedCode(submitted.code),
      });
      return;
    }
    await this.acceptAndAcknowledge(target, runtime, submitted.submission, operationId);
    const accepted = this.index.lookup(targetId, operationId);
    if (accepted?.turn_id === null || accepted?.turn_id === undefined) return;
    const key = settlementKey({
      teamId: target.team.team_name,
      runtimeId: accepted.runtime_id!,
      durabilityNamespace: accepted.durability_namespace!,
      turnId: accepted.turn_id,
    });
    if (this.pendingSettlementSignals.has(key)) {
      await this.refreshSettlementSignal(key);
    }
  }

  private async refreshFromRuntime(
    target: TaskTargetRecord,
    operationId: string,
    providedRuntime?: AgentRuntime,
  ): Promise<void> {
    const current = requiredSubmission(
      requiredTarget(this.opts.store, target.target_id),
      operationId,
    );
    const runtime = providedRuntime ??
      (await this.runtimeFor(target, current)).runtime;
    const lookup = await this.runtimeCall(
      durableCapability(runtime).lookupSubmission(operationId),
      'lookup',
    );
    if (lookup.status === 'in_doubt') {
      if (current.state === 'intent' || current.state === 'accepted') {
        await this.index.recordInDoubt({
          targetId: target.target_id,
          operationId,
          code: boundedCode(lookup.code),
        });
      }
      return;
    }
    if (lookup.status === 'found') {
      await this.acceptAndAcknowledge(target, runtime, lookup.submission, operationId);
      return;
    }
    if (current.state === 'accepted') {
      await this.index.recordInDoubt({
        targetId: target.target_id,
        operationId,
        code: 'ACCEPTED_SUBMISSION_DISAPPEARED',
      });
    }
  }

  private async acceptAndAcknowledge(
    target: TaskTargetRecord,
    runtime: AgentRuntime,
    submission: AgentRuntimeDurableSubmissionRecord,
    expectedOperationId: string,
  ): Promise<void> {
    assertRuntimeSubmission(submission, expectedOperationId);
    const indexed = await this.index.recordAccepted({
      targetId: target.target_id,
      operationId: submission.operation_id,
      runtime: submission,
    });
    const settlement = indexed.settlement;
    if (settlement === null) return;
    if (shouldDeliverChildCompletion(target, indexed)) {
      await this.ensureChildCompletion(target.target_id, indexed);
    }
    if (indexed.settlement_acknowledged_revision >= settlement.revision) return;
    const acknowledged = await this.runtimeCall(
      durableCapability(runtime).acknowledgeSettlement({
        operation_id: indexed.operation_id,
        settlement_revision: settlement.revision,
      }),
      'settlement acknowledgement',
    );
    if (
      !Number.isSafeInteger(acknowledged.acknowledged_revision) ||
      acknowledged.acknowledged_revision < settlement.revision ||
      acknowledged.acknowledged_revision > submission.revision
    ) {
      throw new Error('runtime returned an invalid durable settlement acknowledgement');
    }
    await this.index.recordSettlementAcknowledged({
      targetId: target.target_id,
      operationId: indexed.operation_id,
      revision: acknowledged.acknowledged_revision,
    });
  }

  private async ensureChildCompletion(
    targetId: string,
    child: RuntimeSubmissionRecord,
  ): Promise<void> {
    const target = requiredTarget(this.opts.store, targetId);
    const settlement = child.settlement;
    if (settlement === null) return;
    const toolCallId = `completion:${child.operation_id}`;
    const operationId = taskOperationId({
      targetId,
      parentOperationId: child.operation_id,
      toolCallId,
      toolCallOrdinal: 0,
      kind: 'completion',
    });
    const delivery = {
      kind: 'text' as const,
      input: {
        sourceId: toolCallId,
        text: completionText(child, settlement.status, settlement.result),
      },
    };
    await this.index.recordIntent({
      targetId,
      kind: 'completion',
      operationId,
      inputDigest: durableSubmissionInputDigest(delivery),
      parentOperationId: child.operation_id,
      toolCallId,
      toolCallOrdinal: 0,
      runtimeId: null,
      runtimeRole: 'leader',
      durabilityNamespace: null,
      delivery,
      effect: { kind: 'completion', source_operation_id: child.operation_id },
    });
    const completion = requiredSubmission(
      requiredTarget(this.opts.store, targetId),
      operationId,
    );
    const handle = await this.runtimeFor(target, completion);
    await this.submitOperation(target, completion, handle);
  }

  private async runtimeFor(
    target: TaskTargetRecord,
    submission: RuntimeSubmissionRecord,
  ): Promise<TaskRuntimeHandle> {
    const team = await this.opts.teams.get(target.team.team_name);
    const handle = await this.runtimeCall(team.ensureTaskSubmissionRuntime({
      runtimeId: submission.runtime_id,
      runtimeRole: submission.runtime_role,
      effect: submission.effect,
    }), 'runtime preparation');
    const namespace = durableCapability(handle.runtime).namespace;
    if (
      submission.durability_namespace !== null &&
      submission.durability_namespace !== namespace
    ) {
      throw new DurabilityNamespaceChangedError();
    }
    return handle;
  }

  private async runtimeCall<T>(promise: Promise<T>, operation: string): Promise<T> {
    const timeoutMs = this.opts.runtimeCallTimeoutMs ?? 30_000;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        promise,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () => reject(new RuntimeCallTimedOutError(operation)),
            timeoutMs,
          );
          timer.unref?.();
        }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  private async dispatchSettlementSignal(key: string): Promise<void> {
    const current = this.settlementWork.get(key);
    if (current !== undefined) return current;
    const signal = this.pendingSettlementSignals.get(key);
    if (signal === undefined || this.stopped) return;
    const target = this.opts.store.list().find(
      (entry) => entry.team.team_name === signal.teamId,
    );
    if (target === undefined) {
      this.scheduleSettlementRetry(key);
      return;
    }
    // Finalization closes runtimes while holding the target lifecycle queue.
    // A runtime may synchronously report its final settlement during that close,
    // so terminal settlement reconciliation must use the store's own serialized
    // transaction boundary instead of re-entering the non-reentrant lifecycle
    // queue. Non-terminal execution still uses the broader lifecycle fence.
    const work = target.terminal === null
      ? this.opts.runExclusive(target.target_id, () =>
          this.refreshSettlementSignal(key),
        )
      : this.refreshSettlementSignal(key);
    const tracked = work.finally(() => {
      if (this.settlementWork.get(key) === tracked) {
        this.settlementWork.delete(key);
      }
    });
    this.settlementWork.set(key, tracked);
    try {
      await tracked;
    } catch (error) {
      this.opts.log.warn(
        { target_id: target.target_id, err: errorInfo(error) },
        'durable task settlement reconciliation failed',
      );
      this.scheduleSettlementRetry(key);
      throw error;
    }
  }

  private async refreshSettlementSignal(key: string): Promise<void> {
    const signal = this.pendingSettlementSignals.get(key);
    if (signal === undefined || this.stopped) return;
    const matches = findSubmissionsByTurn(
      this.opts.store,
      signal.teamId,
      signal.runtimeId,
      signal.durabilityNamespace,
      signal.turnId,
    );
    if (matches.length === 0) {
      this.scheduleSettlementRetry(key);
      return;
    }
    for (const match of matches) {
      if (
        match.target.phase !== 'finalized' &&
        match.submission.state !== 'in_doubt' &&
        match.submission.settlement === null
      ) {
        await this.refreshFromRuntime(match.target, match.operationId);
      }
    }
    const refreshed = findSubmissionsByTurn(
      this.opts.store,
      signal.teamId,
      signal.runtimeId,
      signal.durabilityNamespace,
      signal.turnId,
    );
    const complete = refreshed.length > 0 && refreshed.every(
      ({ target, submission }) =>
        target.phase === 'finalized' ||
        submission.state === 'in_doubt' ||
        submission.settlement !== null,
    );
    if (!complete) {
      this.scheduleSettlementRetry(key);
      return;
    }
    this.pendingSettlementSignals.delete(key);
    this.clearSettlementRetry(key);
    for (const targetId of new Set(refreshed.map((match) => match.target.target_id))) {
      this.opts.onSettlementProgress(targetId);
    }
  }

  private scheduleSettlementRetry(key: string): void {
    if (
      this.stopped ||
      !this.pendingSettlementSignals.has(key) ||
      this.settlementRetryTimers.has(key)
    ) {
      return;
    }
    const attempt = (this.settlementRetryAttempts.get(key) ?? 0) + 1;
    this.settlementRetryAttempts.set(key, attempt);
    const delay = this.opts.settlementRetryDelayMs?.(attempt) ??
      Math.min(30_000, 250 * (2 ** Math.min(attempt - 1, 7)));
    const timer = setTimeout(() => {
      this.settlementRetryTimers.delete(key);
      void this.dispatchSettlementSignal(key).catch(() => {});
    }, delay);
    timer.unref?.();
    this.settlementRetryTimers.set(key, timer);
  }

  private clearSettlementRetry(key: string): void {
    const timer = this.settlementRetryTimers.get(key);
    if (timer !== undefined) clearTimeout(timer);
    this.settlementRetryTimers.delete(key);
    this.settlementRetryAttempts.delete(key);
  }
}
class RuntimeCallTimedOutError extends Error {
  constructor(operation: string) {
    super(`durable task runtime ${operation} timed out`);
    this.name = 'RuntimeCallTimedOutError';
  }
}
