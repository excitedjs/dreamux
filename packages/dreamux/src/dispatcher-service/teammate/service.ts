import type { AgentRuntimeProviderCatalog } from '../../agent-runtime/index.js';
import type {
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
} from './agent-config.js';
import {
  completionKey,
  type CompletionInitiator,
  type CompletionRouter,
} from './completion-router.js';
import { TeamMateIdentityStore } from './identity-store.js';
import { TeammateReadModel } from './read-model.js';
import { TeammateService, type TeammateServiceDeps } from './teammate-service.js';
import { TeamMateTurnsStore } from './turns-store.js';
import { allocateConcreteName, type SuffixGenerator } from './name-allocator.js';
import {
  assertManagedWorktreeAvailable,
  dispatcherWorkspace,
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
  type TeamMateWorktreeIdentity,
} from './types.js';

export interface TeammateCollectionOptions {
  config: DreamuxConfig;
  dispatchers: DispatcherStore;
  agentRuntimeProviders: AgentRuntimeProviderCatalog;
  mcpServersForTeamMate?: (input: {
    dispatcherId: string;
    name: string;
    identity: TeamMateIdentity;
  }) => readonly AgentRuntimeMcpServer[];
  /**
   * The per-dispatcher delivery router. Returned lazily per dispatcher id so the
   * process-wide collection stays a singleton while delivery topology is owned by
   * each `DispatcherService` (issue #233). Omitted in storage-only contexts (no
   * settle delivery is then routed).
   */
  routerFor?: (dispatcherId: string) => CompletionRouter;
  /**
   * Resolve the delivery target of a send-initiated turn from the producer's
   * identity: a team member's leader, or the dispatcher agent otherwise. Owned by
   * `DispatcherService` (it holds the team topology + the dispatcher runtime);
   * the collection stays topology-free. `null` when no target can be resolved
   * (the turn is then recorded but not pushed).
   */
  initiatorFor?: (
    dispatcherId: string,
    producer: TeamMateIdentity,
  ) => Promise<CompletionInitiator | null>;
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

/**
 * The dispatcher's teammate collection (issue #233): it owns the identity/turns
 * stores, the worktree manager, and the per-name `TeammateService` entity cache,
 * and exposes `spawn` / `get` / `list` / `history` / `close` plus the factory
 * paths (`createTeamLeader`, `allocateLeaderName`). Per-entity domain operations
 * (`send` / `status` / `last` / completion delivery) live on `TeammateService`.
 */
export class TeammateCollection {
  private readonly identities: TeamMateIdentityStore;
  private readonly turnsStore: TeamMateTurnsStore;
  private readonly readModel: TeammateReadModel;
  private readonly worktrees = new WorktreeManager();
  private readonly entities = new Map<string, TeammateService>();
  private submissionSeq = 0;
  private readonly inFlightSettleCaptures = new Set<Promise<void>>();

  constructor(private readonly opts: TeammateCollectionOptions) {
    this.identities = new TeamMateIdentityStore({ warn: opts.log.warn.bind(opts.log) });
    this.turnsStore = new TeamMateTurnsStore({ warn: opts.log.warn.bind(opts.log) });
    this.readModel = new TeammateReadModel({
      identities: this.identities,
      turnsStore: this.turnsStore,
      runtimeFor: (dispatcherId, name) =>
        this.entities.get(entityKey(dispatcherId, name))?.getRuntime() ?? null,
    });
  }

  turns(): TeamMateTurnsStore {
    return this.turnsStore;
  }

  async allocateLeaderName(dispatcherId: string, teamId: string): Promise<string> {
    return this.allocateName(dispatcherId, 'team_leader', teamId, teamId);
  }

  /**
   * Allocate a dispatcher-global concrete name. The candidate is checked against
   * ALL of the dispatcher's identities regardless of team, so `producerName` is
   * unique across the dispatcher and `producerName:turnId` stays collision-free
   * for the per-dispatcher router (issue #233).
   */
  private async allocateName(
    dispatcherId: string,
    role: TeamMateRole,
    base: string,
    teamSlug?: string,
  ): Promise<string> {
    const taken = await this.identities.listAllNames(dispatcherId);
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
    requireLifecycleText(input.name, 'TeamMate spawn name');
    requireLifecycleText(input.intent, 'TeamMate spawn intent');
    if (input.teamId !== undefined && input.sharedWorkspace === undefined) {
      throw new Error('Team member spawn requires a shared team workspace');
    }
    const role: TeamMateRole =
      input.teamId !== undefined ? 'team_member' : 'teammate';
    const name = await this.allocateName(dispatcherId, role, input.name);
    const agentRuntimeId =
      input.agentRuntime ?? defaultAgentRuntime(this.opts.config, dispatcherId);
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
    const identity = await this.identities.create({
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
    const entity = this.entityFor(dispatcherId, identity);
    await entity.ensureStarted({ teamId: input.teamId });
    const turn = await entity.submitInitialPrompt(input.prompt, {
      ...(input.teamId !== undefined ? { teamId: input.teamId } : {}),
    });
    await this.registerCompletion(dispatcherId, entity, turn.turn_id ?? null);
    return { teammate: entity.status(), turn };
  }

  async send(input: SendTeamMateInput): Promise<TeamMateSendResult> {
    const dispatcherId = input.dispatcherId;
    const entity = await this.mustEntity(dispatcherId, input.name, input.teamId);
    const result = await entity.send({
      prompt: input.prompt,
      ...(input.intent !== undefined ? { intent: input.intent } : {}),
      ...(input.teamId !== undefined ? { teamId: input.teamId } : {}),
    });
    await this.registerCompletion(
      dispatcherId,
      entity,
      result.turn.turn_id ?? null,
    );
    return result;
  }

  async close(input: CloseTeamMateInput): Promise<TeamMateCloseResult> {
    const dispatcherId = input.dispatcherId;
    const entity = await this.mustEntity(dispatcherId, input.name, input.teamId);
    const closed = await entity.close({ note: input.note });
    return closed;
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
    const entity = await this.mustEntity(dispatcherId, name, teamId);
    return entity.channelInput(input);
  }

  async createTeamLeader(input: CreateTeamLeaderInput): Promise<TeamMateSpawnResult> {
    const name = validateTeamMateName(input.name);
    // The leader lives at the team scope root (`team/<team>/identity.json`), so
    // the existence probe must be team-scoped — a dispatcher-scope `get` would
    // miss it and re-create a name that #188 forbids reusing (issue #233).
    const existing = await this.identities.get(input.dispatcherId, name, input.teamId);
    if (existing !== null) {
      throw new Error(`TeamLeader ${JSON.stringify(name)} already exists`);
    }
    const identity = await this.identities.create({
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
    const entity = this.entityFor(input.dispatcherId, identity);
    await entity.ensureStarted({ teamId: input.teamId });
    const turn = await entity.submitInitialPrompt(input.prompt, {
      teamId: input.teamId,
      turnOrigin: 'dispatcher',
    });
    // A dispatcher->leader create registers `leaderName:turnId -> dispatcher`.
    await this.registerCompletion(
      input.dispatcherId,
      entity,
      turn.turn_id ?? null,
    );
    return { teammate: entity.status(), turn };
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

  /** Stop every live teammate runtime in this collection (server shutdown). */
  async stopAll(): Promise<void> {
    for (const entity of this.entities.values()) {
      await entity.stop();
    }
    while (this.inFlightSettleCaptures.size > 0) {
      await Promise.allSettled([...this.inFlightSettleCaptures]);
    }
  }

  /** The live entity for a name, looked up per turn so the router target is known. */
  get(dispatcherId: string, name: string): TeammateService | undefined {
    return this.entities.get(entityKey(dispatcherId, validateTeamMateName(name)));
  }

  async dispatcherWorkspace(dispatcherId: string): Promise<string> {
    return dispatcherWorkspace(this.opts.config, dispatcherId);
  }

  /**
   * Register the just-submitted turn with the dispatcher's router so its settle
   * routes back to the initiator (`producerName:turnId -> initiator`). The
   * initiator is resolved by `DispatcherService` from the producer's identity —
   * the team leader for a member, the dispatcher agent otherwise. Channel-inbound
   * and remote turns never call this, which is the intrinsic delivery gate.
   */
  private async registerCompletion(
    dispatcherId: string,
    entity: TeammateService,
    turnId: string | null,
  ): Promise<void> {
    if (turnId === null) return;
    const router = this.opts.routerFor?.(dispatcherId);
    if (router === undefined) return;
    const initiator = await this.opts.initiatorFor?.(
      dispatcherId,
      entity.current(),
    );
    if (initiator === undefined || initiator === null) return;
    router.register(completionKey(entity.name, turnId), initiator);
  }

  private async mustEntity(
    dispatcherId: string,
    name: string,
    teamId?: string,
  ): Promise<TeammateService> {
    const teammateName = validateTeamMateName(name);
    const existing = this.entities.get(entityKey(dispatcherId, teammateName));
    if (existing !== undefined) {
      this.readModel.assertInRoster(existing.current(), dispatcherId, teamId);
      return existing;
    }
    const identity = await this.readModel.mustIdentity(
      dispatcherId,
      teammateName,
      teamId,
    );
    return this.entityFor(dispatcherId, identity);
  }

  private entityFor(
    dispatcherId: string,
    identity: TeamMateIdentity,
  ): TeammateService {
    const key = entityKey(dispatcherId, identity.name);
    const existing = this.entities.get(key);
    if (existing !== undefined) return existing;
    const entity = new TeammateService(
      this.entityDeps(dispatcherId),
      dispatcherId,
      identity,
    );
    this.entities.set(key, entity);
    return entity;
  }

  private entityDeps(dispatcherId: string): TeammateServiceDeps {
    return {
      config: this.opts.config,
      agentRuntimeProviders: this.opts.agentRuntimeProviders,
      identities: this.identities,
      turnsStore: this.turnsStore,
      readModel: this.readModel,
      worktrees: this.worktrees,
      log: this.opts.log,
      ...(this.opts.mcpServersForTeamMate !== undefined
        ? { mcpServersForTeamMate: this.opts.mcpServersForTeamMate }
        : {}),
      nextSubmissionSeq: () => ++this.submissionSeq,
      trackSettleCapture: (capture) => {
        this.inFlightSettleCaptures.add(capture);
        void capture.finally(() => {
          this.inFlightSettleCaptures.delete(capture);
        });
      },
      routeSettledCompletion: (producerName, turnId, completion) =>
        this.routeSettledCompletion(dispatcherId, producerName, turnId, completion),
    };
  }

  private async routeSettledCompletion(
    dispatcherId: string,
    producerName: string,
    turnId: string,
    completion: CompletionEnvelope,
  ): Promise<void> {
    const router = this.opts.routerFor?.(dispatcherId);
    if (router === undefined) return;
    await router.settle(completionKey(producerName, turnId), completion);
  }
}

function entityKey(dispatcherId: string, name: string): string {
  return `${dispatcherId} ${name}`;
}
