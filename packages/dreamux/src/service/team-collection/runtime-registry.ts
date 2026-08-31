import type { TeamStateTeammateSummary } from '@excitedjs/dreamux-types';

import { requireLifecycleText } from '../agent-entity/types.js';
import { defaultWorkspaceEnabled } from '../../config/config.js';
import { dispatcherWorkspace } from '../worktree/workspaces.js';
import { throwSettledFailures } from '../shutdown-errors.js';
import { TeamService } from '../team-service/index.js';
import type {
  TeamClosedSubscription,
  TeamSchedulerLifecycle,
  TeamServiceCreateOutput,
  TeamServiceDeps,
} from '../team-service/types.js';
import type { TeamMateSharedWorkspace } from '../teammate-collection/types.js';
import type { WorktreeManager } from '../worktree/manager.js';
import { TeamClosedError, teamErrorInfo } from './errors.js';
import { readTeamRoster } from './roster-reader.js';
import type { TeamStore } from './store.js';
import type {
  TeamCollectionOptions,
  TeamCreateAtNameInput,
  TeamCreateResult,
  TeamRecord,
} from './types.js';

interface TeamRuntimeRegistryOptions {
  dispatcherId: string;
  collection: TeamCollectionOptions;
  store: TeamStore;
  worktrees: WorktreeManager;
  mustTeam(teamId: string): Promise<TeamRecord>;
}

/** Owns materialized TeamService instances and their private lifecycle handles. */
export class TeamRuntimeRegistry {
  private readonly cache = new Map<string, TeamService>();
  private readonly schedulers = new Map<
    string,
    { service: TeamService; lifecycle: TeamSchedulerLifecycle }
  >();
  private readonly materialized = new Set<TeamService>();
  private readonly closedSubscriptions = new Map<
    TeamService,
    TeamClosedSubscription
  >();
  private readonly constructing = new Map<string, Promise<TeamService | null>>();

  constructor(private readonly opts: TeamRuntimeRegistryOptions) {}

  /**
   * Create one Team at this candidate name, or report the name as taken.
   *
   * `null` means the candidate is not this creation's to use: a valid Team
   * record already occupies it, or a construction already owns it. The caller
   * allocates another one, and nothing this attempt made survives it.
   */
  async create(
    input: TeamCreateAtNameInput,
    teamId: string,
  ): Promise<TeamCreateResult | null> {
    requireLifecycleText(input.intent, 'Team create intent');
    // A cheap early-out before the expensive workspace preparation. The
    // authoritative answer is the exclusive record publication below, which
    // reports the same thing if the name is taken in between.
    if ((await this.opts.store.get(teamId)) !== null) return null;
    // Synchronous from here: whoever registers first owns this id, so a second
    // create at the same candidate steps aside rather than racing it.
    if (this.constructing.has(teamId)) return null;
    const construction = this.createTeam(input, teamId);
    this.publishConstruction(
      teamId,
      construction.then((created) => created?.service ?? null),
    );
    const created = await construction;
    if (created === null) return null;
    const { service, leaderResult } = created;
    return {
      team: service.view(),
      leader: leaderResult.teammate,
      member_count: await service.memberCount(),
      status: leaderResult.submission?.status ?? null,
      ...(leaderResult.submission?.error !== undefined
        ? { error: leaderResult.submission.error }
        : {}),
    };
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
  ): Promise<TeamServiceCreateOutput<TeamService> | null> {
    const workspace = await this.prepareWorkspace(input, teamId);
    let created: TeamServiceCreateOutput<TeamService> | null;
    try {
      created = await TeamService.createNew(this.depsBase(teamId), {
        teamId,
        name: input.name,
        ...(input.createRequest !== undefined
          ? { createRequest: input.createRequest }
          : {}),
        ...(input.prompt !== undefined ? { prompt: input.prompt } : {}),
        leaderAgentRuntime: input.leaderAgentRuntime,
        intent: input.intent,
        ...(input.identity !== undefined ? { identity: input.identity } : {}),
        ...(input.skillSources !== undefined
          ? { skillSources: input.skillSources }
          : {}),
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
    this.track(created.service);
    this.publish(created.service, created.schedulerLifecycle);
    return created;
  }

  private async prepareWorkspace(
    input: TeamCreateAtNameInput,
    teamId: string,
  ): Promise<TeamMateSharedWorkspace> {
    const workspaceRoot = await dispatcherWorkspace(
      this.opts.collection.config,
      this.opts.dispatcherId,
    );
    return input.worktree === undefined && input.repoCwd === undefined
      ? this.opts.worktrees.prepareDefaultWorkspace({
          dispatcherWorkspace: workspaceRoot,
          slug: teamId,
          workspaceEnabled: defaultWorkspaceEnabled(
            this.opts.collection.config,
            this.opts.dispatcherId,
          ),
        })
      : this.opts.worktrees.prepare({
          dispatcherId: this.opts.dispatcherId,
          teammateName: `team-${teamId}`,
          cwd: input.repoCwd ?? workspaceRoot,
          dispatcherWorkspace: workspaceRoot,
          request: input.worktree ?? {
            mode: 'managed',
            slug: `team-${teamId}`,
            cleanup: 'keep',
          },
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
      if ((await this.opts.store.get(teamId)) !== null) return;
      const cleaned = await this.opts.worktrees.cleanup({
        source_cwd: workspace.sourceCwd,
        source_repo: workspace.sourceRepo,
        worktree: workspace.worktree,
      });
      // Removed or deliberately kept is the end of it. Anything else is a
      // directory this attempt made and nobody now owns, so it is reported the
      // same way a raised failure is — once, with where it is and why it stayed.
      if (cleaned.cleanup_state !== 'deleted' && cleaned.cleanup_state !== 'kept') {
        this.opts.collection.log.warn(
          {
            dispatcher_id: this.opts.dispatcherId,
            team_id: teamId,
            path: cleaned.path,
            cleanup_state: cleaned.cleanup_state,
            cleanup_error: cleaned.cleanup_error,
          },
          'prepared Team worktree was left behind',
        );
      }
    } catch (error) {
      this.opts.collection.log.warn(
        {
          dispatcher_id: this.opts.dispatcherId,
          team_id: teamId,
          path: workspace.worktree.path,
          err: teamErrorInfo(error),
        },
        'prepared Team worktree was left behind',
      );
    }
  }

  /** The Team this process already holds, or `null`. Never materializes one. */
  live(teamId: string): TeamService | null {
    return this.cache.get(teamId) ?? null;
  }

  /**
   * The live Team at this id, joining whatever is already building it.
   *
   * Creation publishes a Team's record before its object graph is finished, so
   * a read that saw only the record would build a second, competing owner of
   * the same Team. Every path that can produce the object registers here
   * instead. `null` from a joined construction means that construction did not
   * produce this Team — a create whose candidate turned out to be taken — so
   * the decision is made again against what is now durable rather than
   * reported as this caller's answer.
   */
  async get(teamId: string): Promise<TeamService> {
    for (;;) {
      const cached = this.cache.get(teamId);
      if (cached !== undefined) return cached;
      const joined = this.constructing.get(teamId);
      if (joined === undefined) {
        const construction = this.rebuild(teamId);
        this.publishConstruction(teamId, construction);
        return construction;
      }
      const service = await joined;
      if (service !== null) return service;
    }
  }

  async startSchedulers(): Promise<void> {
    for (const team of await this.opts.store.list()) {
      if (team.status === 'closed') continue;
      try {
        const service = await this.get(team.team_id);
        const scheduler = this.schedulers.get(service.id);
        if (scheduler === undefined || scheduler.service !== service) {
          throw new Error(
            `Team ${JSON.stringify(service.id)} scheduler lifecycle is unavailable`,
          );
        }
        await scheduler.lifecycle.start();
      } catch (error) {
        this.opts.collection.log.error(
          {
            dispatcher_id: this.opts.dispatcherId,
            team_id: team.team_id,
            err: teamErrorInfo(error),
          },
          'TeamLeader scheduler start failed',
        );
      }
    }
  }

  async startWorkflows(): Promise<void> {
    for (const team of await this.opts.store.list()) {
      if (team.status === 'closed') continue;
      await (await this.get(team.team_id)).startWorkflowAdmission();
    }
  }

  async recoverWorkflows(): Promise<void> {
    for (const team of await this.opts.store.list()) {
      if (team.status === 'closed') continue;
      await (await this.get(team.team_id)).recoverWorkflows();
    }
  }

  closeWorkflowAdmissions(): void {
    for (const service of this.materialized) service.closeWorkflowAdmission();
  }

  stopSchedulers(): void {
    for (const scheduler of this.schedulers.values()) scheduler.lifecycle.stop();
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
    const services = [...this.materialized];
    const results = await Promise.allSettled(
      // The containment root publishes its aggregate admission fence before
      // this sweep. Do not hold a Team route lock while releasing members:
      // their captured completion delivery may resolve the same TeamLeader
      // through that route before the leader itself is released.
      services.map((service) => service.stopForHost()),
    );
    results.forEach((result, index) => {
      if (result.status === 'fulfilled') {
        this.evict(services[index]!.id, services[index]!);
      }
    });
    throwSettledFailures(results, 'multiple Team runtimes failed to stop');
  }

  /**
   * One Team's complete contained-Agent summary, for the aggregate event.
   *
   * A materialized Team answers for itself: it owns those Agents, and its
   * projection is current by construction. Any other Team is read from the
   * authoritative identity stores instead of being reported as empty, which in
   * that event would state that the Team has no Agents at all.
   *
   * The cache answers first because it is keyed and replacement-correct. A
   * Team still being created is not cached yet — it publishes its own
   * `running` transition before creation returns — and `materialized` is the
   * earlier exact fact: the service owns live resources from that moment.
   *
   * Reading only. It must not materialize a Team: the caller runs inside the
   * Team store's own write queue, which materialization writes through.
   */
  async roster(
    team: TeamRecord,
  ): Promise<readonly TeamStateTeammateSummary[] | null> {
    const cached = this.cache.get(team.team_id);
    if (cached !== undefined) return cached.teammatesSummary();
    for (const service of this.materialized) {
      if (service.id === team.team_id) return service.teammatesSummary();
    }
    return readTeamRoster({
      teamRoot: this.opts.store.teamRoot(team.team_id),
      record: team,
      log: this.opts.collection.log,
    });
  }

  /**
   * Rebuild one Team from its record.
   *
   * A closed record is not a Team, it is that Team's history: nothing here
   * constructs one, so a status read, a startup sweep, or a leftover physical
   * cleanup answers from the record instead. That is what keeps this registry
   * bounded by the Teams that are alive rather than by every Team that ever
   * existed.
   */
  private async rebuild(teamId: string): Promise<TeamService> {
    const record = await this.opts.mustTeam(teamId);
    if (record.status === 'closed') {
      throw new TeamClosedError(
        `Team ${JSON.stringify(record.team_id)} is closed`,
      );
    }
    const { service, schedulerLifecycle } = await TeamService.rebuild(
      this.depsBase(record.team_id),
      record,
    );
    this.track(service);
    this.publish(service, schedulerLifecycle);
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

  private publish(
    service: TeamService,
    lifecycle: TeamSchedulerLifecycle,
  ): void {
    this.cache.set(service.id, service);
    this.schedulers.set(service.id, { service, lifecycle });
  }

  /**
   * Take ownership of one materialized Team, and listen for its end.
   *
   * This registry is what holds a Team, so this is where it starts holding one:
   * the factory hands back a finished service and the owner tracks it, rather
   * than being called back into from inside the construction it asked for.
   */
  private track(service: TeamService): void {
    if (this.closedSubscriptions.has(service)) return;
    this.materialized.add(service);
    this.closedSubscriptions.set(
      service,
      // The exact instance that ended is the exact instance dropped; a Team
      // rebuilt at the same id afterwards is a different object and stays.
      service.onClosed(() => this.evict(service.id, service)),
    );
  }

  private evict(teamId: string, expectedService: TeamService): void {
    this.materialized.delete(expectedService);
    this.closedSubscriptions.get(expectedService)?.unsubscribe();
    this.closedSubscriptions.delete(expectedService);
    if (this.cache.get(teamId) !== expectedService) return;
    this.cache.delete(teamId);
    const scheduler = this.schedulers.get(teamId);
    if (scheduler?.service === expectedService) this.schedulers.delete(teamId);
  }

  private depsBase(teamId: string): TeamServiceDeps {
    const collection = this.opts.collection;
    return {
      dispatcherId: this.opts.dispatcherId,
      config: collection.config,
      agentRuntimeProviders: collection.agentRuntimeProviders,
      worktrees: this.opts.worktrees,
      // Each Team gets its own already-resolved root; nothing below rebuilds it.
      teamRoot: this.opts.store.teamRoot(teamId),
      names: collection.names,
      admissions: collection.admissions,
      ...(collection.conversationProjection !== undefined
        ? { conversationProjection: collection.conversationProjection }
        : {}),
      completionDelivery: collection.completionDelivery,
      leaderCompletionInitiator: collection.dispatcherCompletionInitiator,
      admitOperation: collection.admitOperation ?? ((task) => task()),
      store: this.opts.store,
      leaderMcp: collection.leaderMcp,
      ...(collection.coreEvents !== undefined
        ? { coreEvents: collection.coreEvents }
        : {}),
      log: collection.log,
      workflowLog: collection.workflowLog ?? collection.log,
      ...(collection.agentNameSuffixGenerator !== undefined
        ? { agentNameSuffixGenerator: collection.agentNameSuffixGenerator }
        : {}),
    };
  }
}
