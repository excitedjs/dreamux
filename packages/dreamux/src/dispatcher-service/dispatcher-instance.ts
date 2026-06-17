import type {
  AgentRuntimeMcpServer,
  AgentRuntimeTurnResult,
  ChannelInboundEnvelope,
  ChannelTarget,
  CompletionEnvelope,
  DreamuxLogger,
  InboundDeliveryHooks,
  InboundTurnInput,
  TeamMateCompletionDeliveryResult,
} from '@excitedjs/dreamux-types';

import type { AgentRuntimeProviderCatalog } from '../agent-runtime/index.js';
import type { ChannelProviderCatalog } from '../channel/catalog.js';
import type { DreamuxConfig } from '../config/config.js';
import type { RestartIntentConsumer } from '../daemon/restart-intent.js';
import { adminSocketPath as defaultAdminSocketPath } from '../platform/paths.js';
import type { DispatcherStore } from '../state/dispatcher-store.js';
import {
  DispatcherRuntimeService,
  type DispatcherSummary,
} from './dispatcher/service.js';
import type { ChannelMcpCallerScope } from './dispatcher/mcp-descriptors.js';
import { ChannelToolAuthorizationError } from './errors.js';
import type { DispatcherRow } from '../state/dispatcher-store.js';
import {
  CompletionRouter,
  type CompletionInitiator,
} from './teammate/completion-router.js';
import { teammateMcpServerDescriptor } from './teammate/mcp-config.js';
import {
  type SpawnTeamMateRequest,
  TeammateCollection,
} from './teammate/service.js';
import { WorktreeManager } from './teammate/worktree-manager.js';
import { ChannelBindingStore } from './channel-binding/store.js';
import {
  type CloseTeamMateInput,
  type SendTeamMateInput,
  type TeamMateHistoryQuery,
  type TeamMateIdentity,
  type TeamMateRuntimeStatus,
} from './teammate/types.js';
import { type TeamChannelContext, TeamCollection } from './team/service.js';
import type {
  TeamCreateInput,
  TeamDissolveInput,
  TeamHistoryQuery,
} from './team/types.js';

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

export type ChannelToolCaller =
  | { kind: 'dispatcher' }
  | { kind: 'team_leader'; teamId: string; leaderName: string };

/**
 * One dispatcher-local aggregate (issue #233 ownership sinking). It owns the
 * whole per-dispatcher object graph — the delivery `CompletionRouter`, the shared
 * `WorktreeManager` + `ChannelBindingStore`, the `TeammateCollection` and
 * `TeamCollection`, and the `DispatcherRuntimeService` — built once in the
 * constructor. None of these are process-wide singletons; each dispatcher holds
 * its own. The graph is built router-first (topology-free) so the collections can
 * be wired to `this` methods without a construction cycle.
 */
export class DispatcherService implements TeamChannelContext {
  readonly id: string;
  private readonly config: DreamuxConfig;
  private readonly dispatcherRuntime: DispatcherRuntimeService;
  private readonly router: CompletionRouter;
  private readonly teammates: TeammateCollection;
  private readonly teams: TeamCollection;
  private shuttingDown = false;

  constructor(opts: DispatcherServiceOptions) {
    this.id = opts.id;
    this.config = opts.config;
    const adminSocket = opts.adminSocketPath ?? defaultAdminSocketPath();

    this.router = new CompletionRouter({ dispatcherId: opts.id, log: opts.log });

    // One worktree manager + one channel-binding store per dispatcher, shared by
    // both collections (issue #233): the manager is cwd-constrained to this
    // dispatcher's `.workspace`, the binding store keyed by this dispatcher id.
    const worktrees = new WorktreeManager();
    const bindings = new ChannelBindingStore();

    this.dispatcherRuntime = new DispatcherRuntimeService({
      id: opts.id,
      config: opts.config,
      dispatchers: opts.dispatchers,
      agentRuntimeProviders: opts.agentRuntimeProviders,
      channelProviders: opts.channelProviders,
      log: opts.log,
      channelLoggerFactory: opts.channelLoggerFactory,
      ...(opts.adminSocketPath !== undefined
        ? { adminSocketPath: opts.adminSocketPath }
        : {}),
      routeChannelInput: (channelId, turn, envelope, hooks) =>
        this.routeChannelInput(channelId, turn, envelope, hooks),
    });

    this.teammates = new TeammateCollection({
      dispatcherId: opts.id,
      config: opts.config,
      agentRuntimeProviders: opts.agentRuntimeProviders,
      worktrees,
      mcpServersForTeamMate: ({ dispatcherId, identity }) =>
        identity.role === 'team_leader'
          ? [
              teammateMcpServerDescriptor({
                dispatcherId,
                callerKind: 'team_leader',
                teamId: identity.team_id ?? '',
                adminSocketPath: adminSocket,
              }),
              ...this.channelMcpServerDescriptorsForCaller({
                callerKind: 'team_leader',
                team_id: identity.team_id ?? '',
                leader_name: identity.name,
              }),
            ]
          : [],
      router: this.router,
      initiatorFor: (producer) => this.initiatorFor(producer),
      log: opts.log,
    });

    this.teams = new TeamCollection({
      dispatcherId: opts.id,
      teammates: this.teammates,
      worktrees,
      bindings,
    });
  }

  start(): Promise<void> {
    return this.dispatcherRuntime.start();
  }

  stop(): Promise<void> {
    return this.dispatcherRuntime.stop();
  }

  runtimeStatus(): { status: string | null; threadId: string | null } {
    const runtime = this.dispatcherRuntime.getRuntime();
    return {
      status: runtime?.getStatus() ?? null,
      threadId: runtime?.getThreadId() ?? null,
    };
  }

  setRestartIntent(consumer: RestartIntentConsumer | null): void {
    this.dispatcherRuntime.setRestartIntent(consumer);
  }

  summary(row: DispatcherRow): DispatcherSummary {
    return this.dispatcherRuntime.summary(row);
  }

  /**
   * Best-effort dispatcher teardown (issue #233). The `shuttingDown` flag closes
   * the traversal-window race: it is set first so any concurrent `spawn`/`send` /
   * team `create`/`send` is rejected before it can lazily start a runtime the
   * sweep would miss. Then every live teammate runtime (direct + team members +
   * leaders, all held in the single per-dispatcher `TeammateCollection`) is
   * stopped, followed by the dispatcher agent runtime. `stopAll` only touches
   * already-created entities, so it never lazily starts a not-yet-running one.
   */
  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    await this.teammates.stopAll();
    await this.dispatcherRuntime.shutdown();
  }

  private assertNotShuttingDown(): void {
    if (this.shuttingDown) {
      throw new Error(`dispatcher '${this.id}' is shutting down`);
    }
  }

  channelMcpServerDescriptorsForCaller(
    scope: ChannelMcpCallerScope,
  ): AgentRuntimeMcpServer[] {
    return this.dispatcherRuntime.channelMcpServerDescriptorsForCaller(scope);
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
    return this.dispatcherRuntime.invokeChannelTool({
      providerRef: input.providerRef,
      name: input.name,
      arguments: input.arguments,
      channelId,
    });
  }

  workspace(): Promise<string> {
    return this.teammates.dispatcherWorkspace();
  }

  spawnTeamMate(
    input: Omit<SpawnTeamMateRequest, 'teamId' | 'sharedWorkspace'>,
  ) {
    this.assertNotShuttingDown();
    return this.teammates.spawn(input);
  }

  sendTeamMate(input: Omit<SendTeamMateInput, 'teamId'>) {
    this.assertNotShuttingDown();
    return this.teammates.send(input);
  }

  closeTeamMate(input: Omit<CloseTeamMateInput, 'teamId'>) {
    return this.teammates.close(input);
  }

  listTeamMates(): Promise<TeamMateRuntimeStatus[]> {
    return this.teammates.list();
  }

  getTeamMateStatus(name: string) {
    return this.teammates.status(name);
  }

  getTeamMateHistory(input: Omit<TeamMateHistoryQuery, 'teamId'>) {
    return this.teammates.history(input);
  }

  getTeamMateLast(name: string, turns?: number) {
    return this.teammates.last(name, turns);
  }

  getTeamMateCapabilities() {
    return this.teammates.getCapabilities();
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
    const target = await this.dispatcherRuntime.resolveChannelTarget(
      input.meta,
      channelId,
    );
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
    const runtime = this.dispatcherRuntime.getRuntime();
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
      return team?.leader ?? this.dispatcherInitiator();
    }
    return this.dispatcherInitiator();
  }

  /**
   * The dispatcher agent as a delivery target: a thin adapter over the live
   * dispatcher runtime's `completionInput`. Until Phase 5 the dispatcher is not a
   * `TeammateService`, so this adapter — not an entity method — is its initiator.
   */
  private dispatcherInitiator(): CompletionInitiator {
    return {
      completionInput: (
        completion: CompletionEnvelope,
      ): Promise<TeamMateCompletionDeliveryResult> =>
        this.dispatcherRuntime.deliverCompletion(completion),
    };
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

  private async authorizeTeamLeaderChannelEgress(input: {
    channelId: string;
    teamId: string;
    leaderName: string;
    arguments: Record<string, unknown>;
  }): Promise<void> {
    let target: ChannelTarget;
    try {
      target = await this.dispatcherRuntime.resolveChannelTarget(
        input.arguments,
        input.channelId,
      );
    } catch {
      throw new ChannelToolAuthorizationError(
        'BAD_REQUEST',
        'TeamLeader channel tools require a resolvable target',
      );
    }
    const messageId = input.arguments['message_id'];
    if (
      typeof messageId === 'string' &&
      !(await this.dispatcherRuntime.messageBelongsToTarget(
        target,
        messageId,
        input.channelId,
      ))
    ) {
      throw new ChannelToolAuthorizationError(
        'CHANNEL_SCOPE_DENIED',
        'TeamLeader may act only on messages observed in bound team channels',
      );
    }
    const { allowed, channelId } = await this.teamLeaderCanUseChannel({
      teamId: input.teamId,
      leaderName: input.leaderName,
      targetKey: target.target_key,
    });
    if (!allowed || channelId === null) {
      throw new ChannelToolAuthorizationError(
        'CHANNEL_SCOPE_DENIED',
        'TeamLeader may use channels only for bound team channels',
      );
    }
    if (channelId !== input.channelId) {
      throw new ChannelToolAuthorizationError(
        'CHANNEL_SCOPE_DENIED',
        'TeamLeader may use only the channel MCP server bound to the target',
      );
    }
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
    return this.dispatcherRuntime.resolveChannelTarget(meta, channelId);
  }

  private dispatcherConfig() {
    return this.config.dispatchers.find((entry) => entry.id === this.id);
  }
}
