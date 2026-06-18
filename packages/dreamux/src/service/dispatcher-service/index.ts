import type {
  AgentRuntime,
  AgentRuntimeMcpServer,
  AgentRuntimeTurnResult,
  ChannelInboundEnvelope,
  ChannelSession,
  ChannelTarget,
  DreamuxLogger,
  InboundDeliveryHooks,
  InboundDeliveryResult,
  InboundTurnInput,
} from '@excitedjs/dreamux-types';

import type { AgentRuntimeProviderCatalog } from '../../agent-runtime/index.js';
import type { ChannelProviderCatalog } from '../../channel/catalog.js';
import type { DreamuxConfig } from '../../config/config.js';
import type { RestartIntentConsumer } from '../../daemon/restart-intent.js';
import { adminSocketPath as defaultAdminSocketPath } from '../../platform/paths.js';
import type {
  DispatcherRow,
  DispatcherStatus,
  DispatcherStore,
} from '../../state/dispatcher-store.js';
import { createDispatcherAgent } from './agent.js';
import { ChannelSessions } from './channel-sessions.js';
import { authorizeTeamLeaderChannelEgress } from './channel-tool-auth.js';
import type { ChannelMcpCallerScope } from './mcp-descriptors.js';
import { assertRunnableChannelShape } from './runnable-channel.js';
import { ensureDispatcherWorkspace } from '../dispatcher-workspace.js';
import { ChannelToolAuthorizationError } from './errors.js';
import {
  CompletionRouter,
  type CompletionInitiator,
} from '../completion-router/index.js';
import { teammateMcpServerDescriptor } from '../teammate-collection/mcp-config.js';
import {
  TeammateCollection,
  type TeammateOps,
} from '../teammate-collection/index.js';
import type { TeammateService } from '../teammate-service/index.js';
import { WorktreeManager } from '../worktree/manager.js';
import { ChannelBindingStore } from '../channel-binding/store.js';
import { type TeamMateIdentity } from '../teammate-collection/types.js';
import { type TeamChannelContext } from '../team-service/index.js';
import { TeamCollection } from '../team-collection/index.js';
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
 * object graph — the delivery `CompletionRouter`, the shared `WorktreeManager` +
 * `ChannelBindingStore`, the `TeammateCollection` and `TeamCollection`, the live
 * `ChannelSessions`, and the dispatcher's own agent (a contained
 * {@link TeammateService}, Phase 5) — built once in the constructor.
 *
 * The dispatcher *has an* agent (has-a): the shared `TeammateService` owns the
 * agent runtime lifecycle (start/resume/stop), the settle → router capture, and
 * `completionInput` as a delivery target. The dispatcher-only concerns —
 * channel sessions, restart-intent injection, role MCP descriptor assembly, and
 * completion routing — live here, on `DispatcherService`.
 */
export class DispatcherService implements TeamChannelContext {
  readonly id: string;
  private readonly config: DreamuxConfig;
  private readonly dispatchers: DispatcherStore;
  private readonly channelProviders: ChannelProviderCatalog;
  private readonly log: DreamuxLogger;
  private readonly router: CompletionRouter;
  private readonly _teammates: TeammateCollection;
  private readonly teams: TeamCollection;
  private readonly channels: ChannelSessions;
  private readonly agent: TeammateService;
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

    // One worktree manager + one channel-binding store per dispatcher, shared by
    // both collections (issue #233).
    const worktrees = new WorktreeManager();
    const bindings = new ChannelBindingStore();

    this.channels = new ChannelSessions({
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
      router: this.router,
      log: opts.log,
      adminSocketPath: adminSocket,
      resolveCwd: () => this.mustWorkspaceCwd(),
      liveChannels: () => this.channels.live(),
    });

    // The team_leader MCP descriptor builder. Forwarded into every per-team
    // collection (where the leader actually lives) AND the dispatcher collection;
    // a dispatcher-owned teammate is never a leader, so it is a no-op there
    // (issue #233).
    const mcpServersForTeamMate = (input: {
      dispatcherId: string;
      name: string;
      identity: TeamMateIdentity;
    }): readonly AgentRuntimeMcpServer[] =>
      input.identity.role === 'team_leader'
        ? [
            teammateMcpServerDescriptor({
              dispatcherId: input.dispatcherId,
              callerKind: 'team_leader',
              teamId: input.identity.team_id ?? '',
              adminSocketPath: adminSocket,
            }),
            ...this.channelMcpServerDescriptorsForCaller({
              callerKind: 'team_leader',
              team_id: input.identity.team_id ?? '',
              leader_name: input.identity.name,
            }),
          ]
        : [];

    this._teammates = new TeammateCollection({
      dispatcherId: opts.id,
      teamScope: null,
      config: opts.config,
      agentRuntimeProviders: opts.agentRuntimeProviders,
      worktrees,
      mcpServersForTeamMate,
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
      bindings,
      router: this.router,
      initiatorFor: (producer) => this.initiatorFor(producer),
      isShuttingDown: () => this.shuttingDown,
      mcpServersForTeamMate,
      log: opts.log,
    });
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
      // The runtime is up and the sessions are already adopted as the live slot,
      // so each session is observable as it starts (issue #209 fix #7).
      for (const [channelId, session] of channels) {
        await session.start({
          deliver: async (turn, envelope, hooks) =>
            asInboundDeliveryResult(
              await this.routeChannelInput(channelId, turn, envelope, hooks),
            ),
        });
      }
    } catch (err) {
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
    await this.injectRestartNoticeIfNeeded(id, runtime);
  }

  async stop(): Promise<void> {
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
    const channelId = this.resolveToolChannelId(
      input.channelId,
      input.providerRef,
    );
    if (input.caller.kind === 'team_leader') {
      await this.authorizeTeamLeaderChannelEgress({
        channelId,
        teamId: input.caller.teamId,
        leaderName: input.caller.leaderName,
        arguments: input.arguments,
      });
    }
    return this.channels.invokeTool({
      ...(input.providerRef !== undefined ? { providerRef: input.providerRef } : {}),
      name: input.name,
      arguments: input.arguments,
      channelId,
    });
  }

  workspace(): Promise<string> {
    return this._teammates.dispatcherWorkspace();
  }

  /** The dispatcher's own teammates, as the narrow admin-facing op surface
   * (issue #233). The admin layer drives the collection directly through this
   * instead of the dispatcher re-forwarding each verb. */
  get teammates(): TeammateOps {
    return this._teammates;
  }

  /** The single-entity team service for a team id (admin `team_leader` target). */
  team(teamId: string) {
    return this.teams.get(teamId);
  }

  createTeam(input: TeamCreateInput) {
    this.assertNotShuttingDown();
    return this.teams.create(input);
  }

  listTeams() {
    return this.teams.list();
  }

  async getTeamStatus(teamId: string) {
    return (await this.teams.get(teamId)).status();
  }

  getTeamHistory(input: TeamHistoryQuery) {
    return this.teams.history(input);
  }

  async dissolveTeam(input: TeamDissolveInput) {
    return (await this.teams.get(input.teamId)).dissolve(input);
  }

  async bindTeamChannel(input: {
    teamId: string;
    channelId?: string;
    meta: Record<string, unknown>;
  }) {
    const team = await this.teams.get(input.teamId);
    return team.bindChannel(this, {
      ...(input.channelId !== undefined ? { channelId: input.channelId } : {}),
      meta: input.meta,
    });
  }

  async transferTeamChannelBack(input: {
    channelId?: string;
    meta: Record<string, unknown>;
  }) {
    const channelId = this.resolveChannelId(input.channelId);
    const target = await this.channels.resolveTarget(input.meta, channelId);
    return this.teams.transferChannelBack({
      channelId,
      targetKey: target.target_key,
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
      const binding = await this.teams.resolveChannel({
        channelId,
        targetKey: target.target_key,
      });
      if (binding !== null) {
        const team = await this.teams.get(binding.team_name);
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

  async teamLeaderCanUseChannel(input: {
    teamId: string;
    leaderName: string;
    targetKey: string;
  }): Promise<{ allowed: boolean; channelId: string | null }> {
    const team = await this.teams.get(input.teamId).catch(() => null);
    const channelId =
      team === null
        ? null
        : await team.resolveLeaderChannel({
            leaderName: input.leaderName,
            targetKey: input.targetKey,
          });
    return { allowed: channelId !== null, channelId };
  }

  private authorizeTeamLeaderChannelEgress(input: {
    channelId: string;
    teamId: string;
    leaderName: string;
    arguments: Record<string, unknown>;
  }): Promise<void> {
    return authorizeTeamLeaderChannelEgress(
      {
        resolveTarget: (meta, channelId) =>
          this.channels.resolveTarget(meta, channelId),
        messageBelongsToTarget: (target, messageId, channelId) =>
          this.channels.messageBelongsToTarget(target, messageId, channelId),
        teamLeaderCanUseChannel: (i) => this.teamLeaderCanUseChannel(i),
      },
      input,
    );
  }

  private resolveToolChannelId(
    requested?: string,
    providerRef?: string,
  ): string {
    if (providerRef === undefined) return this.resolveChannelId(requested);
    if (requested !== undefined) {
      const channelId = this.resolveChannelId(requested);
      const actualProvider = this.channelProviderRef(channelId);
      if (actualProvider !== providerRef) {
        throw new ChannelToolAuthorizationError(
          'BAD_REQUEST',
          `channel '${channelId}' for dispatcher '${this.id}' uses provider '${actualProvider}', not '${providerRef}'`,
        );
      }
      return channelId;
    }
    const dispatcher = this.dispatcherConfig();
    const matches =
      dispatcher?.channels.filter((channel) => channel.provider === providerRef) ??
      [];
    if (matches.length === 0) {
      throw new ChannelToolAuthorizationError(
        'BAD_REQUEST',
        `dispatcher '${this.id}' has no configured channel for provider '${providerRef}'`,
      );
    }
    if (matches.length > 1) {
      throw new ChannelToolAuthorizationError(
        'BAD_REQUEST',
        `dispatcher '${this.id}' has ${matches.length} channels for provider '${providerRef}'; channel_id is required`,
      );
    }
    return matches[0]!.id;
  }

  resolveChannelId(requested?: string): string {
    const ids = this.dispatcherConfig()?.channels.map((channel) => channel.id) ?? [];
    if (requested !== undefined) {
      if (!ids.includes(requested)) {
        throw new Error(
          `unknown channel_id '${requested}' for dispatcher '${this.id}'; ` +
            `its configured channels are ${
              ids.length > 0 ? ids.map((id) => `'${id}'`).join(', ') : '(none)'
            }`,
        );
      }
      return requested;
    }
    if (ids.length === 0) {
      throw new Error(`dispatcher '${this.id}' has no resolvable channel`);
    }
    if (ids.length > 1) {
      throw new Error(
        `dispatcher '${this.id}' has ${ids.length} channels; ` +
          'channel_id is required to select one',
      );
    }
    return ids[0]!;
  }

  channelProviderRef(channelId: string): string {
    const channel = this.dispatcherConfig()?.channels.find(
      (entry) => entry.id === channelId,
    );
    if (channel === undefined) {
      throw new Error(
        `unknown channel_id '${channelId}' for dispatcher '${this.id}'`,
      );
    }
    return channel.provider;
  }

  resolveChannelTarget(meta: unknown, channelId?: string): Promise<ChannelTarget> {
    return this.channels.resolveTarget(meta, channelId);
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

  private dispatcherConfig() {
    return this.config.dispatchers.find((entry) => entry.id === this.id);
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
