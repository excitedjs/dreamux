import type {
  AgentRuntimeSystemPrompt,
  DreamuxLogger,
  JsonSchema,
} from '@excitedjs/dreamux-types';

import type { AgentRuntimeProviderCatalog } from '../../agent-runtime/index.js';
import type { ConversationProjection } from '../../channel/conversation-projection.js';
import type { DreamuxConfig } from '../../config/config.js';
import {
  agentRuntimeCapability,
  defaultAgentRuntime,
} from '../agent-entity/agent-config.js';
import type {
  AgentEntityCollectionStore,
  AgentNameRegistry,
} from '../agent-entity/identity-store.js';
import type { AdmissionLedger } from '../teammate-service/admission-ledger.js';
import {
  clampHistoryLimit,
  decodeCursor,
  encodeCursor,
  matchesRecordQuery,
  toRecordRow,
  toStatus,
} from '../agent-entity/read-helpers.js';
import {
  assertDispatcherScopedTeammate,
  assertTeamScopedAgent,
  childAgentRuntimeId,
} from '../agent-entity/runtime-profile.js';
import { readAgentActivity } from '../agent-entity/activity-reader.js';
import {
  optionalLifecycleText,
  requireLifecycleText,
  validateTeamMateName,
  type AgentEntityCapabilities,
  type AgentEntityCloseResult,
  type AgentEntityHistoryQuery,
  type AgentEntityHistoryResult,
  type AgentEntityIdentity,
  type AgentEntityLastQuery,
  type AgentEntityLastResult,
  type AgentEntityRecordRow,
  type AgentEntityRuntimeStatus,
  type AgentEntitySendResult,
  type AgentEntitySpawnResult,
} from '../agent-entity/types.js';
import type {
  CompletionDeliveryPolicy,
  CompletionInitiator,
} from '../completion-router/index.js';
import type { SuffixGenerator } from '../name-allocator.js';
import { closeMembersForDissolve } from './dissolve-members.js';
import { teamMateNotFound } from './errors.js';
import {
  collectShutdownFailure,
  throwShutdownFailures,
} from '../shutdown-errors.js';
import { createTeammateService } from '../teammate-service/factory.js';
import { TeammateService } from '../teammate-service/index.js';
import type {
  LockedTeammate,
  TeammateClosedSubscription,
} from '../teammate-service/types.js';
import {
  toSubmissionResult,
  type TurnCompletionDelivery,
} from '../teammate-service/turn-recording.js';
import { AGENT_TASK_SOURCE } from '../submission-sources.js';
import type { WorktreeManager } from '../worktree/manager.js';
import {
  assertManagedWorktreeAvailable,
  dispatcherWorkspace,
  resolveSpawnWorkspace,
} from '../worktree/workspaces.js';
import type {
  CloseTeamMateInput,
  SendTeamMateInput,
  SpawnTeamMateRequest,
  TeammateOps,
} from './types.js';

export interface TeammateCollectionOptions {
  dispatcherId: string;
  /** The Team this Collection belongs to, or `null` for the dispatcher's own. */
  teamScope: string | null;
  config: DreamuxConfig;
  agentRuntimeProviders: AgentRuntimeProviderCatalog;
  worktrees: WorktreeManager;
  /**
   * The `teammate/` collection root the owner bound at construction. This
   * Collection appends only the concrete TeamMate name to it — it never learns
   * whether that root sits under the dispatcher or under a Team.
   */
  store: AgentEntityCollectionStore;
  /** The dispatcher-global name namespace; agent names stay dispatcher-unique. */
  names: AgentNameRegistry;
  admissions: AdmissionLedger;
  completionDelivery?: CompletionDeliveryPolicy;
  conversationProjection?: ConversationProjection | undefined;
  /**
   * Where a completion produced by an Agent in this collection is delivered.
   *
   * It takes no producer: the owner that built this collection already knows
   * the recipient — a dispatcher-owned TeamMate reports to the dispatcher
   * Agent, a Team's TeamMate reports to that Team's leader — and deriving it
   * from the producing record instead would have to re-answer a question
   * ownership already settled.
   */
  initiatorFor?: () => Promise<CompletionInitiator | null>;
  suffixGenerator?: SuffixGenerator;
  log: DreamuxLogger;
}

export interface CreateLockedTeammateOptions {
  systemPromptAppend?: readonly string[];
  outputSchema?: JsonSchema;
}

/**
 * The live TeamMate, or the durable record that already settled it. A closed
 * record is answered as itself rather than constructed: `close` is already done
 * when it reads one, and `send` — the one verb that reopens — is the only
 * caller that turns it back into an entity.
 */
type ResolvedTeamMate = TeammateService | AgentEntityIdentity;

interface FreshIdentityAllocation {
  readonly name: string;
  readonly teamId: string | undefined;
  readonly agentRuntime: string;
  readonly identityPrompt: string | null;
}

/** Scoped construction, cache, subscription, and read owner for TeamMates. */
export class TeammateCollection implements TeammateOps {
  private readonly dispatcherId: string;
  private readonly teamScope: string | null;
  private readonly store: AgentEntityCollectionStore;
  private readonly worktrees: WorktreeManager;
  private readonly entities = new Map<string, TeammateService>();
  private readonly subscriptions = new Map<string, TeammateClosedSubscription>();
  private readonly materializations = new Map<string, Promise<ResolvedTeamMate>>();
  /**
   * TeamMates built for a `send` that has not reopened them yet.
   *
   * They are nobody's until that send succeeds, so they cannot live in
   * {@link entities} — but a second send must still find the one already
   * reopening rather than start a second runtime for the same Agent.
   */
  private readonly reopening = new Map<string, TeammateService>();

  constructor(private readonly opts: TeammateCollectionOptions) {
    this.dispatcherId = opts.dispatcherId;
    this.teamScope = opts.teamScope;
    this.worktrees = opts.worktrees;
    this.store = opts.store;
  }

  async spawn(input: SpawnTeamMateRequest): Promise<AgentEntitySpawnResult> {
    const entity = await this.createFreshEntity(input);
    try {
      const delivery = await this.resolveCompletionDelivery();
      const submission = await entity.submitInput({
        source: AGENT_TASK_SOURCE,
        text: input.prompt,
        ...(delivery !== null ? { deliverCompletion: delivery } : {}),
      });
      return {
        teammate: entity.status(),
        ...toSubmissionResult(submission),
      };
    } catch (error) {
      await this.closeAfterFailedCreation(entity);
      throw error;
    }
  }

  async createLocked(
    input: SpawnTeamMateRequest,
    options: CreateLockedTeammateOptions = {},
  ): Promise<LockedTeammate> {
    // No capability gate: every provider must honor the session-bound output
    // schema, so an unsupported-feature pre-check has nothing left to check.
    let handle: LockedTeammate | null = null;
    await this.createFreshEntity(input, options, (entity) => {
      handle = entity.lock();
    });
    if (handle === null) {
      throw new Error('locked TeamMate publication completed without a handle');
    }
    return handle;
  }

  /**
   * Send to one TeamMate, reopening it if it was closed.
   *
   * The one operation that may bring a closed TeamMate back, and the reason a
   * closed record is otherwise never constructed: it reopens the Agent in the
   * same call, so what enters this collection is a live entity rather than a
   * terminal one.
   */
  send(input: SendTeamMateInput): Promise<AgentEntitySendResult> {
    const resolved = this.resolveEntity(input.name);
    return resolved instanceof Promise
      ? resolved.then((it) => this.sendResolved(this.reopenFrom(it), input))
      : this.sendResolved(this.reopenFrom(resolved), input);
  }

  /**
   * The entity this send acts on, built from a closed record when that is what
   * the collection had. Registered before anything is awaited, so a second send
   * finds the Agent already reopening rather than starting a second runtime.
   */
  private reopenFrom(resolved: ResolvedTeamMate): TeammateService {
    if (resolved instanceof TeammateService) return resolved;
    const reopening = this.reopening.get(resolved.name);
    if (reopening !== undefined) return reopening;
    const entity = this.buildEntity(resolved);
    this.reopening.set(resolved.name, entity);
    return entity;
  }

  private async sendResolved(
    entity: TeammateService,
    input: SendTeamMateInput,
  ): Promise<AgentEntitySendResult> {
    try {
      const result = await entity.send({
        source: AGENT_TASK_SOURCE,
        text: input.prompt,
        ...(input.intent !== undefined ? { intent: input.intent } : {}),
        resolveCompletionDelivery: () => this.resolveCompletionDelivery(),
      });
      // Cached only now: a reopen that failed leaves nothing behind, so a
      // closed TeamMate never occupies the live collection as the closed thing
      // it was.
      this.publish(entity);
      return result;
    } finally {
      if (this.reopening.get(entity.name) === entity) {
        this.reopening.delete(entity.name);
      }
    }
  }

  /**
   * Close one TeamMate.
   *
   * A TeamMate that is already closed is answered from its record: closing what
   * is already history constructs nothing.
   */
  async close(input: CloseTeamMateInput): Promise<AgentEntityCloseResult> {
    const name = validateTeamMateName(input.name);
    const note = requireLifecycleText(input.note, 'TeamMate close note');
    // One record read decides, so a close that lost the race to a concurrent
    // one reads the committed record here and answers from it: closing what is
    // already history constructs nothing.
    const resolved = await this.resolveEntity(name);
    return resolved instanceof TeammateService
      ? resolved.close({ note })
      : { teammate: toStatus(resolved, null) };
  }

  async list(): Promise<AgentEntityRuntimeStatus[]> {
    return (await this.rosterList()).map((identity) => {
      const entity = this.liveEntity(identity.name);
      return entity?.status() ?? toStatus(identity, null);
    });
  }

  async status(name: string): Promise<AgentEntityRuntimeStatus> {
    const identity = await this.mustIdentity(validateTeamMateName(name));
    return this.liveEntity(identity.name)?.status() ?? toStatus(identity, null);
  }

  async history(input: AgentEntityHistoryQuery): Promise<AgentEntityHistoryResult> {
    const rows: AgentEntityRecordRow[] = [];
    for (const identity of await this.rosterList()) {
      const entity = this.liveEntity(identity.name);
      const row = entity?.historyRow() ?? toRecordRow(identity, null);
      if (matchesRecordQuery(row, input)) rows.push(row);
    }
    rows.sort(
      (a, b) =>
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

  async last(
    name: string,
    query: number | AgentEntityLastQuery = {},
  ): Promise<AgentEntityLastResult> {
    const identity = await this.mustIdentity(validateTeamMateName(name));
    const entity = this.liveEntity(identity.name);
    const activity = await readAgentActivity({
      config: this.opts.config,
      providers: this.opts.agentRuntimeProviders,
      identity,
      query: typeof query === 'number' ? { limit: query } : query,
      log: this.opts.log,
    });
    return {
      teammate: entity?.status() ?? toStatus(identity, null),
      requested_records: activity.requestedRecords,
      returned_records: activity.records.length,
      records: activity.records,
      next_cursor: activity.nextCursor,
      truncated: activity.truncated,
    };
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

  async dispatcherWorkspace(): Promise<string> {
    return dispatcherWorkspace(this.opts.config, this.dispatcherId);
  }

  /** Narrow containment query; callers invoke entity capabilities themselves. */
  materializedEntities(): readonly TeammateService[] {
    return [...this.entities.values()].filter((entity) => !entity.isRetired());
  }

  /** Stop every member runtime this dissolving Team holds. Team-scoped only. */
  async stopAllForDissolve(): Promise<void> {
    const failures: unknown[] = [];
    for (const member of await this.heldMembers()) {
      await collectShutdownFailure(failures, () => member.stopForHost());
    }
    throwShutdownFailures(
      failures,
      `Team ${JSON.stringify(this.mustTeamScope())} member runtimes did not stop for dissolve`,
    );
  }

  /** Close every member of this dissolving Team. Team-scoped only. */
  async closeAllForDissolve(note: string): Promise<void> {
    const teamId = this.mustTeamScope();
    const held = await this.heldMembers();
    return closeMembersForDissolve({
      teamId,
      note,
      held,
      roster: await this.rosterList(),
      store: this.store,
    });
  }

  /**
   * Every member this process holds, once whatever was already building one has
   * finished. A materialization that started before its Team fenced itself is
   * still producing a live Agent, so a sweep that read only the cache would
   * miss the one runtime it most needs to stop. Joining what is already in
   * flight is the whole of it: the fence refuses everything not yet started.
   */
  private async heldMembers(): Promise<readonly TeammateService[]> {
    await Promise.allSettled([...this.materializations.values()]);
    const held = new Map<string, TeammateService>();
    for (const entity of this.materializedEntities()) {
      held.set(entity.name, entity);
    }
    // A reopen owns a live Agent before the send that publishes it returns.
    for (const entity of this.reopening.values()) {
      if (!entity.isRetired()) held.set(entity.name, entity);
    }
    return [...held.values()];
  }

  /** The Team these members belong to; dissolve is not a dispatcher verb. */
  private mustTeamScope(): string {
    if (this.teamScope === null) {
      throw new Error('bulk member dissolve is a Team capability');
    }
    return this.teamScope;
  }

  private async createFreshEntity(
    input: SpawnTeamMateRequest,
    options: CreateLockedTeammateOptions = {},
    beforePublish?: (entity: TeammateService) => void,
  ): Promise<TeammateService> {
    requireLifecycleText(input.name, 'TeamMate spawn name');
    requireLifecycleText(input.intent, 'TeamMate spawn intent');
    const identityPrompt = optionalLifecycleText(
      input.identity,
      'TeamMate identity',
    );
    const teamId = this.teamScope ?? undefined;
    if (teamId !== undefined && input.sharedWorkspace === undefined) {
      throw new Error('Team-scoped TeamMate spawn requires a shared team workspace');
    }
    const agentRuntime =
      input.agentRuntime ?? defaultAgentRuntime(this.opts.config, this.dispatcherId);
    // The name prefix follows the collection this Collection was bound to, not
    // anything read back out of a record.
    const name = await this.opts.names.allocate({
      kind: teamId === undefined ? 'dispatcher-teammate' : 'team-teammate',
      base: input.name,
      ...(this.opts.suffixGenerator !== undefined
        ? { generateSuffix: this.opts.suffixGenerator }
        : {}),
    });

    const allocation: FreshIdentityAllocation = {
      name,
      teamId,
      agentRuntime,
      identityPrompt,
    };
    const existing = this.liveEntity(name);
    if (existing !== null || this.materializations.has(name)) {
      throw new Error(`TeamMate ${JSON.stringify(name)} is already materializing`);
    }
    return this.trackMaterialization(name, async () => {
      const identity = await this.createIdentity(input, allocation);
      const entity = this.buildEntity(identity, options);
      const subscription = this.subscribeEntity(entity);
      try {
        beforePublish?.(entity);
      } catch (error) {
        subscription.unsubscribe();
        await this.closeAfterFailedCreation(entity);
        throw error;
      }
      this.entities.set(identity.name, entity);
      this.subscriptions.set(identity.name, subscription);
      return entity;
    });
  }

  private async createIdentity(
    input: SpawnTeamMateRequest,
    allocation: FreshIdentityAllocation,
  ): Promise<AgentEntityIdentity> {
    const { name, teamId, agentRuntime, identityPrompt } = allocation;
    const workspace = await resolveSpawnWorkspace({
      config: this.opts.config,
      worktrees: this.worktrees,
      dispatcherId: this.dispatcherId,
      name,
      request: input,
    });
    if (input.sharedWorkspace === undefined) {
      await assertManagedWorktreeAvailable({
        peers: this.store,
        name,
        worktree: workspace.worktree,
      });
    }
    return this.store.entity(name).create({
      name,
      teamId: teamId ?? null,
      agentRuntime,
      sourceCwd: workspace.sourceCwd,
      sourceRepo: workspace.sourceRepo,
      cwd: workspace.runtimeCwd,
      runtimeCwd: workspace.runtimeCwd,
      worktree: workspace.worktree,
      intent: input.intent,
      identityPrompt,
      ...(input.skillSources !== undefined
        ? { skillSources: input.skillSources }
        : {}),
      status: 'stopped',
    });
  }

  private publishEntity(identity: AgentEntityIdentity): TeammateService {
    return this.publish(this.buildEntity(identity));
  }

  /** Hold one live entity, once. */
  private publish(entity: TeammateService): TeammateService {
    const name = entity.name;
    if (this.entities.get(name) === entity) return entity;
    this.entities.set(name, entity);
    this.subscriptions.set(name, this.subscribeEntity(entity));
    return entity;
  }

  private buildEntity(
    identity: AgentEntityIdentity,
    options: CreateLockedTeammateOptions = {},
  ): TeammateService {
    const systemPrompt = teammateSystemPromptOptions(
      options.systemPromptAppend,
      identity.identity_prompt,
    );
    return createTeammateService({
      dispatcherId: this.dispatcherId,
      identity,
      options: {
        runtimeId: childAgentRuntimeId(identity),
        // Every Agent a TeammateCollection owns is a TeamMate, Team-scoped or
        // not; the value comes from being this owner, never from the record.
        role: 'teammate',
        ownsWorktreeOnClose: this.teamScope === null,
        loggerFields: { teammate: identity.name },
        assertIdentityScope:
          this.teamScope === null
            ? assertDispatcherScopedTeammate
            : assertTeamScopedAgent(this.teamScope),
        skillSources: identity.skill_sources,
        ...(options.outputSchema !== undefined
          ? { outputSchema: options.outputSchema }
          : {}),
        ...(systemPrompt ?? {}),
      },
      config: this.opts.config,
      agentRuntimeProviders: this.opts.agentRuntimeProviders,
      identities: this.store.entity(identity.name),
      peers: this.store,
      admissions: this.opts.admissions,
      worktrees: this.worktrees,
      ...(this.opts.conversationProjection !== undefined
        ? { conversationProjection: this.opts.conversationProjection }
        : {}),
      log: this.opts.log,
    });
  }

  private subscribeEntity(entity: TeammateService): TeammateClosedSubscription {
    const source = entity;
    return entity.onClosed((fact) => {
      if (
        this.entities.get(fact.name) === source &&
        source.isRetired()
      ) {
        this.entities.delete(fact.name);
        this.subscriptions.get(fact.name)?.unsubscribe();
        this.subscriptions.delete(fact.name);
      }
    });
  }

  private liveEntity(name: string): TeammateService | null {
    const entity = this.entities.get(name) ?? null;
    if (entity === null || !entity.isRetired()) return entity;
    this.entities.delete(name);
    this.subscriptions.get(name)?.unsubscribe();
    this.subscriptions.delete(name);
    return null;
  }

  private resolveEntity(
    name: string,
  ): ResolvedTeamMate | Promise<ResolvedTeamMate> {
    const teammateName = validateTeamMateName(name);
    const existing = this.liveEntity(teammateName);
    if (existing !== null) {
      this.assertInCollection(existing.current());
      return existing;
    }
    const inFlight = this.materializations.get(teammateName);
    if (inFlight !== undefined) return inFlight;
    return this.trackMaterialization(teammateName, () =>
      this.materializeEntity(teammateName));
  }

  /**
   * Resolve one TeamMate from its durable record.
   *
   * A closed record is that TeamMate's history, not the TeamMate: constructing
   * one would put a terminal object in a collection of live entities, and bound
   * this dispatcher's memory by how many Agents it ever had. So it is handed
   * back as the record it is, and only `send` builds from it.
   */
  private async materializeEntity(name: string): Promise<ResolvedTeamMate> {
    // Asked before the record is read, because a reopen in flight has already
    // moved past what the record says.
    const reopening = this.reopening.get(name);
    if (reopening !== undefined) return reopening;
    const identity = await this.mustIdentity(name);
    const existing = this.liveEntity(name);
    if (existing !== null) return existing;
    return identity.status === 'closed'
      ? identity
      : this.publishEntity(identity);
  }

  // Generic so the flight's starter keeps the narrower result it produced
  // (spawn always builds an entity) while a joiner handles the union.
  private trackMaterialization<T extends ResolvedTeamMate>(
    name: string,
    materialize: () => Promise<T>,
  ): Promise<T> {
    let tracked: Promise<T>;
    tracked = Promise.resolve()
      .then(materialize)
      .finally(() => {
        if (this.materializations.get(name) === tracked) {
          this.materializations.delete(name);
        }
      });
    this.materializations.set(name, tracked);
    return tracked;
  }

  private async mustIdentity(name: string): Promise<AgentEntityIdentity> {
    const identity = await this.store.entity(name).read();
    if (identity === null) {
      throw teamMateNotFound(name);
    }
    this.assertInCollection(identity);
    return identity;
  }

  private async rosterList(): Promise<AgentEntityIdentity[]> {
    const identities = await this.store.list();
    return identities.filter((identity) =>
      this.assertInCollection(identity, false));
  }

  /**
   * The bound collection root already decided which Agents are reachable here —
   * a leader lives at its Team root and is structurally unreachable through a
   * `teammate/` scan. What is left to check is only that the record agrees
   * about the owner it was found under.
   */
  private assertInCollection(
    identity: AgentEntityIdentity,
    throwOnMismatch = true,
  ): boolean {
    const valid =
      identity.dispatcher_id === this.dispatcherId &&
      identity.team_id === this.teamScope;
    if (!valid && throwOnMismatch) {
      throw teamMateNotFound(identity.name);
    }
    return valid;
  }

  private async resolveCompletionDelivery(): Promise<TurnCompletionDelivery | null> {
    const policy = this.opts.completionDelivery;
    const initiator = await this.opts.initiatorFor?.();
    if (policy === undefined || initiator === undefined || initiator === null) {
      return null;
    }
    return (completion, fact) =>
      policy.deliverRuntime(initiator, completion, fact);
  }

  private async closeAfterFailedCreation(entity: TeammateService): Promise<void> {
    try {
      await entity.close({ note: 'TeamMate creation failed' });
    } catch (cleanupError) {
      this.opts.log.warn(
        {
          err: cleanupError,
          dispatcher_id: this.dispatcherId,
          team_id: this.teamScope,
          teammate: entity.name,
        },
        'failed to close TeamMate after creation failure',
      );
    }
  }
}

function teammateSystemPromptOptions(
  operationAppend: readonly string[] | undefined,
  identityPrompt: string | null,
): { systemPrompt: AgentRuntimeSystemPrompt } | undefined {
  const append = [
    ...(operationAppend ?? []),
    ...(identityPrompt !== null ? [identityPrompt] : []),
  ];
  return append.length === 0 ? undefined : { systemPrompt: { append } };
}
