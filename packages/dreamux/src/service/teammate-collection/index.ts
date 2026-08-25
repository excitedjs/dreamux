import type { AgentRuntimeSystemPrompt, DreamuxLogger } from '@excitedjs/dreamux-types';
import { unsupportedFeatureError } from '@excitedjs/dreamux-utils';

import type { AgentRuntimeProviderCatalog } from '../../agent-runtime/index.js';
import type { ConversationProjection } from '../../channel/conversation-projection.js';
import type { DreamuxConfig } from '../../config/config.js';
import {
  agentRuntimeCapability,
  defaultAgentRuntime,
  resolveAgent,
} from '../agent-entity/agent-config.js';
import { AgentIdentityStore } from '../agent-entity/identity-store.js';
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
import { readAgentTranscript } from '../agent-entity/transcript-reader.js';
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
import type { TurnCompletionDelivery } from '../teammate-service/turn-recording.js';
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
  teamScope: string | null;
  config: DreamuxConfig;
  agentRuntimeProviders: AgentRuntimeProviderCatalog;
  worktrees: WorktreeManager;
  identities: AgentIdentityStore;
  completionDelivery?: CompletionDeliveryPolicy;
  conversationProjection?: ConversationProjection | undefined;
  initiatorFor?: (
    producer: AgentEntityIdentity,
  ) => Promise<CompletionInitiator | null>;
  isShuttingDown?: () => boolean;
  suffixGenerator?: SuffixGenerator;
  log: DreamuxLogger;
}

export interface CreateLockedTeammateOptions {
  systemPromptAppend?: readonly string[];
  outputSchema?: Record<string, unknown>;
}

interface FreshIdentityAllocation {
  readonly name: string;
  readonly role: 'teammate' | 'team_member';
  readonly teamId: string | undefined;
  readonly agentRuntime: string;
  readonly identityPrompt: string | null;
}

/** Scoped construction, cache, subscription, and read owner for TeamMates. */
export class TeammateCollection implements TeammateOps {
  private readonly dispatcherId: string;
  private readonly teamScope: string | null;
  private readonly identities: AgentIdentityStore;
  private readonly worktrees: WorktreeManager;
  private readonly entities = new Map<string, TeammateService>();
  private readonly subscriptions = new Map<string, TeammateClosedSubscription>();
  private readonly materializations = new Map<string, Promise<TeammateService>>();

  constructor(private readonly opts: TeammateCollectionOptions) {
    this.dispatcherId = opts.dispatcherId;
    this.teamScope = opts.teamScope;
    this.worktrees = opts.worktrees;
    this.identities = opts.identities;
  }

  async spawn(input: SpawnTeamMateRequest): Promise<AgentEntitySpawnResult> {
    this.assertAdmissionOpen();
    const entity = await this.createFreshEntity(input);
    try {
      const delivery = await this.resolveCompletionDelivery(entity.current());
      const submission = await entity.submitInitialPrompt(input.prompt, {
        turnOrigin: this.teamScope === null ? 'dispatcher' : 'team_leader',
        ...(delivery !== null ? { deliverCompletion: delivery } : {}),
      });
      return {
        teammate: entity.status(),
        ...submission,
        transcript_path: entity.transcriptPath(),
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
    if (options.outputSchema !== undefined) {
      this.assertStructuredOutputSupported(
        input.agentRuntime ??
          defaultAgentRuntime(this.opts.config, this.dispatcherId),
      );
    }
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
      prompt: input.prompt,
      ...(input.intent !== undefined ? { intent: input.intent } : {}),
      turnOrigin: this.teamScope === null ? 'dispatcher' : 'team_leader',
      resolveCompletionDelivery: () =>
        this.resolveCompletionDelivery(entity.current()),
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
    const transcript = await readAgentTranscript({
      config: this.opts.config,
      providers: this.opts.agentRuntimeProviders,
      identity,
      query: typeof query === 'number' ? { turns: query } : query,
      log: this.opts.log,
    });
    return {
      teammate: entity?.status() ?? toStatus(identity, null),
      requested_turns: transcript.requestedTurns,
      returned_turns: transcript.turns.length,
      turns: transcript.turns,
      next_cursor: transcript.nextCursor,
      truncated: transcript.truncated,
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

  liveWriters(): Array<{
    name: string;
    waitIdle: (() => Promise<void>) | undefined;
  }> {
    return this.materializedEntities()
      .filter((entity) => entity.runtimeStatus() !== null && !entity.isLocked())
      .map((entity) => ({
        name: entity.name,
        waitIdle: entity.waitIdleCapability(),
      }));
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
      throw new Error('Team member spawn requires a shared team workspace');
    }
    const role: FreshIdentityAllocation['role'] =
      teamId === undefined ? 'teammate' : 'team_member';
    const agentRuntime =
      input.agentRuntime ?? defaultAgentRuntime(this.opts.config, this.dispatcherId);
    const name = await this.identities.allocateName({
      dispatcherId: this.dispatcherId,
      kind: role,
      base: input.name,
      ...(this.opts.suffixGenerator !== undefined
        ? { generateSuffix: this.opts.suffixGenerator }
        : {}),
    });

    const allocation: FreshIdentityAllocation = {
      name,
      role,
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
    const { name, role, teamId, agentRuntime, identityPrompt } = allocation;
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
    return this.identities.create({
      dispatcherId: this.dispatcherId,
      name,
      role,
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
      identities: this.identities,
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
    const identity = await this.identities.get(
      this.dispatcherId,
      name,
      this.teamScope ?? undefined,
    );
    if (identity === null) {
      throw new Error(`TeamMate ${JSON.stringify(name)} does not exist`);
    }
    this.assertInCollection(identity);
    return identity;
  }

  private async rosterList(): Promise<AgentEntityIdentity[]> {
    const identities = await this.identities.list(
      this.dispatcherId,
      this.teamScope ?? undefined,
    );
    return identities.filter((identity) =>
      this.assertInCollection(identity, false));
  }

  private assertInCollection(
    identity: AgentEntityIdentity,
    throwOnMismatch = true,
  ): boolean {
    const valid =
      identity.dispatcher_id === this.dispatcherId &&
      (this.teamScope === null
        ? identity.team_id === null && identity.role === 'teammate'
        : identity.team_id === this.teamScope &&
          identity.role === 'team_member');
    if (!valid && throwOnMismatch) {
      throw new Error(`TeamMate ${JSON.stringify(identity.name)} does not exist`);
    }
    return valid;
  }

  private async resolveCompletionDelivery(
    identity: AgentEntityIdentity,
  ): Promise<TurnCompletionDelivery | null> {
    const policy = this.opts.completionDelivery;
    const initiator = await this.opts.initiatorFor?.(identity);
    if (policy === undefined || initiator === undefined || initiator === null) {
      return null;
    }
    return (completion, fact) =>
      policy.deliverRuntime(initiator, completion, fact);
  }

  private assertStructuredOutputSupported(agentRuntimeId: string): void {
    const agent = resolveAgent(
      this.opts.config,
      this.dispatcherId,
      agentRuntimeId,
    );
    const supported = this.opts.agentRuntimeProviders
      .resolve(agent.provider)
      .getCapabilities().structuredOutput?.supported;
    if (supported === true) return;
    throw unsupportedFeatureError(
      'outputSchema',
      'runtime does not support structured output (outputSchema)',
    );
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
