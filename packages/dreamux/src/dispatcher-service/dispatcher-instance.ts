import type {
  AgentRuntimeMcpServer,
  AgentRuntimeTurnResult,
  ChannelInboundEnvelope,
  ChannelTarget,
  CompletionEnvelope,
  InboundDeliveryHooks,
  InboundTurnInput,
} from '@excitedjs/dreamux-types';

import type { DreamuxConfig } from '../config/config.js';
import type { RestartIntentConsumer } from '../daemon/restart-intent.js';
import type {
  DispatcherRuntimeService,
  DispatcherSummary,
} from './dispatcher/service.js';
import type { ChannelMcpCallerScope } from './dispatcher/mcp-descriptors.js';
import { ChannelToolAuthorizationError } from './errors.js';
import type { DispatcherRow } from '../state/dispatcher-store.js';
import type {
  SpawnTeamMateRequest,
  TeamMateAgentService,
} from './teammate/service.js';
import {
  type CloseTeamMateInput,
  type SendTeamMateInput,
  type TeamMateHistoryQuery,
  type TeamMateIdentity,
  type TeamMateRuntimeStatus,
  type TeamMateTurnOrigin,
} from './teammate/types.js';
import type { TeamManager } from './team/service.js';
import type {
  TeamCreateInput,
  TeamDissolveInput,
  TeamHistoryQuery,
} from './team/types.js';
import { validateTeamId } from './team/types.js';

export interface DispatcherServiceOptions {
  id: string;
  config: DreamuxConfig;
  dispatcherRuntime: DispatcherRuntimeService;
  teammateAgents: TeamMateAgentService;
  teamManager: TeamManager;
}

export type ChannelToolCaller =
  | { kind: 'dispatcher' }
  | { kind: 'team_leader'; teamId: string; leaderName: string };

export class DispatcherService {
  readonly id: string;
  private readonly config: DreamuxConfig;
  private readonly dispatcherRuntime: DispatcherRuntimeService;
  private readonly teammateAgents: TeamMateAgentService;
  private readonly teamManager: TeamManager;
  private readonly teams = new Map<string, TeamService>();

  constructor(opts: DispatcherServiceOptions) {
    this.id = opts.id;
    this.config = opts.config;
    this.dispatcherRuntime = opts.dispatcherRuntime;
    this.teammateAgents = opts.teammateAgents;
    this.teamManager = opts.teamManager;
  }

  team(teamId: string): TeamService {
    const id = validateTeamId(teamId);
    let team = this.teams.get(id);
    if (team === undefined) {
      team = new TeamService({
        dispatcherId: this.id,
        teamId: id,
        dispatcher: this,
        teamManager: this.teamManager,
        dispatcherRuntime: this.dispatcherRuntime,
        teammateAgents: this.teammateAgents,
      });
      this.teams.set(id, team);
    }
    return team;
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

  shutdown(): Promise<void> {
    return this.dispatcherRuntime.shutdown();
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
    return this.teammateAgents.dispatcherWorkspace(this.id);
  }

  spawnTeamMate(
    input: Omit<SpawnTeamMateRequest, 'dispatcherId' | 'teamId' | 'sharedWorkspace'>,
  ) {
    return this.teammateAgents.spawn({
      dispatcherId: this.id,
      ...input,
    });
  }

  sendTeamMate(input: Omit<SendTeamMateInput, 'dispatcherId' | 'teamId'>) {
    return this.teammateAgents.send({
      dispatcherId: this.id,
      ...input,
    });
  }

  closeTeamMate(input: Omit<CloseTeamMateInput, 'dispatcherId' | 'teamId'>) {
    return this.teammateAgents.close({
      dispatcherId: this.id,
      ...input,
    });
  }

  listTeamMates(): Promise<TeamMateRuntimeStatus[]> {
    return this.teammateAgents.list(this.id);
  }

  getTeamMateStatus(name: string) {
    return this.teammateAgents.status(this.id, name);
  }

  getTeamMateHistory(input: Omit<TeamMateHistoryQuery, 'dispatcherId' | 'teamId'>) {
    return this.teammateAgents.history({
      dispatcherId: this.id,
      ...input,
    });
  }

  getTeamMateLast(name: string, turns?: number) {
    return this.teammateAgents.last(this.id, name, turns);
  }

  getTeamMateCapabilities() {
    return this.teammateAgents.getCapabilities();
  }

  createTeam(input: Omit<TeamCreateInput, 'dispatcherId'>) {
    return this.team(input.name).create(input);
  }

  listTeams() {
    return this.teamManager.list(this.id);
  }

  getTeamStatus(teamId: string) {
    return this.team(teamId).status();
  }

  getTeamHistory(input: Omit<TeamHistoryQuery, 'dispatcherId'>) {
    return this.teamManager.history({ dispatcherId: this.id, ...input });
  }

  dissolveTeam(input: Omit<TeamDissolveInput, 'dispatcherId'>) {
    return this.team(input.teamId).dissolve(input);
  }

  bindTeamChannel(input: {
    teamId: string;
    channelId?: string;
    meta: Record<string, unknown>;
  }) {
    return this.team(input.teamId).bindChannel(input);
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
    return this.teamManager.transferChannelBack({
      dispatcherId: this.id,
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
      const binding = await this.teamManager.resolveChannel({
        dispatcherId: this.id,
        channelId,
        targetKey: target.target_key,
      });
      if (binding !== null) {
        const result = await this.team(binding.team_name).deliverToLeader(input);
        if (result.status === 'submitted') await hooks?.onAccepted?.(input);
        return result;
      }
    }
    const runtime = this.dispatcherRuntime.getRuntime();
    if (runtime === null) return { status: 'stopped' };
    return runtime.channelInput(input, hooks);
  }

  async deliverTeamMateCompletion(
    identity: TeamMateIdentity,
    completion: CompletionEnvelope,
    origin: TeamMateTurnOrigin | null = null,
  ): Promise<void> {
    if (identity.role === 'team_leader' && origin !== 'dispatcher') return;
    if (identity.role === 'team_member' && identity.team_id !== null) {
      const summary = await this.teamManager
        .status(this.id, identity.team_id)
        .catch(() => null);
      if (summary !== null) {
        const leader = this.teammateAgents.getLiveRuntime(
          this.id,
          summary.team.leader_name,
        );
        if (leader?.completionInput !== undefined) {
          const result = await leader.completionInput(completion);
          if (result.status === 'accepted') return;
        }
      }
    }
    await this.dispatcherRuntime.deliverCompletion(completion);
  }

  async teamLeaderCanUseChannel(input: {
    teamId: string;
    leaderName: string;
    targetKey: string;
  }): Promise<{ allowed: boolean; channelId: string | null }> {
    const channelId = await this.team(input.teamId).resolveLeaderChannel({
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

  private dispatcherConfig() {
    return this.config.dispatchers.find((entry) => entry.id === this.id);
  }
}

export interface TeamServiceOptions {
  dispatcherId: string;
  teamId: string;
  dispatcher: DispatcherService;
  teamManager: TeamManager;
  dispatcherRuntime: DispatcherRuntimeService;
  teammateAgents: TeamMateAgentService;
}

export class TeamService {
  private readonly dispatcherId: string;
  readonly id: string;

  constructor(private readonly opts: TeamServiceOptions) {
    this.dispatcherId = opts.dispatcherId;
    this.id = opts.teamId;
  }

  create(input: Omit<TeamCreateInput, 'dispatcherId'>) {
    return this.opts.teamManager.create({
      dispatcherId: this.dispatcherId,
      ...input,
    });
  }

  status() {
    return this.opts.teamManager.status(this.dispatcherId, this.id);
  }

  async spawnTeamMate(
    input: Omit<SpawnTeamMateRequest, 'dispatcherId' | 'teamId' | 'sharedWorkspace'>,
  ) {
    return this.opts.teammateAgents.spawn({
      dispatcherId: this.dispatcherId,
      teamId: this.id,
      ...input,
      sharedWorkspace: await this.sharedWorkspace(),
    });
  }

  sendTeamMate(input: Omit<SendTeamMateInput, 'dispatcherId' | 'teamId'>) {
    return this.opts.teammateAgents.send({
      dispatcherId: this.dispatcherId,
      teamId: this.id,
      ...input,
    });
  }

  closeTeamMate(input: Omit<CloseTeamMateInput, 'dispatcherId' | 'teamId'>) {
    return this.opts.teammateAgents.close({
      dispatcherId: this.dispatcherId,
      teamId: this.id,
      ...input,
    });
  }

  listTeamMates(): Promise<TeamMateRuntimeStatus[]> {
    return this.opts.teammateAgents.list(this.dispatcherId, this.id);
  }

  getTeamMateStatus(name: string) {
    return this.opts.teammateAgents.status(this.dispatcherId, name, this.id);
  }

  getTeamMateHistory(input: Omit<TeamMateHistoryQuery, 'dispatcherId' | 'teamId'>) {
    return this.opts.teammateAgents.history({
      dispatcherId: this.dispatcherId,
      teamId: this.id,
      ...input,
    });
  }

  getTeamMateLast(name: string, turns?: number) {
    return this.opts.teammateAgents.last(
      this.dispatcherId,
      name,
      turns,
      this.id,
    );
  }

  getTeamMateCapabilities() {
    return this.opts.teammateAgents.getCapabilities();
  }

  dissolve(input: Omit<TeamDissolveInput, 'dispatcherId'>) {
    return this.opts.teamManager.dissolve({
      dispatcherId: this.dispatcherId,
      ...input,
    });
  }

  async bindChannel(input: {
    channelId?: string;
    meta: Record<string, unknown>;
  }) {
    const channelId = this.opts.dispatcher.resolveChannelId(input.channelId);
    const target = await this.opts.dispatcherRuntime.resolveChannelTarget(
      input.meta,
      channelId,
    );
    return this.opts.teamManager.bindChannel({
      dispatcherId: this.dispatcherId,
      teamId: this.id,
      channelId,
      provider: this.opts.dispatcher.channelProviderRef(channelId),
      target,
    });
  }

  deliverToLeader(turn: InboundTurnInput) {
    return this.opts.teamManager.deliverToLeader({
      dispatcherId: this.dispatcherId,
      teamId: this.id,
      turn,
    });
  }

  resolveLeaderChannel(input: {
    leaderName: string;
    targetKey: string;
  }) {
    return this.opts.teamManager.resolveLeaderChannel({
      dispatcherId: this.dispatcherId,
      teamId: this.id,
      leaderName: input.leaderName,
      targetKey: input.targetKey,
    });
  }

  sharedWorkspace() {
    return this.opts.teamManager.sharedWorkspace(this.dispatcherId, this.id);
  }
}
