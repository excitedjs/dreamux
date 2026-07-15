import type {
  ChannelTaskAttemptIdentity,
  ChannelTaskContainerIdentity,
  ChannelTaskHost,
  ChannelTaskHostCapability,
  ChannelTaskHostEventSink,
  ChannelTaskHostNegotiationInput,
  ChannelTaskHostNegotiationResult,
  ChannelTaskHostReplayResult,
  ChannelTaskReceipt,
  ChannelTaskSnapshotRequest,
  ChannelTaskSnapshotResult,
  ChannelTaskSubmitInput,
  ChannelTaskSubmitResult,
  ChannelTaskTerminalResult,
  DreamuxLogger,
} from '@excitedjs/dreamux-types';
import { randomUUID } from 'node:crypto';

import type { AgentRuntimeProviderCatalog } from '../../agent-runtime/index.js';
import type { DreamuxConfig } from '../../config/config.js';
import { agentRuntimeSupportsDurableTasks } from '../teammate-collection/agent-config.js';
import type { ChannelService } from '../channel-service/index.js';
import type { CollaborationSpaceService } from '../collaboration-space/index.js';
import type { CollaborationSpaceRecord } from '../collaboration-space/types.js';
import type { TeamCollection } from '../team-collection/index.js';
import type { TaskTeamSubmissionBridge } from '../task-runtime-submission.js';
import { KeyedAsyncQueue } from '../serial-queue.js';
import { TaskHostEventPump } from './event-pump.js';
import { TaskTargetFinalizer } from './finalizer.js';
import {
  canonicalTaskIdentity,
  taskRequestFingerprint,
  validateTaskSubmitInput,
  validateTaskCancelInput,
} from './identity.js';
import { TaskRuntimeExecutor } from './runtime-execution.js';
import {
  createTaskHostSessionHandle,
  TASK_HOST_CAPABILITIES,
  taskHostRequiredCapabilities,
} from './session-handle.js';
import { TaskHostStore } from './store.js';
import {
  boundedTerminal,
  boundedText,
  errorInfo,
  rejected,
} from './service-helpers.js';
import { provisionTaskTarget } from './target-provisioning.js';
import { admitTaskSubmission } from './admission.js';

export interface TaskChannelHostServiceOptions {
  dispatcherId: string;
  channelId: string;
  provider: string;
  config: DreamuxConfig;
  channels: ChannelService;
  collaborationSpaces: CollaborationSpaceService;
  teams: TeamCollection;
  agentRuntimeProviders: AgentRuntimeProviderCatalog;
  log: DreamuxLogger;
  isShuttingDown: () => boolean;
  store?: TaskHostStore;
  storeRoot?: string;
}

export class TaskChannelHostService {
  private readonly store: TaskHostStore;
  private readonly pump: TaskHostEventPump;
  private readonly finalizer: TaskTargetFinalizer;
  private readonly executor: TaskRuntimeExecutor;
  private readonly lifecycle = new Map<string, Promise<void>>();
  private readonly targetLifecycle = new KeyedAsyncQueue();
  private accepting = false;
  private negotiatedCapabilities = new Set<ChannelTaskHostCapability>();
  private activeSessionFence: string | null = null;
  private sessionAckEligibleThrough = 0;
  private sessionReplayOfferedThrough = 0;
  private sessionSyncMode: 'unnegotiated' | 'snapshot_required' | 'replay' =
    'unnegotiated';
  private sessionSnapshotId: string | null = null;
  private sessionSnapshotNextOffset = 0;
  private recovering = false;
  private stopping = false;

  private constructor(
    private readonly opts: TaskChannelHostServiceOptions,
    store: TaskHostStore,
  ) {
    this.store = store;
    this.pump = new TaskHostEventPump(store, opts.log);
    this.finalizer = new TaskTargetFinalizer({
      store,
      channels: opts.channels,
      teams: opts.teams,
      log: opts.log,
      runExclusive: (targetId, task) => this.targetLifecycle.run(targetId, task),
      onRecovered: () => this.restoreHostStatusIfHealthy(),
    });
    this.executor = new TaskRuntimeExecutor({
      store,
      teams: opts.teams,
      log: opts.log,
      runExclusive: (targetId, task) => this.targetLifecycle.run(targetId, task),
      onSettlementProgress: (targetId) => this.finalizer.start(targetId),
    });
  }

  static async open(
    opts: TaskChannelHostServiceOptions,
  ): Promise<TaskChannelHostService> {
    const store = opts.store ?? await TaskHostStore.open({
      dispatcherId: opts.dispatcherId,
      channelId: opts.channelId,
      providerRef: opts.provider,
      ...(opts.storeRoot !== undefined ? { rootDir: opts.storeRoot } : {}),
      onProjectionError: (error) => {
        opts.log.warn(
          { channel_id: opts.channelId, err: errorInfo(error) },
          'task channel projection write failed',
        );
      },
    });
    return new TaskChannelHostService(opts, store);
  }

  async recover(): Promise<void> {
    this.recovering = true;
    try {
      this.accepting = false;
      this.stopping = false;
      this.finalizer.resume();
      this.executor.resume();
      await this.store.appendHostStatus('recovering');
      let degraded = false;
      for (const target of this.store.list()) {
        try {
          if (target.terminal !== null) {
            if (target.terminal.outcome !== 'cancelled') {
              await this.targetLifecycle.run(target.target_id, () =>
                this.executor.reconcileExisting(target.target_id),
              );
            }
            await this.finalizer.run(target.target_id);
          } else if (
            target.phase !== 'finalized' &&
            target.blocked?.retryable !== false
          ) {
            await this.targetLifecycle.run(target.target_id, () =>
              this.provision(target.target_id),
            );
          }
        } catch (error) {
          degraded = true;
          this.opts.log.error(
            { target_id: target.target_id, err: errorInfo(error) },
            'task channel recovery failed',
          );
        }
      }
      await this.store.appendHostStatus(degraded ? 'degraded' : 'ready');
      this.accepting = true;
    } finally {
      this.recovering = false;
    }
  }

  beginSession(): ChannelTaskHost {
    this.pump.detach();
    const fence = randomUUID();
    this.activeSessionFence = fence;
    this.sessionAckEligibleThrough = this.store.acknowledgedThrough;
    this.sessionReplayOfferedThrough = this.store.acknowledgedThrough;
    this.sessionSyncMode = 'unnegotiated';
    this.sessionSnapshotId = null;
    this.sessionSnapshotNextOffset = 0;
    this.negotiatedCapabilities.clear();
    const required = taskHostRequiredCapabilities(this.repositorySource());
    const optional = TASK_HOST_CAPABILITIES.filter(
      (capability) => !required.includes(capability),
    );
    return createTaskHostSessionHandle({
      fence,
      scope: {
        schema_versions: [1],
        required_capabilities: required,
        optional_capabilities: optional,
        host_stream_id: this.store.hostStreamId,
        stream_generation: this.store.streamGeneration,
        host_status: this.store.hostStatus,
      },
      assertActive: (activeFence) => this.assertSessionFence(activeFence),
      negotiate: (input) => this.negotiate(input, fence),
      submit: (input) => this.submit(input),
      lookupSubmission: (attempt, container) =>
        this.lookupSubmission(attempt, container),
      cancel: (input) => this.cancel(input),
      snapshot: (input) => Promise.resolve(this.snapshot(input, fence)),
      replay: (input) => Promise.resolve(this.replay(input)),
      acknowledgeHostEvents: async (input) => ({
        acknowledged_through: await this.acknowledge(input),
      }),
    });
  }

  attachEventSink(
    sessionFence: string,
    sink: ChannelTaskHostEventSink | undefined,
  ): void {
    this.assertSessionFence(sessionFence);
    this.requireNegotiated();
    if (this.sessionSyncMode !== 'replay') {
      throw new Error(
        'task channel host snapshot must complete before attaching an event sink',
      );
    }
    this.pump.attach(sink ?? null);
  }

  detachEventSink(): void {
    this.pump.detach();
    this.activeSessionFence = null;
    this.negotiatedCapabilities.clear();
    this.sessionSyncMode = 'unnegotiated';
  }

  async prepareStop(): Promise<void> {
    if (this.stopping) return;
    this.stopping = true;
    this.accepting = false;
    this.finalizer.stop();
    this.executor.stop();
    await this.store.appendHostStatus('stopping');
  }

  async finishStop(): Promise<void> {
    await this.prepareStop();
    await this.drain();
    await this.store.appendHostStatus('stopped');
    await this.pump.drain();
  }

  async drain(): Promise<void> {
    while (this.lifecycle.size > 0) {
      await Promise.allSettled([...this.lifecycle.values()]);
    }
    await this.executor.drain();
    await this.finalizer.drain();
    await this.pump.drain();
    await this.store.drainMaintenance();
  }

  close(): void {
    this.accepting = false;
    this.negotiatedCapabilities.clear();
    this.finalizer.stop();
    this.executor.stop();
    this.pump.stop();
  }

  async notifySettlement(input: {
    teamId: string;
    runtimeId: string;
    durabilityNamespace: string;
    turnId: string;
  }): Promise<void> {
    await this.executor.notifySettlement(input);
  }

  async finishForTeam(input: {
    teamId: string;
    leaderName: string;
    result: ChannelTaskTerminalResult;
  }): Promise<ChannelTaskReceipt> {
    const target = this.store.list().find(
      (entry) =>
        entry.team.team_name === input.teamId &&
        entry.team.leader_name === input.leaderName &&
        entry.phase !== 'finalized',
    );
    if (target === undefined) {
      throw new Error('TeamLeader has no active task attempt');
    }
    const terminal = await this.store.setTerminal({
      targetId: target.target_id,
      expectedRevision: null,
      terminal: boundedTerminal(input.result),
    });
    this.finalizer.start(target.target_id);
    return terminal.record.receipt;
  }

  hasTeam(teamId: string): boolean {
    return this.store.list().some(
      (target) => target.team.team_name === teamId && target.phase !== 'finalized',
    );
  }

  hasActiveContainer(space: CollaborationSpaceRecord): boolean {
    return this.store.list().some((target) =>
      target.phase !== 'finalized' &&
      target.channel_id === space.channel_id &&
      target.container.container_type === space.container_type &&
      target.container.container_key === space.container_key
    );
  }

  submissionBridgeForTeam(teamId: string): TaskTeamSubmissionBridge | null {
    if (!this.hasTeam(teamId)) return null;
    return {
      prepareSpawn: (input) => this.executor.prepareSpawn({ teamId, ...input }),
      prepareSend: (input) => this.executor.prepareSend({ teamId, ...input }),
      submitPrepared: (prepared) =>
        this.executor.submitPrepared(teamId, prepared),
      observeSettlement: (input) =>
        this.notifySettlement({ teamId, ...input }),
    };
  }

  private async negotiate(
    input: ChannelTaskHostNegotiationInput,
    fence: string,
  ): Promise<ChannelTaskHostNegotiationResult> {
    if (!input.supported_schema_versions.includes(1)) {
      throw new Error('task channel host schema version 1 is required');
    }
    const required = taskHostRequiredCapabilities(this.repositorySource());
    for (const capability of required) {
      if (!input.supported_capabilities.includes(capability)) {
        throw new Error(`task channel capability '${capability}' is required`);
      }
    }
    this.negotiatedCapabilities = new Set(
      TASK_HOST_CAPABILITIES.filter((capability) =>
        input.supported_capabilities.includes(capability),
      ),
    );
    const resume = input.resume;
    const canReplay =
      resume !== undefined &&
      resume.host_stream_id === this.store.hostStreamId &&
        resume.stream_generation === this.store.streamGeneration &&
        Number.isSafeInteger(resume.acknowledged_through) &&
        resume.acknowledged_through >= this.store.replayFloor &&
        resume.acknowledged_through <= this.store.watermark;
    if (canReplay) {
      this.sessionSyncMode = 'replay';
      this.sessionReplayOfferedThrough = resume.acknowledged_through;
      this.sessionAckEligibleThrough = Math.max(
        this.store.acknowledgedThrough,
        resume.acknowledged_through,
      );
    } else {
      this.sessionSyncMode = 'snapshot_required';
      this.sessionReplayOfferedThrough = this.store.acknowledgedThrough;
      this.sessionAckEligibleThrough = this.store.acknowledgedThrough;
    }
    this.sessionSnapshotId = null;
    this.sessionSnapshotNextOffset = 0;
    return {
      schema_version: 1,
      capabilities: [...this.negotiatedCapabilities],
      host_stream_id: this.store.hostStreamId,
      stream_generation: this.store.streamGeneration,
      watermark: this.store.watermark,
      acknowledged_through: this.store.acknowledgedThrough,
      host_status: this.store.hostStatus,
      session_fence: fence,
      resume: canReplay ? 'replay' : 'snapshot_required',
    };
  }

  private async submit(input: ChannelTaskSubmitInput): Promise<ChannelTaskSubmitResult> {
    if (!this.isNegotiated()) return rejected(
      'TASK_HOST_NOT_NEGOTIATED',
      'task channel host capabilities must be negotiated before delivery',
      false,
    );
    if (!this.accepting || this.stopping || this.opts.isShuttingDown()) {
      return rejected(
        'TASK_HOST_SHUTTING_DOWN',
        'task channel host is not accepting deliveries',
        true,
      );
    }
    try {
      validateTaskSubmitInput(input);
    } catch {
      return rejected('TASK_INPUT_INVALID', 'task delivery is invalid', false);
    }
    const identity = canonicalTaskIdentity({
      dispatcherId: this.opts.dispatcherId,
      channelId: this.opts.channelId,
      containerType: input.container.container_type,
      containerKey: input.container.container_key,
      attempt: input.attempt,
    });
    const fingerprint = taskRequestFingerprint(input);
    return this.targetLifecycle.run(identity.targetId, () =>
      admitTaskSubmission({
        dispatcherId: this.opts.dispatcherId,
        channelId: this.opts.channelId,
        provider: this.opts.provider,
        channels: this.opts.channels,
        collaborationSpaces: this.opts.collaborationSpaces,
        store: this.store,
        defaultLeaderAgentRuntime: () => this.defaultLeaderAgentRuntime(),
        runtimeSupportsDurableTasks: (agentRuntimeId) =>
          this.runtimeSupportsDurableTasks(agentRuntimeId),
        startLifecycle: (targetId) =>
          this.startLifecycle(targetId, () => this.provision(targetId)),
      }, input, identity, fingerprint),
    );
  }

  private async provision(targetId: string): Promise<void> {
    await provisionTaskTarget({
      channelId: this.opts.channelId,
      store: this.store,
      channels: this.opts.channels,
      collaborationSpaces: this.opts.collaborationSpaces,
      teams: this.opts.teams,
      executor: this.executor,
      defaultLeaderAgentRuntime: () => this.defaultLeaderAgentRuntime(),
      runtimeSupportsDurableTasks: (agentRuntimeId) =>
        this.runtimeSupportsDurableTasks(agentRuntimeId),
    }, targetId);
    await this.restoreHostStatusIfHealthy();
  }

  private async restoreHostStatusIfHealthy(): Promise<void> {
    if (this.recovering || this.store.hostStatus !== 'degraded') return;
    const hasRetryableFailure = this.store.list().some((target) =>
      target.blocked?.retryable === true ||
      target.finalizer?.last_error_code !== null &&
        target.finalizer?.last_error_code !== undefined
    );
    if (!hasRetryableFailure) await this.store.appendHostStatus('ready');
  }

  private lookupSubmission(
    attempt: ChannelTaskAttemptIdentity,
    container: ChannelTaskContainerIdentity,
  ): Promise<ChannelTaskReceipt | null> {
    this.requireNegotiated();
    try {
      const identity = canonicalTaskIdentity({
        dispatcherId: this.opts.dispatcherId,
        channelId: this.opts.channelId,
        containerType: container.container_type,
        containerKey: container.container_key,
        attempt,
      });
      return Promise.resolve(this.store.get(identity.targetId)?.receipt ?? null);
    } catch {
      return Promise.resolve(null);
    }
  }

  private async cancel(input: {
    attempt: ChannelTaskAttemptIdentity;
    container: ChannelTaskContainerIdentity;
    reason?: string;
  }): ReturnType<ChannelTaskHost['cancel']> {
    if (!this.isNegotiated()) {
      return { status: 'rejected', code: 'TASK_HOST_NOT_NEGOTIATED' };
    }
    if (!this.accepting || this.stopping || this.opts.isShuttingDown()) {
      return { status: 'rejected', code: 'TASK_HOST_SHUTTING_DOWN' };
    }
    try {
      validateTaskCancelInput(input);
    } catch {
      return { status: 'rejected', code: 'TASK_INPUT_INVALID' };
    }
    const receipt = await this.lookupSubmission(input.attempt, input.container);
    if (receipt === null) return { status: 'not_found' };
    const result = await this.store.setTerminal({
      targetId: receipt.target_id,
      expectedRevision: null,
      terminal: {
        outcome: 'cancelled',
        ...(input.reason !== undefined
          ? { summary: boundedText(input.reason, 64 * 1024) }
          : {}),
      },
    });
    this.finalizer.start(receipt.target_id);
    if (!result.changed) {
      return {
        status: 'already_terminal',
        receipt: result.record.receipt,
        terminal: result.record.terminal!,
      };
    }
    return { status: 'accepted', receipt: result.record.receipt };
  }

  private replay(input: {
    host_stream_id: string;
    stream_generation: number;
    after_sequence: number;
    limit?: number;
  }): ChannelTaskHostReplayResult {
    this.requireNegotiated();
    if (
      this.sessionSyncMode !== 'replay' ||
      input.host_stream_id !== this.store.hostStreamId ||
      input.stream_generation !== this.store.streamGeneration ||
      !Number.isSafeInteger(input.after_sequence) ||
      input.after_sequence < this.store.replayFloor ||
      input.after_sequence > this.store.watermark ||
      input.after_sequence > this.sessionReplayOfferedThrough
    ) {
      this.sessionSyncMode = 'snapshot_required';
      return {
        status: 'snapshot_required',
        host_stream_id: this.store.hostStreamId,
        stream_generation: this.store.streamGeneration,
        watermark: this.store.watermark,
      };
    }
    const batch = this.store.replay(input.after_sequence, input.limit);
    if (batch.last_sequence !== null) {
      this.sessionReplayOfferedThrough = Math.max(
        this.sessionReplayOfferedThrough,
        batch.last_sequence,
      );
      this.sessionAckEligibleThrough = Math.max(
        this.sessionAckEligibleThrough,
        batch.last_sequence,
      );
    }
    return {
      status: 'events',
      batch,
    };
  }

  private snapshot(
    input: ChannelTaskSnapshotRequest | undefined,
    fence: string,
  ): ChannelTaskSnapshotResult {
    this.requireNegotiated();
    if (input?.cursor === undefined) {
      this.sessionSyncMode = 'snapshot_required';
      this.sessionSnapshotId = null;
      this.sessionSnapshotNextOffset = 0;
    } else if (this.sessionSyncMode !== 'snapshot_required') {
      return this.snapshotRestartRequired('cursor_invalid');
    }
    const result = this.store.snapshot(input?.cursor, input?.limit, fence);
    if (result.status !== 'page') {
      this.sessionSnapshotId = null;
      this.sessionSnapshotNextOffset = 0;
      this.sessionSyncMode = 'snapshot_required';
      return result;
    }
    const page = result.page;
    const firstPage = input?.cursor === undefined;
    if (
      (firstPage && page.item_offset !== 0) ||
      (!firstPage &&
        (page.snapshot_id !== this.sessionSnapshotId ||
          page.item_offset !== this.sessionSnapshotNextOffset))
    ) {
      this.sessionSnapshotId = null;
      this.sessionSnapshotNextOffset = 0;
      this.sessionSyncMode = 'snapshot_required';
      return this.snapshotRestartRequired('cursor_invalid');
    }
    this.sessionSnapshotId = page.snapshot_id;
    this.sessionSnapshotNextOffset = page.item_offset + page.item_count;
    if (page.complete) {
      this.sessionSyncMode = 'replay';
      this.sessionReplayOfferedThrough = page.watermark;
      this.sessionAckEligibleThrough = Math.max(
        this.sessionAckEligibleThrough,
        page.watermark,
      );
    }
    return result;
  }

  private snapshotRestartRequired(
    reason: 'cursor_invalid' | 'snapshot_expired' | 'stream_changed',
  ): ChannelTaskSnapshotResult {
    return {
      status: 'restart_required',
      reason,
      host_stream_id: this.store.hostStreamId,
      stream_generation: this.store.streamGeneration,
      watermark: this.store.watermark,
    };
  }

  private acknowledge(input: {
    host_stream_id: string;
    stream_generation: number;
    acknowledged_through: number;
  }): Promise<number> {
    this.requireNegotiated();
    if (input.host_stream_id !== this.store.hostStreamId) {
      throw new Error('host event acknowledgement has the wrong stream id');
    }
    if (input.acknowledged_through > this.sessionAckEligibleThrough) {
      throw new Error('host event acknowledgement exceeds the offered prefix');
    }
    return this.store.acknowledge(
      input.stream_generation,
      input.acknowledged_through,
    );
  }

  private runtimeSupportsDurableTasks(agentRuntimeId: string): boolean {
    try {
      return agentRuntimeSupportsDurableTasks(
        this.opts.config,
        this.opts.dispatcherId,
        agentRuntimeId,
        this.opts.agentRuntimeProviders,
      );
    } catch {
      return false;
    }
  }

  private defaultLeaderAgentRuntime(): string {
    const dispatcher = this.opts.config.dispatchers.find(
      (entry) => entry.id === this.opts.dispatcherId,
    );
    if (dispatcher === undefined) {
      throw new Error(`dispatcher '${this.opts.dispatcherId}' has no config entry`);
    }
    return dispatcher.agentRuntime;
  }

  private repositorySource(): 'static' | 'channel' {
    return this.opts.channels
      .collaborationSpaceConfig(this.opts.channelId)
      .defaultBinding.repositorySource;
  }

  private assertSessionFence(fence: string): void {
    if (this.activeSessionFence !== fence) {
      throw new Error('task channel host session handle has been revoked');
    }
  }

  private isNegotiated(): boolean {
    return this.negotiatedCapabilities.has('durable_task_submission_v1') &&
      this.negotiatedCapabilities.has('host_event_stream_v1');
  }

  private requireNegotiated(): void {
    if (!this.isNegotiated()) {
      throw new Error('task channel host capabilities are not negotiated');
    }
  }

  private startLifecycle(targetId: string, start: () => Promise<void>): void {
    if (this.lifecycle.has(targetId)) return;
    const task = this.targetLifecycle.run(targetId, start)
      .catch((error) => {
        this.opts.log.error(
          { target_id: targetId, err: errorInfo(error) },
          'task target lifecycle failed',
        );
      })
      .finally(() => this.lifecycle.delete(targetId));
    this.lifecycle.set(targetId, task);
  }
}
