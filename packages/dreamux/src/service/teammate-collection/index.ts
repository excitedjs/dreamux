import type { AgentRuntimeProviderCatalog } from '../../agent-runtime/index.js';
import type {
  AgentRuntime,
  AgentRuntimeSystemPrompt,
} from '@excitedjs/dreamux-types';
import type { DreamuxConfig } from '../../config/config.js';
import type { DreamuxLogger } from '@excitedjs/dreamux-types';
import {
  agentRuntimeCapability,
  defaultAgentRuntime,
} from './agent-config.js';
import {
  completionKey,
  type CompletionEnvelope,
  type CompletionInitiator,
  type CompletionRouter,
} from '../completion-router/index.js';
import { createTeammateService } from '../teammate-service/factory.js';
import {
  assertDispatcherScopedTeammate,
  assertTeamScopedAgent,
  childAgentRuntimeId,
} from '../agent-entity/runtime-profile.js';
import { AgentIdentityStore } from '../agent-entity/identity-store.js';
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
import { AgentTurnsStore } from '../agent-entity/turns-store.js';
import { allocateConcreteName, type SuffixGenerator } from './name-allocator.js';
import {
  assertManagedWorktreeAvailable,
  dispatcherWorkspace,
  resolveSpawnWorkspace,
} from '../worktree/workspaces.js';
import type { WorktreeManager } from '../worktree/manager.js';
import {
  optionalLifecycleText,
  requireLifecycleText,
  validateTeamMateName,
  type AgentEntityCapabilities,
  type AgentEntityCloseResult,
  type AgentEntityHistoryQuery,
  type AgentEntityHistoryResult,
  type AgentEntityIdentity,
  type AgentEntityLastResult,
  type AgentEntityRecordRow,
  type AgentEntityRole,
  type AgentEntityRuntimeStatus,
  type AgentEntitySendResult,
  type AgentEntitySpawnResult,
  type AgentEntityWorktreeIdentity,
} from '../agent-entity/types.js';
import type {
  CloseTeamMateInput,
  SendTeamMateInput,
  SpawnTeamMateInput,
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
   * The identity + turns store pair (issue #233 / PR #282 review). Required:
   * `DispatcherService` is the per-dispatcher composition root and builds the
   * shared pair once, then injects it into the dispatcher agent, the
   * dispatcher-scope teammate collection, and each team-scope member
   * collection. The stores are stateless (paths by role + team_id), so one
   * pair safely serves all scopes; `TeammateCollection` must never hide a
   * `new` fallback.
   */
  identities: AgentIdentityStore;
  turnsStore: AgentTurnsStore;
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
    producer: AgentEntityIdentity,
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
  worktree: AgentEntityWorktreeIdentity;
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
  spawn(input: Omit<SpawnTeamMateRequest, 'sharedWorkspace'>): Promise<AgentEntitySpawnResult>;
  send(input: SendTeamMateInput): Promise<AgentEntitySendResult>;
  close(input: CloseTeamMateInput): Promise<AgentEntityCloseResult>;
  list(): Promise<AgentEntityRuntimeStatus[]>;
  status(name: string): Promise<AgentEntityRuntimeStatus>;
  history(input: Omit<AgentEntityHistoryQuery, 'teamId'>): Promise<AgentEntityHistoryResult>;
  last(name: string, turns?: number): Promise<AgentEntityLastResult>;
  getCapabilities(): AgentEntityCapabilities;
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
  private readonly identities: AgentIdentityStore;
  private readonly turnsStore: AgentTurnsStore;
  private readonly worktrees: WorktreeManager;
  private readonly entities = new Map<string, TeammateService>();
  private submissionSeq = 0;
  private readonly inFlightSettleCaptures = new Set<Promise<void>>();

  constructor(private readonly opts: TeammateCollectionOptions) {
    this.dispatcherId = opts.dispatcherId;
    this.teamScope = opts.teamScope;
    this.worktrees = opts.worktrees;
    this.identities = opts.identities;
    this.turnsStore = opts.turnsStore;
  }

  /** The live runtime for a cached entity, or null (drives status projection). */
  private runtimeFor(name: string): AgentRuntime | null {
    return this.entities.get(name)?.getRuntime() ?? null;
  }

  turns(): AgentTurnsStore {
    return this.turnsStore;
  }

  /**
   * Allocate a dispatcher-global concrete name. The candidate is checked against
   * ALL of the dispatcher's identities regardless of team, so `producerName` is
   * unique across the dispatcher and `producerName:turnId` stays collision-free
   * for the per-dispatcher router (issue #233).
   */
  private async allocateName(
    role: AgentEntityRole,
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

  async spawn(input: SpawnTeamMateRequest): Promise<AgentEntitySpawnResult> {
    if (this.opts.isShuttingDown?.())
      throw new Error(`dispatcher '${this.dispatcherId}' is shutting down`);
    requireLifecycleText(input.name, 'TeamMate spawn name');
    requireLifecycleText(input.intent, 'TeamMate spawn intent');
    const identityPrompt = optionalLifecycleText(
      input.identity,
      'TeamMate identity',
    );
    // The scope fixes the role: a team-scope collection spawns `team_member`s
    // (which require a shared team workspace), a dispatcher-scope collection
    // spawns plain `teammate`s (issue #233).
    const teamId = this.teamScope ?? undefined;
    if (teamId !== undefined && input.sharedWorkspace === undefined) {
      throw new Error('Team member spawn requires a shared team workspace');
    }
    const role: AgentEntityRole = teamId !== undefined ? 'team_member' : 'teammate';
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
      identityPrompt,
      status: 'starting',
    });
    const entity = this.entityFor(identity);
    await entity.ensureStarted();
    const turn = await entity.submitInitialPrompt(input.prompt, {
      turnOrigin: teamId === undefined ? 'dispatcher' : 'team_leader',
    });
    await this.registerCompletion(entity, turn.turn_id ?? null);
    return { teammate: entity.status(), turn };
  }

  async send(input: SendTeamMateInput): Promise<AgentEntitySendResult> {
    if (this.opts.isShuttingDown?.())
      throw new Error(`dispatcher '${this.dispatcherId}' is shutting down`);
    const teamId = this.teamScope ?? undefined;
    const entity = await this.mustEntity(input.name);
    const result = await entity.send({
      prompt: input.prompt,
      ...(input.intent !== undefined ? { intent: input.intent } : {}),
      turnOrigin: teamId === undefined ? 'dispatcher' : 'team_leader',
    });
    await this.registerCompletion(entity, result.turn.turn_id ?? null);
    return result;
  }

  async close(input: CloseTeamMateInput): Promise<AgentEntityCloseResult> {
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
    worktree: AgentEntityWorktreeIdentity,
  ): Promise<void> {
    const entity = await this.mustEntity(name);
    await entity.applyWorktreeCleanup(worktree);
  }

  async list(): Promise<AgentEntityRuntimeStatus[]> {
    return (await this.rosterList()).map((identity) =>
      toStatus(identity, this.runtimeFor(identity.name)),
    );
  }

  async status(name: string): Promise<AgentEntityRuntimeStatus> {
    const identity = await this.mustIdentity(validateTeamMateName(name));
    return toStatus(identity, this.runtimeFor(identity.name));
  }

  async history(input: AgentEntityHistoryQuery): Promise<AgentEntityHistoryResult> {
    const rows: AgentEntityRecordRow[] = [];
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

  async last(name: string, turns?: number): Promise<AgentEntityLastResult> {
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
  private async mustIdentity(name: string): Promise<AgentEntityIdentity> {
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
  private async rosterList(): Promise<AgentEntityIdentity[]> {
    return this.identities.list(this.dispatcherId, this.teamScope ?? undefined);
  }

  getCapabilities(): AgentEntityCapabilities {
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
    const results = await Promise.allSettled(
      [...this.entities.values()].map((entity) => entity.stop()),
    );
    while (this.inFlightSettleCaptures.size > 0) {
      await Promise.allSettled([...this.inFlightSettleCaptures]);
    }
    const failures = results
      .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
      .map((result) => result.reason);
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) {
      throw new AggregateError(failures, 'multiple TeamMate runtimes failed to stop');
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

  private assertInCollection(identity: AgentEntityIdentity): void {
    const inCollection =
      identity.dispatcher_id === this.dispatcherId &&
      (this.teamScope === null
        ? identity.team_id === null && identity.role === 'teammate'
        : identity.team_id === this.teamScope && identity.role === 'team_member');
    if (inCollection) return;
    throw new Error(`TeamMate ${JSON.stringify(identity.name)} does not exist`);
  }

  /** Build (and cache) the entity for an identity. The collection owns only
   * caller-supplied identity guidance; it does not invent default teammate role
   * policy. */
  private entityFor(identity: AgentEntityIdentity): TeammateService {
    const existing = this.entities.get(identity.name);
    if (existing !== undefined) return existing;
    const systemPromptOptions = callerIdentitySystemPromptOptions(
      identity.identity_prompt,
    );
    const entity = createTeammateService({
      dispatcherId: this.dispatcherId,
      identity,
      options: {
        runtimeId: childAgentRuntimeId(identity),
        ownsWorktreeOnClose: this.teamScope === null,
        loggerFields: { teammate: identity.name },
        assertIdentityScope:
          this.teamScope === null
            ? assertDispatcherScopedTeammate
            : assertTeamScopedAgent(this.teamScope),
        ...(systemPromptOptions ?? {}),
      },
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

function callerIdentitySystemPromptOptions(
  identityPrompt: string | null,
): { systemPrompt: AgentRuntimeSystemPrompt } | undefined {
  return identityPrompt !== null
    ? { systemPrompt: { append: [identityPrompt] } }
    : undefined;
}
