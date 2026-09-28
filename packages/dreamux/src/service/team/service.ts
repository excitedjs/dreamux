import type {
  AgentRuntimeInterruptOutcome,
  LaunchDraft,
  Team,
  TeamSummary,
} from '@excitedjs/dreamux-types';
import { errorInfo, type TransactionalStore } from '@excitedjs/dreamux-utils';
import { AsyncSeriesHook } from 'tapable';

import type { CompletionInitiator } from '../completion-router/index.js';
import { SchedulerService } from '../scheduler/index.js';
import { CronJobStore } from '../scheduler/store.js';
import type { SchedulerCommands } from '../scheduler/types.js';
import type { TeamStore } from './store.js';
import { TeammateCollection } from '../agent/index.js';
import type { CreateLockedTeammateOptions } from '../agent/service-types.js';
import type {
  SpawnTeamMateRequest,
  TeamWorkspaceLoan,
  TeammateOps,
} from '../agent/types.js';
import {
  AgentIdentityStore,
  AgentEntityCollectionStore,
} from '../agent/store.js';
import type { TeammateSubmitInput } from '../agent/submission.js';
import { AGENT_TASK_SOURCE, SCHEDULED_SOURCE } from '../submission-sources.js';
import {
  teamCronJobsPath,
  teamMateCollectionDir,
} from '../../platform/paths.js';
import {
  optionalLifecycleText,
  requireLifecycleText,
  type AgentEntityIdentityStatus,
  type AgentEntityRuntimeStatus,
} from '../agent/identity.js';
import type { AgentService } from '../agent/service.js';
import { toSubmissionResult } from '../agent/admission.js';
import type { TurnAdmission } from '../agent/turn.js';
import { TeamClosedError } from './errors.js';
import {
  alignedWithLeader,
  createTeamLeaderAgentForTeam,
  leaderForOpenTeam,
  restoreTeamLeaderAgentForTeam,
  teamLeaderAgentBase,
  type TeamLeaderCreationInput,
} from './leader.js';
import { launchDraftTaps } from '../../plugin/hooks.js';
import {
  ClosedFactPublisher,
  type ClosedSubscription,
} from '../../platform/closed-fact.js';
import { TeamClosing } from './closing.js';
import { TeamLeaderCompletionTargets } from './completion-targets.js';
import { TeamRosterProjection } from './roster.js';
import { teamSummary } from './team-summary.js';
import {
  teamClosedFact,
  type TeamClosedFact,
  type TeamClosedListener,
  type TeamCollectionOptions,
  type TeamDissolveCommand,
  type TeamDissolveReceipt,
  type TeamRecord,
  type TeamServiceCreateInput,
} from './types.js';
import {
  WorkflowService,
  type WorkflowOps,
} from '../workflow-service/index.js';

/**
 * What one Team is built from.
 *
 * Collaborators and shared dispatcher facts only: nothing here reaches back
 * into the collection that constructed the Team. A Team is handed what it
 * needs, does its own work with it, and states what happened by publishing its
 * own terminal fact — so its owner learns of its end without the Team ever
 * calling upward into its owner's lifecycle.
 *
 * Everything but the three fields below is forwarded unchanged from the
 * `TeamCollectionOptions` the owning `TeamCollection` was itself constructed
 * with (`depsBase()` spreads it directly); `root`, `nameSuffixGenerator`, and
 * `applyCreateTeamHook` are collection-only concerns a Team never needs — the
 * `createTeam` hook is applied once, by `createFromRequest` itself, before any
 * `TeamService` for that Team exists to be handed these deps.
 *
 * Declared here rather than in `types.ts`: it names `TeamStore`, a concrete
 * class, so it is a constructor-options bag rather than a data type.
 */
export type TeamServiceDeps = Omit<
  TeamCollectionOptions,
  'root' | 'nameSuffixGenerator' | 'applyCreateTeamHook'
> & {
  /**
   * This Team's own root directory, bound by `TeamCollection` when it
   * constructed this service. The TeamLeader's `identity.json`, the Team
   * `record.json`, this Team's cron jobs, and its `teammate/` collection all sit
   * directly under it — the Team never rebuilds the path from ids.
   */
  teamRoot: string;
  store: TeamStore;
  /**
   * Finish the physical reclamation a closed Team's record still owes, through
   * the same record-only path the collection's own startup sweep uses. A
   * plain constructor-supplied value rather than a collection import: `store`
   * ← `service` ← `collection` is the declared direction, so the service tier
   * must not import the collection tier that holds this method.
   */
  settleWorktreeCleanup: (teamId: string) => Promise<void>;
};

/**
 * A single team entity (issue #233): holds its own {@link TeamRecord}, *has a*
 * leader {@link AgentService} (Phase 4, at the team root), and OWNS its
 * members' team-scoped {@link TeammateCollection}. It owns every per-team
 * runtime and resource operation, dissolve included, and is the only writer of
 * its own record. Admin `team_leader` target calls are forwarded to this Team's
 * own collection (no team id — scope is baked in); the leader is never a member
 * row.
 */
export class TeamService implements Team {
  /** This Team's own `TransactionalStore` handle, held for the life of this
   * entity instead of re-fetched per call. `deps.store` owns one such store
   * per Team id (for the life of the collection), so this is the same
   * committed value every write through `deps.store` publishes. */
  private readonly recordHandle: TransactionalStore<TeamRecord | null>;
  private leader_: AgentService | null = null;
  private leaderBuild: Promise<AgentService> | null = null;
  private readonly roster: TeamRosterProjection;
  readonly id: string;
  /** Stored at construction: the `team` hook sees a created Team before its record exists. */
  readonly name: string;
  readonly workspace: string;
  readonly hooks: Team['hooks'];
  /** The TeamLeader's identity storage, bound to this Team's root. */
  private readonly leaderIdentity: AgentIdentityStore;
  /** The team's OWN members collection (`teamScope: team_id`, issue #233).
   * Its concrete class owns the lifecycle methods driven by the team; the PUBLIC
   * surface stays the narrow `teammates` admin ops — never expose internal verbs. */
  private readonly teammateCollection: TeammateCollection;
  private readonly scheduler_: SchedulerService;
  private readonly workflowService: WorkflowService;
  /** This Team's stop-and-close half. */
  private readonly closing: TeamClosing;
  /**
   * This Team's one dissolve, published the moment it is submitted.
   *
   * It is both the operation and the work fence: while it is here the Team
   * takes no new work and a second submission joins rather than dismantling the
   * same Team twice. A failure clears it — the Team stays open and can be asked
   * again — and a success keeps it forever, which is what a closed Team is.
   */
  private dissolveTask: Promise<void> | null = null;
  /** This Team's leader, as everything inside it reports to it. */
  private readonly leaderTargets: TeamLeaderCompletionTargets;
  /** Everyone holding this Team, told once it is durably over. */
  private readonly closed: ClosedFactPublisher<TeamClosedFact>;

  private constructor(
    private readonly deps: TeamServiceDeps,
    init: { teamId: string; name: string; workspace: string },
  ) {
    const { teamId } = init;
    this.id = teamId;
    this.name = init.name;
    this.workspace = init.workspace;
    // Bound synchronously here so the roster below can hold a reference to
    // it; loaded by whichever caller of the static factories reads or
    // publishes this Team's record first (both `createNew` and `rebuild` do
    // so before any code path that could read it through `mustRecord()`).
    this.recordHandle = deps.store.handle(teamId);
    this.hooks = Object.freeze({
      leaderLaunch: launchDraftTaps(
        new AsyncSeriesHook<[LaunchDraft]>(['draft'], 'leaderLaunch'),
        deps.log,
      ),
    });
    this.closed = new ClosedFactPublisher<TeamClosedFact>(deps.log);
    this.leaderTargets = new TeamLeaderCompletionTargets({
      admit: (task) => this.admit(task),
      prepareLeaderCompletion: async (completion) =>
        (await this.leaderService()).prepareCompletion(completion),
    });
    // Constructed before the identity stores below: their persistence hooks
    // publish through it.
    this.roster = new TeamRosterProjection({
      teamId,
      coreEvents: deps.coreEvents,
      record: () => this.mustRecord(),
    });
    // The leader lives at the Team root itself; its TeamMates live one level
    // below, in this Team's own `teammate/` collection. Both roots are composed
    // once here, from the root this Team was constructed with.
    this.leaderIdentity = new AgentIdentityStore({
      dir: deps.teamRoot,
      dispatcherId: deps.dispatcherId,
      expectedName: null,
      log: deps.log,
    });
    // The Agents this Team owns, as its own team-scoped collection. Every
    // Agent in it belongs to this Team, so its completions go to this Team's
    // leader: ownership decides the recipient, not a field on the producing
    // record.
    this.teammateCollection = new TeammateCollection({
      dispatcherId: deps.dispatcherId,
      teamScope: teamId,
      config: deps.config,
      agentRuntimeProviders: deps.agentRuntimeProviders,
      worktrees: deps.worktrees,
      store: new AgentEntityCollectionStore({
        root: teamMateCollectionDir(deps.teamRoot),
        dispatcherId: deps.dispatcherId,
        log: deps.log,
        onPersisted: (identity) => this.roster.publish(identity, 'teammate'),
      }),
      names: deps.names,
      agentServiceFactory: deps.agentServiceFactory,
      conversationProjection: deps.conversationProjection,
      completionDelivery: deps.completionDelivery,
      initiatorFor: async () => this.leaderTargets.current(),
      suffixGenerator: deps.agentNameSuffixGenerator,
      // Same two-fence composition as the cron scheduler built below
      // (`this.admit` outside, `deps.admitOperation` inside). A dispatcher
      // stop closes only the dispatcher's own admission and never this
      // Team's — a Team outlives a dispatcher stop and resumes on the next
      // daemon start — so a member op fenced on this Team's own admit alone
      // would still pass while `stopForHost()` kills that member's runtime
      // underneath it. Gating here also closes a real hole: a read verb
      // reaching this collection through `leader-handle.ts`'s `read()` never
      // crosses either fence at that layer (`read()` is `task(await
      // this.get(id))`, by design, so a Team's own status reads survive a
      // dissolve check there) — composing both fences inside the collection
      // itself is what makes list/status/history/last refuse uniformly with
      // spawn/send/close regardless of which path reached them.
      admitOperation: (task) => this.admit(() => deps.admitOperation(task)),
      // Composed the same way as `admitOperation` just above: a member's
      // construction path must self-close against either fence, since a
      // dispatcher stop releases this Team's runtimes without dissolving the
      // Team itself.
      isClosing: () => this.isClosing() || deps.isClosing(),
      teammateLaunch: deps.teammateLaunch,
      log: deps.log,
    });
    // This Team's Workflow scope: team-scoped runs, reporting to its leader.
    this.workflowService = new WorkflowService({
      dispatcherId: deps.dispatcherId,
      teamId,
      // This Team owns its Workflow scope, so a Workflow's TeamMate is created
      // by this Team directly rather than by asking its owner for a way back in.
      teammates: {
        createLocked: (input, options) =>
          this.createLockedWorkflowTeammate(input, options ?? {}),
      },
      completionDelivery: deps.completionDelivery,
      completionInitiator: () => this.leaderTargets.current(),
      log: deps.workflowLog,
    });
    // This Team's cron scheduler. The `admit` closure below composes two
    // fences in order for every SchedulerService-admitted operation —
    // `create`/`update`/`delete` and a due fire alike: this Team's own
    // closing fence (`this.admit`, checked first, so a mutation racing an
    // in-flight dissolve is refused before it ever reaches the store), then
    // the dispatcher's own admission (`deps.admitOperation`). A fire crosses
    // `this.admit` a second time inside `submitToLeader`, which fences every
    // leader submission for every caller and is not special-cased for cron;
    // `TeamService.admit()` is a stateless check rather than a lock, so the
    // second crossing costs one redundant read, not a second gate.
    this.scheduler_ = new SchedulerService({
      ownerId: `${deps.dispatcherId}/team/${teamId}`,
      store: new CronJobStore(teamCronJobsPath(deps.teamRoot)),
      admit: (task) => this.admit(() => deps.admitOperation(task)),
      submitScheduled: (input) =>
        this.submitToLeader({
          source: SCHEDULED_SOURCE,
          text: input.prompt,
          sourceId: input.sourceId,
        }),
      log: deps.log,
    });
    this.closing = new TeamClosing({
      teamId,
      workflows: this.workflowService,
      scheduler: this.scheduler_,
      members: this.teammateCollection,
      worktrees: deps.worktrees,
      record: () => this.mustRecord(),
      commit: (patch) => this.updateRecord(patch),
    });
  }

  /**
   * Create one Team at this concrete name, or report the name as taken.
   *
   * `null` means a valid Team record already occupies the candidate: nothing
   * was created and the caller should allocate another name. Every other
   * failure throws.
   *
   * This stops once the record and the leader exist, before anything can start
   * a runtime: the rest of creation is {@link startCreated}, which the owner
   * calls only after it holds this Team, so a host stop can reach the leader
   * whose first turn is starting.
   */
  static async createNew(
    deps: TeamServiceDeps,
    input: TeamServiceCreateInput,
  ): Promise<TeamService | null> {
    const service = new TeamService(deps, {
      teamId: input.teamId,
      name: input.name,
      workspace: input.workspace.runtimeCwd,
    });
    // Before the record is written: plugins tap this Team's own hooks here. A
    // taken name discards this object before its leader is ever built.
    deps.announceTeam(service, { origin: 'create' });
    const identityPrompt = optionalLifecycleText(
      input.identity,
      'TeamLeader identity',
    );
    const leaderName = await deps.names.allocate({
      kind: 'team-leader',
      base: input.teamId,
      teamSlug: input.teamId,
      generateSuffix: deps.agentNameSuffixGenerator,
    });
    const published = await deps.store.create({
      dispatcher_id: deps.dispatcherId,
      team_id: input.teamId,
      name: input.name,
      repo_cwd: input.workspace.sourceCwd,
      source_repo: input.workspace.sourceRepo,
      leader_name: leaderName,
      leader_agent_runtime: input.leaderAgentRuntime,
      // The same normalized inputs the leader's own Identity is created from
      // below, so a later recovery recreates the leader this Team accepted.
      leader_identity_prompt: identityPrompt,
      leader_skill_sources: [...(input.skillSources ?? [])],
      runtime_cwd: input.workspace.runtimeCwd,
      worktree: input.workspace.worktree,
      status: 'starting',
      intent: input.intent,
      closed_at: null,
      close_note: null,
      create_request_id: input.createRequest?.requestId ?? null,
      create_payload_hash: input.createRequest?.payloadHash ?? null,
    });
    if (published === null) return null;
    // `deps.store.create` above just published through the same per-Team
    // `TransactionalStore` `service.recordHandle` holds (both resolve from
    // `deps.store`'s own id-keyed map), so `service.mustRecord()` already
    // reflects `published` from this point on with no separate assignment.
    // A create is `previous === null`, always a transition, so the aggregate
    // is published unconditionally here — nothing is seeded on the roster
    // yet, so this states the same empty-teammates fact a fresh Team always
    // starts with.
    service.roster.publishTeamState(published.updated_at);
    try {
      // The TeamMate layer owns identity creation: the Team hands over its own
      // creation inputs and gets back a leader, rather than assembling and
      // persisting an Agent identity itself. Nothing starts here: the leader's
      // runtime starts inside the first submission that needs it — the prompt
      // below when there is one, the first ordinary submission otherwise — so
      // a provider thread is never opened without the turn that makes it
      // durable. A codex thread started without a turn writes no rollout, and
      // the next start of that leader fails to resume it.
      service.leader_ = await service.createLeader({
        leaderName,
        agentRuntime: input.leaderAgentRuntime,
        sourceCwd: input.workspace.sourceCwd,
        sourceRepo: input.workspace.sourceRepo,
        runtimeCwd: input.workspace.runtimeCwd,
        intent: input.intent,
        identityPrompt,
        skillSources: input.skillSources,
      });
      return service;
    } catch (error) {
      return await service.abandonCreated(error, input);
    }
  }

  /**
   * Finish a creation {@link createNew} published: the initial prompt, the
   * `running` transition, and Workflow and scheduler admission. A failure
   * abandons the creation exactly as a failure inside `createNew` does.
   */
  async startCreated(input: TeamServiceCreateInput): Promise<void> {
    try {
      if (input.prompt !== undefined) {
        // Same leader-submission path every other turn takes (`admit` fence,
        // `submitInput`), so the initial turn throws exactly as a later one
        // reports non-`submitted` — but here abandons the creation that asked
        // for it, extracting the message for `failed`/`ambiguous` and naming
        // the status otherwise.
        const initiator = input.deliverCompletionToDispatcher
          ? await this.deps.leaderCompletionInitiator()
          : null;
        const submission = toSubmissionResult(
          await this.submitToLeader({
            source: AGENT_TASK_SOURCE,
            text: input.prompt,
            ...(initiator !== null ? { initiator } : {}),
          }),
        );
        if (submission.status !== 'submitted') {
          if (
            (submission.status === 'failed' ||
              submission.status === 'ambiguous') &&
            submission.error !== undefined
          ) {
            throw new Error(submission.error);
          }
          throw new Error(
            `initial TeamLeader prompt was not admitted (${submission.status})`,
          );
        }
      }
      await this.updateRecord({ status: 'running' });
      await this.workflowService.start();
      await this.startScheduler();
    } catch (error) {
      await this.abandonCreated(error, input);
    }
  }

  /** Close a creation that failed after its record was published. */
  private async abandonCreated(
    error: unknown,
    input: TeamServiceCreateInput,
  ): Promise<never> {
    if (this.leader_ === null) {
      // Only adopt an identity this Team can prove is its own leader's;
      // anything else at that location is not ours to close. Attempted
      // before the close below so `abandonCreation` closes whatever this
      // creation actually made durable, not just what it built in memory.
      try {
        const durable = await this.leaderIdentity.read();
        if (durable !== null && alignedWithLeader(durable, this.mustRecord())) {
          this.leader_ = await restoreTeamLeaderAgentForTeam({
            ...this.leaderAgentBase(),
            identity: durable,
          });
        }
      } catch (adoptError) {
        // The original `error` is still what `abandonCreation` reports and
        // closes against; a leader this Team cannot prove or rebuild is
        // logged rather than left to replace the reason creation actually
        // failed.
        this.deps.log.error(
          {
            dispatcher_id: this.deps.dispatcherId,
            team_id: input.teamId,
            err: errorInfo(adoptError),
          },
          'Team creation-failure leader adoption did not converge',
        );
      }
    }
    return await this.closing.abandonCreation(
      {
        cause: error,
        note: 'Team creation failed',
        // The Team exists and is being closed, so its record answers for
        // the checkout — but only for one this creation actually made. A
        // checkout that was already there was never this attempt's to
        // reclaim.
        worktree: input.workspace.createdCheckout
          ? {
              ...input.workspace.worktree,
              cleanup_state: 'cleanup-pending',
              cleanup_error: null,
            }
          : input.workspace.worktree,
        settleWorktree: () => this.deps.settleWorktreeCleanup(input.teamId),
      },
      this.leader_,
    );
  }

  /**
   * Rebuild one Team from its record.
   *
   * A `running` Team restores its leader from the identity already at the Team
   * root; a `starting` Team whose leader never became durable finishes what
   * creation began by asking the TeamMate layer to create it. A Team that is
   * already closed never reaches here — its owner answers from the record.
   */
  static async rebuild(
    deps: TeamServiceDeps,
    record: TeamRecord,
  ): Promise<TeamService> {
    const service = new TeamService(deps, {
      teamId: record.team_id,
      name: record.name,
      workspace: record.runtime_cwd,
    });
    // `record` was already read through `deps.store.get`/`.list` (every
    // caller of `rebuild` reads a record before calling it), which loaded
    // this same Team's `TransactionalStore` — the one `service.recordHandle`
    // just bound to above — so `service.mustRecord()` already answers `record`
    // with no separate assignment.
    deps.announceTeam(service, { origin: 'rebuild' });
    const identity = await service.leaderIdentity.read();
    const restorable = identity !== null && alignedWithLeader(identity, record);
    // Seed before the leader branch below: creating a leader publishes the
    // aggregate from this roster, and an aggregate that omitted the Team's
    // existing members would be a false fact, not a partial one.
    await service.roster.seed(restorable ? identity : null, () =>
      service.members(),
    );
    if (restorable && identity !== null) {
      // Aligned: take the identity exactly as stored — no restamp, no rewrite.
      service.leader_ = await restoreTeamLeaderAgentForTeam({
        ...service.leaderAgentBase(),
        identity,
      });
    } else {
      service.leader_ = await service.createLeader({
        leaderName: record.leader_name,
        agentRuntime: record.leader_agent_runtime,
        sourceCwd: record.repo_cwd,
        sourceRepo: record.source_repo,
        runtimeCwd: record.runtime_cwd,
        intent: record.intent,
        identityPrompt: record.leader_identity_prompt,
        skillSources: record.leader_skill_sources,
      });
    }
    return service;
  }

  onClosed(listener: TeamClosedListener): ClosedSubscription {
    return this.closed.subscribe(listener);
  }

  get scheduler(): SchedulerCommands {
    return this.scheduler_;
  }

  get workflows(): WorkflowOps {
    return this.workflowService;
  }

  /** This team's members as concrete internal ops. `TeamLeaderHandle` wraps this
   * surface before it reaches admin/MCP callers, so raw `spawn` never bypasses
   * `spawnTeamMate`'s shared-workspace injection there. */
  get teammates(): TeammateOps {
    return this.teammateCollection;
  }

  get dispatcherId(): string {
    return this.mustRecord().dispatcher_id;
  }

  async status(): Promise<TeamSummary> {
    return teamSummary(
      this.mustRecord(),
      (await this.leaderService()).status(),
      await this.memberCount(),
    );
  }

  /**
   * Run one caller operation inside this Team's work fence.
   *
   * From the moment a dissolve raises the fence, and permanently once this Team
   * is durably closed, the Team takes no new work. Dissolve is a
   * stop-and-reclaim rather than a drain, so this refuses rather than queues.
   */
  async admit<T>(task: () => Promise<T>): Promise<T> {
    if (this.isClosing()) {
      throw new TeamClosedError(`Team ${JSON.stringify(this.id)} is closing`);
    }
    if (this.mustRecord().status === 'closed') {
      throw new TeamClosedError(`Team ${JSON.stringify(this.id)} is closed`);
    }
    return task();
  }

  /** Whether this Team is dissolving or already closed — `admit()`'s own fact. */
  isClosing(): boolean {
    return this.dissolveTask !== null;
  }

  /**
   * Submit this Team's dissolve.
   *
   * The answer is the submission, not the outcome. For a non-forced dissolve,
   * the one read that can refuse the whole operation runs before that answer;
   * once it passes, this Team owns the background stop, close, and reclaim.
   * No persisted phase survives the process that ran it — a run that ends
   * mid-dissolve simply leaves an open Team whose children reopen lazily.
   *
   * Whoever asks, it is one operation: a second submission joins the first
   * rather than dismantling the same Team twice, and a dissolve that was
   * refused can be asked again.
   */
  async dissolve(input: TeamDissolveCommand): Promise<TeamDissolveReceipt> {
    const note = requireLifecycleText(input.note, 'Team dissolve note');
    if (this.dissolveTask !== null) return this.dissolveReceipt();
    if (!input.force) await this.closing.requireReclaimableWorktree();
    if (this.dissolveTask !== null) return this.dissolveReceipt();
    // Published before it runs, so the fence is up from this moment and no
    // caller sees a Team that still looks open. Observed, never awaited: the
    // operation belongs to this Team, so its failure is this Team's to report.
    const task = Promise.resolve().then(() =>
      this.runDissolve({ ...input, note }),
    );
    this.dissolveTask = task;
    void task.catch(() => {});
    return this.dissolveReceipt();
  }

  private dissolveReceipt(): TeamDissolveReceipt {
    return { accepted: true, team_name: this.id, status: 'submitted' };
  }

  /**
   * Stop, close, and reclaim — the whole dissolve, behind the receipt.
   *
   * `dissolve` publishes `dissolveTask` before handing back the receipt, so
   * from that moment the Team takes no new work, and every refusal that can
   * still be answered has already happened. A failure lowers the fence again
   * and is stated here: the receipt cannot be revised, so the Team stays open
   * and can be asked again.
   */
  private async runDissolve(input: TeamDissolveCommand): Promise<void> {
    try {
      // A leader an earlier failed attempt released is no longer held, but its
      // identity is still open; the retry closes it from disk like any use.
      await this.closing.dissolve(input, await this.leaderService());
    } catch (error) {
      this.dissolveTask = null;
      this.deps.log.error(
        {
          dispatcher_id: this.deps.dispatcherId,
          team_id: this.id,
          err: errorInfo(error),
        },
        'Team dissolve failed',
      );
      throw error;
    } finally {
      // `closing` closed the same instance this Team passed it, so this Team
      // is the one place that can tell whether that close left it reusable.
      // A leader `closing` never reached (an earlier stop or assessment
      // refused first) is left exactly as it was, still active and still this
      // Team's to reuse — dropping it here would orphan its runtime rather
      // than reuse it. One whose close ran and fully released its runtime is
      // forgotten regardless of whether the identity write behind it landed,
      // so a stuck instance whose write failed is not re-served forever; one
      // whose runtime termination could not be proved keeps its reference,
      // because that runtime might still be alive.
      if (this.leader_?.isSafeToForget() === true) this.leader_ = null;
    }
    // This Team is over and already dropped by its owner; what is left is
    // physical, and the record it left behind is the whole input. A failure
    // leaves the pending fact standing for the next start to finish, so it is
    // reported rather than raised.
    try {
      await this.deps.settleWorktreeCleanup(this.id);
    } catch (error) {
      this.deps.log.error(
        {
          dispatcher_id: this.deps.dispatcherId,
          team_id: this.id,
          err: errorInfo(error),
        },
        'Team managed worktree cleanup failed',
      );
    }
  }

  /** Give back the runtime authority this Team holds, without closing it. */
  async stopForHost(): Promise<void> {
    // A leader a pre-fence use is still materializing is this Team's leader
    // the moment it settles, and that use starts its runtime next; a stop that
    // read only `leader_` would miss exactly that runtime.
    const building = this.leaderBuild?.catch(() => null) ?? null;
    const built = building === null ? null : await building;
    return this.closing.stopForHost(this.leader_ ?? built);
  }

  /**
   * Submit one turn to this Team's TeamLeader.
   *
   * This is the Team's single leader-submission entry: a Channel delivery, an
   * admin/agent submission, and any later invoker all reach the leader through
   * it, so the submission is stated once by the caller instead of being
   * re-derived per call site. `initiator` is the one fact this entry adds on
   * top of an ordinary submission, and it is supplied only when a Core-side
   * initiator is waiting for this turn's completion; a Channel-originated turn
   * has none, because the leader answers on its own Channel.
   *
   * The leader's runtime is started by the submission itself, never ahead of
   * it. The entity announces the input, starts its runtime, and ends the
   * display with the provider's own error when that start fails — but only
   * for a start that happens inside its admitted-input span. Starting the
   * leader here first put a codex start failure before the announcement, so
   * nothing was announced and nothing ended, and the Channel's receipt card
   * stayed on its opening label with no error.
   *
   * A persisted `starting` Team with a valid leader identity is the
   * recoverable tail of Team creation; it becomes `running` once its leader
   * has taken a turn.
   */
  async submitToLeader(
    input: TeammateSubmitInput & { initiator?: CompletionInitiator },
  ): Promise<TurnAdmission> {
    return this.admit(async () => {
      const { initiator, ...submission } = input;
      const admission = await (
        await this.leaderService()
      ).submitInput({
        ...submission,
        deliverCompletion:
          initiator !== undefined
            ? (completion, fact) =>
                this.deps.completionDelivery.deliverRuntime(
                  initiator,
                  completion,
                  fact,
                )
            : undefined,
      });
      if (
        admission.status === 'submitted' &&
        this.mustRecord().status === 'starting'
      ) {
        await this.updateRecord({ status: 'running' });
      }
      return admission;
    });
  }

  /** Interrupt the TeamLeader's owned runtime without starting a dormant one. */
  interruptLeader(): Promise<AgentRuntimeInterruptOutcome> {
    return this.admit(async () => (await this.leaderService()).interrupt());
  }

  /**
   * The directory this Team's Agents run in — lent, not transferred.
   *
   * The Team's record keeps the managed checkout and everything that happens to
   * it. What a member gets is where to run, which is the only part of the
   * Team's workspace that is any of its business.
   */
  private sharedWorkspace(): TeamWorkspaceLoan {
    const record = this.mustRecord();
    return {
      sourceCwd: record.repo_cwd,
      sourceRepo: record.source_repo,
      runtimeCwd: record.runtime_cwd,
    };
  }

  async spawnTeamMate(input: Omit<SpawnTeamMateRequest, 'sharedWorkspace'>) {
    // The owned collection is team-scoped; still pass the shared workspace
    // (issue #233). This stays a real method — injecting the shared workspace is
    // the Team's job — unlike the pure teammate forwards that now go through
    // `.teammates`.
    return this.teammateCollection.spawn({
      ...input,
      sharedWorkspace: this.sharedWorkspace(),
    });
  }

  async createLockedWorkflowTeammate(
    input: Omit<SpawnTeamMateRequest, 'sharedWorkspace'>,
    options: CreateLockedTeammateOptions,
  ) {
    return this.teammateCollection.createLocked(
      {
        ...input,
        sharedWorkspace: this.sharedWorkspace(),
      },
      options,
    );
  }

  closeWorkflowAdmission(): void {
    this.workflowService.requestStopAll();
  }

  startWorkflowAdmission(): Promise<void> {
    return this.workflowService.start();
  }

  recoverWorkflows(): Promise<void> {
    return this.workflowService.recover();
  }

  startScheduler(): Promise<void> {
    return this.scheduler_.start();
  }

  stopScheduler(): void {
    this.scheduler_.stop();
  }

  async memberCount(): Promise<number> {
    return this.teammateCollection.count();
  }

  /**
   * This Team's own unfenced roster read (members-only; the leader is not a
   * member), used only while this Team is reconstructing its own
   * `TeamRosterProjection` during `rebuild()` below. This must not cross
   * `teammateCollection`'s admission fence the way the caller-facing
   * `TeammateOps.list()` verb does: seeding the roster is this Team building
   * its own aggregate, not a caller reaching in from outside, and it must
   * still succeed while the dispatcher's own admission is closed (a `read()`
   * caller reaching this Team through `leader-handle.ts` before it has ever
   * been materialized must still get an answer, per `TeamCollection.read()`'s
   * "reads survive closing").
   */
  private async members(): Promise<AgentEntityRuntimeStatus[]> {
    return this.teammateCollection.memberStatuses();
  }

  /**
   * Ask the TeamMate layer to create this Team's leader from the Team's own
   * creation inputs. The Team never writes an Agent identity itself.
   */
  private async createLeader(
    creation: TeamLeaderCreationInput,
  ): Promise<AgentService> {
    return createTeamLeaderAgentForTeam({
      ...this.leaderAgentBase(),
      creation,
    });
  }

  private leaderAgentBase() {
    return teamLeaderAgentBase({
      deps: this.deps,
      teamId: this.id,
      workspace: this.mustRecord().worktree,
      identities: this.leaderIdentity,
      onPersisted: (identity) => this.roster.publish(identity, 'team_leader'),
      leaderLaunch: this.hooks.leaderLaunch,
    });
  }

  /**
   * The one place this Team's durable record is written.
   *
   * Every lifecycle write this Team makes while it is alive — creation's
   * `running` transition, recovery's, the dissolve close — lands here, so the
   * in-memory record this entity answers from is never a stale copy of what is
   * on disk.
   */
  private async updateRecord(
    patch: Parameters<TeamStore['update']>[1],
  ): Promise<TeamRecord> {
    const previous = this.mustRecord();
    const updated = await this.deps.store.update(this.id, patch);
    // No separate field to assign: `updated` is already what
    // `this.recordHandle.current` holds, published through it by the
    // `TeamStore.update` call above.
    // The write that closes the record is what ends this Team, so the fact is
    // stated exactly where it becomes true — once, on the transition.
    if (previous.status !== 'closed' && updated.status === 'closed') {
      this.closed.publish(teamClosedFact(updated));
    }
    // The aggregate reports the same status transitions the record itself
    // recognizes — every status write goes through this one method, so this is
    // the whole rule, stated once, for every caller (creation's `running`
    // transition and dissolve's `closed` transition included).
    if (previous.status !== updated.status) {
      this.roster.publishTeamState(updated.updated_at);
    }
    return updated;
  }

  private mustRecord(): TeamRecord {
    const current = this.recordHandle.current;
    if (current === null)
      throw new Error(`Team ${JSON.stringify(this.id)} is not booted`);
    return current;
  }

  /** This Team's leader identity status, read from whatever this Team's own
   * `AgentIdentityStore` already holds in memory — never a file read. Used by
   * the read model to answer `leader_state` for a Team this process already
   * has live, without going through a fresh one-shot reader over the same
   * `identity.json` a live entity already committed through. */
  leaderIdentityStatus(): AgentEntityIdentityStatus | null {
    return this.leaderIdentity.current()?.status ?? null;
  }

  /** This Team's leader, materialized from the identity at its root when this Team is holding none, and built once however many ordinary uses ask at the same time — two would be two Agents over one identity. */
  private async leaderService(): Promise<AgentService> {
    if (this.leader_ !== null) return this.leader_;
    this.leaderBuild ??= leaderForOpenTeam({
      ...this.leaderAgentBase(),
      record: this.mustRecord(),
    }).finally(() => {
      this.leaderBuild = null;
    });
    this.leader_ = await this.leaderBuild;
    return this.leader_;
  }
}
