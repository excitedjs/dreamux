import type {
  AgentRuntimeProviderCatalog,
  AgentRuntime,
  AgentRuntimeTurnResult,
  CompletionEnvelope,
} from '../agent-runtime/index.js';
import type { InboundDeliveryHooks, InboundTurnInput } from '../agent-runtime/turn.js';
import type { FeishuInboundEnvelope } from '../channel/feishu/feishu-channel.js';
import type { DreamuxConfig } from '../config/config.js';
import type { DispatcherStore } from '../state/dispatcher-store.js';
import type { DreamuxLogger } from '../platform/logger.js';
import type { FeishuBot } from '../channel/feishu/bot.js';
import type { DispatcherRow } from '../state/dispatcher-store.js';
import type { RestartIntentConsumer } from '../daemon/restart-intent.js';
import { adminSocketPath as defaultAdminSocketPath } from '../platform/paths.js';
import {
  DispatcherAgentService,
  type DispatcherSummary,
  type FeishuChannelToolCall,
} from './dispatcher/service.js';
import { TeamService } from './team/service.js';
import { TeamMateAgentService } from './teammate/service.js';
import { teammateMcpServerDescriptor } from './teammate/mcp-config.js';
import { feishuMcpServerDescriptor } from '../channel/feishu/feishu-mcp-surface.js';
import type {
  CloseTeamMateInput,
  TeamMateHistoryQuery,
  SendTeamMateInput,
  SpawnTeamMateInput,
  TeamMateIdentity,
  TeamMateTurnOrigin,
} from './teammate/types.js';
import type {
  TeamBindChannelInput,
  TeamCreateGroupInput,
  TeamCreateInput,
  TeamCreateGroupResult,
  TeamDissolveInput,
  TeamTransferChannelBackInput,
} from './team/types.js';

export interface DispatcherServiceOptions {
  config: DreamuxConfig;
  dispatchers: DispatcherStore;
  agentRuntimeProviders: AgentRuntimeProviderCatalog;
  adminSocketPath?: string;
  botFactory?: (row: DispatcherRow, secret: string) => FeishuBot;
  skipBotSecret?: boolean;
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

  constructor(opts: DispatcherServiceOptions) {
    this.dispatchers = new DispatcherAgentService({
      config: opts.config,
      dispatchers: opts.dispatchers,
      agentRuntimeProviders: opts.agentRuntimeProviders,
      log: opts.log,
      channelLoggerFactory: opts.channelLoggerFactory,
      ...(opts.adminSocketPath !== undefined
        ? { adminSocketPath: opts.adminSocketPath }
        : {}),
      ...(opts.botFactory !== undefined ? { botFactory: opts.botFactory } : {}),
      ...(opts.skipBotSecret !== undefined
        ? { skipBotSecret: opts.skipBotSecret }
        : {}),
      routeChannelInput: (id, turn, envelope, hooks) =>
        this.routeChannelInput(id, turn, envelope, hooks),
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
              feishuMcpServerDescriptor({
                dispatcherId,
                callerKind: 'team_leader',
                teamId: identity.team_id ?? '',
                leaderName: identity.name,
                adminSocketPath: opts.adminSocketPath ?? defaultAdminSocketPath(),
              }),
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
      createFeishuGroup: (input) => this.dispatchers.createFeishuGroup(input),
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

  callFeishuMcpTool(input: FeishuChannelToolCall) {
    return this.dispatchers.callFeishuMcpTool(input);
  }

  feishuMessageBelongsToChat(
    dispatcherId: string,
    messageId: string,
    chatId: string,
  ) {
    return this.dispatchers.feishuMessageBelongsToChat(dispatcherId, messageId, chatId);
  }

  async routeChannelInput(
    dispatcherId: string,
    input: InboundTurnInput,
    envelope: FeishuInboundEnvelope,
    hooks?: InboundDeliveryHooks,
  ): Promise<AgentRuntimeTurnResult> {
    const binding = await this.teams.resolveChannel({
      dispatcherId,
      provider: envelope.provider,
      chatId: envelope.chatId,
      chatType: envelope.chatType,
    });
    if (binding !== null) {
      const result = await this.teams.deliverToLeader({
        dispatcherId,
        teamId: binding.team_id,
        turn: input,
      });
      if (result.status === 'submitted') await hooks?.onAccepted?.(input);
      return result;
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
    // channel stays pull-only (ledger), but a dispatcher-initiated send/control
    // turn to that same leader returns to the dispatcher like any teammate.
    // An unattributed leader turn (origin null, e.g. settled after a restart
    // lost the in-memory origin map) defaults to the ledger so it can never
    // inject channel traffic into dispatcher context.
    if (identity.role === 'team_leader' && origin !== 'dispatcher') {
      await this.teams.recordLeaderTurn({
        dispatcherId,
        leaderName: identity.name,
        summary: completionSummary(completion),
      });
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

  getTeamMateHistoryEvents(dispatcherId: string, name: string) {
    return this.teammates.historyEvents(dispatcherId, name);
  }

  getTeamMateLast(dispatcherId: string, name: string) {
    return this.teammates.last(dispatcherId, name);
  }

  getTeamMateContext(dispatcherId: string, name: string) {
    return this.teammates.context(dispatcherId, name);
  }

  getTeamMateCapabilities() {
    return this.teammates.getCapabilities();
  }

  createTeam(input: TeamCreateInput) {
    return this.teams.create(input);
  }

  createTeamGroup(input: TeamCreateGroupInput): Promise<TeamCreateGroupResult> {
    return this.teams.createGroup(input);
  }

  listTeams(dispatcherId: string) {
    return this.teams.list(dispatcherId);
  }

  getTeamStatus(dispatcherId: string, teamId: string) {
    return this.teams.status(dispatcherId, teamId);
  }

  getTeamLedger(dispatcherId: string, teamId: string) {
    return this.teams.ledger(dispatcherId, teamId);
  }

  dissolveTeam(input: TeamDissolveInput) {
    return this.teams.dissolve(input);
  }

  bindTeamChannel(input: TeamBindChannelInput) {
    return this.teams.bindChannel(input);
  }

  transferTeamChannelBack(input: TeamTransferChannelBackInput) {
    return this.teams.transferChannelBack(input);
  }

  teamLeaderCanUseChannel(input: {
    dispatcherId: string;
    teamId: string;
    leaderName: string;
    provider: 'builtin:feishu';
    chatId: string;
  }) {
    return this.teams.teamLeaderCanUseChannel(input);
  }

  async shutdown(): Promise<void> {
    await this.teammates.stopAll();
    await this.dispatchers.shutdown();
  }
}

function completionSummary(completion: CompletionEnvelope): string {
  const preview = completion.result.replace(/\s+/g, ' ').trim();
  const bounded = preview.length <= 240 ? preview : `${preview.slice(0, 237)}...`;
  return bounded === ''
    ? `TeamLeader turn ${completion.status}`
    : `TeamLeader turn ${completion.status}: ${bounded}`;
}
