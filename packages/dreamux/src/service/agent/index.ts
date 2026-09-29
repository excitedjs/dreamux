import type { DreamuxLogger, LaunchDraft } from '@excitedjs/dreamux-types';
import type { AsyncSeriesHook } from 'tapable';

import type {
  AgentRuntimeProviderCatalog,
  AgentRuntimePublicCapabilities,
} from '../../agent-runtime/index.js';
import type { ConversationProjection } from '../dispatcher-core-events/conversation-projection.js';
import {
  defaultAgentRuntime,
  type ResolvedAgentConfig,
} from '../../config/config.js';
import type { ConfigReader } from '../../config/service.js';
import { AgentEntityCollectionStore, type AgentNameRegistry } from './store.js';
import { matchesRecordQuery, toRecordRow, toStatus } from './records.js';
import {
  clampHistoryLimit,
  decodeCursor,
  encodeCursor,
} from '../../platform/history-page.js';
import { childAgentRuntimeId } from './runtime-id.js';
import { readAgentActivity } from './activity.js';
import {
  optionalLifecycleText,
  requireLifecycleText,
  validateAgentEntityName,
  type AgentEntityCapabilities,
  type AgentEntityCloseResult,
  type AgentEntityHistoryQuery,
  type AgentEntityHistoryResult,
  type AgentEntityIdentity,
  type AgentEntityLastQuery,
  type AgentEntityLastResult,
  type AgentEntityRecordRow,
  type AgentEntityRuntimeCapability,
  type AgentEntityRuntimeStatus,
  type AgentEntitySendResult,
  type AgentEntitySpawnResult,
} from './identity.js';
import type {
  CompletionDeliveryPolicy,
  CompletionInitiator,
} from '../completion-router/index.js';
import type { SuffixGenerator } from '../name-allocator.js';
import { teamMateNotFound } from './errors.js';
import { teammateSystemPromptOptions } from './system-prompt.js';
import { composeLaunchDraft } from '../../plugin/hooks.js';
import { ServerShuttingDownError } from '../../platform/errors.js';
import { InFlightWork } from '../../platform/in-flight-work.js';
import {
  collectShutdownFailure,
  throwShutdownFailures,
} from '../../platform/shutdown-errors.js';
import type { AgentEntityBuildDeps, AgentServiceFactory } from './factory.js';
import { AgentService } from './service.js';
import type {
  CreateLockedTeammateOptions,
  LockedTeammate,
  TeammateServiceOptions,
} from './service-types.js';
import { toSubmissionResult } from './admission.js';
import type { TurnCompletionDelivery } from './turn.js';
import { AGENT_TASK_SOURCE } from '../submission-sources.js';
import type { WorktreeManager } from '../worktree/manager.js';
import {
  assertManagedWorktreeAvailable,
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
  config: ConfigReader;
  agentRuntimeProviders: AgentRuntimeProviderCatalog;
  worktrees: WorktreeManager;
  /**
   * The `teammate/` collection root this Collection is bound to. It appends
   * only the concrete TeamMate name to it — it never learns whether that root
   * sits under the dispatcher or under a Team — and builds its own
   * `AgentEntityCollectionStore` from it; nothing outside the agent module
   * constructs that store.
   */
  root: string;
  /**
   * Fired after a member's identity is created or updated in a way that
   * changed status, threaded into the `AgentEntityCollectionStore` this
   * Collection builds around `root`.
   */
  onPersisted: (identity: AgentEntityIdentity) => void;
  /** The dispatcher-global name namespace; agent names stay dispatcher-unique. */
  names: AgentNameRegistry;
  agentServiceFactory: AgentServiceFactory;
  completionDelivery?: CompletionDeliveryPolicy;
  conversationProjection: ConversationProjection;
  /**
   * The admission fence every `TeammateOps` verb this collection hands out
   * crosses before it runs, so a spawn/send/close/read alike refuses once the
   * owner is closing instead of only the three mutations gating themselves.
   * The dispatcher-root owner passes its own dispatcher fence directly; a
   * Team passes its own fence composed around the dispatcher's
   * (`(task) => this.admit(() => dispatcherAdmitOperation(task))`, the same
   * composition its cron scheduler already uses), because a dispatcher stop
   * closes only the dispatcher's own admission — a Team outlives it and stays
   * open to resume on the next daemon start — so a member op fenced on the
   * Team's own admit alone would still pass while the dispatcher is tearing
   * that Team's runtimes down underneath it.
   */
  admitOperation: <T>(task: () => Promise<T>) => Promise<T>;
  /**
   * Whether the owner this collection was built for is already closing: the
   * dispatcher's own dispatcher-wide close for the dispatcher-root case, or
   * that fact composed with the owning Team's own dissolve for a Team-scoped
   * collection (mirroring `admitOperation`'s own composition). Every
   * construction path that can start a runtime — `spawn`/`createFreshEntity`,
   * `send`'s reopen — reads this once its entity exists (`spawn` synchronously
   * right after registering it; `send`'s reopen after the async build, inside
   * `buildReopened`, since composing a launch draft puts an `await` before the
   * entity exists) and closes it immediately instead of proceeding to its
   * first submission, so an already-admitted call that finishes constructing
   * after `close()` published its fence never starts a runtime the owner's
   * own post-drain sweep would only have caught later.
   */
  isClosing: () => boolean;
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
  suffixGenerator?: SuffixGenerator | undefined;
  /**
   * The owning Dispatcher's `teammateLaunch` hook, run once per Agent
   * construction for every TeamMate this collection builds — spawn, reopen,
   * and `createLocked` alike. Required, matching `admitOperation`/`isClosing`:
   * every owner already supplies one, dispatcher-root or Team-scoped.
   */
  teammateLaunch: AsyncSeriesHook<
    [LaunchDraft, Readonly<{ teamId: string | null }>]
  >;
  log: DreamuxLogger;
}

/**
 * A closed record that has not been reopened.
 *
 * Reopening (`reopenFrom`) opens a fresh `AgentService` from the same
 * directory through `AgentServiceFactory.open`, which binds and loads its own
 * store — there is no store instance to carry forward from the read that
 * found this record closed.
 */
interface ClosedTeamMateRecord {
  readonly identity: AgentEntityIdentity;
}

/**
 * The live TeamMate, or the durable record that already settled it. A closed
 * record is answered as itself rather than constructed: `close` is already done
 * when it reads one, and `send` — the one verb that reopens — is the only
 * caller that turns it back into an entity.
 */
type ResolvedTeamMate = AgentService | ClosedTeamMateRecord;

/** Scoped construction, cache, subscription, and read owner for TeamMates. */
export class TeammateCollection implements TeammateOps {
  private readonly dispatcherId: string;
  private readonly teamScope: string | null;
  private readonly store: AgentEntityCollectionStore;
  private readonly worktrees: WorktreeManager;
  private readonly entities = new Map<string, AgentService>();
  private readonly materializations = new Map<
    string,
    Promise<ResolvedTeamMate>
  >();
  /**
   * TeamMates being built for a `send` that has not reopened them yet, keyed
   * by name to the in-flight build promise rather than to the entity itself
   * (opening one is `async`, so building one can no longer register itself
   * into the map synchronously). An entry is held for its owning `send`
   * call's whole span — the build and
   * the send together, exactly as long as the map held the entity itself
   * before — and is removed by that same call, by promise identity, once it
   * settles either way; see {@link reopenFrom} and {@link sendReopened}.
   *
   * They are nobody's until that send succeeds, so they cannot live in
   * {@link entities} — but a second send must still find the one already
   * reopening rather than start a second runtime for the same Agent.
   */
  private readonly reopening = new Map<string, Promise<AgentService>>();
  /**
   * Counts only `createFreshEntity`'s `AgentNameRegistry.allocate()` call —
   * the one real disk I/O between an admitted `spawn`/`createLocked` and its
   * build registering into {@link materializations} below. Deliberately not
   * the whole `spawn`/`send`/`createLocked` call: those go on to start a
   * runtime with no timeout of its own (a `thread/start` RPC), and a
   * `stop()` sweep — the thing that would unblock a runtime stuck there — must
   * never wait on that same call to finish first (see
   * `dispatcher-service/lifecycle.ts`'s two-pass sweep for the same hazard). A
   * `destroy()`/`stop()` sweep joins only this narrow window before it
   * snapshots {@link materializations}, so a call admitted a moment before a
   * dissolve fenced this collection has always finished registering (never
   * necessarily finished running) by the time the sweep's snapshot runs.
   */
  private readonly inFlight = new InFlightWork();

  constructor(private readonly opts: TeammateCollectionOptions) {
    this.dispatcherId = opts.dispatcherId;
    this.teamScope = opts.teamScope;
    this.worktrees = opts.worktrees;
    this.store = new AgentEntityCollectionStore({
      root: opts.root,
      dispatcherId: opts.dispatcherId,
      log: opts.log,
      onPersisted: opts.onPersisted,
    });
  }

  spawn(input: SpawnTeamMateRequest): Promise<AgentEntitySpawnResult> {
    return this.opts.admitOperation(() => this.spawnAdmitted(input));
  }

  private async spawnAdmitted(
    input: SpawnTeamMateRequest,
  ): Promise<AgentEntitySpawnResult> {
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
    return this.opts.admitOperation(() => this.sendAdmitted(input));
  }

  private async sendAdmitted(
    input: SendTeamMateInput,
  ): Promise<AgentEntitySendResult> {
    const resolved = await this.resolveEntity(input.name);
    return resolved instanceof AgentService
      ? this.sendResolved(resolved, input)
      : this.sendReopened(resolved, input);
  }

  /**
   * Send to a TeamMate reopened from a closed record.
   *
   * `reopenFrom` registers this reopen's build promise into {@link reopening}
   * before anything here is awaited, so a second send arriving before this
   * one finishes joins it (through `resolveEntity` → `materializeEntity`)
   * instead of starting a second runtime. The entry is held for this call's
   * whole span — the build and the send together, matching how long the map
   * held the entity itself before this was a promise map — and is removed
   * here, by promise identity, once this call settles either way. A
   * concurrent joiner resolves to the same already-built entity and takes
   * the plain `sendResolved` branch above, never touching this map itself.
   */
  private async sendReopened(
    resolved: ClosedTeamMateRecord,
    input: SendTeamMateInput,
  ): Promise<AgentEntitySendResult> {
    const name = resolved.identity.name;
    const build = this.reopenFrom(resolved);
    try {
      return await this.sendResolved(await build, input);
    } finally {
      if (this.reopening.get(name) === build) this.reopening.delete(name);
    }
  }

  /**
   * Build (or join an in-flight build of) the entity behind a closed record.
   * Registered before anything is awaited, so a second send finds the Agent
   * already reopening rather than starting a second runtime.
   * `selfCloseIfClosing`'s check-and-throw runs inside the build itself
   * (`buildReopened`), after the entity exists, so its throw rejects the
   * registered promise instead of throwing synchronously out of this
   * function.
   */
  private reopenFrom(resolved: ClosedTeamMateRecord): Promise<AgentService> {
    const name = resolved.identity.name;
    const existing = this.reopening.get(name);
    if (existing !== undefined) return existing;
    const build = this.buildReopened(name);
    this.reopening.set(name, build);
    return build;
  }

  private async buildReopened(name: string): Promise<AgentService> {
    const entity = await this.openEntity(name);
    if (entity === null) throw teamMateNotFound(name);
    this.selfCloseIfClosing(entity);
    return entity;
  }

  private async sendResolved(
    entity: AgentService,
    input: SendTeamMateInput,
  ): Promise<AgentEntitySendResult> {
    const result = await entity.send({
      source: AGENT_TASK_SOURCE,
      text: input.prompt,
      intent: input.intent,
      resolveCompletionDelivery: () => this.resolveCompletionDelivery(),
    });
    // Cached only now: a reopen that failed leaves nothing behind, so a
    // closed TeamMate never occupies the live collection as the closed thing
    // it was.
    this.publish(entity);
    return result;
  }

  /**
   * Close one TeamMate.
   *
   * A TeamMate that is already closed is answered from its record: closing what
   * is already history constructs nothing.
   */
  close(input: CloseTeamMateInput): Promise<AgentEntityCloseResult> {
    return this.opts.admitOperation(() => this.closeAdmitted(input));
  }

  private async closeAdmitted(
    input: CloseTeamMateInput,
  ): Promise<AgentEntityCloseResult> {
    const name = validateAgentEntityName(input.name);
    const note = requireLifecycleText(input.note, 'TeamMate close note');
    // One record read decides, so a close that lost the race to a concurrent
    // one reads the committed record here and answers from it: closing what is
    // already history constructs nothing.
    const resolved = await this.resolveEntity(name);
    return resolved instanceof AgentService
      ? resolved.close({ note })
      : { teammate: toStatus(resolved.identity, null) };
  }

  /** Occupied member directories include closed and unreadable identities. */
  async count(): Promise<number> {
    return (await this.store.names()).length;
  }

  list(): Promise<AgentEntityRuntimeStatus[]> {
    return this.opts.admitOperation(() => this.memberStatuses());
  }

  /**
   * This collection's own unfenced read of its current members' status.
   *
   * For the owner's internal use — a Team reads its own roster this way while
   * seeding its own aggregate state (`TeamService.seed()`) — never for a
   * caller reaching the `TeammateOps.list()` verb above, which gates on
   * `admitOperation` the same as every other verb. An owner reading its own
   * children does not cross the collection's admission boundary a second
   * time.
   */
  async memberStatuses(): Promise<AgentEntityRuntimeStatus[]> {
    return (await this.rosterList()).map((identity) => {
      const entity = this.liveEntity(identity.name);
      return entity?.status() ?? toStatus(identity, null);
    });
  }

  status(name: string): Promise<AgentEntityRuntimeStatus> {
    return this.opts.admitOperation(() => this.statusAdmitted(name));
  }

  private async statusAdmitted(
    name: string,
  ): Promise<AgentEntityRuntimeStatus> {
    const identity = await this.mustIdentity(validateAgentEntityName(name));
    return this.liveEntity(identity.name)?.status() ?? toStatus(identity, null);
  }

  history(input: AgentEntityHistoryQuery): Promise<AgentEntityHistoryResult> {
    return this.opts.admitOperation(() => this.historyAdmitted(input));
  }

  private async historyAdmitted(
    input: AgentEntityHistoryQuery,
  ): Promise<AgentEntityHistoryResult> {
    const rows: AgentEntityRecordRow[] = [];
    for (const identity of await this.rosterList()) {
      const entity = this.liveEntity(identity.name);
      const row = entity?.historyRow() ?? toRecordRow(identity, null);
      if (matchesRecordQuery(row, input)) rows.push(row);
    }
    rows.sort(
      (a, b) => b.updated_at - a.updated_at || a.name.localeCompare(b.name),
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

  last(
    name: string,
    query: number | AgentEntityLastQuery = {},
  ): Promise<AgentEntityLastResult> {
    return this.opts.admitOperation(() => this.lastAdmitted(name, query));
  }

  private async lastAdmitted(
    name: string,
    query: number | AgentEntityLastQuery,
  ): Promise<AgentEntityLastResult> {
    const identity = await this.mustIdentity(validateAgentEntityName(name));
    const entity = this.liveEntity(identity.name);
    const activity = await readAgentActivity({
      config: this.opts.config.current(),
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

  getCapabilities(): Promise<AgentEntityCapabilities> {
    return this.opts.admitOperation(() =>
      Promise.resolve(this.getCapabilitiesAdmitted()),
    );
  }

  private getCapabilitiesAdmitted(): AgentEntityCapabilities {
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
      agent_runtimes: Object.entries(this.opts.config.current().agents).map(
        ([agentRuntimeId, agent]) =>
          this.agentRuntimeCapability(agentRuntimeId, agent),
      ),
    };
  }

  /**
   * Project one `agents[]` entry as the runtime-facing capability descriptor
   * `getCapabilities()` reports. Recovery and structured output are mandatory
   * provider behavior, so neither is projected here; only whether the
   * provider resolved, plus the bounded facts it declared about itself.
   */
  private agentRuntimeCapability(
    agentRuntimeId: string,
    agent: ResolvedAgentConfig,
  ): AgentEntityRuntimeCapability {
    let capabilities: AgentRuntimePublicCapabilities | null = null;
    let unsupportedReason: string | null = null;
    try {
      // The catalog's snapshot, not a fresh `getCapabilities()` call: Core
      // validated and froze it once at registration, so this projection cannot
      // observe a provider object that changed underneath it.
      capabilities = this.opts.agentRuntimeProviders.resolve(
        agent.provider,
      ).capabilities;
    } catch (error) {
      unsupportedReason =
        error instanceof Error ? error.message : String(error);
    }
    return {
      id: agentRuntimeId,
      spawn: { agent_runtime: agentRuntimeId },
      runtime_available: capabilities !== null,
      unsupported_reason: unsupportedReason,
      tags: capabilities?.tags ?? [],
      public_config: capabilities?.publicConfig ?? null,
    };
  }

  /** Narrow containment query; callers invoke entity capabilities themselves. */
  materializedEntities(): readonly AgentService[] {
    return [...this.entities.values()].filter((entity) => !entity.isRetired());
  }

  /**
   * Stop every member runtime this collection holds, releasing runtime
   * authority without closing anything.
   *
   * Scope-neutral: a host stop and the runtime-release phase of a Team
   * dissolve want the same thing from this collection, so there is one verb
   * for both instead of two identical bodies differing only in their error
   * message.
   */
  async stop(): Promise<void> {
    const failures: unknown[] = [];
    for (const member of await this.heldMembers()) {
      await collectShutdownFailure(failures, () => member.stopForHost());
    }
    throwShutdownFailures(
      failures,
      `${this.scopeLabel()} member runtimes did not stop`,
    );
  }

  /**
   * Destroy every member of a dissolving Team. Team-scoped only.
   *
   * A member is one of two kinds, and each is destroyed as what it is. One
   * this process holds is closed through its own entity (`AgentService.close`
   * already stops its runtime, drains, and converges before it writes closed),
   * so its terminal is published exactly as in any other close — that is what
   * keeps a dissolve from leaving a child process burning tokens behind a
   * Team that no longer exists. One that exists only as a record has no
   * runtime this process could be holding: it is marked closed at rest
   * through the store tier's own entry (`closeUnbuilt`) rather than by
   * building an entity for it, which would start an Agent in order to stop
   * it.
   *
   * Held members are excluded from the record pass by identity rather than by
   * the status they ended up with, so a member whose close failed surfaces as
   * that failure instead of being declared closed with a runtime still live.
   */
  async destroy(note: string): Promise<void> {
    const teamId = this.mustTeamScope();
    const failures: unknown[] = [];
    const held = await this.heldMembers();
    for (const member of held) {
      await collectShutdownFailure(failures, async () => {
        await member.close({ note });
      });
    }
    const heldNames = new Set(held.map((member) => member.name));
    for (const identity of await this.rosterList()) {
      if (identity.status === 'closed' || heldNames.has(identity.name)) {
        continue;
      }
      await collectShutdownFailure(failures, async () => {
        await this.store.closeUnbuilt(identity.name, note);
      });
    }
    throwShutdownFailures(
      failures,
      `Team ${JSON.stringify(teamId)} members did not close for dissolve`,
    );
  }

  /**
   * Every member this process holds, once whatever was already building one has
   * finished. A materialization that started before the owner fenced itself is
   * still producing a live Agent, so a sweep that read only the cache would
   * miss the one runtime it most needs to stop.
   *
   * The fence refuses everything not yet admitted, but an admitted
   * `spawn`/`createLocked` call has one real disk I/O
   * (`AgentNameRegistry.allocate`, counted by {@link inFlight}) before it
   * registers a build into {@link materializations} below — a sweep that
   * snapshotted that map right after the fence rises could run in that gap
   * and see neither the pending build nor, once it lands, the entity it
   * produces. Draining {@link inFlight} first closes exactly that gap: it
   * guarantees every admitted call has *registered*, not that it has
   * finished — a call already past its allocate is still joined by the
   * `materializations`/`reopening` awaits right below, which stop at entity
   * construction and never wait on a submitted turn or a started runtime, so
   * this can never block behind the very runtime a `stop()` sweep exists to
   * kill.
   */
  private async heldMembers(): Promise<readonly AgentService[]> {
    await this.inFlight.drain();
    await Promise.allSettled([...this.materializations.values()]);
    const held = new Map<string, AgentService>();
    for (const entity of this.materializedEntities()) {
      held.set(entity.name, entity);
    }
    // A reopen owns a live Agent before the send that publishes it returns.
    // `allSettled`, not `all`: a reopen that lost the `selfCloseIfClosing`
    // race rejects, and must not abort this sweep — it never produced a live
    // entity to stop, so it is simply skipped.
    const reopened = await Promise.allSettled([...this.reopening.values()]);
    for (const outcome of reopened) {
      if (outcome.status !== 'fulfilled') continue;
      if (!outcome.value.isRetired())
        held.set(outcome.value.name, outcome.value);
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

  /** This collection's owner, for a scope-neutral failure message. */
  private scopeLabel(): string {
    return this.teamScope === null
      ? `dispatcher ${JSON.stringify(this.dispatcherId)}`
      : `Team ${JSON.stringify(this.teamScope)}`;
  }

  private async createFreshEntity(
    input: SpawnTeamMateRequest,
    options: CreateLockedTeammateOptions = {},
    beforePublish?: (entity: AgentService) => void,
  ): Promise<AgentService> {
    requireLifecycleText(input.name, 'TeamMate spawn name');
    requireLifecycleText(input.intent, 'TeamMate spawn intent');
    const identityPrompt = optionalLifecycleText(
      input.identity,
      'TeamMate identity',
    );
    const teamId = this.teamScope ?? undefined;
    if (teamId !== undefined && input.sharedWorkspace === undefined) {
      throw new Error(
        'Team-scoped TeamMate spawn requires a shared team workspace',
      );
    }
    const agentRuntime =
      input.agentRuntime ??
      defaultAgentRuntime(this.opts.config.current(), this.dispatcherId);
    // The name prefix follows the collection this Collection was bound to, not
    // anything read back out of a record. Counted into `inFlight` for exactly
    // this allocate: it is the one real disk I/O between admission and
    // registering a build into `materializations` below, and the two run in
    // the same synchronous continuation once it resolves, so a `drain()`
    // waiter is never woken before the registration lands.
    const leaveAllocating = this.inFlight.enter();
    let name: string;
    try {
      name = await this.opts.names.allocate({
        kind: teamId === undefined ? 'dispatcher-teammate' : 'team-teammate',
        base: input.name,
        generateSuffix: this.opts.suffixGenerator,
      });
    } finally {
      leaveAllocating();
    }
    const existing = this.liveEntity(name);
    if (existing !== null || this.materializations.has(name)) {
      throw new Error(
        `TeamMate ${JSON.stringify(name)} is already materializing`,
      );
    }
    return this.trackMaterialization(name, async () => {
      const workspace = await resolveSpawnWorkspace({
        config: this.opts.config.current(),
        worktrees: this.worktrees,
        dispatcherId: this.dispatcherId,
        name,
        request: input,
      });
      if (input.sharedWorkspace === undefined) {
        await assertManagedWorktreeAvailable({
          findManagedWorktreeOwner: (path, excludingName) =>
            this.findManagedWorktreeOwner(path, excludingName),
          name,
          worktree: workspace.worktree,
        });
      }
      const entity = await this.opts.agentServiceFactory.create({
        location: { dir: this.store.entityDir(name), expectedName: name },
        creation: {
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
          skillSources: input.skillSources,
          status: 'stopped',
        },
        options: (identity) => this.teammateOptions(identity, options),
        deps: this.entityBuildDeps(),
        log: this.opts.log,
      });
      try {
        beforePublish?.(entity);
      } catch (error) {
        await this.closeAfterFailedCreation(entity);
        throw error;
      }
      this.entities.set(entity.name, entity);
      this.subscribeEntity(entity);
      this.selfCloseIfClosing(entity);
      return entity;
    });
  }

  /**
   * Stop a just-registered entity's runtime immediately, and refuse to
   * proceed, when the owner is already closing.
   *
   * `spawn`/`send` cross `admitOperation` before `close()` publishes its
   * fence, but finish materializing their entity afterward, moments before
   * they would otherwise submit its first input — exactly the "get them
   * stopped as fast as possible" case a Dispatcher close is for. The owner's
   * first runtime-sweep pass reads its live entities before this
   * materialization finishes, so it never saw this one, and the sweep does
   * not run again until its second, post-drain pass (after this same admitted
   * call has settled) — without this check the entity would start a runtime
   * nothing kills until that later pass reaches it. `stopForHost()` releases
   * runtime authority without durably closing the entity, so a caller that
   * went on to submit anyway would simply revive it — throwing here is what
   * actually prevents that continuation, faster than waiting for the sweep's
   * second pass.
   */
  private selfCloseIfClosing(entity: AgentService): void {
    if (!this.opts.isClosing()) return;
    entity.stopForHost().catch(() => undefined);
    throw new ServerShuttingDownError(
      `dispatcher '${this.dispatcherId}' is shutting down`,
    );
  }

  /** Hold one live entity, once. */
  private publish(entity: AgentService): AgentService {
    const name = entity.name;
    if (this.entities.get(name) === entity) return entity;
    this.entities.set(name, entity);
    this.subscribeEntity(entity);
    return entity;
  }

  /**
   * Open the entity already at `name`'s directory, or `null` when its
   * identity is missing. Used by a reopen (`buildReopened`) and by a
   * materialize that found a non-closed record (`materializeEntity`) —
   * both bind and load their own store through the factory, so there is no
   * store instance to carry forward from an earlier read.
   */
  private openEntity(name: string): Promise<AgentService | null> {
    return this.opts.agentServiceFactory.open({
      location: { dir: this.store.entityDir(name), expectedName: name },
      options: (identity) => this.teammateOptions(identity, {}),
      deps: this.entityBuildDeps(),
      log: this.opts.log,
    });
  }

  /**
   * Every collaborator an entity this Collection builds needs besides its
   * identity storage and its role-specific options — the same for a fresh
   * create and a reopen, so both `createFreshEntity` and `openEntity` share
   * it.
   */
  private entityBuildDeps(): AgentEntityBuildDeps {
    return {
      config: this.opts.config,
      agentRuntimeProviders: this.opts.agentRuntimeProviders,
      onPersisted: this.opts.onPersisted,
      findManagedWorktreeOwner: (path, excludingName) =>
        this.findManagedWorktreeOwner(path, excludingName),
      worktrees: this.worktrees,
      conversationProjection: this.opts.conversationProjection,
      log: this.opts.log,
    };
  }

  /**
   * The name of whichever sibling already owns `path` as its managed
   * worktree, or `null` when it is free. Asked fresh on each call, never a
   * snapshot taken at construction: a sibling's managed worktree occupancy
   * can change between calls.
   */
  private async findManagedWorktreeOwner(
    path: string,
    excludingName: string,
  ): Promise<string | null> {
    const collision = (await this.store.list()).find(
      (identity) =>
        identity.name !== excludingName &&
        identity.worktree.mode === 'managed' &&
        identity.worktree.path === path,
    );
    return collision?.name ?? null;
  }

  /**
   * Runs the owning Dispatcher's `teammateLaunch` hook first, carrying this
   * collection's own Team scope: plugin skill roots follow `identity`'s own
   * roots, fenced against them, and plugin instructions follow the built-in
   * membership sentence, landing just before `identity_prompt` (see
   * {@link teammateSystemPromptOptions}).
   */
  private async teammateOptions(
    identity: AgentEntityIdentity,
    options: CreateLockedTeammateOptions,
  ): Promise<TeammateServiceOptions> {
    const draft = await composeLaunchDraft(
      this.opts.teammateLaunch,
      identity.skill_sources,
      { teamId: this.teamScope },
    );
    const systemPrompt = teammateSystemPromptOptions(
      identity,
      options.systemPromptAppend,
      draft.instructions,
    );
    return {
      runtimeId: childAgentRuntimeId(identity),
      // Every Agent a TeammateCollection owns is a TeamMate, Team-scoped or
      // not; the value comes from being this owner, never from the record.
      role: 'teammate',
      loggerFields: { teammate: identity.name },
      skillSources: [...identity.skill_sources, ...draft.skillSources],
      outputSchema: options.outputSchema,
      ...(systemPrompt ?? {}),
    };
  }

  /**
   * Evict this entity once it durably closes. `liveEntity` below is the same
   * eviction reached synchronously, for a reader that runs before this
   * promise settles; both agree on the same test, so whichever runs first
   * evicts and the other finds nothing left to do.
   */
  private subscribeEntity(entity: AgentService): void {
    void entity.closed.then(() => {
      if (this.entities.get(entity.name) === entity && entity.isRetired()) {
        this.entities.delete(entity.name);
      }
    });
  }

  private liveEntity(name: string): AgentService | null {
    const entity = this.entities.get(name) ?? null;
    if (entity === null || !entity.isRetired()) return entity;
    this.entities.delete(name);
    return null;
  }

  private resolveEntity(
    name: string,
  ): ResolvedTeamMate | Promise<ResolvedTeamMate> {
    const teammateName = validateAgentEntityName(name);
    const existing = this.liveEntity(teammateName);
    if (existing !== null) {
      this.assertInCollection(existing.current());
      return existing;
    }
    const inFlight = this.materializations.get(teammateName);
    if (inFlight !== undefined) return inFlight;
    return this.trackMaterialization(teammateName, () =>
      this.materializeEntity(teammateName),
    );
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
    const identity = await this.readIdentity(name);
    // A materialization elsewhere may have published this entity while the
    // read above was in flight.
    const existing = this.liveEntity(name);
    if (existing !== null) return existing;
    if (identity.status === 'closed') return { identity };
    const entity = await this.openEntity(name);
    if (entity === null) throw teamMateNotFound(name);
    return this.publish(entity);
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

  /**
   * A live entity's own committed value is authoritative over a fresh file
   * read (mirroring `resolveEntity`'s live-first pattern above): a runtime
   * that just wrote a status transition would otherwise race a reader that
   * skipped straight to the file.
   */
  private async mustIdentity(name: string): Promise<AgentEntityIdentity> {
    const live = this.liveEntity(name);
    if (live !== null) {
      const identity = live.current();
      this.assertInCollection(identity);
      return identity;
    }
    return this.readIdentity(name);
  }

  /** A read-only snapshot of one member's identity — no store kept. */
  private async readIdentity(name: string): Promise<AgentEntityIdentity> {
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
      this.assertInCollection(identity, false),
    );
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

  private async closeAfterFailedCreation(entity: AgentService): Promise<void> {
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
