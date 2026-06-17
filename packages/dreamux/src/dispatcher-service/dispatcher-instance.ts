import type {
  AgentRuntimeMcpServer,
  AgentRuntimeTurnResult,
  ChannelInboundEnvelope,
  ChannelTarget,
  CompletionEnvelope,
  InboundDeliveryHooks,
  InboundTurnInput,
  TeamMateCompletionDeliveryResult,
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
import type { CompletionInitiator } from './teammate/completion-router.js';
import type {
  SpawnTeamMateRequest,
  TeammateCollection,
} from './teammate/service.js';
import {
  type CloseTeamMateInput,
  type SendTeamMateInput,
  type TeamMateHistoryQuery,
  type TeamMateIdentity,
  type TeamMateRuntimeStatus,
} from './teammate/types.js';
import type { TeamChannelContext } from './team/service.js';
import type { TeamCollection } from './team/service.js';
import type {
  TeamCreateInput,
  TeamDissolveInput,
  TeamHistoryQuery,
} from './team/types.js';

export interface DispatcherServiceOptions {
  id: string;
  config: DreamuxConfig;
  dispatcherRuntime: DispatcherRuntimeService;
  teammates: TeammateCollection;
  teams: TeamCollection;
}

export type ChannelToolCaller =
  | { kind: 'dispatcher' }
  | { kind: 'team_leader'; teamId: string; leaderName: string };

export class DispatcherService implements TeamChannelContext {
  readonly id: string;
  private readonly config: DreamuxConfig;
  private readonly dispatcherRuntime: DispatcherRuntimeService;
  private readonly teammates: TeammateCollection;
  private readonly teams: TeamCollection;

  constructor(opts: DispatcherServiceOptions) {
    this.id = opts.id;
    this.config = opts.config;
    this.dispatcherRuntime = opts.dispatcherRuntime;
    this.teammates = opts.teammates;
    this.teams = opts.teams;
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
    return this.teammates.dispatcherWorkspace(this.id);
  }

  spawnTeamMate(
    input: Omit<SpawnTeamMateRequest, 'dispatcherId' | 'teamId' | 'sharedWorkspace'>,
  ) {
    return this.teammates.spawn({
      dispatcherId: this.id,
      ...input,
    });
  }

  sendTeamMate(input: Omit<SendTeamMateInput, 'dispatcherId' | 'teamId'>) {
    return this.teammates.send({
      dispatcherId: this.id,
      ...input,
    });
  }

  closeTeamMate(input: Omit<CloseTeamMateInput, 'dispatcherId' | 'teamId'>) {
    return this.teammates.close({
      dispatcherId: this.id,
      ...input,
    });
  }

  listTeamMates(): Promise<TeamMateRuntimeStatus[]> {
    return this.teammates.list(this.id);
  }

  getTeamMateStatus(name: string) {
    return this.teammates.status(this.id, name);
  }

  getTeamMateHistory(input: Omit<TeamMateHistoryQuery, 'dispatcherId' | 'teamId'>) {
    return this.teammates.history({
      dispatcherId: this.id,
      ...input,
    });
  }

  getTeamMateLast(name: string, turns?: number) {
    return this.teammates.last(this.id, name, turns);
  }

  getTeamMateCapabilities() {
    return this.teammates.getCapabilities();
  }

  /** The single-entity team service for a team id (admin `team_leader` target). */
  team(teamId: string) {
    return this.teams.get(this.id, teamId);
  }

  createTeam(input: Omit<TeamCreateInput, 'dispatcherId'>) {
    return this.teams.create({ dispatcherId: this.id, ...input });
  }

  listTeams() {
    return this.teams.list(this.id);
  }

  async getTeamStatus(teamId: string) {
    return (await this.teams.get(this.id, teamId)).status();
  }

  getTeamHistory(input: Omit<TeamHistoryQuery, 'dispatcherId'>) {
    return this.teams.history({ dispatcherId: this.id, ...input });
  }

  async dissolveTeam(input: Omit<TeamDissolveInput, 'dispatcherId'>) {
    return (await this.teams.get(this.id, input.teamId)).dissolve(input);
  }

  async bindTeamChannel(input: {
    teamId: string;
    channelId?: string;
    meta: Record<string, unknown>;
  }) {
    const team = await this.teams.get(this.id, input.teamId);
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
      const binding = await this.teams.resolveChannel({
        dispatcherId: this.id,
        channelId,
        targetKey: target.target_key,
      });
      if (binding !== null) {
        const team = await this.teams.get(this.id, binding.team_name);
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
      const team = await this.teams.get(this.id, producer.team_id).catch(() => null);
      if (team === null) return this.dispatcherInitiator();
      const leader = this.teammates.get(this.id, team.leaderName);
      return leader ?? this.dispatcherInitiator();
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
    const team = await this.teams.get(this.id, input.teamId).catch(() => null);
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
