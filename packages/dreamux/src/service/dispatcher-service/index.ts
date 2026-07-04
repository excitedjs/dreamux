import type {
  AgentRuntime,
  AgentRuntimeMcpServer,
  AgentRuntimeStatus,
  AgentRuntimeTurnResult,
  ChannelInboundEnvelope,
  ChannelSession,
  DreamuxLogger,
  InboundDeliveryResult,
  InboundTurnInput,
} from '@excitedjs/dreamux-types';

import type { AgentRuntimeProviderCatalog } from '../../agent-runtime/index.js';
import type { ChannelProviderCatalog } from '../../channel/catalog.js';
import type { SubscribeChannelProviderCatalog } from '../../subscribe-channel/catalog.js';
import type { DreamuxConfig } from '../../config/config.js';
import type { RestartIntentConsumer } from '../../daemon/restart-intent.js';
import {
  adminSocketPath as defaultAdminSocketPath,
  dispatcherCronJobsPath,
} from '../../platform/paths.js';
import type {
  DispatcherRow,
  DispatcherStore,
} from '../../state/dispatcher-store.js';
import { createDispatcherAgent } from './agent.js';
import { dispatcherMcpServerDescriptors } from './mcp-descriptors.js';
import { subscribeChannelMcpServerDescriptors } from '../../subscribe-channel/mcp-descriptors.js';
import type { ChannelMcpCallerScope } from './mcp-descriptors.js';
import { ensureDispatcherIdentity as ensureDispatcherRootIdentity } from './identity.js';
import { assertRunnableChannelShape } from './runnable-channel.js';
import { ensureDispatcherWorkspace } from '../dispatcher-workspace.js';
import { CompletionRouter, type CompletionInitiator } from '../completion-router/index.js';
import { TeammateCollection, type TeammateOps } from '../teammate-collection/index.js';
import { AgentIdentityStore } from '../agent-entity/identity-store.js';
import { AgentTurnsStore } from '../agent-entity/turns-store.js';
import type { TeammateService } from '../teammate-service/index.js';
import { WorktreeManager } from '../worktree/manager.js';
import {
  runtimeStatusToIdentityStatus,
  type AgentEntityIdentity,
  type AgentEntityIdentityStatus,
} from '../agent-entity/types.js';
import { TeamCollection } from '../team-collection/index.js';
import { SchedulerService } from '../scheduler/service.js';
import { CronJobStore } from '../scheduler/store.js';
import {
  ChannelService,
  type ChannelRouteOwner,
} from '../channel-service/index.js';
import type {
  TeamCreateInput,
  TeamDissolveInput,
  TeamHistoryQuery,
  TeamLeaderSendResult,
} from '../team-collection/types.js';

export interface DispatcherServiceOptions {
  id: string;
  config: DreamuxConfig;
  dispatchers: DispatcherStore;
  agentRuntimeProviders: AgentRuntimeProviderCatalog;
  channelProviders: ChannelProviderCatalog;
  subscribeChannelProviders: SubscribeChannelProviderCatalog;
  adminSocketPath?: string;
  channelLoggerFactory: (dispatcherId: string) => DreamuxLogger;
  log: DreamuxLogger;
}

export interface DispatcherSummary {
  dispatcher_id: string;
  channel_identity: string;
  status: AgentEntityIdentityStatus;
  thread_id: string | null;
  enabled: boolean;
}

export interface DispatcherRuntimeStatus {
  status: string | null;
  threadId: string | null;
  lastError: string | null;
}

interface LiveDispatcherRuntimeStatus {
  status: AgentRuntimeStatus;
  threadId: string | null;
  lastError: string | null;
}

export type ChannelToolCaller =
  | { kind: 'dispatcher' }
  | { kind: 'team_leader'; teamId: string; leaderName: string };

export class DispatcherService {
  readonly id: string;
  private readonly config: DreamuxConfig;
  private readonly dispatchers: DispatcherStore;
  private readonly channelProviders: ChannelProviderCatalog;
  private readonly subscribeChannelProviders: SubscribeChannelProviderCatalog;
  private readonly log: DreamuxLogger;
  private readonly router: CompletionRouter;
  private readonly _teammates: TeammateCollection;
  private readonly teams: TeamCollection;
  private readonly channels: ChannelService;
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
  private shuttingDown = false;

  constructor(opts: DispatcherServiceOptions) {
    this.id = opts.id;
    this.config = opts.config;
    this.dispatchers = opts.dispatchers;
    this.channelProviders = opts.channelProviders;
    this.subscribeChannelProviders = opts.subscribeChannelProviders;
    this.log = opts.log;
    const adminSocket = opts.adminSocketPath ?? defaultAdminSocketPath();
    this.agentRuntimeProviders = opts.agentRuntimeProviders;
    this.adminSocket = adminSocket;

    this.router = new CompletionRouter({ dispatcherId: opts.id, log: opts.log });

    const worktrees = new WorktreeManager();

    const identities = new AgentIdentityStore({
      warn: opts.log.warn.bind(opts.log),
    });
    const turnsStore = new AgentTurnsStore({
      warn: opts.log.warn.bind(opts.log),
    });
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
      isShuttingDown: () => this.shuttingDown,
      log: opts.log,
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
      isShuttingDown: () => this.shuttingDown,
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
    });
  }

  get scheduler(): SchedulerService {
    return this.scheduler_;
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
    const identity = await this.ensureDispatcherIdentity(workspaceCwd);
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
      }).concat(subscribeChannelMcpServerDescriptors({
        dispatcherId: id,
        subscriptions: this.config.subscriptions ?? [],
        subscribeChannelProviders: this.subscribeChannelProviders,
        adminSocketPath: this.adminSocket,
      })),
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
    try {
      await this.mustAgent().ensureStarted();
      await this.injectRestartNoticeIfNeeded(this.id, this.mustRuntime());
    } catch (err) {
      throw err;
    }
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
      for (const [channelId, session] of channels) {
        await session.start({
          deliver: async (turn, envelope) =>
            asInboundDeliveryResult(
              await this.routeChannelInput(channelId, turn, envelope),
            ),
        });
        this.assertNotShuttingDown();
        liveChannels.set(channelId, session);
        this.channels.adopt(liveChannels);
      }
      if (channels.size === 0) this.channels.adopt(liveChannels);
      this.preparedChannels = null;
      this.assertNotShuttingDown();
      await this.scheduler.start();
      this.assertNotShuttingDown();
      await this.teams.startSchedulers();
      this.assertNotShuttingDown();
      this.inputSourcesStarted = true;
    } catch (err) {
      this.scheduler.stop();
      this.teams.stopSchedulers();
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

  async stop(): Promise<void> {
    this.stopping = true;
    try {
      if (this.preparing !== null) {
        await this.preparing.catch(() => {});
      }
      if (this.inputSourcesStarting !== null) {
        await this.inputSourcesStarting.catch(() => {});
      }
      this.scheduler.stop();
      this.teams.stopSchedulers();
      await this.channels.closeAll(this.log);
      if (this.preparedChannels !== null) {
        await closeAllBuilt(this.preparedChannels);
        this.preparedChannels = null;
      }
      this.channels.clear();
      this.inputSourcesStarted = false;
      try {
        await this.agent?.stop();
      } catch (err) {
        this.log.error(
          { dispatcher_id: this.id, err: errInfo(err) },
          'error stopping dispatcher',
        );
      }
    } finally {
      this.stopping = false;
    }
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
    await this._teammates.stopAll();
    await this.teams.stopAll();
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

  async invokeChannelTool(input: {
    providerRef?: string;
    channelId?: string;
    name: string;
    arguments: Record<string, unknown>;
    caller: ChannelToolCaller;
  }): Promise<unknown> {
    if (input.caller.kind === 'team_leader') {
      await this.channels.authorizeTeamLeaderEgress({
        owner: {
          kind: 'team',
          teamName: input.caller.teamId,
          leaderName: input.caller.leaderName,
        },
        ...(input.channelId !== undefined ? { channelId: input.channelId } : {}),
        ...(input.providerRef !== undefined ? { providerRef: input.providerRef } : {}),
        arguments: input.arguments,
      });
    }
    return this.channels.invokeTool({
      ...(input.providerRef !== undefined ? { providerRef: input.providerRef } : {}),
      name: input.name,
      arguments: input.arguments,
      ...(input.channelId !== undefined ? { channelId: input.channelId } : {}),
    });
  }

  workspace(): Promise<string> { return this._teammates.dispatcherWorkspace(); }

  get teammates(): TeammateOps {
    return this._teammates;
  }

  team(teamId: string) { return this.teams.get(teamId); }

  teamScheduler(teamId: string) { return this.teams.scheduler(teamId); }

  createTeam(input: TeamCreateInput) { this.assertNotShuttingDown(); return this.teams.create(input); }

  sendTeamLeader(input: {
    teamId: string;
    prompt: string;
    intent?: string;
  }): Promise<TeamLeaderSendResult> {
    this.assertNotShuttingDown();
    return this.teams.sendToLeader(input.teamId, {
      prompt: input.prompt,
      ...(input.intent !== undefined ? { intent: input.intent } : {}),
      initiator: this.mustAgent(),
    });
  }

  listTeams() { return this.teams.list(); }

  async getTeamStatus(teamId: string) {
    return (await this.teams.get(teamId)).status();
  }

  getTeamHistory(input: TeamHistoryQuery) { return this.teams.history(input); }

  activeTeamBindingSummary(owner: ChannelRouteOwner) {
    return this.channels.activeBindingSummaryForOwner(owner);
  }

  async dissolveTeam(input: TeamDissolveInput) {
    const owner = await this.teams.requireOpenTeamRouteOwner(input.teamId);
    await this.channels.transferAllForOwner(owner);
    return (await this.teams.get(input.teamId)).dissolve(input);
  }

  async bindTeamChannel(input: {
    teamId: string;
    channelId?: string;
    meta: Record<string, unknown>;
  }) {
    const owner = await this.teams.requireOpenTeamRouteOwner(input.teamId);
    return this.channels.bindTarget({
      owner,
      ...(input.channelId !== undefined ? { channelId: input.channelId } : {}),
      meta: input.meta,
    });
  }

  async transferTeamChannelBack(input: {
    expectedOwner?: ChannelRouteOwner;
    channelId?: string;
    meta: Record<string, unknown>;
  }) {
    return this.channels.transferBack({
      ...(input.expectedOwner !== undefined ? { expectedOwner: input.expectedOwner } : {}),
      ...(input.channelId !== undefined ? { channelId: input.channelId } : {}),
      meta: input.meta,
    });
  }

  async routeChannelInput(
    channelId: string,
    input: InboundTurnInput,
    envelope: ChannelInboundEnvelope,
  ): Promise<AgentRuntimeTurnResult> {
    this.assertNotShuttingDown();
    const target = envelope.target;
    if (target.bindable) {
      const routed = await this.channels.resolveInboundBinding({
        channelId,
        target,
      });
      if (
        routed !== null &&
        (await this.teams.isOpenTeam(routed.owner.teamName))
      ) {
        const team = await this.teams.get(routed.owner.teamName);
        return team.deliverToLeader(input);
      }
    }
    return this.mustAgent().channelInput(input);
  }

  async initiatorFor(
    producer: AgentEntityIdentity,
  ): Promise<CompletionInitiator | null> {
    if (producer.role === 'team_member' && producer.team_id !== null) {
      const team = await this.teams.get(producer.team_id).catch(() => null);
      return team?.leader ?? this.mustAgent();
    }
    return this.mustAgent();
  }

  private async injectRestartNoticeIfNeeded(
    dispatcherId: string,
    runtime: AgentRuntime,
  ): Promise<void> {
    if (!runtime.wasCheckpointResumed()) return;
    const notice = this.restartIntent?.claim(dispatcherId, Date.now()) ?? null;
    if (notice === null) return;
    try {
      const result = await runtime.completionInput({
        text: notice,
        sourceId: `restart-notice:${dispatcherId}`,
      });
      if (result.status === 'failed') {
        this.log.warn(
          { dispatcher_id: dispatcherId, err: errInfo(result.error) },
          'restart notice injection failed',
        );
      }
    } catch (err) {
      this.log.warn(
        { dispatcher_id: dispatcherId, err: errInfo(err) },
        'restart notice injection errored',
      );
    }
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

  private async ensureDispatcherIdentity(cwd: string): Promise<AgentEntityIdentity> {
    const dispatcherConfig = this.config.dispatchers.find(
      (dispatcher) => dispatcher.id === this.id,
    );
    if (dispatcherConfig === undefined) {
      throw new Error(`dispatcher '${this.id}' has no config entry`);
    }
    return ensureDispatcherRootIdentity(this.identities, {
      dispatcherId: this.id,
      agentRuntime: dispatcherConfig.agentRuntime,
      sourceCwd: cwd,
      cwd,
      runtimeCwd: cwd,
      worktree: {
        mode: 'reuse-cwd',
        slug: null,
        path: cwd,
        branch: null,
        base_ref: null,
        cleanup: 'keep',
        cleanup_state: 'not-managed',
        cleanup_error: null,
      },
    });
  }
}

function asInboundDeliveryResult(
  result: AgentRuntimeTurnResult,
): InboundDeliveryResult {
  return result.status === 'skipped' ? { status: 'stopped' } : result;
}

async function closeAllBuilt(
  channels: Map<string, ChannelSession>,
): Promise<void> {
  for (const session of channels.values()) {
    try {
      await session.close();
    } catch {
      /* best effort */
    }
  }
}

function errInfo(err: unknown): { message: string; stack?: string } {
  if (err instanceof Error) {
    return err.stack !== undefined
      ? { message: err.message, stack: err.stack }
      : { message: err.message };
  }
  return { message: String(err) };
}
