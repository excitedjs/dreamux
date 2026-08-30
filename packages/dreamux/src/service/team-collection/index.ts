import type {
  // The published `team.create` contract; the Team domain returns it directly
  // rather than defining a second creation-result shape.
  TeamCreateResult as TeamCreateRequestResult,
} from '@excitedjs/dreamux-types';

import type { WorktreeManager } from '../worktree/manager.js';
import { requireLifecycleText } from '../agent-entity/types.js';
import { KeyedAsyncQueue } from '../serial-queue.js';
import { TeamStore } from './store.js';
import type {
  TeamCreateInput,
  TeamCreateAtNameInput,
  TeamCreateResult,
  TeamHistoryQuery,
  TeamHistoryResult,
  TeamListRow,
  TeamRecord,
  TeamCollectionOptions,
  TeamSummary,
} from './types.js';
import { validateTeamId } from './types.js';
import { allocateConcreteNameAsync } from '../name-allocator.js';
import {
  TeamService,
} from '../team-service/index.js';
import {
  IdempotencyConflictError,
  TeamClosedError,
  TeamNotFoundError,
  teamErrorInfo,
} from './errors.js';
import { TeamCollectionReadModel } from './read-model.js';
import { TeamRuntimeRegistry } from './runtime-registry.js';
import { TeamWorktreeCleanup } from './worktree-cleanup.js';

/**
 * The dispatcher's team collection (issue #233): one per dispatcher, owned by
 * `DispatcherService`. It stores, creates, finds, lists, caches, and evicts
 * Teams, and nothing else — a Team's own lifecycle, including dissolve, belongs
 * to the {@link TeamService} that is that Team.
 *
 * `get(teamId)` is a get-or-rebuild factory (like `Dispatchers.get` /
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
  private readonly runtimes: TeamRuntimeRegistry;
  /** Record-direct reclamation for Teams that are already closed. */
  private readonly cleanup: TeamWorktreeCleanup;
  /** Serializes the whole lookup/create sequence per request id. */
  private readonly createRequestLifecycle = new KeyedAsyncQueue();

  constructor(private readonly opts: TeamCollectionOptions) {
    this.dispatcherId = opts.dispatcherId;
    this.worktrees = opts.worktrees;
    this.store = new TeamStore({
      root: opts.root,
      dispatcherId: this.dispatcherId,
      ...(opts.coreEvents !== undefined ? { coreEvents: opts.coreEvents } : {}),
      // Resolved at publication time, never captured: a materialized Team
      // states its own roster, and any other Team's is read from the identity
      // stores that authoritatively hold it.
      roster: (team) => this.runtimes.roster(team),
    });
    this.reads = new TeamCollectionReadModel({
      dispatcherId: this.dispatcherId,
      store: this.store,
      log: opts.log,
    });
    this.runtimes = new TeamRuntimeRegistry({
      dispatcherId: this.dispatcherId,
      collection: opts,
      store: this.store,
      worktrees: this.worktrees,
      mustTeam: (teamId) => this.mustTeam(teamId),
    });
    this.cleanup = new TeamWorktreeCleanup({
      store: this.store,
      worktrees: this.worktrees,
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
      accept: async (candidate) =>
        (await this.store.get(candidate)) === null,
      ...(this.opts.nameSuffixGenerator !== undefined
        ? { generateSuffix: this.opts.nameSuffixGenerator }
        : {}),
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
  }): Promise<TeamCreateRequestResult> {
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
        // The record is the acceptance point, so it alone answers the replay. A
        // hard process loss between publishing it and the leader identity
        // becoming durable leaves a truthful `starting` Team; materializing it
        // finishes creation through the ordinary TeamMate-owned leader path.
        return {
          status: accepted.status === 'closed' ? 'closed' : 'existing',
          team_name: accepted.team_id,
          leader_name: accepted.leader_name,
        };
      }
      const outcome: { created: TeamCreateResult | null } = { created: null };
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
          });
          return outcome.created !== null;
        },
        ...(this.opts.nameSuffixGenerator !== undefined
          ? { generateSuffix: this.opts.nameSuffixGenerator }
          : {}),
      });
      const created = outcome.created;
      if (created === null) {
        throw new Error(
          `team.create request ${JSON.stringify(input.requestId)} accepted the name ` +
            `${JSON.stringify(teamName)} without publishing a Team record`,
        );
      }
      return {
        status: 'created',
        team_name: created.team.team_name,
        leader_name: created.team.leader_name,
      };
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
   * Create one Team at an exact name the caller chose.
   *
   * Publication of the Team record decides the outcome: a name a valid record
   * already occupies fails here rather than resolving to some other Team. Use
   * {@link createAtCandidate} when a name allocator should rotate instead.
   */
  async create(input: TeamCreateAtNameInput): Promise<TeamCreateResult> {
    const created = await this.createAtCandidate(input);
    if (created === null) {
      throw new Error(
        `Team ${JSON.stringify(input.name)} already exists`,
      );
    }
    return created;
  }

  /**
   * Create one Team at a candidate name, or report the candidate as taken.
   *
   * `null` means a valid Team record occupies that name — the candidate is
   * unavailable and the allocator should offer another.
   */
  private async createAtCandidate(
    input: TeamCreateAtNameInput,
  ): Promise<TeamCreateResult | null> {
    return this.runtimes.create(input, validateTeamId(input.name));
  }

  async list(): Promise<TeamListRow[]> {
    return this.reads.list();
  }

  async history(
    input: TeamHistoryQuery,
  ): Promise<TeamHistoryResult> {
    return this.reads.history(input);
  }

  /**
   * Get-or-rebuild the team's service; a cold-cache miss is deduped (#233).
   *
   * Live Teams only: a closed record has no service, so this reports it as
   * closed rather than building one. Callers outside reach a Team through
   * {@link open} or a lease, which say the same thing in their own words.
   */
  private async get(teamId: string): Promise<TeamService> {
    const id = validateTeamId(teamId);
    return this.runtimes.get(id);
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
   * A Team this process already holds answers for itself, because its live
   * state is the more current version of the same shape. Any other Team is read
   * from its records: whether it is closed or simply not materialized here, a
   * read must not build an entity — and a Team with no runtime in this process
   * has no runtime state for a projection to be missing.
   */
  async summary(teamId: string): Promise<TeamSummary> {
    const record = await this.mustTeam(validateTeamId(teamId));
    const live = this.runtimes.live(record.team_id);
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
      await this.cleanup.settle(teamId);
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
    await this.runtimes.startSchedulers();
  }

  async startWorkflows(): Promise<void> {
    await this.runtimes.startWorkflows();
  }

  async recoverWorkflows(): Promise<void> {
    await this.runtimes.recoverWorkflows();
  }

  closeWorkflowAdmissions(): void {
    this.runtimes.closeWorkflowAdmissions();
  }

  stopSchedulers(): void {
    this.runtimes.stopSchedulers();
  }

  async stopForHost(): Promise<void> {
    await this.runtimes.stopForHost();
  }
}
