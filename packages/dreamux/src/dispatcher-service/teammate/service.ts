import type { AgentRuntimeProviderCatalog } from '../../agent-runtime/index.js';
import type {
  AgentRuntime,
  AgentRuntimeTurnResult,
  AgentRuntimeMcpServer,
  CompletionEnvelope,
} from '@excitedjs/dreamux-types';
import type { DreamuxConfig } from '../../config/config.js';
import type { DispatcherStore } from '../../state/dispatcher-store.js';
import type { DreamuxLogger } from '@excitedjs/dreamux-types';
import {
  agentRuntimeCapability,
  defaultAgentRuntime,
  resolveAgent,
} from './agent-config.js';
import { deliverTeamMateTurnSettled } from './completion-delivery.js';
import { TeamMateIdentityStore } from './identity-store.js';
import {
  type LiveTeamMate,
  type LiveTeamMateSettledInput,
  LiveTeamMateRegistry,
  recordTurnOrigin,
} from './live-runtime.js';
import { TeammateReadModel } from './read-model.js';
import { TeamMateTurnsStore } from './turns-store.js';
import { allocateConcreteName, type SuffixGenerator } from './name-allocator.js';
import {
  recordSettledTurn,
  recordSubmittedTurn,
  toTurnResult,
} from './turn-recording.js';
import {
  assertManagedWorktreeAvailable,
  dispatcherWorkspace,
  reprepareDeletedManagedWorktree,
  resolveSpawnWorkspace,
} from './workspaces.js';
import { WorktreeManager } from './worktree-manager.js';
import {
  requireLifecycleText,
  validateTeamMateName,
  type CloseTeamMateInput,
  type SendTeamMateInput,
  type SpawnTeamMateInput,
  type TeamMateCapabilities,
  type TeamMateCloseResult,
  type CreateTeamLeaderInput,
  type TeamMateHistoryQuery,
  type TeamMateHistoryResult,
  type TeamMateIdentity,
  type TeamMateLastResult,
  type TeamMateRole,
  type TeamMateRuntimeStatus,
  type TeamMateSendResult,
  type TeamMateSpawnResult,
  type TeamMateTurnOrigin,
  type TeamMateTurnResult,
  type TeamMateWorktreeIdentity,
} from './types.js';

export interface TeamMateAgentServiceOptions {
  config: DreamuxConfig;
  dispatchers: DispatcherStore;
  agentRuntimeProviders: AgentRuntimeProviderCatalog;
  mcpServersForTeamMate?: (input: {
    dispatcherId: string;
    name: string;
    identity: TeamMateIdentity;
  }) => readonly AgentRuntimeMcpServer[];
    onTeamMateCompletion?: (
    dispatcherId: string,
    identity: TeamMateIdentity,
    completion: CompletionEnvelope,
        origin: TeamMateTurnOrigin | null,
  ) => void | Promise<void>;
    suffixGenerator?: SuffixGenerator;
  log: DreamuxLogger;
}

export interface TeamMateSharedWorkspace {
  sourceCwd: string;
  sourceRepo: string | null;
  runtimeCwd: string;
  worktree: TeamMateWorktreeIdentity;
}

export type SpawnTeamMateRequest = SpawnTeamMateInput & {
  sharedWorkspace?: TeamMateSharedWorkspace;
};

export class TeamMateAgentService {
  private readonly identities: TeamMateIdentityStore;
  private readonly turnsStore: TeamMateTurnsStore;
  private readonly readModel: TeammateReadModel;
  private readonly runtimes: LiveTeamMateRegistry;
  private readonly worktrees = new WorktreeManager();
  private submissionSeq = 0;
    private readonly inFlightSettleCaptures = new Set<Promise<void>>();

  constructor(private readonly opts: TeamMateAgentServiceOptions) {
    this.identities = new TeamMateIdentityStore({ warn: opts.log.warn.bind(opts.log) });
    this.turnsStore = new TeamMateTurnsStore({ warn: opts.log.warn.bind(opts.log) });
    this.runtimes = new LiveTeamMateRegistry({
      identities: this.identities,
      log: opts.log,
      ...(opts.mcpServersForTeamMate !== undefined
        ? { mcpServersForTeamMate: opts.mcpServersForTeamMate }
        : {}),
    });
    this.readModel = new TeammateReadModel({
      identities: this.identities,
      turnsStore: this.turnsStore,
      runtimeFor: (dispatcherId, name) =>
        this.runtimes.getRuntime(dispatcherId, name),
    });
  }

    turns(): TeamMateTurnsStore {
    return this.turnsStore;
  }

    async allocateLeaderName(dispatcherId: string, teamId: string): Promise<string> {
    return this.allocateName(dispatcherId, 'team_leader', teamId, teamId);
  }

    private async allocateName(
    dispatcherId: string,
    role: TeamMateRole,
    base: string,
    teamSlug?: string,
  ): Promise<string> {
    const identities = await this.identities.list(dispatcherId);
    const taken = new Set(identities.map((identity) => identity.name));
    return allocateConcreteName({
      role,
      base,
      ...(teamSlug !== undefined ? { teamSlug } : {}),
      exists: (candidate) => taken.has(candidate),
      ...(this.opts.suffixGenerator !== undefined
        ? { generateSuffix: this.opts.suffixGenerator }
        : {}),
    });
  }

  async spawn(input: SpawnTeamMateRequest): Promise<TeamMateSpawnResult> {
    const dispatcherId = input.dispatcherId;
    const requestedName = requireLifecycleText(input.name, 'TeamMate spawn name');
    requireLifecycleText(input.intent, 'TeamMate spawn intent');
    if (input.teamId !== undefined && input.sharedWorkspace === undefined) {
      throw new Error('Team member spawn requires a shared team workspace');
    }
    const role: TeamMateRole =
      input.teamId !== undefined ? 'team_member' : 'teammate';
    const name = await this.allocateName(dispatcherId, role, requestedName);
    const agentRuntimeId =
      input.agentRuntime ?? defaultAgentRuntime(this.opts.config, dispatcherId);
    const agent = resolveAgent(this.opts.config, dispatcherId, agentRuntimeId);
    const provider = this.opts.agentRuntimeProviders.resolve(agent.provider);
    const workspace = await resolveSpawnWorkspace({
      config: this.opts.config,
      worktrees: this.worktrees,
      dispatcherId,
      name,
      request: input,
    });
    if (input.sharedWorkspace === undefined) {
      await assertManagedWorktreeAvailable({
        identities: this.identities,
        dispatcherId,
        name,
        worktree: workspace.worktree,
      });
    }
    let identity = await this.identities.create({
      dispatcherId,
      name,
      role,
      teamId: input.teamId ?? null,
      agentRuntime: agentRuntimeId,
      sourceCwd: workspace.sourceCwd,
      sourceRepo: workspace.sourceRepo,
      cwd: workspace.runtimeCwd,
      runtimeCwd: workspace.runtimeCwd,
      worktree: workspace.worktree,
      intent: input.intent,
      status: 'starting',
    });
    const live = await this.runtimes.start({
      dispatcherId,
      identity,
      provider,
      agent,
      ...(this.opts.onTeamMateCompletion !== undefined
        ? {
            onTurnSettled: (settled) =>
              this.captureSettledTurn(dispatcherId, identity, settled),
          }
        : {}),
    });
    identity = live.state.current();
    const turn = await this.submitPrompt(dispatcherId, name, input.prompt, {
      teamId: input.teamId,
    });
    await recordSubmittedTurn(this.turnsStore, dispatcherId, live, {
      turnId: turn.turn_id ?? null,
      turnOrigin: turnOriginForTeamId(input.teamId),
      prompt: input.prompt,
    });
    return { teammate: this.readModel.toStatus(live.state.current(), live.runtime), turn };
  }

  async send(input: SendTeamMateInput): Promise<TeamMateSendResult> {
    const dispatcherId = input.dispatcherId;
    const live = await this.ensureRuntime(dispatcherId, input.name, {
      teamId: input.teamId,
      reopenClosed: true,
    });
    if (input.intent !== undefined && input.intent !== '') {
      await live.state.updateIntent(input.intent);
    }
    const turn = await this.submitPrompt(dispatcherId, input.name, input.prompt, {
      teamId: input.teamId,
    });
    await recordSubmittedTurn(this.turnsStore, dispatcherId, live, {
      turnId: turn.turn_id ?? null,
      turnOrigin: turnOriginForTeamId(input.teamId),
      prompt: input.prompt,
    });
    return { teammate: this.readModel.toStatus(live.state.current(), live.runtime), turn };
  }

  async close(input: CloseTeamMateInput): Promise<TeamMateCloseResult> {
    const dispatcherId = input.dispatcherId;
    const name = validateTeamMateName(input.name);
    const identity = await this.readModel.mustIdentity(
      dispatcherId,
      name,
      input.teamId,
    );
    requireLifecycleText(input.note, 'TeamMate close note');
    const live = this.runtimes.get(dispatcherId, name);
    if (live !== undefined) {
      await live.runtime.stop();
      this.runtimes.delete(dispatcherId, name);
    }
    const closed = await this.identities.update(identity, {
      status: 'closed',
      closedAt: Date.now(),
      closeNote: input.note,
      lastSeenAt: Date.now(),
      worktree: await this.worktrees.cleanup(identity),
    });
    return { teammate: this.readModel.toStatus(closed, null) };
  }

  async list(
    dispatcherId: string,
    teamId?: string,
  ): Promise<TeamMateRuntimeStatus[]> {
    return this.readModel.list(dispatcherId, teamId);
  }

  async status(
    dispatcherId: string,
    name: string,
    teamId?: string,
  ): Promise<TeamMateRuntimeStatus> {
    return this.readModel.status(dispatcherId, name, teamId);
  }

  async history(input: TeamMateHistoryQuery): Promise<TeamMateHistoryResult> {
    return this.readModel.history(input);
  }

  async last(
    dispatcherId: string,
    name: string,
    turns?: number,
    teamId?: string,
  ): Promise<TeamMateLastResult> {
    return this.readModel.last(dispatcherId, name, turns, teamId);
  }

  async channelInput(
    dispatcherId: string,
    teamId: string,
    name: string,
    input: import('@excitedjs/dreamux-types').InboundTurnInput,
  ): Promise<AgentRuntimeTurnResult> {
    const live = await this.ensureRuntime(dispatcherId, name, {
      teamId,
      reopenClosed: true,
    });
    const result = await live.runtime.channelInput(input);
    if (result.status === 'submitted') {
      recordTurnOrigin(live, result.turnId, 'channel');
      await recordSubmittedTurn(this.turnsStore, dispatcherId, live, {
        turnId: result.turnId,
        turnOrigin: 'channel',
        prompt: input.text,
      });
    }
    return result;
  }

  async createTeamLeader(input: CreateTeamLeaderInput): Promise<TeamMateSpawnResult> {
    const name = validateTeamMateName(input.name);
    const existing = await this.identities.get(input.dispatcherId, name);
    if (existing !== null) {
      throw new Error(`TeamLeader ${JSON.stringify(name)} already exists`);
    }
    const agent = resolveAgent(
      this.opts.config,
      input.dispatcherId,
      input.agentRuntime,
    );
    const provider = this.opts.agentRuntimeProviders.resolve(agent.provider);
    let identity = await this.identities.create({
      dispatcherId: input.dispatcherId,
      name,
      role: 'team_leader',
      teamId: input.teamId,
      agentRuntime: input.agentRuntime,
      sourceCwd: input.sourceCwd,
      sourceRepo: input.sourceRepo,
      cwd: input.runtimeCwd,
      runtimeCwd: input.runtimeCwd,
      worktree: input.worktree,
      intent: input.intent ?? null,
      status: 'starting',
    });
    const live = await this.runtimes.start({
      dispatcherId: input.dispatcherId,
      identity,
      provider,
      agent,
      ...(this.opts.onTeamMateCompletion !== undefined
        ? {
            onTurnSettled: (settled) =>
              this.captureSettledTurn(input.dispatcherId, identity, settled),
          }
        : {}),
    });
    identity = live.state.current();
    const turn = await this.submitPrompt(input.dispatcherId, name, input.prompt, {
      teamId: input.teamId,
      turnOrigin: 'dispatcher',
    });
    await recordSubmittedTurn(this.turnsStore, input.dispatcherId, live, {
      turnId: turn.turn_id ?? null,
      turnOrigin: 'dispatcher',
      prompt: input.prompt,
    });
    return { teammate: this.readModel.toStatus(live.state.current(), live.runtime), turn };
  }

  getCapabilities(): TeamMateCapabilities {
    return {
      verbs: [
        'spawn',
        'send',
        'close',
        'history',
        'list',
        'status',
        'last',
        'get_capabilities',
      ],
      agent_runtimes: Object.entries(this.opts.config.agents).map(
        ([agentRuntimeId, agent]) =>
          agentRuntimeCapability(
            this.opts.agentRuntimeProviders,
            agentRuntimeId,
            agent,
          ),
      ),
    };
  }

  async stopAll(): Promise<void> {
    await this.runtimes.stopAll();
    while (this.inFlightSettleCaptures.size > 0) {
      await Promise.allSettled([...this.inFlightSettleCaptures]);
    }
  }

  getLiveRuntime(dispatcherId: string, name: string): AgentRuntime | null {
    return this.runtimes.getRuntime(dispatcherId, validateTeamMateName(name));
  }

  private async ensureRuntime(
    dispatcherId: string,
    name: string,
    opts: { teamId?: string; reopenClosed?: boolean } = {},
  ): Promise<LiveTeamMate> {
    const teammateName = validateTeamMateName(name);
    const existing = this.runtimes.get(dispatcherId, teammateName);
    if (existing !== undefined) {
      this.readModel.assertInRoster(
        existing.state.current(),
        dispatcherId,
        opts.teamId,
      );
      return existing;
    }
    let identity = await this.readModel.mustIdentity(
      dispatcherId,
      teammateName,
      opts.teamId,
    );
    if (identity.status === 'closed') {
      if (opts.reopenClosed !== true) {
        throw new Error(`TeamMate ${JSON.stringify(teammateName)} is closed`);
      }
      identity = await reprepareDeletedManagedWorktree({
        config: this.opts.config,
        identities: this.identities,
        worktrees: this.worktrees,
        identity,
      });
      identity = await this.identities.update(identity, {
        status: 'starting',
        closedAt: null,
        closeNote: null,
        lastError: null,
      });
    }
    const agent = resolveAgent(
      this.opts.config,
      dispatcherId,
      identity.agent_runtime,
    );
    const provider = this.opts.agentRuntimeProviders.resolve(agent.provider);
    return this.runtimes.start({
      dispatcherId,
      identity,
      provider,
      agent,
      ...(this.opts.onTeamMateCompletion !== undefined
        ? {
            onTurnSettled: (settled) =>
              this.captureSettledTurn(dispatcherId, identity, settled),
          }
        : {}),
    });
  }

  private captureSettledTurn(
    dispatcherId: string,
    identity: TeamMateIdentity,
    settled: LiveTeamMateSettledInput,
  ): void {
    const sink = this.opts.onTeamMateCompletion;
    if (sink === undefined) return;
    const capture = deliverTeamMateTurnSettled({
      dispatcherId,
      name: identity.name,
      identity,
      runtime: settled.runtime,
      settled: settled.settled,
      turnOrigins: settled.turnOrigins,
      sink,
      log: this.opts.log,
      recordSettledTurn: (input) =>
        recordSettledTurn(
          this.turnsStore,
          dispatcherId,
          identity.name,
          settled.state,
          input,
        ),
    });
    this.inFlightSettleCaptures.add(capture);
    void capture.finally(() => {
      this.inFlightSettleCaptures.delete(capture);
    });
  }

  private async submitPrompt(
    dispatcherId: string,
    name: string,
    prompt: string,
    opts: { teamId?: string; turnOrigin?: TeamMateTurnOrigin } = {},
  ): Promise<TeamMateTurnResult> {
    const live = await this.ensureRuntime(dispatcherId, name, opts);
    const submissionSeq = ++this.submissionSeq;
    const result = await live.runtime.channelInput({
      sourceId: `teammate:${name}:${submissionSeq}`,
      text: prompt,
    });
    if (result.status === 'submitted') {
      recordTurnOrigin(
        live,
        result.turnId,
        opts.turnOrigin ?? turnOriginForTeamId(opts.teamId),
      );
    }
    return toTurnResult(result);
  }

    async dispatcherWorkspace(dispatcherId: string): Promise<string> {
    return dispatcherWorkspace(this.opts.config, dispatcherId);
  }
}

function turnOriginForTeamId(teamId: string | undefined): TeamMateTurnOrigin {
  return teamId === undefined ? 'dispatcher' : 'team_leader';
}
