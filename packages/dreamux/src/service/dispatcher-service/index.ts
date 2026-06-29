import type {
  AgentRuntime,
  AgentRuntimeMcpServer,
  AgentRuntimeTurnResult,
  ChannelInboundEnvelope,
  ChannelSession,
  DreamuxLogger,
  InboundDeliveryHooks,
  InboundDeliveryResult,
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
  DispatcherStatus,
  DispatcherStore,
} from '../../state/dispatcher-store.js';
import { createDispatcherAgent } from './agent.js';
import type { ChannelMcpCallerScope } from './mcp-descriptors.js';
import { assertRunnableChannelShape } from './runnable-channel.js';
import { ensureDispatcherWorkspace } from '../dispatcher-workspace.js';
import { CompletionRouter, type CompletionInitiator } from '../completion-router/index.js';
import { TeammateCollection, type TeammateOps } from '../teammate-collection/index.js';
import { TeamMateIdentityStore } from '../teammate-collection/identity-store.js';
import { TeamMateTurnsStore } from '../teammate-collection/turns-store.js';
import type { TeammateService } from '../teammate-service/index.js';
import { WorktreeManager } from '../worktree/manager.js';
import { type TeamMateIdentity } from '../teammate-collection/types.js';
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
  status: DispatcherStatus;
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
  private readonly agent: TeammateService;
  private readonly scheduler_: SchedulerService;
  private restartIntent: RestartIntentConsumer | null = null;
  private starting: Promise<void> | null = null;
  private workspaceCwd: string | null = null;
  private shuttingDown = false;

  constructor(opts: DispatcherServiceOptions) {
    this.id = opts.id;
    this.config = opts.config;
    this.dispatchers = opts.dispatchers;
    this.channelProviders = opts.channelProviders;
    this.log = opts.log;
    const adminSocket = opts.adminSocketPath ?? defaultAdminSocketPath();

    this.router = new CompletionRouter({ dispatcherId: opts.id, log: opts.log });

    const worktrees = new WorktreeManager();

    // One identity + turns store pair shared by the dispatcher agent (role
    // `dispatcher` debug record), the dispatcher-scope collection (role
    // `teammate` reads), and the team collection — which forwards it into every
    // per-team collection and its own read probes (R4) — constructed BEFORE all
    // of them (issue #233). The stores are stateless (paths by role + team_id),
    // so one pair safely serves every role/scope.
    const identities = new TeamMateIdentityStore({
      warn: opts.log.warn.bind(opts.log),
    });
    const turnsStore = new TeamMateTurnsStore({
      warn: opts.log.warn.bind(opts.log),
    });

    this.channels = new ChannelService({
      dispatcherId: opts.id,
      config: opts.config,
      channelProviders: opts.channelProviders,
      channelLoggerFactory: opts.channelLoggerFactory,
      ...(opts.adminSocketPath !== undefined
        ? { adminSocketPath: opts.adminSocketPath }
        : {}),
    });

    this.agent = createDispatcherAgent({
      id: opts.id,
      config: opts.config,
      dispatchers: opts.dispatchers,
      agentRuntimeProviders: opts.agentRuntimeProviders,
      identities,
      turnsStore,
      router: this.router,
      log: opts.log,
      adminSocketPath: adminSocket,
      resolveCwd: () => this.mustWorkspaceCwd(),
      liveChannels: () => this.channels.live(),
    });

    this.scheduler_ = new SchedulerService({
      ownerId: opts.id,
      store: new CronJobStore({
        cronJobsPath: dispatcherCronJobsPath(opts.id),
        dispatcherId: opts.id,
      }),
      absentRuntimeStrategy: 'miss',
      getRuntime: () => this.agent.getRuntime(),
      submitScheduled: (input) => this.agent.scheduledInput(input),
      log: opts.log,
    });

    // A dispatcher-owned teammate is never a team_leader, so it carries no
    // launch policy (the team_leader policy is owned by the team layer).
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
   * Launch the dispatcher agent runtime, then its channel sessions (issue #233
   * Phase 5). The order is load-bearing: the agent runtime starts FIRST so an
   * inbound arriving during `session.start()` resolves a running runtime instead
   * of throwing (issue #209 fix #7). A single `starting` promise serializes
   * concurrent callers.
   */
  async start(): Promise<void> {
    if (this.agent.getRuntime() !== null) return;
    if (this.starting !== null) return this.starting;
    const promise = this.doStart().finally(() => {
      this.starting = null;
    });
    this.starting = promise;
    return promise;
  }

  private async doStart(): Promise<void> {
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
    this.workspaceCwd = await ensureDispatcherWorkspace(this.config, id);

    // Build the un-started channel sessions BEFORE the runtime so the dispatcher
    // MCP descriptors are derived from each session's own descriptor; the agent
    // launch reads them via `liveChannels()`. They are adopted as live only after
    // the runtime starts so the descriptor build sees them.
    const channels = await this.channels.build();
    this.channels.adopt(channels);

    let runtime: AgentRuntime;
    try {
      await this.agent.ensureStarted();
      runtime = this.mustRuntime();
    } catch (err) {
      this.channels.clear();
      await closeAllBuilt(channels);
      throw err;
    }

    try {
      // Runtime up, sessions adopted as the live slot so each is observable as it
      // starts (issue #209 fix #7); restart-notice + scheduler arming run in this
      // SAME try so a failure rolls back rather than leaving cron silently unarmed.
      for (const [channelId, session] of channels) {
        await session.start({
          deliver: async (turn, envelope, hooks) =>
            asInboundDeliveryResult(
              await this.routeChannelInput(channelId, turn, envelope, hooks),
            ),
        });
      }
      await this.injectRestartNoticeIfNeeded(id, runtime);
      await this.scheduler.start();
      await this.teams.startSchedulers();
    } catch (err) {
      this.scheduler.stop();
      this.teams.stopSchedulers();
      // Undo the slot adoption so a failed start never leaves a half-built slot.
      this.channels.clear();
      await closeAllBuilt(channels);
      try {
        await this.agent.stop();
      } catch {
        /* best effort */
      }
      throw err;
    }

    this.log.info(
      {
        dispatcher_id: id,
        channel_identity: row.channel_identity,
        cwd: this.workspaceCwd,
      },
      'dispatcher ready',
    );
  }

  async stop(): Promise<void> {
    this.scheduler.stop();
    this.teams.stopSchedulers();
    await this.channels.closeAll(this.log);
    try {
      await this.agent.stop();
    } catch (err) {
      this.log.error(
        { dispatcher_id: this.id, err: errInfo(err) },
        'error stopping dispatcher',
      );
    }
  }

  runtimeStatus(): { status: string | null; threadId: string | null } {
    const runtime = this.agent.getRuntime();
    return {
      status: runtime?.getStatus() ?? null,
      threadId: runtime?.getThreadId() ?? null,
    };
  }

  setRestartIntent(consumer: RestartIntentConsumer | null): void {
    this.restartIntent = consumer;
  }

  summary(row: DispatcherRow): DispatcherSummary {
    const runtime = this.agent.getRuntime();
    return {
      dispatcher_id: row.dispatcher_id,
      channel_identity: row.channel_identity,
      status: runtime?.getStatus() ?? row.status,
      thread_id: runtime?.getThreadId() ?? row.thread_id,
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
    if (this.shuttingDown) {
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
        const result = await team.deliverToLeader(input);
        if (result.status === 'submitted') await hooks?.onAccepted?.(input);
        return result;
      }
    }
    const runtime = this.agent.getRuntime();
    if (runtime === null) return { status: 'stopped' };
    return runtime.channelInput(input, hooks);
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
      return team?.leader ?? this.agent;
    }
    // The dispatcher agent itself is the contained `TeammateService` (issue #233
    // Phase 5) — a dispatcher-owned teammate or leader delivers to it via its own
    // `completionInput`, the same unified router path as any other target.
    return this.agent;
  }

  private async injectRestartNoticeIfNeeded(
    dispatcherId: string,
    runtime: AgentRuntime,
  ): Promise<void> {
    if (!runtime.wasThreadResumed()) return;
    const notice = this.restartIntent?.claim(dispatcherId, Date.now()) ?? null;
    if (notice === null) return;
    try {
      const result = await runtime.systemInput({
        kind: 'system',
        text: notice,
        reason: 'restart-notice',
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
    const runtime = this.agent.getRuntime();
    if (runtime === null) {
      throw new Error(`dispatcher '${this.id}' agent runtime is not running`);
    }
    return runtime;
  }

  private mustWorkspaceCwd(): string {
    const cwd = this.workspaceCwd;
    if (cwd === null) {
      throw new Error(
        `dispatcher '${this.id}' workspace cwd is not resolved yet`,
      );
    }
    return cwd;
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
