import type { TeamSummary } from '@excitedjs/dreamux-types';

import type { WorktreeManager } from '../worktree/manager.js';
import { requireLifecycleText } from '../agent/identity.js';
import { defaultWorkspaceEnabled } from '../../config/config.js';
import { dispatcherWorkspace } from '../worktree/workspaces.js';
import type { ClosedSubscription } from '../../platform/closed-fact.js';
import { throwSettledFailures } from '../../platform/shutdown-errors.js';
import { KeyedAsyncQueue } from '../../platform/serial-queue.js';
import { TeamStore } from './store.js';
import {
  validateTeamId,
  type TeamCreateAtNameInput,
  type TeamCreateInput,
  type TeamHistoryQuery,
  type TeamHistoryResult,
  type TeamListRow,
  type TeamRecord,
  type TeamCollectionOptions,
  type TeamServiceDeps,
} from './types.js';
import { allocateConcreteNameAsync } from '../name-allocator.js';
import { TeamService } from './service.js';
import type { TeamMateSharedWorkspace } from '../agent/types.js';
import {
  IdempotencyConflictError,
  TeamClosedError,
  TeamNotFoundError,
  teamErrorInfo,
} from './errors.js';
import { TeamCollectionReadModel } from './read-model.js';

/**
 * The dispatcher's team collection (issue #233): one per dispatcher, owned by
 * `DispatcherService`. It stores, creates, finds, lists, materializes, and
 * evicts Teams, and nothing else — a Team's own lifecycle, including dissolve,
 * belongs to the {@link TeamService} that is that Team.
 *
 * `get` (private) is a get-or-rebuild factory (like `Dispatchers.get` /
 * `TeammateCollection.entityFor`): cached live service if any, else rebuilt
 * from the persisted {@link TeamRecord} and cached. Each `TeamService` OWNS its
 * per-team `TeammateCollection` (`teamScope: team_id`) built from the shared
 * deps forwarded here.
 */
export class TeamCollection {
  private readonly dispatcherId: string;
  private readonly store: TeamStore;
  private readonly worktrees: WorktreeManager;
  private readonly reads: TeamCollectionReadModel;
  /**
   * One materialized Team per id: the live service plus the subscription that
   * evicts it when it closes. An entry here is by definition both cached and
   * subscribed — the two never exist at different times, since {@link track}
   * always sets both together — so one map is the whole materialization cache.
   */
  private readonly live = new Map<
    string,
    { service: TeamService; subscription: ClosedSubscription }
  >();
  private readonly constructing = new Map<
    string,
    Promise<TeamService | null>
  >();
  /** Serializes the whole lookup/create sequence per request id. */
  private readonly createRequestLifecycle = new KeyedAsyncQueue();

  constructor(private readonly opts: TeamCollectionOptions) {
    this.dispatcherId = opts.dispatcherId;
    this.worktrees = opts.worktrees;
    this.store = new TeamStore({
      root: opts.root,
      dispatcherId: this.dispatcherId,
    });
    this.reads = new TeamCollectionReadModel({
      dispatcherId: this.dispatcherId,
      store: this.store,
      log: opts.log,
      live: (teamId) => this.live.get(teamId)?.service ?? null,
    });
  }

  /**
   * Allocate one free concrete Team name.
   *
   * Free means only "no valid Team record occupies it". Returning a candidate
   * reserves nothing: a concrete name is owned exactly while a valid Team
   * record sits at it, so a caller that loses the race allocates again.
   */
  async allocateName(namePrefix: string): Promise<string> {
    requireLifecycleText(namePrefix, 'Team name prefix');
    return allocateConcreteNameAsync({
      kind: 'team',
      base: namePrefix,
      accept: async (candidate) => (await this.store.get(candidate)) === null,
      generateSuffix: this.opts.nameSuffixGenerator,
    });
  }

  /**
   * Create one Team under a `team.create` request identity.
   *
   * The Team record is the whole protocol. Publishing it exclusively is the
   * single acceptance point: it is what makes the Team exist, what takes the
   * concrete name, and what durably records the request id and canonical
   * payload hash a later replay is decided against.
   *
   * Before publication nothing is owned — the request is unaccepted, no Team
   * exists, and the candidate name is free — so a lost process, a rejected
   * candidate, or a plain retry may simply pick another name. After publication
   * the same id with the same payload always resolves back to that Team,
   * including once it is closed; the same id with a different payload is an
   * idempotency conflict.
   */
  async createFromRequest(input: {
    requestId: string;
    payloadHash: string;
    options: TeamCreateInput;
    deliverCompletionToDispatcher: boolean;
  }): Promise<TeamSummary> {
    return this.createRequestLifecycle.run(input.requestId, async () => {
      const { namePrefix, ...options } = input.options;
      const accepted = await this.acceptedRequest(input.requestId);
      if (accepted !== null) {
        if (accepted.create_payload_hash !== input.payloadHash) {
          throw new IdempotencyConflictError(
            `request_id ${JSON.stringify(input.requestId)} was already accepted with a ` +
              'different team.create payload; use a new request_id for a new Team',
          );
        }
        // Read the accepted Team without materializing it or resubmitting work.
        return this.summaryFromRecord(accepted);
      }
      const outcome: { created: TeamService | null } = { created: null };
      const teamName = await allocateConcreteNameAsync({
        kind: 'team',
        base: namePrefix,
        accept: async (candidate) => {
          // A valid record at this candidate belongs to another Team — this
          // request has not been accepted anywhere — so move on. The probe is
          // only an optimization: publication answers the same question
          // authoritatively, and losing that race is the same ordinary
          // "unavailable candidate", not a persistence failure.
          if ((await this.store.get(candidate)) !== null) {
            return false;
          }
          outcome.created = await this.createAtCandidate({
            ...options,
            name: candidate,
            createRequest: {
              requestId: input.requestId,
              payloadHash: input.payloadHash,
            },
            deliverCompletionToDispatcher: input.deliverCompletionToDispatcher,
          });
          return outcome.created !== null;
        },
        generateSuffix: this.opts.nameSuffixGenerator,
      });
      const created = outcome.created;
      if (created === null) {
        throw new Error(
          `team.create request ${JSON.stringify(input.requestId)} accepted the name ` +
            `${JSON.stringify(teamName)} without publishing a Team record`,
        );
      }
      return created.status();
    });
  }

  /**
   * The Team this request id already produced, read from the records.
   *
   * The records are the only ledger: a creation that failed after publishing
   * one still accepted the request, and a process that died before returning
   * left the same proof behind. Scanning them is what makes a replay answer
   * the same way across restarts.
   */
  private async acceptedRequest(requestId: string): Promise<TeamRecord | null> {
    for (const team of await this.store.list()) {
      if (team.create_request_id === requestId) return team;
    }
    return null;
  }

  /**
   * Create one Team at a candidate name, or report the candidate as taken.
   *
   * `null` means a valid Team record occupies that name — the candidate is
   * unavailable and the allocator should offer another.
   */
  private async createAtCandidate(
    input: TeamCreateAtNameInput,
  ): Promise<TeamService | null> {
    return this.create(input, validateTeamId(input.name));
  }

  /** Compact rows from records alone; a list never consults a live runtime. */
  async list(): Promise<TeamListRow[]> {
    return this.reads.list();
  }

  async history(input: TeamHistoryQuery): Promise<TeamHistoryResult> {
    return this.reads.history(input);
  }

  /**
   * Get-or-rebuild the team's service; a cold-cache miss is deduped (#233).
   *
   * Live Teams only: a closed record has no service, so this reports it as
   * closed rather than building one. Callers outside reach a Team through
   * {@link open} or a lease, which say the same thing in their own words.
   *
   * Creation publishes a Team's record before its object graph is finished, so
   * a read that saw only the record would build a second, competing owner of
   * the same Team. Every path that can produce the object registers through
   * `constructing` instead. `null` from a joined construction means that
   * construction did not produce this Team — a create whose candidate turned
   * out to be taken — so the decision is made again against what is now
   * durable rather than reported as this caller's answer.
   */
  private async get(teamId: string): Promise<TeamService> {
    const id = validateTeamId(teamId);
    for (;;) {
      const cached = this.live.get(id)?.service;
      if (cached !== undefined) return cached;
      const joined = this.constructing.get(id);
      if (joined === undefined) {
        const construction = this.rebuild(id);
        this.publishConstruction(id, construction);
        return construction;
      }
      const service = await joined;
      if (service !== null) return service;
    }
  }

  /**
   * Run one TeamLeader operation inside its own Team's work fence.
   *
   * A TeamLeader reaches its Team by naming it, and the Team it names is
   * whichever Team currently holds that id: there is no second identity to
   * prove, because a Team has exactly one leader for its whole life and a
   * leader has no existence apart from the Team that owns it.
   */
  async admit<T>(
    teamId: string,
    task: (service: TeamService) => Promise<T>,
  ): Promise<T> {
    const service = await this.open(teamId);
    return service.admit(() => task(service));
  }

  /** Read a live Team without entering its work fence; reads survive closing. */
  async read<T>(
    teamId: string,
    task: (service: TeamService) => Promise<T>,
  ): Promise<T> {
    return task(await this.get(validateTeamId(teamId)));
  }

  /**
   * One Team's status.
   *
   * An open Team this process already holds answers for itself, because its
   * live state is the more current version of the same shape. Any other Team is
   * read from its records: whether it is closed or simply not materialized
   * here, a read must not build an entity — and a Team with no runtime in this
   * process has no runtime state for a projection to be missing.
   */
  async summary(teamId: string): Promise<TeamSummary> {
    const record = await this.mustTeam(validateTeamId(teamId));
    return this.summaryFromRecord(record);
  }

  /**
   * One source selection for status and accepted-request replay.
   *
   * The record just read from the store is authoritative for lifecycle, and it
   * decides whether there is an entity to ask at all: a closed Team is a
   * record, so it answers from that record and never from a cached service.
   * Only an open Team this process holds answers for itself.
   */
  private async summaryFromRecord(record: TeamRecord): Promise<TeamSummary> {
    if (record.status === 'closed') return this.reads.summary(record);
    const live = this.live.get(record.team_id)?.service ?? null;
    return live === null ? this.reads.summary(record) : live.status();
  }

  /**
   * Finish the physical reclamation a previous run left pending.
   *
   * The Team's own worktree cleanup fact is the entire recovery authority: a
   * `closed` Team still marked `cleanup-pending` has a managed checkout the
   * operator authorized destroying, and nothing else about a dissolve outlives
   * the process that ran it. Nothing is materialized to do it — a closed Team
   * is a record, and the record is all this work reads and writes.
   *
   * Each reclaim is launched, not awaited: it is the same background work that
   * ran behind the durable close, so a slow Git must not hold up dispatcher
   * start. A failure leaves the pending fact standing for the next start.
   */
  async recoverWorktreeCleanup(): Promise<void> {
    for (const record of await this.store.list()) {
      if (record.status !== 'closed') continue;
      if (record.worktree.cleanup_state !== 'cleanup-pending') continue;
      void this.reclaimTeamWorktree(record.team_id);
    }
  }

  private async reclaimTeamWorktree(teamId: string): Promise<void> {
    try {
      await this.settleClosedWorktree(teamId);
    } catch (error) {
      this.opts.log.error(
        {
          dispatcher_id: this.dispatcherId,
          team_id: teamId,
          err: teamErrorInfo(error),
        },
        'Team managed worktree cleanup recovery failed',
      );
    }
  }

  /**
   * Reclaim the managed checkout a closed Team still owes, from its record
   * alone.
   *
   * A closed Team is a record and nothing else: no `TeamService` is
   * constructed here, because there is no live Team left to construct. The
   * dissolve that just closed one (via the `settleWorktreeCleanup` callback
   * `TeamServiceDeps` gives its `TeamService`) and this collection's own
   * startup sweep both reach this same method and do exactly the same thing,
   * since the record is the only input either of them has.
   *
   * The Team's record is the only owner of that checkout and the only place
   * its result is written: the Agents that ran inside the directory never
   * held a copy of this fact, so there is nothing downstream to notify. A
   * failure throws without writing a second fact — the `cleanup-pending` one
   * stands and the next start finds the same work to do, which is why there is
   * no retry ledger.
   */
  private async settleClosedWorktree(teamId: string): Promise<void> {
    const record = await this.store.get(teamId);
    if (
      record === null ||
      record.worktree.cleanup_state !== 'cleanup-pending'
    ) {
      return;
    }
    const cleaned = await this.worktrees.cleanup(
      {
        source_cwd: record.repo_cwd,
        source_repo: record.source_repo,
        worktree: record.worktree,
      },
      { force: record.worktree_cleanup_force },
    );
    if (cleaned.cleanup_state === 'retained-error') {
      throw new Error(
        cleaned.cleanup_error ?? 'managed worktree cleanup failed',
      );
    }
    // The authorization goes with the pending work it authorized.
    await this.store.update(teamId, {
      worktree: { ...cleaned, cleanup_error: null },
      cleanupForce: false,
    });
  }

  /**
   * Get one Team that can take new work.
   *
   * The collection's whole part in a per-Team operation: find the entity, or
   * say why there is none to reach — {@link TeamNotFoundError} for a Team that
   * does not exist, {@link TeamClosedError} for one that is over. What happens
   * next is the Team's own.
   */
  async open(teamId: string): Promise<TeamService> {
    const id = validateTeamId(teamId);
    const record = await this.mustTeam(id);
    if (record.status === 'closed') {
      throw new TeamClosedError(`Team ${JSON.stringify(id)} is closed`);
    }
    return this.get(id);
  }

  private async mustTeam(teamId: string): Promise<TeamRecord> {
    const team = await this.store.get(validateTeamId(teamId));
    if (team === null) {
      throw new TeamNotFoundError(
        `Team ${JSON.stringify(teamId)} does not exist`,
      );
    }
    return team;
  }

  async startSchedulers(): Promise<void> {
    for (const team of await this.store.list()) {
      if (team.status === 'closed') continue;
      try {
        const service = await this.get(team.team_id);
        await service.startScheduler();
      } catch (error) {
        this.opts.log.error(
          {
            dispatcher_id: this.dispatcherId,
            team_id: team.team_id,
            err: teamErrorInfo(error),
          },
          'TeamLeader scheduler start failed',
        );
      }
    }
  }

  async startWorkflows(): Promise<void> {
    for (const team of await this.store.list()) {
      if (team.status === 'closed') continue;
      await (await this.get(team.team_id)).startWorkflowAdmission();
    }
  }

  async recoverWorkflows(): Promise<void> {
    for (const team of await this.store.list()) {
      if (team.status === 'closed') continue;
      await (await this.get(team.team_id)).recoverWorkflows();
    }
  }

  closeWorkflowAdmissions(): void {
    for (const entry of this.live.values()) {
      entry.service.closeWorkflowAdmission();
    }
  }

  stopSchedulers(): void {
    for (const entry of this.live.values()) entry.service.stopScheduler();
  }

  /**
   * Release the runtime authority this process took over its Teams.
   *
   * Only Teams this process materialized are swept, because only they hold a
   * runtime to release. The discovery pass this replaced listed every durable
   * non-closed record and materialized it first, which on a `starting` record
   * creates that Team's TeamLeader identity — durable work on the stop path,
   * done to entities the run never started.
   */
  async stopForHost(): Promise<void> {
    const entries = [...this.live.values()];
    const results = await Promise.allSettled(
      // The containment root publishes its aggregate admission fence before
      // this sweep. Do not hold a Team route lock while releasing members:
      // their captured completion delivery may resolve the same TeamLeader
      // through that route before the leader itself is released.
      entries.map((entry) => entry.service.stopForHost()),
    );
    results.forEach((result, index) => {
      if (result.status === 'fulfilled') {
        this.evict(entries[index]!.service.id, entries[index]!.service);
      }
    });
    throwSettledFailures(results, 'multiple Team runtimes failed to stop');
  }

  /**
   * Create one Team at this candidate name, or report the name as taken.
   *
   * `null` means the candidate is not this creation's to use: a valid Team
   * record already occupies it, or a construction already owns it. The caller
   * allocates another one, and nothing this attempt made survives it.
   */
  private async create(
    input: TeamCreateAtNameInput,
    teamId: string,
  ): Promise<TeamService | null> {
    requireLifecycleText(input.intent, 'Team create intent');
    // A cheap early-out before the expensive workspace preparation. The
    // authoritative answer is the exclusive record publication below, which
    // reports the same thing if the name is taken in between.
    if ((await this.store.get(teamId)) !== null) return null;
    // Synchronous from here: whoever registers first owns this id, so a second
    // create at the same candidate steps aside rather than racing it.
    if (this.constructing.has(teamId)) return null;
    const construction = this.createTeam(input, teamId);
    this.publishConstruction(teamId, construction);
    return construction;
  }

  /**
   * Prepare the workspace, publish the record, and take ownership of the
   * result — the whole of what creating a Team means here.
   *
   * It is one operation because it has one side effect to answer for. The
   * checkout is prepared before any record exists, so an ending that never
   * publishes one has to undo it; after publication the record owns the
   * checkout, and undoing it here would reach into a Team that exists.
   */
  private async createTeam(
    input: TeamCreateAtNameInput,
    teamId: string,
  ): Promise<TeamService | null> {
    const workspace = await this.prepareWorkspace(input, teamId);
    let created: TeamService | null;
    try {
      created = await TeamService.createNew(this.depsBase(teamId), {
        teamId,
        name: input.name,
        createRequest: input.createRequest,
        prompt: input.prompt,
        deliverCompletionToDispatcher: input.deliverCompletionToDispatcher,
        leaderAgentRuntime: input.leaderAgentRuntime,
        intent: input.intent,
        identity: input.identity,
        skillSources: input.skillSources,
        workspace,
      });
    } catch (error) {
      await this.discardUnclaimedCheckout(teamId, workspace);
      throw error;
    }
    if (created === null) {
      await this.discardUnclaimedCheckout(teamId, workspace);
      return null;
    }
    this.track(created);
    return created;
  }

  private async prepareWorkspace(
    input: TeamCreateAtNameInput,
    teamId: string,
  ): Promise<TeamMateSharedWorkspace> {
    const workspaceRoot = await dispatcherWorkspace(
      this.opts.config.current(),
      this.dispatcherId,
    );
    return input.worktree === undefined && input.repoCwd === undefined
      ? this.worktrees.prepareDefaultWorkspace({
          dispatcherWorkspace: workspaceRoot,
          slug: teamId,
          workspaceEnabled: defaultWorkspaceEnabled(
            this.opts.config.current(),
            this.dispatcherId,
          ),
        })
      : this.worktrees.prepare({
          dispatcherId: this.dispatcherId,
          teammateName: `team-${teamId}`,
          cwd: input.repoCwd ?? workspaceRoot,
          dispatcherWorkspace: workspaceRoot,
          request: input.worktree,
        });
  }

  /**
   * Undo the checkout this failed attempt made, while it is still nobody's.
   *
   * A Team record is the only owner a managed checkout can have, so its absence
   * is the proof that this preparation is unclaimed. Once a record exists — the
   * closed one an abandoned creation leaves, or the Team that took the name —
   * that record carries the cleanup and this must not touch the directory.
   * Removal honors the requested policy, so a `keep` checkout is kept exactly
   * as a dissolve would keep it, and a reused directory is never reached at all.
   *
   * Nothing here can be retried later: without a record there is no owner to
   * carry a pending reclaim, so a removal that reports a refusal rather than
   * raising one is stated here or nowhere.
   */
  private async discardUnclaimedCheckout(
    teamId: string,
    workspace: TeamMateSharedWorkspace,
  ): Promise<void> {
    if (!workspace.createdCheckout) return;
    try {
      if ((await this.store.get(teamId)) !== null) return;
      const cleaned = await this.worktrees.cleanup({
        source_cwd: workspace.sourceCwd,
        source_repo: workspace.sourceRepo,
        worktree: workspace.worktree,
      });
      // Removed or deliberately kept is the end of it. Anything else is a
      // directory this attempt made and nobody now owns, so it is reported the
      // same way a raised failure is — once, with where it is and why it stayed.
      if (
        cleaned.cleanup_state !== 'deleted' &&
        cleaned.cleanup_state !== 'kept'
      ) {
        this.opts.log.warn(
          {
            dispatcher_id: this.dispatcherId,
            team_id: teamId,
            path: cleaned.path,
            cleanup_state: cleaned.cleanup_state,
            cleanup_error: cleaned.cleanup_error,
          },
          'prepared Team worktree was left behind',
        );
      }
    } catch (error) {
      this.opts.log.warn(
        {
          dispatcher_id: this.dispatcherId,
          team_id: teamId,
          path: workspace.worktree.path,
          err: teamErrorInfo(error),
        },
        'prepared Team worktree was left behind',
      );
    }
  }

  /**
   * Rebuild one Team from its record.
   *
   * A closed record is not a Team, it is that Team's history: nothing here
   * constructs one, so a status read, a startup sweep, or a leftover physical
   * cleanup answers from the record instead. That is what keeps this
   * collection bounded by the Teams that are alive rather than by every Team
   * that ever existed.
   */
  private async rebuild(teamId: string): Promise<TeamService> {
    const record = await this.mustTeam(teamId);
    if (record.status === 'closed') {
      throw new TeamClosedError(
        `Team ${JSON.stringify(record.team_id)} is closed`,
      );
    }
    const service = await TeamService.rebuild(
      this.depsBase(record.team_id),
      record,
    );
    this.track(service);
    return service;
  }

  /**
   * Register the one construction of this Team while it runs.
   *
   * It is removed as soon as it settles: the cache holds what it produced, and
   * a construction that produced nothing leaves no trace to join.
   */
  private publishConstruction(
    teamId: string,
    construction: Promise<TeamService | null>,
  ): void {
    const tracked = construction.finally(() => {
      this.constructing.delete(teamId);
    });
    this.constructing.set(teamId, tracked);
    // Whoever started it reports its failure; a construction nobody joined must
    // not also surface as an unhandled rejection.
    void tracked.catch(() => undefined);
  }

  /**
   * Take ownership of one materialized Team: cache it and listen for its end.
   *
   * This collection is what holds a Team, so this is where it starts holding
   * one: the factory hands back a finished service and the owner tracks it,
   * rather than being called back into from inside the construction it asked
   * for.
   */
  private track(service: TeamService): void {
    if (this.live.get(service.id)?.service === service) return;
    this.live.set(service.id, {
      service,
      // The exact instance that ended is the exact instance dropped; a Team
      // rebuilt at the same id afterwards is a different object and stays.
      subscription: service.onClosed(() => this.evict(service.id, service)),
    });
  }

  private evict(teamId: string, expectedService: TeamService): void {
    const entry = this.live.get(teamId);
    if (entry?.service !== expectedService) return;
    entry.subscription.unsubscribe();
    this.live.delete(teamId);
  }

  private depsBase(teamId: string): TeamServiceDeps {
    return {
      ...this.opts,
      // Each Team gets its own already-resolved root; nothing below rebuilds it.
      teamRoot: this.store.teamRoot(teamId),
      store: this.store,
      settleWorktreeCleanup: (id) => this.settleClosedWorktree(id),
    };
  }
}
