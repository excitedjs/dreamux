import type {
  AgentRuntime,
  AgentRuntimeMcpServer,
  AgentRuntimeTurnResult,
  ChannelInboundEnvelope,
  ChannelSession,
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
import { handleCollaborationTargetLifecycle } from './collaboration-routing.js';
import { dispatcherMcpServerDescriptors } from './mcp-descriptors.js';
import type { ChannelMcpCallerScope } from '../channel-service/mcp-descriptors.js';
import { ensureDispatcherRootIdentity } from './identity.js';
import { assertRunnableChannelShape } from './runnable-channel.js';
import { asInboundDeliveryResult, closeAllBuilt, errInfo } from './runtime-helpers.js';
import { DispatcherScopedChannelRouting } from './scoped-channel-routing.js';
import { DispatcherTaskDrain } from './inbound-task-drain.js';
import { rollbackFailedInputSourceStart } from './input-source-start-rollback.js';
import { TeamChannelCoordinator } from './team-channel-coordinator.js';
import { stopTeamRuntimes } from './team-runtime-stop.js';
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
import {
  collectShutdownFailure,
  throwShutdownFailures,
} from '../shutdown-errors.js';
import { CompletionRouter, type CompletionInitiator } from '../completion-router/index.js';
import { TeammateCollection, type TeammateOps } from '../teammate-collection/index.js';
import { AgentIdentityStore } from '../agent-entity/identity-store.js';
import { AgentTurnsStore } from '../agent-entity/turns-store.js';
import type { TeammateService } from '../teammate-service/index.js';
import { WorktreeManager } from '../worktree/manager.js';
import {
  runtimeStatusToIdentityStatus,
  type AgentEntityIdentity,
} from '../agent-entity/types.js';
import { TeamCollection } from '../team-collection/index.js';
import { SchedulerService, type SchedulerCommands } from '../scheduler/service.js';
import { CronJobStore } from '../scheduler/store.js';
import { ChannelService, type ChannelRouteOwner } from '../channel-service/index.js';
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
  TeamLeaderSendResult,
} from '../team-collection/types.js';
import type {
  DispatcherRuntimeStatus,
  DispatcherServiceOptions,
  DispatcherSummary,
  LiveDispatcherRuntimeStatus,
} from './types.js';

export type { ChannelToolCaller, TeamLeaderHandle };

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
  private readonly coreEvents: DispatcherCoreEventBus;
  private readonly teamChannels: TeamChannelCoordinator;
  private readonly channelRoutes: DispatcherScopedChannelRouting;
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
    const turnsStore = new AgentTurnsStore(opts.log, this.coreEvents.publisher);
    this.identities = identities;
    this.turnsStore = turnsStore;

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
        ],
      log: opts.log,
      coreEvents: this.coreEvents.publisher,
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
      dispatcherAgentRuntime: () => this.dispatcherAgentRuntime(),
      channels: this.channels,
      teams: this.teams,
      collaborationSpaces: this.collaborationSpaces,
      log: this.log,
      admit: (task) => this.admitOperation(task),
      fallback: (turn) => this.mustAgent().channelInput(turn),
      isUnavailable: () => this.shuttingDown || this.stopping,
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
      agentRuntime: this.dispatcherAgentRuntime(),
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
      runtime: this.mustRuntime(),
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
    const liveChannels = new Map<string, ChannelSession>();
    try {
      if (this.shouldStartRuntimeForResumeNotice()) {
        await this.startAgentRuntime();
      }
      this.assertNotShuttingDown();
      await this.collaborationSpaces.resumePendingTargets();
      this.assertNotShuttingDown();
      for (const [channelId, session] of channels) {
        const coreEvents = this.coreEvents.createSource(channelId);
        const strictRoutes = this.channelRoutes.createSessionLease(channelId);
        await session.start({
          deliver: async (turn, envelope) =>
            asInboundDeliveryResult(
              await this.channelRoutes.route(channelId, turn, envelope),
            ),
          targetLifecycle: (event) =>
            handleCollaborationTargetLifecycle({
              dispatcherId: this.id,
              dispatcherAgentRuntime: this.dispatcherAgentRuntime(),
              channelId,
              event,
              channels: this.channels,
              collaborationSpaces: this.collaborationSpaces,
              log: this.log,
            }),
          coreEvents: coreEvents.source,
          ensureCollaborationTarget: strictRoutes.ensure,
          deliverExact: strictRoutes.deliverExact,
        });
        this.assertNotShuttingDown();
        liveChannels.set(channelId, session);
        this.channels.adopt(liveChannels);
      }
      if (channels.size === 0) this.channels.adopt(liveChannels);
      this.preparedChannels = null;
      this.assertNotShuttingDown();
      await this.scheduler_.start();
      this.assertNotShuttingDown();
      await this.teams.startSchedulers();
      this.assertNotShuttingDown();
      this.inputSourcesStarted = true;
    } catch (err) {
      this.channelRoutes.revokeSessionLeases();
      this.admittedTasks.closeAdmission();
      await rollbackFailedInputSourceStart({
        dispatcherId: this.id,
        sessions: channels,
        channels: this.channels,
        coreEvents: this.coreEvents,
        scheduler: this.scheduler_,
        teams: this.teams,
        admittedTasks: this.admittedTasks,
        collaborationSpaces: this.collaborationSpaces,
        agent: this.agent,
        log: this.log,
      });
      this.preparedChannels = null;
      this.inputSourcesStarted = false;
      if (!this.shuttingDown && !this.stopping) this.admittedTasks.openAdmission();
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
    this.channelRoutes.revokeSessionLeases();
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
    const failures: unknown[] = [];
    try {
      if (this.preparing !== null) await this.preparing.catch(() => {});
      if (this.inputSourcesStarting !== null) await this.inputSourcesStarting.catch(() => {});
      this.coreEvents.revokeSources();
      await this.channels.closeAll(this.log);
      if (this.preparedChannels !== null) {
        await closeAllBuilt(this.preparedChannels);
        this.preparedChannels = null;
      }
      this.channels.clear();
      this.scheduler_.stop();
      this.teams.stopSchedulers();
      await this.admittedTasks.drain();
      await this.collaborationSpaces.drainLifecycleTasks();
      this.scheduler_.stop();
      this.teams.stopSchedulers();
      const teamStopError = await stopTeamRuntimes({
        dispatcherId: this.id,
        teams: this.teams,
        log: this.log,
      });
      if (teamStopError !== null) failures.push(teamStopError);
      this.inputSourcesStarted = false;
      await collectShutdownFailure(failures, async () => {
        await this.agent?.stop();
      });
      if (failures.length > 0) {
        for (const failure of failures) {
          this.log.error(
            { dispatcher_id: this.id, err: errInfo(failure) },
            'error stopping dispatcher resource',
          );
        }
      }
    } finally {
      this.inputSourcesStarted = false;
    }
    throwShutdownFailures(
      failures,
      `multiple resources in dispatcher ${JSON.stringify(this.id)} failed to stop`,
    );
  }

  runtimeStatus(): DispatcherRuntimeStatus {
    const agent = this.agent;
    const runtime = agent?.getRuntime() ?? null;
    const identity = agent?.current() ?? null;
    return {
      status: runtime?.getStatus() ?? null,
      threadId: runtime?.getCheckpoint()?.id ?? identity?.session_id ?? null,
      lastError: identity?.last_error ?? null,
    };
  }

  liveRuntimeStatus(): LiveDispatcherRuntimeStatus | null {
    const agent = this.agent;
    const runtime = agent?.getRuntime() ?? null;
    if (runtime === null) return null;
    const identity = agent?.current() ?? null;
    return {
      status: runtime.getStatus(),
      threadId: runtime.getCheckpoint()?.id ?? identity?.session_id ?? null,
      lastError: identity?.last_error ?? null,
    };
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
    const agent = this.agent;
    const runtime = agent?.getRuntime() ?? null;
    const identity = agent?.current() ?? null;
    return {
      dispatcher_id: row.dispatcher_id,
      channel_identity: row.channel_identity,
      status: runtime !== null
        ? runtimeStatusToIdentityStatus(runtime.getStatus())
        : (identity?.status ?? 'stopped'),
      thread_id: runtime?.getCheckpoint()?.id ?? identity?.session_id ?? null,
      enabled: row.enabled === 1,
    };
  }

  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    this.admittedTasks.closeAdmission();
    const failures: unknown[] = [];
    await collectShutdownFailure(failures, () => this.stop());
    await collectShutdownFailure(failures, () => this._teammates.stopAll());
    await collectShutdownFailure(failures, () => this.teams.stopAll());
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

  team(teamId: string): Promise<TeamLeaderHandle> {
    return this.admitOperation(async () =>
      teamLeaderHandle({
        lease: await this.teams.teamLeaderLease(teamId),
        withService: (lease, task) =>
          this.admitOperation(() => this.teams.withTeamLeaderLease(lease, task)),
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

  listTeams() { return this.teams.list(); }

  async getTeamStatus(teamId: string) {
    return this.admitOperation(async () => (await this.teams.get(teamId)).status());
  }

  getTeamHistory(input: TeamHistoryQuery) { return this.teams.history(input); }

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

  async dissolveTeam(input: TeamDissolveInput) {
    return this.admitOperation(() => this.teamChannels.dissolve(input));
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

  routeChannelInput(
    channelId: string,
    input: InboundTurnInput,
    envelope: ChannelInboundEnvelope,
  ): Promise<AgentRuntimeTurnResult> {
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
      const team = await this.teams.get(producer.team_id).catch(() => null);
      return team?.leader ?? this.mustAgent();
    }
    return this.mustAgent();
  }

  private mustRuntime(): AgentRuntime {
    const runtime = this.mustAgent().getRuntime();
    if (runtime === null) {
      throw new Error(`dispatcher '${this.id}' agent runtime is not running`);
    }
    return runtime;
  }

  private mustAgent(): TeammateService {
    const agent = this.agent;
    if (agent === null) {
      throw new Error(`dispatcher '${this.id}' agent is not prepared`);
    }
    return agent;
  }

  private dispatcherAgentRuntime(): string {
    const dispatcherConfig = this.config.dispatchers.find(
      (dispatcher) => dispatcher.id === this.id,
    );
    if (dispatcherConfig === undefined) {
      throw new Error(`dispatcher '${this.id}' has no config entry`);
    }
    return dispatcherConfig.agentRuntime;
  }
}
