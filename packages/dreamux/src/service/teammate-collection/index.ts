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
  type AgentEntityWorktreeIdentity,
} from '../agent-entity/types.js';
import type {
  CompletionDeliveryPolicy,
  CompletionInitiator,
} from '../completion-router/index.js';
import type { SuffixGenerator } from '../name-allocator.js';
import { throwSettledFailures } from '../shutdown-errors.js';
import { createTeammateService } from '../teammate-service/factory.js';
import type { TeammateService } from '../teammate-service/index.js';
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
  isShuttingDown?: () => boolean;
  suffixGenerator?: SuffixGenerator;
  log: DreamuxLogger;
}

export interface CreateLockedTeammateOptions {
  systemPromptAppend?: readonly string[];
  outputSchema?: JsonSchema;
}

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
  private readonly materializations = new Map<string, Promise<TeammateService>>();

  constructor(private readonly opts: TeammateCollectionOptions) {
    this.dispatcherId = opts.dispatcherId;
    this.teamScope = opts.teamScope;
    this.worktrees = opts.worktrees;
    this.store = opts.store;
  }

  async spawn(input: SpawnTeamMateRequest): Promise<AgentEntitySpawnResult> {
    this.assertAdmissionOpen();
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
    this.assertAdmissionOpen();
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

  send(input: SendTeamMateInput): Promise<AgentEntitySendResult> {
    this.assertAdmissionOpen();
    const entity = this.resolveEntity(input.name);
    return entity instanceof Promise
      ? entity.then((resolved) => this.sendResolved(resolved, input))
      : this.sendResolved(entity, input);
  }

  private sendResolved(
    entity: TeammateService,
    input: SendTeamMateInput,
  ): Promise<AgentEntitySendResult> {
    return entity.send({
      source: AGENT_TASK_SOURCE,
      text: input.prompt,
      ...(input.intent !== undefined ? { intent: input.intent } : {}),
      resolveCompletionDelivery: () => this.resolveCompletionDelivery(),
    });
  }

  async close(input: CloseTeamMateInput): Promise<AgentEntityCloseResult> {
    return (await this.mustEntity(input.name)).close({ note: input.note });
  }

  async applyWorktreeCleanup(
    name: string,
    worktree: AgentEntityWorktreeIdentity,
  ): Promise<void> {
    await (await this.mustEntity(name)).applyWorktreeCleanup(worktree);
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

  /**
   * Construct/cache every durable non-closed entity for an aggregate owner.
   * The caller remains responsible for invoking entity lifecycle capabilities;
   * this Collection method performs only its canonical materialization role.
   */
  async materializeNonClosedEntities(): Promise<readonly TeammateService[]> {
    const identities = (await this.rosterList()).filter(
      (identity) => identity.status !== 'closed',
    );
    const results = await Promise.allSettled(
      identities.map((identity) => this.mustEntity(identity.name)),
    );
    const entities = results.flatMap((result) =>
      result.status === 'fulfilled' ? [result.value] : []);
    throwSettledFailures(
      results,
      'one or more durable TeamMates could not be materialized',
    );
    return entities;
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
    const entity = this.buildEntity(identity);
    const subscription = this.subscribeEntity(entity);
    this.entities.set(identity.name, entity);
    this.subscriptions.set(identity.name, subscription);
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

  private resolveEntity(name: string): TeammateService | Promise<TeammateService> {
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

  private mustEntity(name: string): Promise<TeammateService> {
    return Promise.resolve(this.resolveEntity(name));
  }

  private async materializeEntity(name: string): Promise<TeammateService> {
    const identity = await this.mustIdentity(name);
    const existing = this.liveEntity(name);
    if (existing !== null) return existing;
    return this.publishEntity(identity);
  }

  private trackMaterialization(
    name: string,
    materialize: () => Promise<TeammateService>,
  ): Promise<TeammateService> {
    let tracked: Promise<TeammateService>;
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
      throw new Error(`TeamMate ${JSON.stringify(name)} does not exist`);
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
      throw new Error(`TeamMate ${JSON.stringify(identity.name)} does not exist`);
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

  private assertAdmissionOpen(): void {
    if (this.opts.isShuttingDown?.()) {
      throw new Error(`dispatcher '${this.dispatcherId}' is shutting down`);
    }
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
