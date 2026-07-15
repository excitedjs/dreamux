import type {
  AgentRuntimeMcpServer,
  AgentRuntimeTurnResult,
  ChannelInboundEnvelope,
  ChannelSession,
  ChannelTaskTerminalResult,
  DreamuxLogger,
  InboundTurnInput,
} from '@excitedjs/dreamux-types';

import type { AgentRuntimeProviderCatalog } from '../../agent-runtime/index.js';
import type { ChannelProviderCatalog } from '../../channel/catalog.js';
import type { DreamuxConfig } from '../../config/config.js';
import type { RestartIntentConsumer } from '../../daemon/restart-intent.js';
import { adminSocketPath as defaultAdminSocketPath, dispatcherCronJobsPath } from '../../platform/paths.js';
import type { DispatcherRow, DispatcherStore } from '../../state/dispatcher-store.js';
import { createDispatcherAgent } from './agent.js';
import { handleCollaborationTargetLifecycle, routeTeamOrCollaborationChannelInput } from './collaboration-routing.js';
import { dispatcherMcpServerDescriptors } from './mcp-descriptors.js';
import type { ChannelMcpCallerScope } from '../channel-service/mcp-descriptors.js';
import { ensureDispatcherRootIdentity } from './identity.js';
import { assertRunnableChannelShape } from './runnable-channel.js';
import {
  configuredDispatcherAgentRuntime,
  dispatcherRuntimeStatus,
  dispatcherSummary,
  liveDispatcherRuntimeStatus,
  requiredDispatcherRuntime,
  type DispatcherRuntimeStatus,
  type DispatcherSummary,
  type LiveDispatcherRuntimeStatus,
} from './runtime-views.js';
import { asInboundDeliveryResult, closeAllBuilt } from './runtime-helpers.js';
import { startChannelSessions } from './channel-session-start.js';
import { DispatcherTaskDrain } from './inbound-task-drain.js';
import { stopDispatcherResources } from './stop-resources.js';
import { TeamChannelCoordinator } from './team-channel-coordinator.js';
import { admittedTeammateOps } from './teammate-ops.js';
import {
  teamLeaderHandle,
  type TeamLeaderHandle,
} from './team-leader-handle.js';
import { injectRestartNoticeIfNeeded } from './restart-notice.js';
import {
  invokeDispatcherChannelTool,
  type ChannelToolCaller,
} from './channel-tool-invocation.js';
import { ensureDispatcherWorkspace } from '../dispatcher-workspace.js';
import { collectShutdownFailure, throwShutdownFailures } from '../shutdown-errors.js';
import { CompletionRouter, type CompletionInitiator } from '../completion-router/index.js';
import { TeammateCollection } from '../teammate-collection/index.js';
import type { TeammateOps } from '../teammate-collection/types.js';
import { AgentIdentityStore } from '../agent-entity/identity-store.js';
import { AgentTurnsStore } from '../agent-entity/turns-store.js';
import type { TeammateService } from '../teammate-service/index.js';
import { WorktreeManager } from '../worktree/manager.js';
import type { AgentEntityIdentity } from '../agent-entity/types.js';
import { TeamCollection } from '../team-collection/index.js';
import { SchedulerService, type SchedulerCommands } from '../scheduler/service.js';
import { CronJobStore } from '../scheduler/store.js';
import { ChannelService, type ChannelRouteOwner } from '../channel-service/index.js';
import { CollaborationSpaceService } from '../collaboration-space/index.js';
import { TaskChannelHostCollection } from '../channel-task-host/index.js';
import { taskAttemptMcpServerDescriptor } from '../channel-task-host/mcp-config.js';
import type {
  CollaborationSpaceBindInput,
  CollaborationSpaceDissolveInput,
  CollaborationSpaceStatusInput,
} from '../collaboration-space/types.js';
import type {
  TeamCreateInput,
  TeamDissolveInput,
  TeamHistoryQuery,
  TeamLeaderSendResult,
} from '../team-collection/types.js';
import type { TaskOperationInvocation } from '../task-runtime-submission.js';

export interface DispatcherServiceOptions {
  id: string;
  config: DreamuxConfig;
  dispatchers: DispatcherStore;
  agentRuntimeProviders: AgentRuntimeProviderCatalog;
  channelProviders: ChannelProviderCatalog;
  adminSocketPath?: string;
  channelLoggerFactory: (dispatcherId: string) => DreamuxLogger;
  log: DreamuxLogger;
}

export type {
  ChannelToolCaller,
  DispatcherRuntimeStatus,
  DispatcherSummary,
  TeamLeaderHandle,
};

export class DispatcherService {
  readonly id: string;
  private readonly config: DreamuxConfig;
  private readonly dispatchers: DispatcherStore;
  private readonly channelProviders: ChannelProviderCatalog;
  private readonly log: DreamuxLogger;
  private readonly router: CompletionRouter;
  private readonly _teammates: TeammateCollection;
  private readonly teams: TeamCollection;
  private readonly channels: ChannelService;
  private readonly collaborationSpaces: CollaborationSpaceService;
  private taskHosts: TaskChannelHostCollection | null = null;
  private readonly teamChannels: TeamChannelCoordinator;
  private agent: TeammateService | null = null;
  private readonly scheduler_: SchedulerService;
  private readonly identities: AgentIdentityStore;
  private readonly turnsStore: AgentTurnsStore;
  private readonly agentRuntimeProviders: AgentRuntimeProviderCatalog;
  private readonly adminSocket: string;
  private restartIntent: RestartIntentConsumer | null = null;
  private starting: Promise<void> | null = null;
  private preparing: Promise<void> | null = null;
  private inputSourcesStarting: Promise<void> | null = null;
  private preparedChannels: Map<string, ChannelSession> | null = null;
  private inputSourcesStarted = false;
  private workspaceCwd: string | null = null;
  private stopping = false;
  private stoppingTask: Promise<void> | null = null;
  private shuttingDown = false;
  private readonly admittedTasks: DispatcherTaskDrain;
  private readonly teammateOps: TeammateOps;

  constructor(opts: DispatcherServiceOptions) {
    this.id = opts.id;
    this.admittedTasks = new DispatcherTaskDrain(
      () => `dispatcher '${this.id}' is shutting down`,
    );
    this.config = opts.config;
    this.dispatchers = opts.dispatchers;
    this.channelProviders = opts.channelProviders;
    this.log = opts.log;
    const adminSocket = opts.adminSocketPath ?? defaultAdminSocketPath();
    this.agentRuntimeProviders = opts.agentRuntimeProviders;
    this.adminSocket = adminSocket;

    this.router = new CompletionRouter({ dispatcherId: opts.id, log: opts.log });

    const worktrees = new WorktreeManager();

    const identities = new AgentIdentityStore(opts.log);
    const turnsStore = new AgentTurnsStore(opts.log);
    this.identities = identities;
    this.turnsStore = turnsStore;

    this.channels = new ChannelService({
      dispatcherId: opts.id,
      config: opts.config,
      channelProviders: opts.channelProviders,
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
      getRuntime: () => this.agent?.getRuntime() ?? null,
      submitScheduled: (input) => this.mustAgent().scheduledInput(input),
      log: opts.log,
    });

    this._teammates = new TeammateCollection({
      dispatcherId: opts.id,
      teamScope: null,
      config: opts.config,
      agentRuntimeProviders: opts.agentRuntimeProviders,
      worktrees,
      identities,
      turnsStore,
      router: this.router,
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
      turnsStore,
      router: this.router,
      initiatorFor: (producer) => this.initiatorFor(producer),
      isShuttingDown: () => this.shuttingDown || this.stopping,
      admitOperation: (task) => this.admitOperation(task),
      adminSocketPath: adminSocket,
      leaderChannelDescriptors: ({ teamId, leaderName }) =>
        [
          ...this.channelMcpServerDescriptorsForCaller({
            callerKind: 'team_leader',
            team_id: teamId,
            leader_name: leaderName,
          }),
          ...(this.taskHosts?.hasTeam(teamId) === true
            ? [taskAttemptMcpServerDescriptor({
                dispatcherId: this.id,
                teamId,
                leaderName,
                adminSocketPath: this.adminSocket,
              })]
            : []),
        ],
      taskSubmissionBridgeFor: (teamId) =>
        this.taskHosts?.submissionBridgeForTeam(teamId) ?? null,
      log: opts.log,
    });

    this.collaborationSpaces = new CollaborationSpaceService({
      dispatcherId: opts.id,
      config: opts.config,
      teams: this.teams,
      channels: this.channels,
      log: opts.log,
      isShuttingDown: () => this.shuttingDown || this.stopping,
    });
    this.teamChannels = new TeamChannelCoordinator({
      teams: this.teams,
      channels: this.channels,
      collaborationSpaces: this.collaborationSpaces,
    });
  }

  get scheduler(): SchedulerCommands {
    return this.scheduler_.commands;
  }

  async start(): Promise<void> {
    return this.startInputSources();
  }

  async prepareChannels(): Promise<void> {
    this.assertNotShuttingDown();
    if (this.preparedChannels !== null || this.inputSourcesStarted) return;
    if (this.preparing !== null) return this.preparing;
    const promise = this.doPrepareChannels().finally(() => {
      this.preparing = null;
    });
    this.preparing = promise;
    return promise;
  }

  private async doPrepareChannels(): Promise<void> {
    this.assertNotShuttingDown();
    const id = this.id;
    const row = this.dispatchers.get(id);
    if (row === null) throw new Error(`no dispatcher '${id}'`);
    const dispatcherConfig = this.config.dispatchers.find(
      (dispatcher) => dispatcher.id === id,
    );
    if (dispatcherConfig !== undefined) {
      assertRunnableChannelShape(dispatcherConfig, this.channelProviders);
    }
    if (dispatcherConfig === undefined) {
      throw new Error(`dispatcher '${id}' has no config entry`);
    }

    const workspaceCwd = await ensureDispatcherWorkspace(this.config, id);
    const identity = await ensureDispatcherRootIdentity({
      identities: this.identities,
      dispatcherId: id,
      agentRuntime: configuredDispatcherAgentRuntime(this.config, this.id),
      cwd: workspaceCwd,
    });
    const agent = createDispatcherAgent({
      id,
      config: this.config,
      agentRuntimeProviders: this.agentRuntimeProviders,
      identities: this.identities,
      turnsStore: this.turnsStore,
      router: this.router,
      log: this.log,
      mcpServers: dispatcherMcpServerDescriptors({
        dispatcherId: id,
        channels: this.channels.configuredChannels(),
        channelProviders: this.channelProviders,
        adminSocketPath: this.adminSocket,
      }),
      identity,
    });

    const channels = await this.channels.build();
    try {
      this.assertNotShuttingDown();
      if (this.taskHosts === null) {
        this.taskHosts = await TaskChannelHostCollection.open({
          dispatcherId: this.id,
          config: this.config,
          channels: this.channels,
          collaborationSpaces: this.collaborationSpaces,
          teams: this.teams,
          agentRuntimeProviders: this.agentRuntimeProviders,
          log: this.log,
          isShuttingDown: () => this.shuttingDown || this.stopping,
        });
      }
      await this.taskHosts.recover();
      this.assertNotShuttingDown();
      this.workspaceCwd = workspaceCwd;
      this.agent = agent;
      this.preparedChannels = channels;
    } catch (err) {
      await closeAllBuilt(channels);
      throw err;
    }
  }

  private async startAgentRuntime(): Promise<void> {
    if (this.mustAgent().getRuntime() !== null) return;
    if (this.starting !== null) return this.starting;
    const promise = this.doStartAgentRuntime().finally(() => {
      this.starting = null;
    });
    this.starting = promise;
    return promise;
  }

  private async doStartAgentRuntime(): Promise<void> {
    await this.mustAgent().ensureStarted();
    await injectRestartNoticeIfNeeded({
      dispatcherId: this.id,
      runtime: requiredDispatcherRuntime(this.agent, this.id),
      restartIntent: this.restartIntent,
      now: Date.now(),
      log: this.log,
    });
  }

  async startInputSources(): Promise<void> {
    this.assertNotShuttingDown();
    if (this.inputSourcesStarted) return;
    if (this.inputSourcesStarting !== null) return this.inputSourcesStarting;
    const promise = this.doStartInputSources().finally(() => {
      this.inputSourcesStarting = null;
    });
    this.inputSourcesStarting = promise;
    return promise;
  }

  private async doStartInputSources(): Promise<void> {
    this.assertNotShuttingDown();
    await this.prepareChannels();
    this.assertNotShuttingDown();
    const channels = this.preparedChannels ?? new Map<string, ChannelSession>();
    try {
      if (this.shouldStartRuntimeForResumeNotice()) {
        await this.startAgentRuntime();
      }
      this.assertNotShuttingDown();
      await startChannelSessions({
        sessions: channels,
        taskHosts: this.mustTaskHosts(),
        deliver: async (channelId, turn, envelope) =>
          asInboundDeliveryResult(
            await this.routeChannelInput(channelId, turn, envelope),
          ),
        targetLifecycle: (channelId, event) =>
          handleCollaborationTargetLifecycle({
            dispatcherId: this.id,
            dispatcherAgentRuntime: configuredDispatcherAgentRuntime(
              this.config,
              this.id,
            ),
            channelId,
            event,
            channels: this.channels,
            collaborationSpaces: this.collaborationSpaces,
            log: this.log,
          }),
        assertReady: () => this.assertNotShuttingDown(),
        adopt: (live) => this.channels.adopt(live),
      });
      this.preparedChannels = null;
      this.assertNotShuttingDown();
      await this.scheduler_.start();
      this.assertNotShuttingDown();
      await this.teams.startSchedulers();
      this.assertNotShuttingDown();
      await this.collaborationSpaces.resumePendingTargets();
      this.assertNotShuttingDown();
      this.inputSourcesStarted = true;
    } catch (err) {
      this.scheduler_.stop();
      this.teams.stopSchedulers();
      this.taskHosts?.detachEventSinks();
      this.channels.clear();
      await closeAllBuilt(channels);
      try {
        await this.agent?.stop();
      } catch {
        /* best effort */
      }
      this.preparedChannels = null;
      this.inputSourcesStarted = false;
      throw err;
    }

    const id = this.id;
    const row = this.dispatchers.get(id);
    this.log.info(
      {
        dispatcher_id: id,
        channel_identity: row?.channel_identity ?? '',
        cwd: this.workspaceCwd,
      },
      'dispatcher ready',
    );
  }

  stop(): Promise<void> {
    if (this.stoppingTask !== null) return this.stoppingTask;
    this.stopping = true;
    this.admittedTasks.closeAdmission();
    const task = this.doStop().finally(() => {
      this.stopping = false;
      this.stoppingTask = null;
      if (!this.shuttingDown) this.admittedTasks.openAdmission();
    });
    this.stoppingTask = task;
    return task;
  }

  private async doStop(): Promise<void> {
    try {
      await stopDispatcherResources({
        dispatcherId: this.id,
        preparing: this.preparing,
        inputSourcesStarting: this.inputSourcesStarting,
        taskHosts: this.taskHosts,
        scheduler: this.scheduler_,
        teams: this.teams,
        admittedTasks: this.admittedTasks,
        collaborationSpaces: this.collaborationSpaces,
        channels: this.channels,
        preparedChannels: this.preparedChannels,
        agent: this.agent,
        log: this.log,
      });
    } finally {
      this.preparedChannels = null;
      this.inputSourcesStarted = false;
    }
  }

  runtimeStatus(): DispatcherRuntimeStatus {
    return dispatcherRuntimeStatus(this.agent);
  }

  liveRuntimeStatus(): LiveDispatcherRuntimeStatus {
    return liveDispatcherRuntimeStatus(this.agent);
  }

  setRestartIntent(consumer: RestartIntentConsumer | null): void {
    this.restartIntent = consumer;
  }

  private shouldStartRuntimeForResumeNotice(): boolean {
    const identity = this.agent?.current() ?? null;
    return (
      identity !== null &&
      identity.session_id !== null &&
      this.restartIntent?.hasTarget(this.id, Date.now()) === true
    );
  }

  summary(row: DispatcherRow): DispatcherSummary {
    return dispatcherSummary(row, this.agent);
  }

  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    this.admittedTasks.closeAdmission();
    const failures: unknown[] = [];
    await collectShutdownFailure(failures, () => this.stop());
    await collectShutdownFailure(failures, () => this._teammates.stopAll());
    await collectShutdownFailure(failures, () => this.teams.stopAll());
    this.taskHosts?.close();
    this.taskHosts = null;
    throwShutdownFailures(
      failures,
      `multiple resources in dispatcher ${JSON.stringify(this.id)} failed to shut down`,
    );
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

  async invokeChannelTool(input: {
    providerRef?: string;
    channelId?: string;
    name: string;
    arguments: Record<string, unknown>;
    caller: ChannelToolCaller;
  }): Promise<unknown> {
    return invokeDispatcherChannelTool({ channels: this.channels, ...input });
  }

  workspace(): Promise<string> { return this._teammates.dispatcherWorkspace(); }

  get teammates(): TeammateOps {
    return this.teammateOps;
  }

  async team(teamId: string): Promise<TeamLeaderHandle> {
    await this.ensureTaskOwnershipLoaded();
    return this.admitOperation(async () =>
      teamLeaderHandle({
        lease: await this.teams.teamLeaderLease(teamId),
        withService: (lease, task) =>
          this.admitOperation(() => this.teams.withTeamLeaderLease(lease, task)),
      }),
    );
  }

  async teamScheduler(teamId: string) {
    await this.ensureTaskOwnershipLoaded();
    return this.admitOperation(() => this.teams.scheduler(teamId));
  }
  async createTeam(input: TeamCreateInput) {
    await this.ensureTaskOwnershipLoaded();
    return this.admitOperation(() => this.teams.create(input));
  }

  async sendTeamLeader(input: {
    teamId: string;
    prompt: string;
    intent?: string;
    taskInvocation?: TaskOperationInvocation;
  }): Promise<TeamLeaderSendResult> {
    await this.ensureTaskOwnershipLoaded();
    return this.admitOperation(() =>
      this.teams.sendToLeader(input.teamId, {
        prompt: input.prompt,
        ...(input.intent !== undefined ? { intent: input.intent } : {}),
        ...(input.taskInvocation !== undefined
          ? { taskInvocation: input.taskInvocation }
          : {}),
        initiator: this.mustAgent(),
      }),
    );
  }

  listTeams() { return this.teams.list(); }
  async getTeamStatus(teamId: string) {
    await this.ensureTaskOwnershipLoaded();
    return this.admitOperation(async () => (await this.teams.get(teamId)).status());
  }

  getTeamHistory(input: TeamHistoryQuery) { return this.teams.history(input); }

  bindCollaborationSpace(input: CollaborationSpaceBindInput) {
    return this.admitOperation(() => this.collaborationSpaces.bind(input));
  }

  async dissolveCollaborationSpace(input: CollaborationSpaceDissolveInput) {
    // Destructive collaboration operations must load and recover durable task
    // ownership first. A lazy dispatcher cannot infer absence from an unopened
    // task-host collection after a process restart.
    await this.ensureTaskOwnershipLoaded();
    return this.admitOperation(() => this.collaborationSpaces.dissolve(input, {
      assertCanDissolve: (space) => this.taskHosts?.assertSpaceCanDissolve(space),
    }));
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

  async dissolveTeam(input: TeamDissolveInput) {
    await this.ensureTaskOwnershipLoaded();
    if (this.taskHosts?.hasTeam(input.teamId) === true) {
      throw new Error(
        `Team ${JSON.stringify(input.teamId)} is owned by an active task attempt; ` +
          'finish or cancel the task attempt instead',
      );
    }
    return this.admitOperation(() => this.teamChannels.dissolve(input));
  }

  async finishTaskAttempt(input: {
    teamId: string;
    leaderName: string;
    result: ChannelTaskTerminalResult;
  }): Promise<import('@excitedjs/dreamux-types').ChannelTaskReceipt> {
    await this.ensureTaskOwnershipLoaded();
    return this.admitOperation(() =>
      this.teams.withTeamLeaderLease(
        { teamId: input.teamId, leaderName: input.leaderName },
        () => this.mustTaskHosts().finishForTeam(input),
      ),
    );
  }

  async bindTeamChannel(input: {
    teamId: string;
    channelId?: string;
    meta: Record<string, unknown>;
  }) {
    await this.ensureTaskOwnershipLoaded();
    return this.admitOperation(() => this.teamChannels.bind(input));
  }

  async transferTeamChannelBack(input: {
    expectedOwner?: ChannelRouteOwner;
    channelId?: string;
    meta: Record<string, unknown>;
  }) {
    return this.admitOperation(() => this.teamChannels.transferBack(input));
  }

  routeChannelInput(
    channelId: string,
    input: InboundTurnInput,
    envelope: ChannelInboundEnvelope,
  ): Promise<AgentRuntimeTurnResult> {
    return this.admitOperation(() =>
      routeTeamOrCollaborationChannelInput({
        channelId,
        dispatcherAgentRuntime: configuredDispatcherAgentRuntime(this.config, this.id),
        turn: input,
        envelope,
        channels: this.channels,
        teams: this.teams,
        collaborationSpaces: this.collaborationSpaces,
        fallback: (turn) => this.mustAgent().channelInput(turn),
      }),
    );
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
      const team = await this.teams.get(producer.team_id).catch(() => null);
      return team?.leader ?? this.mustAgent();
    }
    return this.mustAgent();
  }

  private mustTaskHosts(): TaskChannelHostCollection {
    const hosts = this.taskHosts;
    if (hosts === null) {
      throw new Error(`dispatcher '${this.id}' task channel host is not prepared`);
    }
    return hosts;
  }

  private async ensureTaskOwnershipLoaded(): Promise<void> {
    if (this.taskHosts === null) await this.prepareChannels();
  }

  private mustAgent(): TeammateService {
    const agent = this.agent;
    if (agent === null) {
      throw new Error(`dispatcher '${this.id}' agent is not prepared`);
    }
    return agent;
  }

}
