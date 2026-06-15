import type { AgentRuntimeProviderCatalog } from '../agent-runtime/index.js';
import type {
  AgentRuntime,
  AgentRuntimeTurnResult,
  ChannelInboundEnvelope,
  ChannelTarget,
  CompletionEnvelope,
  InboundDeliveryHooks,
  InboundTurnInput,
} from '@excitedjs/dreamux-types';
import type { ChannelProviderCatalog } from '../channel/catalog.js';
import { type DreamuxConfig } from '../config/config.js';
import type { DispatcherStore } from '../state/dispatcher-store.js';
import type { DreamuxLogger } from '@excitedjs/dreamux-types';
import type { RestartIntentConsumer } from '../daemon/restart-intent.js';
import { adminSocketPath as defaultAdminSocketPath } from '../platform/paths.js';
import {
  DispatcherAgentService,
  type DispatcherSummary,
} from './dispatcher/service.js';
import { TeamService } from './team/service.js';
import { TeamMateAgentService } from './teammate/service.js';
import { teammateMcpServerDescriptor } from './teammate/mcp-config.js';
import type { TeamMateCallerPrincipal } from './teammate/types.js';
import type {
  CloseTeamMateInput,
  TeamMateHistoryQuery,
  SendTeamMateInput,
  SpawnTeamMateInput,
  TeamMateIdentity,
  TeamMateTurnOrigin,
} from './teammate/types.js';
import type {
  TeamCreateInput,
  TeamDissolveInput,
  TeamHistoryQuery,
} from './team/types.js';

/**
 * A channel-tool authorization failure raised by the service layer (the
 * TeamLeader egress gate). It carries the admin error CODE so the admin layer
 * can map the deny to the same wire code the former in-admin channel-egress
 * scope check produced (`BAD_REQUEST` / `CHANNEL_SCOPE_DENIED`) without the service layer
 * depending on the admin protocol module.
 */
export class ChannelToolAuthorizationError extends Error {
  constructor(
    readonly code: 'BAD_REQUEST' | 'CHANNEL_SCOPE_DENIED',
    message: string,
  ) {
    super(message);
    this.name = 'ChannelToolAuthorizationError';
  }
}

export interface DispatcherServiceOptions {
  config: DreamuxConfig;
  dispatchers: DispatcherStore;
  agentRuntimeProviders: AgentRuntimeProviderCatalog;
  channelProviders: ChannelProviderCatalog;
  adminSocketPath?: string;
  channelLoggerFactory: (dispatcherId: string) => DreamuxLogger;
  log: DreamuxLogger;
}

/**
 * Dispatcher Service owns server-side orchestration for dispatchers.
 *
 * The stdio MCP shim and admin method layer only map tool/admin calls into this
 * service. Teammate identities, resume history, and teammate AgentRuntime
 * instances are delegated to the agent-centric TeamMate sub-service.
 */
export class DispatcherService {
  readonly dispatchers: DispatcherAgentService;
  readonly teammates: TeamMateAgentService;
  readonly teams: TeamService;
  private readonly config: DreamuxConfig;

  constructor(opts: DispatcherServiceOptions) {
    this.config = opts.config;
    this.dispatchers = new DispatcherAgentService({
      config: opts.config,
      dispatchers: opts.dispatchers,
      agentRuntimeProviders: opts.agentRuntimeProviders,
      channelProviders: opts.channelProviders,
      log: opts.log,
      channelLoggerFactory: opts.channelLoggerFactory,
      ...(opts.adminSocketPath !== undefined
        ? { adminSocketPath: opts.adminSocketPath }
        : {}),
      routeChannelInput: (id, channelId, turn, envelope, hooks) =>
        this.routeChannelInput(id, channelId, turn, envelope, hooks),
    });
    this.teammates = new TeamMateAgentService({
      config: opts.config,
      dispatchers: opts.dispatchers,
      agentRuntimeProviders: opts.agentRuntimeProviders,
      mcpServersForTeamMate: ({ dispatcherId, identity }) =>
        identity.role === 'team_leader'
          ? [
              teammateMcpServerDescriptor({
                dispatcherId,
                callerKind: 'team_leader',
                teamId: identity.team_id ?? '',
                leaderName: identity.name,
                adminSocketPath: opts.adminSocketPath ?? defaultAdminSocketPath(),
              }),
              // The TeamLeader's channel MCP descriptor(s) come from the live
              // channel sessions' own neutral `mcpServerDescriptor` — core never
              // names a channel's MCP shape. The dispatcher is running when a
              // TeamLeader is created/resumed, so its sessions are live.
              ...this.dispatchers.channelMcpServerDescriptorsForCaller(
                dispatcherId,
                {
                  callerKind: 'team_leader',
                  team_id: identity.team_id ?? '',
                  leader_name: identity.name,
                },
              ),
            ]
          : [],
      // Reverse delivery (issue #147): a settled teammate turn bridges here to
      // the dispatcher runtime's completionInput, becoming a fresh dispatcher
      // turn. The facade is where both services meet.
      onTeamMateCompletion: (id, identity, completion, origin) =>
        this.deliverTeamMateCompletion(id, identity, completion, origin),
      log: opts.log,
    });
    this.teams = new TeamService({
      teammates: this.teammates,
    });
  }

  setRestartIntent(consumer: RestartIntentConsumer | null): void {
    this.dispatchers.setRestartIntent(consumer);
  }

  startDispatcher(id: string): Promise<void> {
    return this.dispatchers.startDispatcher(id);
  }

  stopDispatcher(id: string): Promise<void> {
    return this.dispatchers.stopDispatcher(id);
  }

  getRuntime(id: string): AgentRuntime | null {
    return this.dispatchers.getRuntime(id);
  }

  summarize(): DispatcherSummary[] {
    return this.dispatchers.summarize();
  }

  /**
   * Invoke a provider-owned channel tool on behalf of a caller (the blind MCP
   * conduit's `tools/call`). Core forwards the raw `{name, arguments}` to the
   * neutral channel seam and never names a tool. A TeamLeader caller is gated +
   * retargeted here: its egress is authorized against its OWN active channel
   * binding and routed through that bound channel's bot. A dispatcher/teammate
   * caller egresses the primary channel (or the sessionless provider path).
   */
  async invokeChannelTool(input: {
    dispatcherId: string;
    name: string;
    arguments: Record<string, unknown>;
    caller: TeamMateCallerPrincipal;
  }): Promise<unknown> {
    if (input.caller.kind === 'team_leader') {
      const channelId = await this.authorizeTeamLeaderChannelEgress({
        dispatcherId: input.dispatcherId,
        teamId: input.caller.teamId,
        leaderName: input.caller.leaderName,
        arguments: input.arguments,
      });
      return this.dispatchers.invokeChannelTool({
        dispatcherId: input.dispatcherId,
        name: input.name,
        arguments: input.arguments,
        channelId,
      });
    }
    return this.dispatchers.invokeChannelTool({
      dispatcherId: input.dispatcherId,
      name: input.name,
      arguments: input.arguments,
    });
  }


  /**
   * Authorize a TeamLeader channel egress and resolve which channel it leaves
   * through (issue #209 live multi-channel routing). The egress channel is the
   * leader's OWN active binding for the resolved target. Three deny paths are
   * preserved byte-for-behavior from the former admin-layer channel-egress scope check:
   *   - no resolvable target in the call → BAD_REQUEST;
   *   - the referenced message was not observed in a bound channel →
   *     CHANNEL_SCOPE_DENIED;
   *   - the target is not bound to this leader → CHANNEL_SCOPE_DENIED.
   * The neutral target is provider-resolved (`session.resolveTarget`), so core
   * never reads a channel selector field by name; `message_id` is the neutral
   * channel field the ownership check keys off.
   */
  private async authorizeTeamLeaderChannelEgress(input: {
    dispatcherId: string;
    teamId: string;
    leaderName: string;
    arguments: Record<string, unknown>;
  }): Promise<string> {
    let target: ChannelTarget;
    try {
      target = await this.dispatchers.resolveChannelTarget(
        input.dispatcherId,
        input.arguments,
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
      !(await this.dispatchers.messageBelongsToTarget(
        input.dispatcherId,
        target,
        messageId,
      ))
    ) {
      throw new ChannelToolAuthorizationError(
        'CHANNEL_SCOPE_DENIED',
        'TeamLeader may act only on messages observed in bound team channels',
      );
    }
    const { allowed, channelId } = await this.teamLeaderCanUseChannel({
      dispatcherId: input.dispatcherId,
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
    return channelId;
  }

  /**
   * Resolve the dispatcher-local `channel_id` for a dispatcher — the single
   * source of truth shared by the bind path and the inbound router so a stored
   * binding and an inbound message resolve to the same `(channel_id, target_key)`
   * (issue #209 binding store v2). An explicit `requested` id must match the sole
   * configured channel, so a caller cannot bind under a channel id the router
   * would never key on.
   */
  private resolveChannelId(dispatcherId: string, requested?: string): string {
    const dispatcher = this.config.dispatchers.find(
      (entry) => entry.id === dispatcherId,
    );
    const ids = dispatcher
      ? dispatcher.channels.map((channel) => channel.id)
      : [];
    if (requested !== undefined) {
      if (!ids.includes(requested)) {
        throw new Error(
          `unknown channel_id '${requested}' for dispatcher '${dispatcherId}'; ` +
            `its configured channels are ${
              ids.length > 0 ? ids.map((id) => `'${id}'`).join(', ') : '(none)'
            }`,
        );
      }
      return requested;
    }
    // No explicit channel: a single-channel dispatcher resolves unambiguously
    // (legacy). With more than one channel the caller MUST name one, since
    // binding/egress under the wrong channel would key the wrong target.
    if (ids.length === 0) {
      throw new Error(
        `dispatcher '${dispatcherId}' has no resolvable channel`,
      );
    }
    if (ids.length > 1) {
      throw new Error(
        `dispatcher '${dispatcherId}' has ${ids.length} channels; ` +
          'channel_id is required to select one',
      );
    }
    return ids[0]!;
  }

  /**
   * The configured provider ref for a dispatcher's channel. Core reads it from
   * config (never hardcodes a provider) so a binding records the actual bound
   * channel's provider — feishu or any future channel provider.
   */
  private channelProviderRef(dispatcherId: string, channelId: string): string {
    const dispatcher = this.config.dispatchers.find(
      (entry) => entry.id === dispatcherId,
    );
    const channel = dispatcher?.channels.find((entry) => entry.id === channelId);
    if (channel === undefined) {
      throw new Error(
        `unknown channel_id '${channelId}' for dispatcher '${dispatcherId}'`,
      );
    }
    return channel.provider;
  }

  async routeChannelInput(
    dispatcherId: string,
    channelId: string,
    input: InboundTurnInput,
    envelope: ChannelInboundEnvelope,
    hooks?: InboundDeliveryHooks,
  ): Promise<AgentRuntimeTurnResult> {
    // `channelId` is the channel the message actually arrived through (the
    // originating live session tags it), so a multi-channel dispatcher keys on
    // the right channel rather than re-deriving a single one from config. The
    // neutral inbound envelope already carries the channel-resolved
    // `ChannelTarget`; core routes by (channel_id, target_key) without naming any
    // provider selector.
    const target = envelope.target;
    // Only a bindable target (a group) can carry an active Team binding; a P2P
    // (non-bindable) target always routes to the dispatcher, never a TeamLeader.
    if (target.bindable) {
      const binding = await this.teams.resolveChannel({
        dispatcherId,
        channelId,
        targetKey: target.target_key,
      });
      if (binding !== null) {
        const result = await this.teams.deliverToLeader({
          dispatcherId,
          teamId: binding.team_name,
          turn: input,
        });
        if (result.status === 'submitted') await hooks?.onAccepted?.(input);
        return result;
      }
    }
    const runtime = this.dispatchers.getRuntime(dispatcherId);
    if (runtime === null) return { status: 'stopped' };
    return runtime.channelInput(input, hooks);
  }

  async deliverTeamMateCompletion(
    dispatcherId: string,
    identity: TeamMateIdentity,
    completion: CompletionEnvelope,
    origin: TeamMateTurnOrigin | null = null,
  ): Promise<void> {
    // Routing is per turn, not per role: a TeamLeader turn fed by its bound
    // channel stays pull-only, but a dispatcher-initiated send/control turn to
    // that same leader returns to the dispatcher like any teammate. An
    // unattributed leader turn (origin null, e.g. settled after a restart lost
    // the in-memory origin map) defaults to pull-only so it can never inject
    // channel traffic into dispatcher context. The leader's own turns archive
    // captures the turn (#199 Slice 3 removed the separate team audit ledger).
    if (identity.role === 'team_leader' && origin !== 'dispatcher') {
      return;
    }
    if (identity.owner.kind === 'team' && identity.role === 'team_member') {
      const leader = this.teammates.getLiveRuntime(
        dispatcherId,
        identity.owner.leader_name,
      );
      if (leader?.completionInput !== undefined) {
        const result = await leader.completionInput(completion);
        if (result.status === 'accepted') return;
      }
    }
    await this.dispatchers.deliverCompletion(dispatcherId, completion);
  }

  spawnTeamMate(input: SpawnTeamMateInput) {
    return this.teammates.spawn(input);
  }

  sendTeamMate(input: SendTeamMateInput) {
    return this.teammates.send(input);
  }

  closeTeamMate(input: CloseTeamMateInput) {
    return this.teammates.close(input);
  }

  listTeamMates(dispatcherId: string) {
    return this.teammates.list(dispatcherId);
  }

  getTeamMateStatus(dispatcherId: string, name: string) {
    return this.teammates.status(dispatcherId, name);
  }

  getTeamMateHistory(input: TeamMateHistoryQuery) {
    return this.teammates.history(input);
  }

  getTeamMateLast(dispatcherId: string, name: string, turns?: number) {
    return this.teammates.last(dispatcherId, name, turns);
  }

  getTeamMateCapabilities() {
    return this.teammates.getCapabilities();
  }

  createTeam(input: TeamCreateInput) {
    return this.teams.create(input);
  }

  listTeams(dispatcherId: string) {
    return this.teams.list(dispatcherId);
  }

  getTeamStatus(dispatcherId: string, teamId: string) {
    return this.teams.status(dispatcherId, teamId);
  }

  getTeamHistory(input: TeamHistoryQuery) {
    return this.teams.history(input);
  }

  dissolveTeam(input: TeamDissolveInput) {
    return this.teams.dissolve(input);
  }

  /**
   * Bind a channel target to a Team (a core-owned Team capability, exposed on the
   * Team MCP). Core resolves `channel_id` and runs the channel's `resolveTarget`
   * (provider-owned) over the caller's `meta` selector at this edge, then passes
   * the resolved `(channel_id, target)` down to the Team service / store. `meta`
   * is opaque to core (e.g. a chat channel: `{ chat_id }`); the provider infers/validates the
   * target (group-only). A non-bindable (P2P) target is rejected fail-loud by the
   * store.
   */
  async bindTeamChannel(input: {
    dispatcherId: string;
    teamId: string;
    channelId?: string;
    meta: Record<string, unknown>;
  }) {
    const channelId = this.resolveChannelId(input.dispatcherId, input.channelId);
    const target = await this.dispatchers.resolveChannelTarget(
      input.dispatcherId,
      input.meta,
      channelId,
    );
    return this.teams.bindChannel({
      dispatcherId: input.dispatcherId,
      teamId: input.teamId,
      channelId,
      // The bound channel's own configured provider ref — core never hardcodes a
      // provider (issue #209 de-leak): a non-feishu channel binds under its ref.
      provider: this.channelProviderRef(input.dispatcherId, channelId),
      target,
    });
  }

  async transferTeamChannelBack(input: {
    dispatcherId: string;
    channelId?: string;
    meta: Record<string, unknown>;
  }) {
    const channelId = this.resolveChannelId(input.dispatcherId, input.channelId);
    const target = await this.dispatchers.resolveChannelTarget(
      input.dispatcherId,
      input.meta,
      channelId,
    );
    return this.teams.transferChannelBack({
      dispatcherId: input.dispatcherId,
      channelId,
      targetKey: target.target_key,
    });
  }

  /**
   * Whether a TeamLeader may use a channel target for egress, and through which
   * channel (issue #209 live multi-channel routing). The leader's egress channel
   * is resolved from its OWN active binding for the neutral `targetKey` — not a
   * single config-derived channel — so a leader bound on a secondary channel
   * replies through that channel's bot. Returns the resolved `channelId` (null
   * when the leader has no active binding for the target) so the egress path uses
   * the bound bot. The caller resolves `targetKey` via the channel session, so
   * core never names a provider selector here.
   */
  async teamLeaderCanUseChannel(input: {
    dispatcherId: string;
    teamId: string;
    leaderName: string;
    targetKey: string;
  }): Promise<{ allowed: boolean; channelId: string | null }> {
    const channelId = await this.teams.resolveLeaderChannel({
      dispatcherId: input.dispatcherId,
      teamId: input.teamId,
      leaderName: input.leaderName,
      targetKey: input.targetKey,
    });
    return { allowed: channelId !== null, channelId };
  }

  async shutdown(): Promise<void> {
    await this.teammates.stopAll();
    await this.dispatchers.shutdown();
  }
}
