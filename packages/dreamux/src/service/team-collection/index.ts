import type {
  // The published `team.create` contract; the Team domain returns it directly
  // rather than defining a second creation-result shape.
  TeamCreateResult as TeamCreateRequestResult,
} from '@excitedjs/dreamux-types';

import type { InboundDeliveryResult } from '../teammate-service/turn-recording.js';

import type { WorktreeManager } from '../worktree/manager.js';
import type {
  CompletionInitiator,
  PreparedCompletionDelivery,
} from '../completion-router/index.js';
import { requireLifecycleText } from '../agent-entity/types.js';
import type { TeammateSubmitInput } from '../teammate-service/submission.js';
import type { SchedulerCommands } from '../scheduler/types.js';
import { KeyedAsyncQueue } from '../serial-queue.js';
import { TeamStore } from './store.js';
import type {
  TeamCreateInput,
  TeamCreateAtNameInput,
  TeamCreateResult,
  AcceptedTeamDissolve,
  AcceptedTeamLogicalClose,
  TeamDissolveRequest,
  TeamHistoryQuery,
  TeamHistoryResult,
  TeamLeaderLease,
  TeamListRow,
  TeamRecord,
  TeamSummary,
  TeamCollectionOptions,
} from './types.js';
import { validateTeamId } from './types.js';
import { allocateConcreteNameAsync } from '../name-allocator.js';
import {
  TeamService,
} from '../team-service/index.js';
import type { TurnAdmission } from '../teammate-service/turn-recording.js';
import {
  IdempotencyConflictError,
  isTeamUnavailable,
  TeamClosedError,
  TeamGenerationChangedError,
  TeamNotFoundError,
} from './errors.js';
import { isActiveDissolve } from './dissolve-lifecycle.js';
import { TeamDissolveController } from './dissolve-controller.js';
import { TeamCollectionReadModel } from './read-model.js';
import { TeamRuntimeRegistry } from './runtime-registry.js';

/**
 * The dispatcher's team collection (issue #233): one per dispatcher, owned by
 * `DispatcherService`. Owns the team store + worktree manager; exposes
 * `create` / `list` / `history` and open-Team route-owner facts. `get(teamId)` is a get-or-rebuild factory (like `Dispatchers.get`
 * / `TeammateCollection.entityFor`): cached live {@link TeamService} if any, else
 * rebuilt from the persisted {@link TeamRecord} and cached. Each `TeamService`
 * OWNS its per-team {@link TeammateCollection} (`teamScope: team_id`) built from
 * the shared deps forwarded here. Closed services may remain cached for read
 * projections; durable status plus the shared fence prevents reuse, and
 * physical-cleanup completion may evict the cache entry.
 */
/** One accepted creation request, as reconstructed from its Team record. */
interface AcceptedCreateRequest {
  teamId: string;
  payloadHash: string;
}

export class TeamCollection {
  private readonly dispatcherId: string;
  private readonly store: TeamStore;
  private readonly worktrees: WorktreeManager;
  /**
   * Serializes route publication with the start of Team closure. The closing
   * marker is deliberately separate from persisted Team status: it is a
   * process-lifetime write fence, while `closed` remains the durable fact.
   */
  private readonly routeLifecycle = new KeyedAsyncQueue();
  private readonly routeClosing = new Set<string>();
  private readonly leaderRecipientKeys = new Map<string, object>();
  private readonly dissolves: TeamDissolveController;
  private readonly reads: TeamCollectionReadModel;
  private readonly runtimes: TeamRuntimeRegistry;
  /**
   * Accepted `team.create` identities, keyed by request id.
   *
   * Pure derived acceleration over the Team records that already carry those
   * identities — never a second authority. It is reconstructed from the records
   * on first use and kept current by the creations this process performs, so
   * losing it costs a directory scan and nothing else.
   */
  private acceptedRequests: Map<string, AcceptedCreateRequest> | null = null;
  private acceptedRequestsBuild:
    | Promise<Map<string, AcceptedCreateRequest>>
    | null = null;
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
      routeLifecycle: this.routeLifecycle,
      mustTeam: (teamId) => this.mustTeam(teamId),
      admitAvailable: (teamId, task) =>
        this.withTeamAvailable(teamId, () => task()),
      completionInitiator: (teamId, delegate) =>
        this.completionInitiatorThroughAvailability(
          teamId,
          delegate.recipientKey ?? delegate,
          (_service, completion) => delegate.prepareCompletion(completion),
        ),
      leaderCompletionInitiator: (teamId) =>
        this.completionInitiatorForLeader(teamId),
      withTeamLeaderLease: (lease, task) =>
        this.withTeamLeaderLease(lease, task),
    });
    this.dissolves = new TeamDissolveController({
      dispatcherId: this.dispatcherId,
      store: this.store,
      worktrees: this.worktrees,
      routeLifecycle: this.routeLifecycle,
      log: opts.log,
      isShuttingDown: opts.isShuttingDown,
      ...(opts.trackAcceptedOperation !== undefined
        ? { trackAcceptedOperation: opts.trackAcceptedOperation }
        : {}),
      mustTeam: (teamId) => this.mustTeam(teamId),
      getService: (teamId) => this.get(teamId),
      activateClosing: (record, service) =>
        this.activateTeamClosingFence(record, service),
      closeResources: (input) => this.closeAcceptedResources(input),
      endClosing: (teamId, reopen) => this.endTeamClosing(teamId, reopen),
      replaceCachedRecord: (teamId, record) =>
        this.runtimes.replaceCachedRecord(teamId, record),
      assertNewCloseAvailable: (teamId) => {
        if (this.routeClosing.has(teamId)) {
          throw new TeamClosedError(`Team ${JSON.stringify(teamId)} is closing`);
        }
      },
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
      const accepted = (await this.acceptedRequestIndex()).get(input.requestId);
      if (accepted !== undefined) {
        if (accepted.payloadHash !== input.payloadHash) {
          throw new IdempotencyConflictError(
            `request_id ${JSON.stringify(input.requestId)} was already accepted with a ` +
              'different team.create payload; use a new request_id for a new Team',
          );
        }
        return this.replayResult(accepted.teamId);
      }
      const outcome: { created: TeamCreateResult | null } = { created: null };
      let teamName: string;
      try {
        teamName = await allocateConcreteNameAsync({
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
      } catch (err) {
        // A creation that failed after publishing its record still accepted this
        // request: the record is the acceptance point, and the cleanup path
        // closes that Team rather than removing it. Drop the derived index so
        // the next attempt re-reads the records instead of creating a second
        // Team for an id that already owns one.
        this.acceptedRequests = null;
        this.acceptedRequestsBuild = null;
        throw err;
      }
      const created = outcome.created;
      if (created === null) {
        throw new Error(
          `team.create request ${JSON.stringify(input.requestId)} accepted the name ` +
            `${JSON.stringify(teamName)} without publishing a Team record`,
        );
      }
      (await this.acceptedRequestIndex()).set(input.requestId, {
        teamId: teamName,
        payloadHash: input.payloadHash,
      });
      return {
        status: 'created',
        team_name: created.team.team_name,
        leader_name: created.team.leader_name,
      };
    });
  }

  /** Reconstruct the derived request-id index from the authoritative records. */
  private async acceptedRequestIndex(): Promise<
    Map<string, AcceptedCreateRequest>
  > {
    const ready = this.acceptedRequests;
    if (ready !== null) return ready;
    this.acceptedRequestsBuild ??= (async () => {
      const index = new Map<string, AcceptedCreateRequest>();
      for (const team of await this.store.list()) {
        if (team.create_request_id === null || team.create_payload_hash === null) {
          continue;
        }
        index.set(team.create_request_id, {
          teamId: team.team_id,
          payloadHash: team.create_payload_hash,
        });
      }
      this.acceptedRequests = index;
      return index;
    })();
    return this.acceptedRequestsBuild;
  }

  /**
   * Project a replayed request from the Team record alone.
   *
   * The record is the acceptance point, so it alone answers the replay. A hard
   * process loss between publishing it and the leader identity becoming durable
   * leaves a truthful `starting` Team; materializing it finishes creation
   * through the ordinary TeamMate-owned leader path, so there is nothing for a
   * replay to reconstruct or refuse here.
   */
  private async replayResult(teamId: string): Promise<TeamCreateRequestResult> {
    const record = await this.mustTeam(teamId);
    return {
      status: record.status === 'closed' ? 'closed' : 'existing',
      team_name: record.team_id,
      leader_name: record.leader_name,
    };
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
   * unavailable and the allocator should offer another. Everything else, a
   * closing route included, throws.
   */
  private async createAtCandidate(
    input: TeamCreateAtNameInput,
  ): Promise<TeamCreateResult | null> {
    const teamId = validateTeamId(input.name);
    if (this.routeClosing.has(teamId)) {
      throw new TeamClosedError(`Team ${JSON.stringify(teamId)} is closing`);
    }
    return this.routeLifecycle.run(teamId, async () => {
      if (this.routeClosing.has(teamId)) {
        throw new TeamClosedError(`Team ${JSON.stringify(teamId)} is closing`);
      }
      return this.runtimes.create(input, teamId);
    });
  }

  async list(): Promise<TeamListRow[]> {
    return this.reads.list();
  }

  async history(
    input: TeamHistoryQuery,
  ): Promise<TeamHistoryResult> {
    return this.reads.history(input);
  }

  /** Get-or-rebuild the team's service; a cold-cache miss is deduped (#233). */
  async get(teamId: string): Promise<TeamService> {
    const id = validateTeamId(teamId);
    return this.runtimes.get(id);
  }

  async teamLeaderLease(teamId: string): Promise<TeamLeaderLease> {
    const id = validateTeamId(teamId);
    return this.withTeamAvailable(id, async (service) => {
      return { teamId: id, leaderName: service.leaderName };
    });
  }

  /** Read-safe generation lease used to construct a handle while closing. */
  async teamLeaderReadLease(teamId: string): Promise<TeamLeaderLease> {
    const id = validateTeamId(teamId);
    return this.routeLifecycle.run(id, async () => {
      const record = await this.mustTeam(id);
      return { teamId: id, leaderName: record.leader_name };
    });
  }

  async withTeamLeaderLease<T>(
    lease: TeamLeaderLease,
    task: (service: TeamService) => Promise<T>,
  ): Promise<T> {
    const id = validateTeamId(lease.teamId);
    return this.withTeamAvailable(id, async (service) => {
      if (service.leaderName !== lease.leaderName) {
        throw new TeamGenerationChangedError(
          `Team ${JSON.stringify(id)} generation is no longer current`,
        );
      }
      return task(service);
    });
  }

  /** Generation-only read lease; durable closing keeps Team read paths alive. */
  async withTeamLeaderReadLease<T>(
    lease: TeamLeaderLease,
    task: (service: TeamService) => Promise<T>,
  ): Promise<T> {
    const id = validateTeamId(lease.teamId);
    return this.routeLifecycle.run(id, async () => {
      const record = await this.mustTeam(id);
      if (record.leader_name !== lease.leaderName) {
        throw new TeamGenerationChangedError(
          `Team ${JSON.stringify(id)} generation is no longer current`,
        );
      }
      return task(await this.get(id));
    });
  }

  /**
   * Submit one turn to a Team's TeamLeader through the shared availability
   * fence. A Team that does not exist, is closed, or is closing fails here as
   * that exact fact — {@link TeamNotFoundError} or {@link TeamClosedError} —
   * before any runtime admission.
   */
  async submitToLeader(
    teamId: string,
    input: Parameters<TeamService['submitToLeader']>[0],
  ): Promise<TurnAdmission> {
    const id = validateTeamId(teamId);
    return this.withTeamAvailable(id, (service) => service.submitToLeader(input));
  }

  async deliverToLeader(
    teamId: string,
    input: TeammateSubmitInput,
  ): Promise<InboundDeliveryResult> {
    const id = validateTeamId(teamId);
    return this.withTeamAvailable(id, (service) =>
      service.deliverToLeader(input),
    );
  }

  /** Resolve a generation-bound completion target without exposing the leader. */
  async completionInitiatorForLeader(
    teamId: string,
  ): Promise<CompletionInitiator | null> {
    const id = validateTeamId(teamId);
    const record = await this.store.get(id);
    if (record === null) return null;
    const leaderName = record.leader_name;
    return this.completionInitiatorThroughAvailability(
      id,
      this.leaderRecipientKey(id, leaderName),
      async (service, completion) => {
        if (service.leaderName !== leaderName) {
          return unsupportedPreparedCompletion(
            'TeamLeader generation is no longer current',
          );
        }
        return service.leader.prepareCompletion(completion);
      },
    );
  }

  /**
   * Persist and fence one Team dissolve before returning an accepted handle.
   * The route lifecycle queue atomically orders the trigger-specific
   * preflight, durable acceptance, and the shared availability fence.
   */
  async acceptDissolve(
    request: TeamDissolveRequest,
  ): Promise<AcceptedTeamDissolve> {
    return this.dissolves.accept(request);
  }

  /** Start or join the one runner for a durably accepted operation. */
  startAcceptedDissolve(handle: AcceptedTeamDissolve): void {
    this.dissolves.start(handle);
  }

  /** Resume durable gates and lifecycle work before any normal Team work. */
  async recoverDissolves(): Promise<void> {
    await this.dissolves.recover();
  }

  /**
   * Interrupt only owner retry timers and pending phase advances. Physical
   * cleanup and resource-close attempts stay tracked through shutdown drain.
   */
  interruptDissolvesForShutdown(): void {
    this.dissolves.interruptForShutdown();
  }

  /** The resource half of an accepted dissolve, owned by this collection. */
  private async closeAcceptedResources(
    input: AcceptedTeamLogicalClose,
  ): Promise<TeamSummary> {
    const current = await this.dissolves.requireCurrentRecord({
      teamId: input.teamId,
      operationId: input.operationId,
    });
    const service = await this.get(input.teamId);
    if (current.status === 'closed') return service.status();
    return service.closeLogically({
      note: input.note,
      dissolve: input.dissolve,
      worktree: input.worktree,
    });
  }

  /**
   * Raise the one process-local Team closing fence. Callers hold the Team's
   * route-lifecycle queue and have already decided whether this is a new
   * ordinary close or an idempotent durable dissolve recovery/join.
   */
  private activateTeamClosingFence(
    record: TeamRecord,
    service: TeamService,
  ): void {
    this.routeClosing.add(record.team_id);
    this.runtimes.closeAdmissionAndStopScheduler(record.team_id, service);
  }

  private completionInitiatorThroughAvailability(
    teamId: string,
    recipientKey: object,
    deliver: (
      service: TeamService,
      completion: Parameters<CompletionInitiator['prepareCompletion']>[0],
    ) => ReturnType<CompletionInitiator['prepareCompletion']>,
  ): CompletionInitiator {
    return {
      recipientKey,
      prepareCompletion: async (completion) => {
        let prepared;
        try {
          prepared = await this.withTeamAvailable(teamId, (service) =>
            deliver(service, completion),
          );
        } catch (error) {
          if (isTeamUnavailable(error)) {
            return unsupportedPreparedCompletion();
          }
          throw error;
        }
        return Object.freeze({
          submit: async () => {
            try {
              return await this.withTeamAvailable(teamId, () =>
                prepared.submit());
            } catch (error) {
              if (isTeamUnavailable(error)) {
                return {
                  status: 'unsupported' as const,
                  reason: 'Team is closing or unavailable',
                };
              }
              throw error;
            }
          },
        });
      },
    };
  }

  private leaderRecipientKey(teamId: string, leaderName: string): object {
    const key = `${teamId}\0${leaderName}`;
    let identity = this.leaderRecipientKeys.get(key);
    if (identity === undefined) {
      identity = Object.freeze({});
      this.leaderRecipientKeys.set(key, identity);
    }
    return identity;
  }

  async hasTeam(teamId: string): Promise<boolean> {
    return (await this.store.get(validateTeamId(teamId))) !== null;
  }

  private async withTeamAvailable<T>(
    teamId: string,
    task: (service: TeamService) => Promise<T>,
  ): Promise<T> {
    const id = validateTeamId(teamId);
    return this.routeLifecycle.run(id, async () => {
      const record = await this.mustOpenTeam(id);
      if (this.routeClosing.has(id) || isActiveDissolve(record.dissolve)) {
        throw new TeamClosedError(`Team ${JSON.stringify(id)} is closing`);
      }
      const service = await this.get(id);
      return task(service);
    });
  }

  private async endTeamClosing(
    teamId: string,
    reopen: boolean,
  ): Promise<void> {
    const id = validateTeamId(teamId);
    await this.routeLifecycle.run(id, async () => {
      const current = await this.store.get(id);
      if (current !== null && isActiveDissolve(current.dissolve)) return;
      if (reopen && current !== null && current.status !== 'closed') {
        await this.runtimes.reopen(id);
      }
      this.routeClosing.delete(id);
    });
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

  private async mustOpenTeam(teamId: string): Promise<TeamRecord> {
    const team = await this.mustTeam(teamId);
    if (team.status === 'closed') {
      throw new TeamClosedError(`Team ${JSON.stringify(teamId)} is closed`);
    }
    return team;
  }

  async scheduler(teamId: string): Promise<SchedulerCommands> {
    await this.mustOpenTeam(teamId);
    return this.runtimes.scheduler(validateTeamId(teamId));
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

function unsupportedPreparedCompletion(
  reason = 'Team is closing or unavailable',
): PreparedCompletionDelivery {
  return Object.freeze({
    submit: async () => ({
      status: 'unsupported' as const,
      reason,
    }),
  });
}
