import type { AgentRuntimeProviderCatalog } from '../../agent-runtime/index.js';
import type {
  AgentRuntime,
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
} from '../completion-router/index.js';
import { createTeammateService } from '../teammate-service/factory.js';
import { TeamMateIdentityStore } from './identity-store.js';
import {
  clampHistoryLimit,
  decodeCursor,
  encodeCursor,
  foldLastTurns,
  matchesRecordQuery,
  toRecordRow,
  toStatus,
  validateLastTurns,
} from './read-helpers.js';
import type { TeammateService } from '../teammate-service/index.js';
import { TeamMateTurnsStore } from './turns-store.js';
import { allocateConcreteName, type SuffixGenerator } from './name-allocator.js';
import {
  assertManagedWorktreeAvailable,
  dispatcherWorkspace,
  resolveSpawnWorkspace,
} from '../worktree/workspaces.js';
import type { WorktreeManager } from '../worktree/manager.js';
import {
  requireLifecycleText,
  validateTeamMateName,
  type CloseTeamMateInput,
  type SendTeamMateInput,
  type SpawnTeamMateInput,
  type TeamMateCapabilities,
  type TeamMateCloseResult,
  type TeamMateHistoryQuery,
  type TeamMateHistoryResult,
  type TeamMateIdentity,
  type TeamMateLastResult,
  type TeamMateRecordRow,
  type TeamMateRole,
  type TeamMateRuntimeStatus,
  type TeamMateSendResult,
  type TeamMateSpawnResult,
  type TeamMateWorktreeIdentity,
} from './types.js';

export interface TeammateCollectionOptions {
  /** The dispatcher this collection belongs to (issue #233 ownership sinking). */
  dispatcherId: string;
  /**
   * The fixed scope this collection serves (issue #233): `null` = the
   * dispatcher's own teammates (`teammate/<name>/`); a `team_id` = that team's
   * members (`team/<team>/teammate/<name>/`). One `TeammateCollection` per
   * scope; the scope is baked in, not threaded per call — `spawn` / `send` /
   * `list` / `status` / `history` / `last` / `close` supply this scope to the
   * (unchanged) stores and read model. The team leader is owned directly by
   * `TeamService`.
   */
  teamScope: string | null;
  config: DreamuxConfig;
  agentRuntimeProviders: AgentRuntimeProviderCatalog;
  /** The per-dispatcher worktree manager, shared with the team collection. */
  worktrees: WorktreeManager;
  /**
   * The identity + turns store pair, optionally injected (issue #233). The
   * dispatcher-scope collection shares one pair with the dispatcher agent (passed
   * here); per-team collections omit them and the constructor news its own. The
   * stores are stateless (paths by role + team_id), so a shared pair is safe.
   */
  identities?: TeamMateIdentityStore;
  turnsStore?: TeamMateTurnsStore;
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
 * The narrow teammate-operations surface a dispatcher or team exposes to the
 * admin layer (issue #233). `TeammateCollection` implements it; the owning
 * service hands it out via a `get teammates()` so callers can drive the
 * collection without the service re-forwarding each verb. `Omit` hides the
 * scope-internal inputs — `sharedWorkspace` (injected by `TeamService.spawnTeamMate`)
 * and the history `teamId` (the scope is baked into the collection) — and the
 * lifecycle methods (`turns` / `stopAll` / `dispatcherWorkspace`) stay off the
 * interface entirely.
 */
export interface TeammateOps {
  spawn(input: Omit<SpawnTeamMateRequest, 'sharedWorkspace'>): Promise<TeamMateSpawnResult>;
  send(input: SendTeamMateInput): Promise<TeamMateSendResult>;
  close(input: CloseTeamMateInput): Promise<TeamMateCloseResult>;
  list(): Promise<TeamMateRuntimeStatus[]>;
  status(name: string): Promise<TeamMateRuntimeStatus>;
  history(input: Omit<TeamMateHistoryQuery, 'teamId'>): Promise<TeamMateHistoryResult>;
  last(name: string, turns?: number): Promise<TeamMateLastResult>;
  getCapabilities(): TeamMateCapabilities;
}

/**
 * A scoped teammate collection (issue #233): one instance per scope — one for the
 * dispatcher's own teammates (`teamScope: null`), one per team
 * (`teamScope: team_id`). The dispatcher-scope collection is owned by
 * `DispatcherService`; each team-scope collection is owned by its `TeamService`.
 * It owns the identity/turns stores, holds the per-dispatcher worktree manager,
 * and caches the per-name member `TeammateService` entity, and exposes `spawn` /
 * `list` / `history` / `close`. Per-entity domain operations (`send` /
 * `status` / `last` / completion delivery) live on `TeammateService`. Both the
 * dispatcher id and the scope are baked into the collection, not threaded per
 * call.
 */
export class TeammateCollection implements TeammateOps {
  private readonly dispatcherId: string;
  private readonly teamScope: string | null;
  private readonly identities: TeamMateIdentityStore;
  private readonly turnsStore: TeamMateTurnsStore;
  private readonly worktrees: WorktreeManager;
  private readonly entities = new Map<string, TeammateService>();
  private submissionSeq = 0;
  private readonly inFlightSettleCaptures = new Set<Promise<void>>();

  constructor(private readonly opts: TeammateCollectionOptions) {
    this.dispatcherId = opts.dispatcherId;
    this.teamScope = opts.teamScope;
    this.worktrees = opts.worktrees;
    this.identities =
      opts.identities ??
      new TeamMateIdentityStore({ warn: opts.log.warn.bind(opts.log) });
    this.turnsStore =
      opts.turnsStore ??
      new TeamMateTurnsStore({ warn: opts.log.warn.bind(opts.log) });
  }

  /** The live runtime for a cached entity, or null (drives status projection). */
  private runtimeFor(name: string): AgentRuntime | null {
    return this.entities.get(name)?.getRuntime() ?? null;
  }

  turns(): TeamMateTurnsStore {
    return this.turnsStore;
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
    // The scope fixes the role: a team-scope collection spawns `team_member`s
    // (which require a shared team workspace), a dispatcher-scope collection
    // spawns plain `teammate`s (issue #233).
    const teamId = this.teamScope ?? undefined;
    if (teamId !== undefined && input.sharedWorkspace === undefined) {
      throw new Error('Team member spawn requires a shared team workspace');
    }
    const role: TeamMateRole = teamId !== undefined ? 'team_member' : 'teammate';
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
      teamId: teamId ?? null,
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
    await entity.ensureStarted({ teamId });
    const turn = await entity.submitInitialPrompt(input.prompt, {
      ...(teamId !== undefined ? { teamId } : {}),
    });
    await this.registerCompletion(entity, turn.turn_id ?? null);
    return { teammate: entity.status(), turn };
  }

  async send(input: SendTeamMateInput): Promise<TeamMateSendResult> {
    if (this.opts.isShuttingDown?.())
      throw new Error(`dispatcher '${this.dispatcherId}' is shutting down`);
    const teamId = this.teamScope ?? undefined;
    const entity = await this.mustEntity(input.name);
    const result = await entity.send({
      prompt: input.prompt,
      ...(input.intent !== undefined ? { intent: input.intent } : {}),
      ...(teamId !== undefined ? { teamId } : {}),
      turnOrigin: teamId === undefined ? 'dispatcher' : 'team_leader',
    });
    await this.registerCompletion(entity, result.turn.turn_id ?? null);
    return result;
  }

  async close(input: CloseTeamMateInput): Promise<TeamMateCloseResult> {
    const entity = await this.mustEntity(input.name);
    const closed = await entity.close({ note: input.note });
    return closed;
  }

  /**
   * Sync a member's persisted worktree to the Team's authoritative `dissolve`
   * cleanup result (issue #237), so a borrowed shared worktree's `cleanup_state`
   * does not stay `managed-active` after the Team removed it. Concrete-only (off
   * `TeammateOps`): only `TeamService.dissolve`, which holds the concrete
   * collection, calls this — it is not part of the admin-facing teammate surface.
   */
  async applyWorktreeCleanup(
    name: string,
    worktree: TeamMateWorktreeIdentity,
  ): Promise<void> {
    const entity = await this.mustEntity(name);
    await entity.applyWorktreeCleanup(worktree);
  }

  async list(): Promise<TeamMateRuntimeStatus[]> {
    return (await this.rosterList()).map((identity) =>
      toStatus(identity, this.runtimeFor(identity.name)),
    );
  }

  async status(name: string): Promise<TeamMateRuntimeStatus> {
    const identity = await this.mustIdentity(validateTeamMateName(name));
    return toStatus(identity, this.runtimeFor(identity.name));
  }

  async history(input: TeamMateHistoryQuery): Promise<TeamMateHistoryResult> {
    const rows: TeamMateRecordRow[] = [];
    for (const identity of await this.rosterList()) {
      const row = toRecordRow(identity, this.runtimeFor(identity.name));
      if (matchesRecordQuery(row, input)) {
        rows.push(row);
      }
    }
    rows.sort((a, b) =>
      b.last_seen_at - a.last_seen_at ||
      b.updated_at - a.updated_at ||
      a.name.localeCompare(b.name),
    );
    const start = input.cursor !== undefined ? decodeCursor(input.cursor) : 0;
    const limit = clampHistoryLimit(input.limit);
    const items = rows.slice(start, start + limit);
    const next = start + items.length;
    return {
      items,
      next_cursor: next < rows.length ? encodeCursor(next) : null,
    };
  }

  async last(name: string, turns?: number): Promise<TeamMateLastResult> {
    const requestedTurns = validateLastTurns(turns);
    const identity = await this.mustIdentity(validateTeamMateName(name));
    const teammate = toStatus(identity, this.runtimeFor(identity.name));
    const lastTurns = await foldLastTurns(
      this.turnsStore,
      identity,
      requestedTurns,
    );
    return {
      teammate,
      requested_turns: requestedTurns,
      returned_turns: lastTurns.length,
      turns: lastTurns,
    };
  }

  /**
   * Resolve an identity by name within this collection's scope, throwing "does
   * not exist" for a missing or wrong-scope name (the single read-by-name
   * chokepoint, issue #233).
   */
  private async mustIdentity(name: string): Promise<TeamMateIdentity> {
    const teamId = this.teamScope ?? undefined;
    const identity = await this.identities.get(this.dispatcherId, name, teamId);
    if (identity === null) {
      throw new Error(`TeamMate ${JSON.stringify(name)} does not exist`);
    }
    this.assertInCollection(identity);
    return identity;
  }

  /**
   * The scope roster (issue #233): physical scoping is the roster — a
   * dispatcher-scope list reads only `teammate/<name>/`, a team-scope list only
   * that team's MEMBERS under `team/<team>/teammate/<name>/`. The leader lives at
   * the team root and is a contained `TeammateService`, never a member row, so no
   * post-filter is needed.
   */
  private async rosterList(): Promise<TeamMateIdentity[]> {
    return this.identities.list(this.dispatcherId, this.teamScope ?? undefined);
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

  private async mustEntity(name: string): Promise<TeammateService> {
    const teammateName = validateTeamMateName(name);
    const existing = this.entities.get(teammateName);
    if (existing !== undefined) {
      this.assertInCollection(existing.current());
      return existing;
    }
    const identity = await this.mustIdentity(teammateName);
    return this.entityFor(identity);
  }

  private assertInCollection(identity: TeamMateIdentity): void {
    const inCollection =
      identity.dispatcher_id === this.dispatcherId &&
      (this.teamScope === null
        ? identity.team_id === null && identity.role === 'teammate'
        : identity.team_id === this.teamScope && identity.role === 'team_member');
    if (inCollection) return;
    throw new Error(`TeamMate ${JSON.stringify(identity.name)} does not exist`);
  }

  /** Build (and cache) the entity for an identity. Options default to empty:
   * members and dispatcher-owned teammates get no role policy here. */
  private entityFor(identity: TeamMateIdentity): TeammateService {
    const existing = this.entities.get(identity.name);
    if (existing !== undefined) return existing;
    const entity = createTeammateService({
      dispatcherId: this.dispatcherId,
      identity,
      launch: { kind: 'agent-ref' },
      config: this.opts.config,
      agentRuntimeProviders: this.opts.agentRuntimeProviders,
      identities: this.identities,
      turnsStore: this.turnsStore,
      worktrees: this.worktrees,
      log: this.opts.log,
      nextSubmissionSeq: () => ++this.submissionSeq,
      trackSettleCapture: (capture) => {
        this.inFlightSettleCaptures.add(capture);
        void capture.finally(() => {
          this.inFlightSettleCaptures.delete(capture);
        });
      },
      routeSettledCompletion: (producerName, turnId, completion) =>
        this.routeSettledCompletion(producerName, turnId, completion),
    });
    this.entities.set(identity.name, entity);
    return entity;
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
