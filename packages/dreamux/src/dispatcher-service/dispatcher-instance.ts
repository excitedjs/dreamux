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
  ScopedCloseTeamMateInput,
  ScopedSendTeamMateInput,
  ScopedSpawnTeamMateInput,
  TeamMateAgentService,
} from './teammate/service.js';
import {
  dispatcherPrincipal,
  teamLeaderPrincipal,
  type TeamMateCallerPrincipal,
  type TeamMateHistoryQuery,
  type TeamMateIdentity,
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

export class TeammateRoster {
  constructor(
    private readonly teammateAgents: TeamMateAgentService,
    private readonly principal: TeamMateCallerPrincipal,
  ) {}

  spawn(input: Omit<ScopedSpawnTeamMateInput, 'principal'>) {
    return this.teammateAgents.spawnScoped({
      principal: this.principal,
      ...input,
    });
  }

  send(input: Omit<ScopedSendTeamMateInput, 'principal'>) {
    return this.teammateAgents.sendScoped({
      principal: this.principal,
      ...input,
    });
  }

  close(input: Omit<ScopedCloseTeamMateInput, 'principal'>) {
    return this.teammateAgents.closeScoped({
      principal: this.principal,
      ...input,
    });
  }

  list() {
    return this.teammateAgents.listScoped(this.principal);
  }

  status(name: string) {
    return this.teammateAgents.statusScoped(this.principal, name);
  }

  history(input: Omit<TeamMateHistoryQuery, 'dispatcherId' | 'principal'>) {
    return this.teammateAgents.historyScoped({
      principal: this.principal,
      ...input,
    });
  }

  last(name: string, turns?: number) {
    return this.teammateAgents.lastScoped(this.principal, name, turns);
  }

  capabilities() {
    return this.teammateAgents.getCapabilities();
  }
}

export class TeamTeammateRoster {
  constructor(
    private readonly teammateAgents: TeamMateAgentService,
    private readonly teamManager: TeamManager,
    private readonly dispatcherId: string,
    private readonly teamId: string,
  ) {}

  async spawn(input: Omit<ScopedSpawnTeamMateInput, 'principal'>) {
    return this.teammateAgents.spawnScoped({
      principal: await this.principal(),
      ...input,
      sharedWorkspace: await this.teamManager.sharedWorkspace(
        this.dispatcherId,
        this.teamId,
      ),
    });
  }

  async send(input: Omit<ScopedSendTeamMateInput, 'principal'>) {
    return this.teammateAgents.sendScoped({
      principal: await this.principal(),
      ...input,
    });
  }

  async close(input: Omit<ScopedCloseTeamMateInput, 'principal'>) {
    return this.teammateAgents.closeScoped({
      principal: await this.principal(),
      ...input,
    });
  }

  async list() {
    return this.teammateAgents.listScoped(await this.principal());
  }

  async status(name: string) {
    return this.teammateAgents.statusScoped(await this.principal(), name);
  }

  async history(input: Omit<TeamMateHistoryQuery, 'dispatcherId' | 'principal'>) {
    return this.teammateAgents.historyScoped({
      principal: await this.principal(),
      ...input,
    });
  }

  async last(name: string, turns?: number) {
    return this.teammateAgents.lastScoped(await this.principal(), name, turns);
  }

  capabilities() {
    return this.teammateAgents.getCapabilities();
  }

  private async principal(): Promise<TeamMateCallerPrincipal> {
    const summary = await this.teamManager.status(this.dispatcherId, this.teamId);
    return teamLeaderPrincipal({
      dispatcherId: this.dispatcherId,
      teamId: this.teamId,
      leaderName: summary.team.leader_name,
    });
  }
}

export class DispatcherService {
  readonly teammates: TeammateRoster;
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
    this.teammates = new TeammateRoster(
      this.teammateAgents,
      dispatcherPrincipal(this.id),
    );
  }

  teammatesFor(principal: TeamMateCallerPrincipal): TeammateRoster {
    return new TeammateRoster(this.teammateAgents, principal);
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
    caller: TeamMateCallerPrincipal;
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

  sharedTeamWorkspace(teamId: string) {
    return this.team(teamId).sharedWorkspace();
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
    if (identity.owner.kind === 'team' && identity.role === 'team_member') {
      const leader = this.teammateAgents.getLiveRuntime(
        this.id,
        identity.owner.leader_name,
      );
      if (leader?.completionInput !== undefined) {
        const result = await leader.completionInput(completion);
        if (result.status === 'accepted') return;
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
  readonly teammates: TeamTeammateRoster;
  private readonly dispatcherId: string;
  readonly id: string;

  constructor(private readonly opts: TeamServiceOptions) {
    this.dispatcherId = opts.dispatcherId;
    this.id = opts.teamId;
    this.teammates = new TeamTeammateRoster(
      opts.teammateAgents,
      opts.teamManager,
      opts.dispatcherId,
      opts.teamId,
    );
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
