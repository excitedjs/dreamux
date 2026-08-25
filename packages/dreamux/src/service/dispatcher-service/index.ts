import type {
  AgentRuntimeMcpServer,
  ChannelInboundEnvelope,
  DreamuxLogger,
  InboundDeliveryResult,
  InboundTurnInput,
} from '@excitedjs/dreamux-types';

import type { RestartIntentConsumer } from '../../daemon/restart-intent.js';
import { adminSocketPath as defaultAdminSocketPath, dispatcherCronJobsPath } from '../../platform/paths.js';
import { errorInfo } from '../../platform/error-info.js';
import type { DispatcherRow } from '../../state/dispatcher-store.js';
import type { ChannelMcpCallerScope } from '../channel-service/mcp-descriptors.js';
import { DispatcherScopedChannelRouting } from './scoped-channel-routing.js';
import { DispatcherTaskDrain } from './inbound-task-drain.js';
import { DispatcherInputSourceLifecycle } from './input-source-lifecycle.js';
import { TeamChannelCoordinator } from './team-channel-coordinator.js';
import { stopTeamRuntimes } from './team-runtime-stop.js';
import { admittedTeammateOps } from './teammate-ops.js';
import { teamLeaderHandle, type TeamLeaderHandle } from './team-leader-handle.js';
import type { ChannelToolCaller } from './channel-tool-invocation.js';
import {
  collectShutdownFailure,
  throwShutdownFailures,
} from '../shutdown-errors.js';
import {
  CompletionDeliveryPolicy,
  type CompletionInitiator,
} from '../completion-router/index.js';
import { TeammateCollection } from '../teammate-collection/index.js';
import type { TeammateOps } from '../teammate-collection/types.js';
import { AgentIdentityStore } from '../agent-entity/identity-store.js';
import { createConversationProjection } from '../../channel/conversation-projection.js';
import type { TeammateService } from '../teammate-service/index.js';
import { WorktreeManager } from '../worktree/manager.js';
import type { AgentEntityIdentity } from '../agent-entity/types.js';
import { TeamCollection } from '../team-collection/index.js';
import { SchedulerService } from '../scheduler/service.js';
import type { SchedulerCommands } from '../scheduler/types.js';
import { CronJobStore } from '../scheduler/store.js';
import { ChannelService, type ChannelRouteOwner } from '../channel-service/index.js';
import { channelOriginFromDispatcherRoute } from '../channel-origin.js';
import { CollaborationSpaceService } from '../collaboration-space/index.js';
import { DispatcherCoreEventBus } from '../dispatcher-core-events/index.js';
import type {
  CollaborationSpaceBindInput,
  CollaborationSpaceDissolveInput,
  CollaborationSpaceStatusInput,
} from '../collaboration-space/types.js';
import type {
  TeamCreateInput,
  TeamDissolveInput,
  TeamHistoryQuery,
  TeamLeaderLease,
  TeamLeaderSendResult,
} from '../team-collection/types.js';
import type {
  DispatcherRuntimeStatus,
  DispatcherServiceOptions,
  DispatcherSummary,
  LiveDispatcherRuntimeStatus,
} from './types.js';
import { DispatcherWorkflows } from './dispatcher-workflows.js';
import { asInboundDeliveryResult } from './runtime-helpers.js';
import {
  dispatcherRuntimeStatus,
  dispatcherSummary,
  liveDispatcherRuntimeStatus,
} from './runtime-status.js';

export type { ChannelToolCaller, TeamLeaderHandle };

export class DispatcherService {
  readonly id: string;
  private readonly log: DreamuxLogger;
  private readonly _teammates: TeammateCollection;
  private readonly teams: TeamCollection;
  private readonly channels: ChannelService;
  private readonly collaborationSpaces: CollaborationSpaceService;
  private readonly coreEvents: DispatcherCoreEventBus;
  private readonly teamChannels: TeamChannelCoordinator;
  private readonly channelRoutes: DispatcherScopedChannelRouting;
  private readonly inputSources: DispatcherInputSourceLifecycle;
  private readonly scheduler_: SchedulerService;
  private restartIntent: RestartIntentConsumer | null = null;
  private stopping = false;
  private stoppingTask: Promise<void> | null = null;
  private shuttingDown = false;
  private readonly admittedTasks: DispatcherTaskDrain;
  private readonly teammateOps: TeammateOps;
  private readonly workflowOwner: DispatcherWorkflows;

  constructor(opts: DispatcherServiceOptions) {
    this.id = opts.id;
    this.admittedTasks = new DispatcherTaskDrain(
      () => `dispatcher '${this.id}' is shutting down`,
    );
    this.log = opts.log;
    const adminSocket = opts.adminSocketPath ?? defaultAdminSocketPath();
    const completionDelivery = new CompletionDeliveryPolicy({
      dispatcherId: opts.id,
      log: opts.log,
    });
    const workflowLog = opts.workflowLoggerFactory?.(opts.id) ?? opts.log;
    const configuredChannelCount =
      opts.config.dispatchers.find((dispatcher) => dispatcher.id === opts.id)
        ?.channels.length ?? 0;
    this.coreEvents = new DispatcherCoreEventBus({
      dispatcherId: opts.id,
      log: opts.log,
      maxSources: configuredChannelCount,
    });

    const worktrees = new WorktreeManager();
    const identities = new AgentIdentityStore(opts.log, this.coreEvents.publisher);
    const conversationProjection = createConversationProjection({
      coreEvents: this.coreEvents.publisher,
      log: opts.log,
    });

    this.channels = new ChannelService({
      dispatcherId: opts.id,
      config: opts.config,
      channelProviders: opts.channelProviders,
      coreEvents: this.coreEvents.publisher,
      channelLoggerFactory: opts.channelLoggerFactory,
      ...(opts.adminSocketPath !== undefined
        ? { adminSocketPath: opts.adminSocketPath }
        : {}),
    });

    this.scheduler_ = new SchedulerService({
      ownerId: opts.id,
      store: new CronJobStore({
        cronJobsPath: dispatcherCronJobsPath(opts.id),
        dispatcherId: opts.id,
      }),
      absentRuntimeStrategy: 'submit',
      admit: (task) => this.admitOperation(task),
      getWriter: () => this.inputSources.agent,
      submitScheduled: async (input) =>
        asInboundDeliveryResult(await this.mustAgent().scheduledInput(input)),
      log: opts.log,
    });

    this._teammates = new TeammateCollection({
      dispatcherId: opts.id,
      teamScope: null,
      config: opts.config,
      agentRuntimeProviders: opts.agentRuntimeProviders,
      worktrees,
      identities,
      conversationProjection,
      completionDelivery,
      initiatorFor: (producer) => this.initiatorFor(producer),
      isShuttingDown: () => this.shuttingDown || this.stopping,
      log: opts.log,
    });
    this.teammateOps = admittedTeammateOps({
      teammates: this._teammates,
      admit: (task) => this.admitOperation(task),
    });
    this.teams = new TeamCollection({
      dispatcherId: opts.id,
      config: opts.config,
      agentRuntimeProviders: opts.agentRuntimeProviders,
      worktrees,
      identities,
      conversationProjection,
      completionDelivery,
      initiatorFor: (producer) => this.initiatorFor(producer),
      isShuttingDown: () => this.shuttingDown || this.stopping,
      admitOperation: (task) => this.admitOperation(task),
      trackAcceptedOperation: (task) => this.admittedTasks.trackAccepted(task),
      adminSocketPath: adminSocket,
      leaderChannelDescriptors: ({ teamId, leaderName }) =>
        [
          ...this.channelMcpServerDescriptorsForCaller({
            callerKind: 'team_leader',
            team_id: teamId,
            leader_name: leaderName,
          }),
        ],
      log: opts.log,
      workflowLog,
      coreEvents: this.coreEvents.publisher,
    });
    this.workflowOwner = new DispatcherWorkflows({
      dispatcherId: opts.id,
      teammates: this._teammates,
      teams: this.teams,
      completionDelivery,
      completionInitiator: () => this.mustAgent(),
      admit: (task) => this.admitOperation(task),
      log: workflowLog,
    });

    this.collaborationSpaces = new CollaborationSpaceService({
      dispatcherId: opts.id,
      config: opts.config,
      teams: this.teams,
      channels: this.channels,
      coreEvents: this.coreEvents.publisher,
      log: opts.log,
      isShuttingDown: () => this.shuttingDown || this.stopping,
    });
    this.teamChannels = new TeamChannelCoordinator({
      teams: this.teams,
      channels: this.channels,
      collaborationSpaces: this.collaborationSpaces,
    });
    this.channelRoutes = new DispatcherScopedChannelRouting({
      dispatcherId: this.id,
      dispatcherAgentRuntime: () => this.inputSources.dispatcherAgentRuntime(),
      channels: this.channels,
      teams: this.teams,
      collaborationSpaces: this.collaborationSpaces,
      log: this.log,
      admit: (task) => this.admitOperation(task),
      fallback: async (turn, envelope) => {
        const channelOrigin = channelOriginFromDispatcherRoute(envelope);
        if (channelOrigin === null) {
          opts.log.warn(
            {
              channel_id: envelope.channel_id,
              provider: envelope.provider,
              target_type: envelope.target.target_type,
            },
            'channel origin could not be snapshotted; delivering the dispatcher turn without one',
          );
        }
        return asInboundDeliveryResult(
          await this.mustAgent().channelInput(turn, channelOrigin ?? undefined),
        );
      },
      isUnavailable: () => this.shuttingDown || this.stopping,
    });
    this.inputSources = new DispatcherInputSourceLifecycle({
      dispatcherId: opts.id,
      config: opts.config,
      dispatchers: opts.dispatchers,
      channelProviders: opts.channelProviders,
      agentRuntimeProviders: opts.agentRuntimeProviders,
      identities,
      conversationProjection,
      log: opts.log,
      channels: this.channels,
      adminSocketPath: adminSocket,
      channelRoutes: this.channelRoutes,
      collaborationSpaces: this.collaborationSpaces,
      coreEvents: this.coreEvents,
      scheduler: this.scheduler_,
      teams: this.teams,
      teammates: this._teammates,
      admittedTasks: this.admittedTasks,
      workflows: this.workflowOwner,
      isUnavailable: () => this.shuttingDown || this.stopping,
      restartIntent: () => this.restartIntent,
    });
  }

  get scheduler(): SchedulerCommands {
    return this.scheduler_.commands;
  }

  async start(): Promise<void> {
    return this.startInputSources();
  }

  async prepareChannels(): Promise<void> {
    return this.inputSources.prepareChannels();
  }

  async startInputSources(): Promise<void> {
    return this.inputSources.start();
  }

  stop(): Promise<void> {
    if (this.stoppingTask !== null) return this.stoppingTask;
    this.stopping = true;
    this.channelRoutes.revokeSessionLeases();
    this.admittedTasks.closeAdmission();
    this.workflowOwner.closeAdmission();
    this.teams.interruptDissolvesForShutdown();
    this.scheduler_.stop();
    this.teams.stopSchedulers();
    let cleanupComplete = false;
    const task = this.doStop()
      .then(
        () => {
          cleanupComplete = true;
          this.inputSources.markCleanupComplete();
        },
        (error: unknown) => {
          this.inputSources.markCleanupPending();
          throw error;
        },
      )
      .finally(() => {
        this.stopping = false;
        this.stoppingTask = null;
        if (!this.shuttingDown && cleanupComplete) {
          this.admittedTasks.openAdmission();
        }
      });
    this.stoppingTask = task;
    return task;
  }

  /** Publish every aggregate fence synchronously before process-level drain. */
  beginShutdown(): void {
    this.shuttingDown = true;
    this.channelRoutes.revokeSessionLeases();
    this.admittedTasks.closeAdmission();
    this.workflowOwner.closeAdmission();
    this.teams.interruptDissolvesForShutdown();
    this.scheduler_.stop();
    this.teams.stopSchedulers();
  }
  private async doStop(): Promise<void> {
    const failures: unknown[] = [];
    try {
      this.coreEvents.revokeSources();
      this.scheduler_.stop();
      this.teams.stopSchedulers();
      this.teams.interruptDissolvesForShutdown();
      await collectShutdownFailure(failures, () => this.workflowOwner.stopAll());
      const teamStopError = await stopTeamRuntimes({
        dispatcherId: this.id,
        teams: this.teams,
        log: this.log,
      });
      if (teamStopError !== null) failures.push(teamStopError);
      await closeDurableTeammates(
        this._teammates,
        'Dispatcher stopped',
        failures,
      );
      await collectShutdownFailure(failures, async () => {
        await this.inputSources.agent?.close({ note: 'Dispatcher stopped' });
      });
      // Channel/session close and accepted start/work drains may themselves
      // wait on an entity Turn. Close canonical entities first so those waits
      // can converge, then drain and repeat the idempotent canonical sweep for
      // any publication that was already admitted before the fences.
      await collectShutdownFailure(failures, () =>
        this.channels.closeAll(this.log));
      await collectShutdownFailure(failures, () =>
        this.inputSources.closePreparedChannels());
      this.channels.clear();
      await collectShutdownFailure(failures, () =>
        this.inputSources.waitForSettledStart());
      await collectShutdownFailure(failures, () =>
        this.collaborationSpaces.drainLifecycleTasks());
      await collectShutdownFailure(failures, () => this.admittedTasks.drain());
      await collectShutdownFailure(failures, () => this.workflowOwner.stopAll());
      const lateTeamStopError = await stopTeamRuntimes({
        dispatcherId: this.id,
        teams: this.teams,
        log: this.log,
      });
      if (lateTeamStopError !== null) failures.push(lateTeamStopError);
      await closeDurableTeammates(
        this._teammates,
        'Dispatcher stopped',
        failures,
      );
      await collectShutdownFailure(failures, async () => {
        await this.inputSources.agent?.close({ note: 'Dispatcher stopped' });
      });
      this.inputSources.markStopped();
      if (failures.length > 0) {
        for (const failure of failures) {
          this.log.error(
            { dispatcher_id: this.id, err: errorInfo(failure) },
            'error stopping dispatcher resource',
          );
        }
      }
    } finally {
      this.inputSources.markStopped();
    }
    throwShutdownFailures(
      failures,
      `multiple resources in dispatcher ${JSON.stringify(this.id)} failed to stop`,
    );
  }

  runtimeStatus(): DispatcherRuntimeStatus {
    return dispatcherRuntimeStatus(this.inputSources.agent);
  }

  liveRuntimeStatus(): LiveDispatcherRuntimeStatus | null {
    return liveDispatcherRuntimeStatus(this.inputSources.agent);
  }

  setRestartIntent(consumer: RestartIntentConsumer | null): void {
    this.restartIntent = consumer;
  }

  summary(row: DispatcherRow): DispatcherSummary {
    return dispatcherSummary(row, this.inputSources.agent);
  }

  async shutdown(): Promise<void> {
    this.beginShutdown();
    await this.stop();
  }

  private assertNotShuttingDown(): void {
    if (this.shuttingDown || this.stopping) {
      throw new Error(`dispatcher '${this.id}' is shutting down`);
    }
  }

  channelMcpServerDescriptorsForCaller(
    scope: ChannelMcpCallerScope,
  ): AgentRuntimeMcpServer[] {
    return this.channels.channelMcpServerDescriptorsForCaller(scope);
  }

  async invokeChannelTool(
    input: Parameters<TeamChannelCoordinator['invokeChannelTool']>[0],
  ): Promise<unknown> {
    return this.admitOperation(() => this.teamChannels.invokeChannelTool(input));
  }

  workspace(): Promise<string> {
    return this._teammates.dispatcherWorkspace();
  }

  get teammates(): TeammateOps {
    return this.teammateOps;
  }

  get workflows() {
    return this.workflowOwner.ops;
  }

  team(teamId: string): Promise<TeamLeaderHandle> {
    return this.admitOperation(async () =>
      teamLeaderHandle({
        lease: await this.teams.teamLeaderReadLease(teamId),
        withMutationService: (lease, task) =>
          this.admitOperation(() => this.teams.withTeamLeaderLease(lease, task)),
        withReadService: (lease, task) =>
          this.teams.withTeamLeaderReadLease(lease, task),
      }),
    );
  }

  teamScheduler(teamId: string) {
    return this.admitOperation(() => this.teams.scheduler(teamId));
  }

  createTeam(input: TeamCreateInput) {
    return this.admitOperation(() => this.teams.createFromPrefix(input));
  }

  sendTeamLeader(input: {
    teamId: string;
    prompt: string;
    intent?: string;
  }): Promise<TeamLeaderSendResult> {
    return this.admitOperation(() =>
      this.teams.sendToLeader(input.teamId, {
        prompt: input.prompt,
        ...(input.intent !== undefined ? { intent: input.intent } : {}),
        initiator: this.mustAgent(),
      }),
    );
  }

  listTeams() {
    return this.teams.list();
  }

  async getTeamStatus(teamId: string) {
    return this.admitOperation(async () => (await this.teams.get(teamId)).status());
  }

  getTeamHistory(input: TeamHistoryQuery) {
    return this.teams.history(input);
  }

  bindCollaborationSpace(input: CollaborationSpaceBindInput) {
    return this.admitOperation(() => this.collaborationSpaces.bind(input));
  }

  dissolveCollaborationSpace(input: CollaborationSpaceDissolveInput) {
    return this.admitOperation(() => this.collaborationSpaces.dissolve(input));
  }

  getCollaborationSpaceStatus(input: CollaborationSpaceStatusInput) {
    return this.collaborationSpaces.status(input);
  }

  listCollaborationSpaces() {
    return this.collaborationSpaces.list();
  }

  activeTeamBindingSummary(owner: ChannelRouteOwner) {
    return this.channels.activeBindingSummaryForOwner(owner);
  }
  activeTeamBindingSummaries(owner: ChannelRouteOwner) {
    return this.channels.activeBindingSummariesForOwner(owner);
  }

  async dissolveTeam(input: TeamDissolveInput) {
    const publicMethodEnteredAt = Date.now();
    return this.admitOperation(() => this.teamChannels.dissolve(input, publicMethodEnteredAt));
  }

  async dissolveTeamForLeader(input: {
    lease: TeamLeaderLease;
    note: string;
  }) {
    return this.admitOperation(() =>
      this.teamChannels.dissolveForTeamLeader(input),
    );
  }

  async bindTeamChannel(input: Parameters<TeamChannelCoordinator['bind']>[0]) {
    return this.admitOperation(() => this.teamChannels.bind(input));
  }

  async bindTeamLeaderChannel(input: Parameters<TeamChannelCoordinator['bindForTeamLeader']>[0]) {
    return this.admitOperation(() => this.teamChannels.bindForTeamLeader(input));
  }

  async transferTeamChannelBack(input: {
    expectedOwner?: ChannelRouteOwner;
    channelId?: string;
    meta: Record<string, unknown>;
  }) {
    return this.admitOperation(() => this.teamChannels.transferBack(input));
  }

  async transferTeamLeaderChannelBack(input: {
    lease: TeamLeaderLease;
    channelId?: string;
    meta: Record<string, unknown>;
  }) {
    return this.admitOperation(() =>
      this.teamChannels.transferBackForTeamLeader(input),
    );
  }

  routeChannelInput(
    channelId: string,
    input: InboundTurnInput,
    envelope: ChannelInboundEnvelope,
  ): Promise<InboundDeliveryResult> {
    return this.channelRoutes.route(channelId, input, envelope);
  }

  admitOperation<T>(task: () => Promise<T>): Promise<T> {
    return this.admittedTasks.run(async () => {
      this.assertNotShuttingDown();
      return task();
    });
  }

  /** Resolve send-initiated completion delivery from the producer topology. */
  async initiatorFor(
    producer: AgentEntityIdentity,
  ): Promise<CompletionInitiator | null> {
    if (producer.role === 'team_member' && producer.team_id !== null) {
      return this.teams.completionInitiatorForLeader(producer.team_id);
    }
    return this.mustAgent();
  }

  private mustAgent(): TeammateService {
    const agent = this.inputSources.agent;
    if (agent === null) {
      throw new Error(`dispatcher '${this.id}' agent is not prepared`);
    }
    return agent;
  }
}

async function closeDurableTeammates(
  teammates: TeammateCollection,
  note: string,
  failures: unknown[],
): Promise<void> {
  await collectShutdownFailure(failures, async () => {
    await teammates.materializeNonClosedEntities();
  });
  for (const teammate of teammates.materializedEntities()) {
    await collectShutdownFailure(failures, async () => {
      await teammate.close({ note });
    });
  }
}
