import type {
  AgentRuntime,
  AgentRuntimeMcpServer,
  AgentRuntimeTurnResult,
  ChannelInboundEnvelope,
  ChannelSession,
  DreamuxLogger,
  InboundDeliveryHooks,
  InboundTurnInput,
} from '@excitedjs/dreamux-types';

import type { AgentRuntimeProviderCatalog } from '../../agent-runtime/index.js';
import type { ChannelProviderCatalog } from '../../channel/catalog.js';
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
import {
  asInboundDeliveryResult,
  closeAllBuilt,
  errInfo,
} from './helpers.js';
import { dispatcherMcpServerDescriptors } from './mcp-descriptors.js';
import type { ChannelMcpCallerScope } from './mcp-descriptors.js';
import { assertRunnableChannelShape } from './runnable-channel.js';
import { ensureDispatcherWorkspace } from '../dispatcher-workspace.js';
import { CompletionRouter, type CompletionInitiator } from '../completion-router/index.js';
import { TeammateCollection, type TeammateOps } from '../teammate-collection/index.js';
import { TeamMateIdentityStore } from '../teammate-collection/identity-store.js';
import { TeamMateTurnsStore } from '../teammate-collection/turns-store.js';
import type { TeammateService } from '../teammate-service/index.js';
import { WorktreeManager } from '../worktree/manager.js';
import {
  runtimeStatusToIdentityStatus,
  type TeamMateIdentity,
  type TeamMateIdentityStatus,
} from '../teammate-collection/types.js';
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
  adminSocketPath?: string;
  channelLoggerFactory: (dispatcherId: string) => DreamuxLogger;
  log: DreamuxLogger;
}

export interface DispatcherSummary {
  dispatcher_id: string;
  channel_identity: string;
  status: TeamMateIdentityStatus;
  thread_id: string | null;
  enabled: boolean;
}

export type ChannelToolCaller =
  | { kind: 'dispatcher' }
  | { kind: 'team_leader'; teamId: string; leaderName: string };

/**
 * One dispatcher-local aggregate (issue #233). It owns the whole per-dispatcher
 * object graph — the delivery `CompletionRouter`, the shared `WorktreeManager`,
 * the `TeammateCollection` and `TeamCollection`, the `ChannelService`, and the dispatcher's own agent (a contained
 * {@link TeammateService}, Phase 5) — built once in the constructor.
 *
 * The dispatcher *has an* agent (has-a): the shared `TeammateService` owns the
 * agent runtime lifecycle (start/resume/stop), the settle → router capture, and
 * `completionInput` as a delivery target. The dispatcher-only concerns —
 * ChannelService orchestration, restart-intent injection, role MCP descriptor
 * assembly, and completion routing — live here, on `DispatcherService`.
 */
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
  private agent: TeammateService | null = null;
  private readonly scheduler_: SchedulerService;
  private readonly identities: TeamMateIdentityStore;
  private readonly turnsStore: TeamMateTurnsStore;
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
    this.log = opts.log;
    const adminSocket = opts.adminSocketPath ?? defaultAdminSocketPath();
    this.agentRuntimeProviders = opts.agentRuntimeProviders;
    this.adminSocket = adminSocket;

    this.router = new CompletionRouter({ dispatcherId: opts.id, log: opts.log });

    const worktrees = new WorktreeManager();

    // One identity + turns store pair shared by the dispatcher root identity,
    // the dispatcher-scope collection, and the team collection — which forwards
    // it into every per-team collection and its own read probes (R4).
    const identities = new TeamMateIdentityStore({
      warn: opts.log.warn.bind(opts.log),
    });
    const turnsStore = new TeamMateTurnsStore({
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

    // Dispatcher-owned teammates carry no default role policy. If the caller
    // supplies MCP identity guidance, the collection passes it through as an
    // append-only system prompt fragment.
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

    // The Team layer owns the team_leader role policy; the dispatcher only lends
    // the primitives a leader's policy is built from — the admin socket and its
    // channel-egress descriptors (channels are dispatcher-owned).
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

  /**
   * Prepare the dispatcher aggregate and start input sources. The dispatcher
   * runtime remains dormant until an unbound channel turn, dispatcher cron, or
   * explicit restart-notice eager start needs it.
   */
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
    // The single runtime boundary that fails loud on a not-yet-runnable channel
    // shape (a provider with no loaded implementation). State seeding stays
    // fail-soft so this is the only place that rejects it.
    if (dispatcherConfig !== undefined) {
      assertRunnableChannelShape(dispatcherConfig, this.channelProviders);
    }
    if (dispatcherConfig === undefined) {
      throw new Error(`dispatcher '${id}' has no config entry`);
    }

    // The dispatcher agent runs in its validated workspace (issue #182 PR-4): no
    // fallback to a Dreamux state dir. Resolved BEFORE the agent launch so the
    // agent's launch builder reads it.
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
          deliver: async (turn, envelope, hooks) =>
            asInboundDeliveryResult(
              await this.routeChannelInput(channelId, turn, envelope, hooks),
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

  runtimeStatus(): {
    status: string | null;
    threadId: string | null;
    lastError: string | null;
  } {
    const agent = this.agent;
    const runtime = agent?.getRuntime() ?? null;
    const identity = agent?.current() ?? null;
    return {
      status: runtime?.getStatus() ?? null,
      threadId: runtime?.getCheckpoint()?.id ?? identity?.session_id ?? null,
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

  /**
   * Best-effort dispatcher teardown (issue #233). The `shuttingDown` flag closes
   * the traversal-window race: it is set first so any concurrent `spawn`/`send` /
   * team `create`/`send` is rejected before it can lazily start a runtime the
   * sweep would miss. Then every live teammate runtime is stopped, followed by
   * the dispatcher agent (channel sessions first, then the agent runtime).
   */
  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    // Members now live in per-team collections, so the dispatcher-scope `stopAll`
    // alone would miss them — sweep both (issue #233). Each team's `stopAll`
    // stops its own members + leader; only materialized teams are swept.
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

  /** The dispatcher's own teammates, as the narrow admin-facing op surface
   * (issue #233). The admin layer drives the collection directly through this
   * instead of the dispatcher re-forwarding each verb. */
  get teammates(): TeammateOps {
    return this._teammates;
  }

  /** The single-entity team service for a team id (admin `team_leader` target). */
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
    hooks?: InboundDeliveryHooks,
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
        return team.deliverToLeader(input, hooks);
      }
    }
    return this.mustAgent().channelInput(input, hooks);
  }

  /**
   * Resolve the delivery target of a send-initiated turn from its producer's
   * identity (issue #233). A team member's completion routes to its leader's
   * `TeammateService`; a dispatcher-owned teammate or a team leader routes to the
   * dispatcher agent. Topology is fixed by #199 visibility, so the producer's
   * role + team is enough — no caller principal is threaded.
   */
  async initiatorFor(
    producer: TeamMateIdentity,
  ): Promise<CompletionInitiator | null> {
    if (producer.role === 'team_member' && producer.team_id !== null) {
      const team = await this.teams.get(producer.team_id).catch(() => null);
      // The team's leader is its contained `TeammateService` (issue #233 Phase
      // 4); a member's settled turn delivers to it via `completionInput`.
      return team?.leader ?? this.mustAgent();
    }
    // The dispatcher agent itself is the contained `TeammateService` (issue #233
    // Phase 5) — a dispatcher-owned teammate or leader delivers to it via its own
    // `completionInput`, the same unified router path as any other target.
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

  private async ensureDispatcherIdentity(cwd: string): Promise<TeamMateIdentity> {
    const dispatcherConfig = this.config.dispatchers.find(
      (dispatcher) => dispatcher.id === this.id,
    );
    if (dispatcherConfig === undefined) {
      throw new Error(`dispatcher '${this.id}' has no config entry`);
    }
    return this.identities.ensureDispatcherIdentity({
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
