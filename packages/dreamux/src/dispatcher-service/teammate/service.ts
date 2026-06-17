import type { AgentRuntimeProviderCatalog } from '../../agent-runtime/index.js';
import type {
  AgentRuntimeMcpServer,
  CompletionEnvelope,
} from '@excitedjs/dreamux-types';
import type { DreamuxConfig } from '../../config/config.js';
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
import type { WorktreeManager } from './worktree-manager.js';
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
  /** The dispatcher this collection belongs to (issue #233 ownership sinking). */
  dispatcherId: string;
  config: DreamuxConfig;
  agentRuntimeProviders: AgentRuntimeProviderCatalog;
  /** The per-dispatcher worktree manager, shared with the team collection. */
  worktrees: WorktreeManager;
  mcpServersForTeamMate?: (input: {
    dispatcherId: string;
    name: string;
    identity: TeamMateIdentity;
  }) => readonly AgentRuntimeMcpServer[];
  /**
   * The dispatcher's delivery router (issue #233). Omitted in storage-only
   * contexts (no settle delivery is then routed).
   */
  router?: CompletionRouter;
  /**
   * Resolve the delivery target of a send-initiated turn from the producer's
   * identity: a team member's leader, or the dispatcher agent otherwise. Owned by
   * `DispatcherService` (it holds the team topology + the dispatcher runtime);
   * the collection stays topology-free. `null` when no target can be resolved
   * (the turn is then recorded but not pushed).
   */
  initiatorFor?: (
    producer: TeamMateIdentity,
  ) => Promise<CompletionInitiator | null>;
  /**
   * Reject any new turn while the dispatcher is shutting down (issue #233). The
   * single gate for every lazy-start path — `spawn`/`send` from a dispatcher
   * teammate or via the team layer — so a shutdown-window turn cannot start a
   * runtime the `stopAll` sweep already passed.
   */
  isShuttingDown?: () => boolean;
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
 * The dispatcher's teammate collection (issue #233): one instance per dispatcher,
 * owned by `DispatcherService`. It owns the identity/turns stores, holds the
 * per-dispatcher worktree manager, and caches the per-name `TeammateService`
 * entity, and exposes `spawn` / `get` / `list` / `history` / `close` plus the
 * factory paths (`createTeamLeader`, `allocateLeaderName`). Per-entity domain
 * operations (`send` / `status` / `last` / completion delivery) live on
 * `TeammateService`. The dispatcher id is baked into the collection, not threaded
 * per call.
 */
export class TeammateCollection {
  private readonly dispatcherId: string;
  private readonly identities: TeamMateIdentityStore;
  private readonly turnsStore: TeamMateTurnsStore;
  private readonly readModel: TeammateReadModel;
  private readonly worktrees: WorktreeManager;
  private readonly entities = new Map<string, TeammateService>();
  private submissionSeq = 0;
  private readonly inFlightSettleCaptures = new Set<Promise<void>>();

  constructor(private readonly opts: TeammateCollectionOptions) {
    this.dispatcherId = opts.dispatcherId;
    this.worktrees = opts.worktrees;
    this.identities = new TeamMateIdentityStore({ warn: opts.log.warn.bind(opts.log) });
    this.turnsStore = new TeamMateTurnsStore({ warn: opts.log.warn.bind(opts.log) });
    this.readModel = new TeammateReadModel({
      dispatcherId: this.dispatcherId,
      identities: this.identities,
      turnsStore: this.turnsStore,
      runtimeFor: (name) => this.entities.get(name)?.getRuntime() ?? null,
    });
  }

  turns(): TeamMateTurnsStore {
    return this.turnsStore;
  }

  async allocateLeaderName(teamId: string): Promise<string> {
    return this.allocateName('team_leader', teamId, teamId);
  }

  /**
   * Allocate a dispatcher-global concrete name. The candidate is checked against
   * ALL of the dispatcher's identities regardless of team, so `producerName` is
   * unique across the dispatcher and `producerName:turnId` stays collision-free
   * for the per-dispatcher router (issue #233).
   */
  private async allocateName(
    role: TeamMateRole,
    base: string,
    teamSlug?: string,
  ): Promise<string> {
    const taken = await this.identities.listAllNames(this.dispatcherId);
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
    if (this.opts.isShuttingDown?.())
      throw new Error(`dispatcher '${this.dispatcherId}' is shutting down`);
    requireLifecycleText(input.name, 'TeamMate spawn name');
    requireLifecycleText(input.intent, 'TeamMate spawn intent');
    if (input.teamId !== undefined && input.sharedWorkspace === undefined) {
      throw new Error('Team member spawn requires a shared team workspace');
    }
    const role: TeamMateRole =
      input.teamId !== undefined ? 'team_member' : 'teammate';
    const name = await this.allocateName(role, input.name);
    const agentRuntimeId =
      input.agentRuntime ?? defaultAgentRuntime(this.opts.config, this.dispatcherId);
    const workspace = await resolveSpawnWorkspace({
      config: this.opts.config,
      worktrees: this.worktrees,
      dispatcherId: this.dispatcherId,
      name,
      request: input,
    });
    if (input.sharedWorkspace === undefined) {
      await assertManagedWorktreeAvailable({
        identities: this.identities,
        dispatcherId: this.dispatcherId,
        name,
        worktree: workspace.worktree,
      });
    }
    const identity = await this.identities.create({
      dispatcherId: this.dispatcherId,
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
    const entity = this.entityFor(identity);
    await entity.ensureStarted({ teamId: input.teamId });
    const turn = await entity.submitInitialPrompt(input.prompt, {
      ...(input.teamId !== undefined ? { teamId: input.teamId } : {}),
    });
    await this.registerCompletion(entity, turn.turn_id ?? null);
    return { teammate: entity.status(), turn };
  }

  async send(input: SendTeamMateInput): Promise<TeamMateSendResult> {
    if (this.opts.isShuttingDown?.())
      throw new Error(`dispatcher '${this.dispatcherId}' is shutting down`);
    const entity = await this.mustEntity(input.name, input.teamId);
    const result = await entity.send({
      prompt: input.prompt,
      ...(input.intent !== undefined ? { intent: input.intent } : {}),
      ...(input.teamId !== undefined ? { teamId: input.teamId } : {}),
    });
    await this.registerCompletion(entity, result.turn.turn_id ?? null);
    return result;
  }

  async close(input: CloseTeamMateInput): Promise<TeamMateCloseResult> {
    const entity = await this.mustEntity(input.name, input.teamId);
    const closed = await entity.close({ note: input.note });
    return closed;
  }

  async list(teamId?: string): Promise<TeamMateRuntimeStatus[]> {
    return this.readModel.list(teamId);
  }

  async status(name: string, teamId?: string): Promise<TeamMateRuntimeStatus> {
    return this.readModel.status(name, teamId);
  }

  async history(input: TeamMateHistoryQuery): Promise<TeamMateHistoryResult> {
    return this.readModel.history(input);
  }

  async last(
    name: string,
    turns?: number,
    teamId?: string,
  ): Promise<TeamMateLastResult> {
    return this.readModel.last(name, turns, teamId);
  }

  /**
   * Create a team leader as a contained {@link TeammateService} (issue #233
   * Phase 4): same entity, store, runtime, and turn recording as a regular
   * teammate, only with `role: 'team_leader'` so it lands at the team root. The
   * created entity is returned so the {@link TeamService} can hold it directly
   * (has-a), rather than re-resolving the leader by name on every call.
   */
  async createTeamLeader(
    input: CreateTeamLeaderInput,
  ): Promise<{ leader: TeammateService; result: TeamMateSpawnResult }> {
    const name = validateTeamMateName(input.name);
    // The leader lives at the team scope root (`team/<team>/identity.json`), so
    // the existence probe must be team-scoped — a dispatcher-scope `get` would
    // miss it and re-create a name that #188 forbids reusing (issue #233).
    const existing = await this.identities.get(this.dispatcherId, name, input.teamId);
    if (existing !== null) {
      throw new Error(`TeamLeader ${JSON.stringify(name)} already exists`);
    }
    const identity = await this.identities.create({
      dispatcherId: this.dispatcherId,
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
    const entity = this.entityFor(identity);
    await entity.ensureStarted({ teamId: input.teamId });
    const turn = await entity.submitInitialPrompt(input.prompt, {
      teamId: input.teamId,
      turnOrigin: 'dispatcher',
    });
    // A dispatcher->leader create registers `leaderName:turnId -> dispatcher`.
    await this.registerCompletion(entity, turn.turn_id ?? null);
    return { leader: entity, result: { teammate: entity.status(), turn } };
  }

  /**
   * Materialize a team's leader {@link TeammateService} entity by its known name
   * (issue #233 Phase 4). The leader lives at the team root, so the lookup is
   * team-scoped; the entity is created from the persisted record on first access
   * after a restart and cached thereafter. The `TeamService` holds the returned
   * entity for the team's lifetime.
   */
  async leader(teamId: string, leaderName: string): Promise<TeammateService> {
    return this.mustEntity(leaderName, teamId);
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

  async dispatcherWorkspace(): Promise<string> {
    return dispatcherWorkspace(this.opts.config, this.dispatcherId);
  }

  /**
   * Register the just-submitted turn with the dispatcher's router so its settle
   * routes back to the initiator (`producerName:turnId -> initiator`). The
   * initiator is resolved by `DispatcherService` from the producer's identity —
   * the team leader for a member, the dispatcher agent otherwise. Channel-inbound
   * and remote turns never call this, which is the intrinsic delivery gate.
   */
  private async registerCompletion(
    entity: TeammateService,
    turnId: string | null,
  ): Promise<void> {
    if (turnId === null) return;
    const router = this.opts.router;
    if (router === undefined) return;
    const initiator = await this.opts.initiatorFor?.(entity.current());
    if (initiator === undefined || initiator === null) return;
    router.register(completionKey(entity.name, turnId), initiator);
  }

  private async mustEntity(
    name: string,
    teamId?: string,
  ): Promise<TeammateService> {
    const teammateName = validateTeamMateName(name);
    const existing = this.entities.get(teammateName);
    if (existing !== undefined) {
      this.readModel.assertInRoster(existing.current(), teamId);
      return existing;
    }
    const identity = await this.readModel.mustIdentity(teammateName, teamId);
    return this.entityFor(identity);
  }

  private entityFor(identity: TeamMateIdentity): TeammateService {
    const existing = this.entities.get(identity.name);
    if (existing !== undefined) return existing;
    const entity = new TeammateService(
      this.entityDeps(),
      this.dispatcherId,
      identity,
    );
    this.entities.set(identity.name, entity);
    return entity;
  }

  private entityDeps(): TeammateServiceDeps {
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
        this.routeSettledCompletion(producerName, turnId, completion),
    };
  }

  private async routeSettledCompletion(
    producerName: string,
    turnId: string,
    completion: CompletionEnvelope,
  ): Promise<void> {
    const router = this.opts.router;
    if (router === undefined) return;
    await router.settle(completionKey(producerName, turnId), completion);
  }
}
