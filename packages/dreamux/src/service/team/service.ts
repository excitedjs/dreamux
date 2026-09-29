import type {
  AgentRuntimeInterruptOutcome,
  LaunchDraft,
  Team,
  TeamContainedRole,
  TeamStateTeammateSummary,
  TeamSummary,
  TeammateStatus,
} from '@excitedjs/dreamux-types';
import { errorInfo, errorMessage } from '@excitedjs/dreamux-utils';
import { AsyncSeriesHook } from 'tapable';
import type { UnbuiltAgent } from '../agent/factory.js';

import {
  teamCronJobsPath,
  teamMateCollectionDir,
} from '../../platform/paths.js';
import {
  collectShutdownFailure,
  throwShutdownFailures,
} from '../../platform/shutdown-errors.js';
import { launchDraftTaps } from '../../plugin/hooks.js';
import { toSubmissionResult } from '../agent/admission.js';
import {
  optionalLifecycleText,
  requireLifecycleText,
  type AgentEntityIdentity,
  type AgentEntityIdentityStatus,
  type AgentEntityWorktreeIdentity,
} from '../agent/identity.js';
import { TeammateCollection } from '../agent/index.js';
import type { AgentService } from '../agent/service.js';
import type { TeammateSubmitInput } from '../agent/submission.js';
import type { TurnAdmission } from '../agent/turn.js';
import type { TeamWorkspaceLoan, TeammateOps } from '../agent/types.js';
import type {
  CompletionInitiator,
  PreparedCompletionDelivery,
  PreparedCompletionFact,
} from '../completion-router/index.js';
import { SchedulerService } from '../scheduler/index.js';
import type { SchedulerCommands } from '../scheduler/types.js';
import { AGENT_TASK_SOURCE } from '../submission-sources.js';
import {
  WorkflowService,
  type WorkflowOps,
} from '../workflow-service/index.js';
import type {
  WorktreeCleanupAssessment,
  WorktreeManager,
} from '../worktree/manager.js';
import {
  TeamClosedError,
  TeamDissolveBlockedError,
  TeamDissolveFailedError,
  isTeamUnavailable,
} from './errors.js';
import {
  createTeamLeaderAgentForTeam,
  openTeamLeader,
  teamLeaderOptions,
  type TeamLeaderCreationInput,
} from './leader.js';
import type { TeamRecordHandle, TeamRecordUpdate } from './store.js';
import { teamSummary } from './team-summary.js';
import {
  teamClosedFact,
  type TeamClosedFact,
  type TeamCollectionOptions,
  type TeamDissolveCommand,
  type TeamDissolveReceipt,
  type TeamRecord,
  type TeamServiceCreateInput,
} from './types.js';

/**
 * What one Team is built from.
 *
 * Collaborators and shared dispatcher facts only: nothing here reaches back
 * into the collection that constructed the Team. A Team is handed what it
 * needs, does its own work with it, and states what happened by publishing its
 * own terminal fact — so its owner learns of its end without the Team ever
 * calling upward into its owner's lifecycle.
 *
 * The collection binds this Team's root and record and passes its shared
 * collaborators. The actual dispatcher hook object is viewed only through
 * `team` and `teammateLaunch`; the collection alone applies `createTeam`
 * before constructing a Team.
 *
 * Declared here rather than in `types.ts`: it configures this concrete
 * `TeamService`, so it is a constructor-options bag rather than a data type.
 */
export type TeamServiceDeps = Omit<
  TeamCollectionOptions,
  'root' | 'dispatcherHooks'
> & {
  dispatcherHooks: Pick<
    TeamCollectionOptions['dispatcherHooks'],
    'teammateLaunch' | 'team'
  >;
  /**
   * This Team's own root directory, bound by `TeamCollection` when it
   * constructed this service. The TeamLeader's `identity.json`, the Team
   * `record.json`, this Team's cron jobs, and its `teammate/` collection all sit
   * directly under it — the Team never rebuilds the path from ids.
   */
  teamRoot: string;
  /**
   * This Team's own record, not the collection's whole `TeamStore`: the
   * collection is who must read every Team's record (list/status/history, a
   * closed Team's post-dissolve worktree fact) and probe a candidate name
   * without materializing a Team, so it keeps the id-addressable store; this
   * Team writes and reads only through the one record `handle()` bound to
   * its own id, and can never reach another Team's by id.
   */
  record: TeamRecordHandle;
};

/**
 * A single team entity (issue #233): holds its own {@link TeamRecord}, *has a*
 * leader {@link AgentService} (Phase 4, at the team root), and OWNS its
 * members' team-scoped {@link TeammateCollection}. It owns every per-team
 * runtime and resource operation, dissolve included, and is the only writer of
 * its own record's lifecycle status. The one exception is the record's
 * post-close worktree fact: `settleTeamWorktreeCleanup` writes that
 * once the Team is closed, after no `TeamService` instance for it is left to.
 * Admin `team_leader` target calls are forwarded to this Team's own collection (no
 * team id — scope is baked in); the leader is never a member row.
 */
export class TeamService implements Team {
  /**
   * This Team's leader, held for the Team's whole life once `createNew` or
   * `rebuild` succeeds — there is no lazy rebuild path left that could ever
   * find this empty again. `null` only in the narrow window before either of
   * those has finished, when a creation that failed before a leader ever
   * became durable is being abandoned; {@link mustLeader} is for every other
   * reader.
   */
  private leader_: AgentService | null = null;
  /**
   * One Team's contained Agents, as the aggregate event reports them.
   *
   * A runtime projection and nothing else: it is seeded when the Team
   * materializes and kept current by committed identity observations after
   * `teammate.state`, so it never disagrees with the identity stores that own the
   * fact. Nothing reads it back into a decision, and it is never persisted — role
   * in particular is derived from which owner holds the Agent, which is exactly
   * what this map records.
   */
  private readonly rosterMembers = new Map<string, TeamStateTeammateSummary>();
  readonly id: string;
  /** Stored at construction: the `team` hook sees a created Team before its record exists. */
  readonly name: string;
  readonly workspace: string;
  readonly hooks: Team['hooks'];
  /** The team's OWN members collection (bound to its Team id and workspace).
   * Its concrete class owns the lifecycle methods driven by the team; the PUBLIC
   * surface stays the narrow `teammates` admin ops — never expose internal verbs. */
  private readonly teammateCollection: TeammateCollection;
  private readonly scheduler_: SchedulerService;
  private readonly workflowService: WorkflowService;
  /**
   * This Team's one dissolve, published the moment it is submitted.
   *
   * It is both the operation and the work fence: while it is here the Team
   * takes no new work and a second submission joins rather than dismantling the
   * same Team twice. The closed record is the one reversible step left:
   * a write that fails clears this fence so dissolve can be asked again, and a
   * write that lands keeps this set forever — every step after it is
   * best-effort cleanup of a Team that is already over.
   */
  private dissolveTask: Promise<void> | null = null;
  /**
   * Everyone holding this Team learns it is durably over by awaiting this:
   * resolved once, after this Team's record is durably `closed` and the
   * child-destroy that followed it has run (succeeded or not) — not at the
   * moment the record write lands, so a host stop that starts in between still
   * finds this Team live and reaches a leader or member whose runtime is still
   * mid-destroy. `TeamCollection` evicts this exact instance off it
   * (`service.closed.then(() => this.evict(...))`).
   */
  readonly closed: Promise<TeamClosedFact>;
  private resolveClosed!: (fact: TeamClosedFact) => void;

  private constructor(
    private readonly deps: TeamServiceDeps,
    init: { teamId: string; name: string; workspace: TeamWorkspaceLoan },
  ) {
    const { teamId } = init;
    this.id = teamId;
    this.name = init.name;
    this.workspace = init.workspace.runtimeCwd;
    this.hooks = Object.freeze({
      leaderLaunch: launchDraftTaps(
        new AsyncSeriesHook<[LaunchDraft]>(['draft'], 'leaderLaunch'),
        deps.log,
      ),
    });
    this.closed = new Promise<TeamClosedFact>((resolve) => {
      this.resolveClosed = resolve;
    });
    // The leader lives at the Team root itself; its TeamMates live one level
    // below, in this Team's own `teammate/` collection.
    // The Agents this Team owns, as its own team-scoped collection. Every
    // Agent in it belongs to this Team, so its completions go to this Team's
    // leader: ownership decides the recipient, not a field on the producing
    // record.
    this.teammateCollection = new TeammateCollection({
      dispatcherId: deps.dispatcherId,
      teamScope: { id: teamId, workspace: init.workspace },
      config: deps.config,
      agentRuntimeProviders: deps.agentRuntimeProviders,
      worktrees: deps.worktrees,
      root: teamMateCollectionDir(deps.teamRoot),
      names: deps.names,
      agentServiceFactory: deps.agentServiceFactory,
      completionOwner: this,
      fence: this,
      teammateLaunch: deps.dispatcherHooks.teammateLaunch,
      log: deps.log,
    });
    this.teammateCollection.events.on('state', (identity) =>
      this.publish(identity, 'teammate'),
    );
    this.workflowService = new WorkflowService({
      dispatcherId: deps.dispatcherId,
      teamId,
      teammates: this.teammateCollection,
      completionDelivery: deps.completionDelivery,
      completionOwner: this,
      fence: this,
      log: deps.workflowLog,
    });
    this.scheduler_ = new SchedulerService({
      ownerId: `${deps.dispatcherId}/team/${teamId}`,
      cronJobsPath: teamCronJobsPath(deps.teamRoot),
      fence: this,
      recipient: this,
      log: deps.log,
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
      workspace: input.workspace,
    });
    // Before the record is written: plugins tap this Team's own hooks here. A
    // taken name discards this object before its leader is ever built.
    deps.dispatcherHooks.team.call(service, { origin: 'create' });
    const identityPrompt = optionalLifecycleText(
      input.identity,
      'TeamLeader identity',
    );
    const leaderName = await deps.names.allocate({
      kind: 'team-leader',
      base: input.teamId,
      teamSlug: input.teamId,
    });
    const published = await deps.record.create({
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
    // `deps.record.create` above just published through this Team's own
    // `TransactionalStore`, so `service.mustRecord()` (reading `deps.record`
    // directly) already reflects `published` from this point on with no
    // separate assignment.
    // A create is `previous === null`, always a transition, so the aggregate
    // is published unconditionally here — nothing is seeded on the roster
    // yet, so this states the same empty-teammates fact a fresh Team always
    // starts with.
    service.publishTeamState(published.updated_at);
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
        // Same leader-submission path every other turn takes (`admitTeam` fence,
        // `submitInput`), so the initial turn throws exactly as a later one
        // reports non-`submitted` — but here abandons the creation that asked
        // for it, extracting the message for `failed`/`ambiguous` and naming
        // the status otherwise.
        const completionRecipient = input.deliverCompletionToDispatcher
          ? this.deps.completionOwner.completionRecipient()
          : null;
        const submission = toSubmissionResult(
          await this.submitInput({
            source: AGENT_TASK_SOURCE,
            text: input.prompt,
            ...(completionRecipient !== null ? { completionRecipient } : {}),
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
      await this.startAdmissions();
    } catch (error) {
      await this.abandonCreated(error, input);
    }
  }

  /**
   * Close a creation that failed after its record was published, and report
   * why.
   *
   * `this.leader_` is whatever this creation attempt already holds: set when
   * `startCreated`'s own post-record steps failed, still `null` when
   * `createNew`'s own leader creation never durably finished. Neither case
   * goes looking for an orphaned identity to adopt — a leader this Team never
   * held a reference to is not this attempt's to close.
   *
   * The record was already published, so the Team exists: it is closed rather
   * than removed, and the concrete name stays taken. The closed write runs
   * first, the same order dissolve uses, so nothing racing this creation can
   * still admit into it while its children come down; {@link destroyChildren}
   * — the same routine dissolve runs — follows regardless of whether that
   * write landed, because a creation that could not be undone cleanly must
   * still say what originally went wrong.
   */
  private async abandonCreated(
    error: unknown,
    input: TeamServiceCreateInput,
  ): Promise<never> {
    const note = 'Team creation failed';
    // The Team exists and is being closed, so its record answers for the
    // checkout — but only for one this creation actually made. A checkout
    // that was already there was never this attempt's to reclaim.
    const worktree: AgentEntityWorktreeIdentity = input.workspace
      .createdCheckout
      ? {
          ...input.workspace.worktree,
          cleanup_state: 'cleanup-pending',
          cleanup_error: null,
        }
      : input.workspace.worktree;
    const failures: unknown[] = [error];
    let closed = false;
    await collectShutdownFailure(failures, async () => {
      await this.updateRecord({
        status: 'closed',
        closedAt: Date.now(),
        closeNote: note,
        worktree,
      });
      closed = true;
    });
    await collectShutdownFailure(failures, () => this.destroyChildren(note));
    // Only the durable record can ask for the reclaim, and only after it says
    // closed. If the commit did not land, the checkout stays exactly as it is
    // and this Team keeps whatever it prepared.
    if (closed) {
      this.closeFromRecord();
      await collectShutdownFailure(failures, () =>
        settleTeamWorktreeCleanup(this.deps.record, this.deps.worktrees),
      );
    }
    if (failures.length === 1) throw error;
    throw new AggregateError(
      failures,
      `Team ${JSON.stringify(this.id)} creation failed and cleanup did not converge`,
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
      workspace: {
        sourceCwd: record.repo_cwd,
        sourceRepo: record.source_repo,
        runtimeCwd: record.runtime_cwd,
      },
    });
    // `record` was already read through the collection's `store.get`/`.list`
    // (every caller of `rebuild` reads a record before calling it), which
    // loaded this same Team's `TransactionalStore` — the one `deps.record`
    // wraps — so `service.mustRecord()` (reading `deps.record` directly)
    // already answers `record` with no separate assignment.
    deps.dispatcherHooks.team.call(service, { origin: 'rebuild' });
    // Seed members before a fresh leader is created: creating one publishes
    // the aggregate from this roster from the awaited create result, and
    // an aggregate that omitted the Team's existing members would be a false
    // fact, not a partial one.
    await service.seedMembers();
    const opened = await openTeamLeader(
      {
        teamId: service.id,
        teamRoot: deps.teamRoot,
        agentServiceFactory: deps.agentServiceFactory,
      },
      record,
    );
    if (opened === null) {
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
    } else {
      service.remember(
        opened.identity.name,
        'team_leader',
        opened.identity.status,
      );
      service.leader_ = await service.buildLeader(opened);
    }
    // A Team rebuilt from disk reconciles the Workflow records its previous
    // process left running before anything can reach it.
    await service.workflowService.recover();
    return service;
  }

  get scheduler(): SchedulerCommands {
    return this.scheduler_;
  }

  /**
   * Admit one leader-tool operation at its former owner-lookup point.
   * A live leader lease can outlast dispatcher admission or the Team's closed
   * write while earlier children stop. Check dispatcher admission, then the
   * durable closed fact, as the addressed collection lookups do. Dissolving
   * before that write is checked by the child's ordinary Team fence, not by
   * this access operation. Adapters keep their own argument-parsing order and
   * admission span: child lookup only, or the full dissolve/channel request.
   */
  admitLeaderTools<T>(operation: () => Promise<T>): Promise<T> {
    return this.deps.fence.admit(async () => {
      if (this.mustRecord().status === 'closed') {
        throw new TeamClosedError(`Team ${JSON.stringify(this.id)} is closed`);
      }
      return operation();
    });
  }

  get workflows(): WorkflowOps {
    return this.workflowService;
  }

  /** This Team's members, including spawn into its fixed shared workspace. */
  get teammates(): TeammateOps {
    return this.teammateCollection;
  }

  get dispatcherId(): string {
    return this.mustRecord().dispatcher_id;
  }

  async status(): Promise<TeamSummary> {
    return teamSummary(
      this.mustRecord(),
      this.mustLeader().status(),
      await this.teammateCollection.count(),
    );
  }

  /**
   * Run one caller operation inside this Team's work fence.
   *
   * From the moment a dissolve raises the fence, and permanently once this Team
   * is durably closed, the Team takes no new work. Dissolve is a
   * stop-and-reclaim rather than a drain. Children then enter dispatcher admission.
   */
  async admit<T>(task: () => Promise<T>): Promise<T> {
    this.assertOpen();
    return this.deps.fence.admit(task);
  }

  async admitTeam<T>(task: () => Promise<T>): Promise<T> {
    this.assertOpen();
    return task();
  }

  assertOpen(): void {
    if (this.dissolveTask !== null) {
      throw new TeamClosedError(`Team ${JSON.stringify(this.id)} is closing`);
    }
    if (this.mustRecord().status === 'closed') {
      throw new TeamClosedError(`Team ${JSON.stringify(this.id)} is closed`);
    }
  }

  isClosing(): boolean {
    return this.dissolveTask !== null || this.deps.fence.isClosing();
  }

  /**
   * Submit this Team's dissolve.
   *
   * The answer is the submission, not the outcome. For a non-forced dissolve,
   * the one read that can refuse the whole operation runs before that answer;
   * once it passes, this Team owns the background write-closed, destroy, and
   * reclaim. A precheck refusal leaves the Team untouched and the fence never
   * rises, so it can be asked again; a run that ends mid-dissolve after the
   * closed record lands leaves that record durably closed regardless — a
   * closed Team is never rebuilt, so whatever `destroyChildren` had not yet
   * reached when the process ended stays exactly as it was, inert residue
   * under a Team nothing will reopen.
   *
   * Once its entry admits the request, a second submission joins the first
   * rather than dismantling the same Team twice.
   */
  async dissolve(input: TeamDissolveCommand): Promise<TeamDissolveReceipt> {
    const note = requireLifecycleText(input.note, 'Team dissolve note');
    if (this.dissolveTask !== null) return this.dissolveReceipt();
    if (!input.force) await this.requireReclaimableWorktree();
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
   * Write closed, then destroy every child and reclaim the worktree — the
   * whole dissolve, behind the receipt.
   *
   * The precheck `dissolve` already ran is the only refusal this operation
   * still has to offer, so the closed write below is the one reversible step
   * left: nothing has stopped or closed anything ahead of it, so a write that
   * does not land leaves the Team exactly as `dissolve` found it and clears
   * the fence so it can be asked again. Once that write lands the Team is
   * over for good — destroying its children and reclaiming its worktree are
   * both best-effort from here: attempted, logged on failure, never rolled
   * back, because there is nothing left to roll back to.
   */
  private async runDissolve(input: TeamDissolveCommand): Promise<void> {
    try {
      await this.updateRecord(await this.dissolveRecordPatch(input));
    } catch (error) {
      this.dissolveTask = null;
      this.deps.log.error(
        {
          dispatcher_id: this.deps.dispatcherId,
          team_id: this.id,
          err: errorInfo(error),
        },
        'Team dissolve failed to write its closed record',
      );
      throw error;
    }
    try {
      await this.destroyChildren(input.note);
    } catch (error) {
      this.deps.log.error(
        {
          dispatcher_id: this.deps.dispatcherId,
          team_id: this.id,
          err: errorInfo(error),
        },
        'Team dissolve did not converge',
      );
    } finally {
      this.closeFromRecord();
    }
    // This Team is over and already dropped by its owner; what is left is
    // physical, and the record it left behind is the whole input. A failure
    // leaves the pending fact standing for the next start to finish, so it is
    // reported rather than raised.
    try {
      await settleTeamWorktreeCleanup(this.deps.record, this.deps.worktrees);
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

  /**
   * The closed record a dissolve commits: the worktree/`cleanupForce` fact
   * `settleTeamWorktreeCleanup`'s later, real reclaim reads its authorization
   * from. Reads through {@link assessWorktree} again rather than reusing the
   * pre-admission precheck's answer, because a forced dissolve never ran that
   * precheck at all (`dissolve()` skips it when `input.force` is set) and a
   * non-forced one did not keep its result around to thread through. A
   * `blocked` result is treated the same as `eligible`: any refusal this
   * operation could still make already happened in the precheck, so from here
   * both simply owe a reclaim attempt, and `WorktreeManager.cleanup()` (run
   * after children are destroyed) is what actually decides whether a
   * still-dirty worktree is removed or only kept.
   */
  private async dissolveRecordPatch(
    input: TeamDissolveCommand,
  ): Promise<TeamRecordUpdate> {
    const assessment = await this.assessWorktree();
    const worktree =
      assessment.status === 'terminal'
        ? assessment.worktree
        : {
            ...this.mustRecord().worktree,
            cleanup_state: 'cleanup-pending' as const,
            cleanup_error: null,
          };
    return {
      status: 'closed',
      closedAt: Date.now(),
      closeNote: input.note,
      worktree,
      cleanupForce: assessment.status !== 'terminal' && input.force,
    };
  }

  /**
   * Ask whether this Team's own managed checkout may be reclaimed.
   *
   * `force` never skips the question, it only overrides the refusal: this same
   * call is what proves the worktree is managed, exists, and is registered to
   * this Team's repository.
   */
  private async assessWorktree(): Promise<WorktreeCleanupAssessment> {
    const record = this.mustRecord();
    try {
      return await this.deps.worktrees.assessCleanup({
        source_cwd: record.repo_cwd,
        source_repo: record.source_repo,
        worktree: record.worktree,
      });
    } catch (error) {
      // The caller waits on this read now, so it is an answer rather than a
      // log line: a moved source checkout or an unregistered worktree has to
      // reach whoever asked, or `/dissolve` reports a wall with no reason.
      throw new TeamDissolveFailedError(
        `Team worktree assessment failed: ${errorMessage(error)}`,
      );
    }
  }

  private async requireReclaimableWorktree(): Promise<void> {
    const assessment = await this.assessWorktree();
    if (assessment.status === 'blocked') {
      throw new TeamDissolveBlockedError(assessment.reason);
    }
  }

  /**
   * Destroy every resource this Team holds, once its own closed record
   * already makes it unreachable: Workflows first (stop runs, release held
   * members' locks, keep history), then the scheduler's own store, then every
   * member through the collection's `destroy`, then the leader.
   *
   * Every step is attempted and its failure collected — a resource that will
   * not close still leaves the Team's own record closed, so nothing here can
   * undo that. An Agent this fails to close keeps its identity on disk as
   * inert residue: a closed Team is never rebuilt, so nothing materializes it
   * again.
   * `this.leader_` is `null` only for a Team whose creation failed before a
   * leader ever existed; dissolve and abandoned-creation cleanup share this
   * one routine.
   */
  private async destroyChildren(note: string): Promise<void> {
    const failures: unknown[] = [];
    await collectShutdownFailure(failures, () =>
      this.workflowService.stopAll(),
    );
    await collectShutdownFailure(failures, () => this.scheduler_.destroy());
    await collectShutdownFailure(failures, () =>
      this.teammateCollection.destroy(note),
    );
    const leader = this.leader_;
    if (leader !== null) {
      await collectShutdownFailure(failures, async () => {
        await leader.close({ note });
      });
    }
    throwShutdownFailures(
      failures,
      `Team ${JSON.stringify(this.id)} resources did not close`,
    );
  }

  /**
   * Give back the runtime authority this Team holds, without closing it.
   *
   * Only Agents this process actually materialized are reached: a Team's
   * durable members that never ran hold nothing to release, and materializing
   * them here would make a host stop touch entities it never started. Nothing
   * durable is written — a Team is closed by dissolve, never by a process
   * stopping. One failure never prevents the remaining resources from being
   * released. The leader is `null` only for a Team whose creation failed
   * before it ever existed, in which case this Team is never tracked and
   * never reached here.
   */
  async stopForHost(): Promise<void> {
    const leader = this.leader_;
    const failures: unknown[] = [];
    await collectShutdownFailure(failures, () =>
      this.workflowService.stopAll(),
    );
    await collectShutdownFailure(failures, () =>
      this.teammateCollection.stop(),
    );
    if (leader !== null) {
      await collectShutdownFailure(failures, () => leader.stopForHost());
    }
    throwShutdownFailures(
      failures,
      `multiple runtimes in Team ${JSON.stringify(this.id)} failed to stop`,
    );
  }

  /**
   * Submit one turn to this Team's TeamLeader.
   *
   * This is the Team's single leader-submission entry: a Channel delivery, an
   * admin/agent submission, and any later invoker all reach the leader through
   * it, so the submission is stated once by the caller instead of being
   * re-derived per call site. The ordinary submission's `completionRecipient`
   * is supplied only when a Core-side initiator awaits this turn's completion;
   * a Channel-originated turn has none, because the leader answers on its own
   * Channel.
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
  async submitInput(input: TeammateSubmitInput): Promise<TurnAdmission> {
    return this.admitTeam(async () => {
      const admission = await this.mustLeader().submitInput(input);
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
    return this.admitTeam(() => this.mustLeader().interrupt());
  }

  /**
   * Open this Team's admissions: resume accepting Workflow runs and arm the
   * scheduler. Both steps are idempotent.
   *
   * Runs once, right after creation succeeds, and again for every Team a
   * daemon start rebuilds (`TeamCollection.startAdmissions()`). Dissolve never
   * calls this: once it has written this Team's record closed there is
   * nothing left to reopen.
   */
  async startAdmissions(): Promise<void> {
    await this.workflowService.start();
    await this.scheduler_.start();
  }

  /** Close this Team's admissions: stop accepting Workflow runs and disarm the scheduler. */
  stopAdmissions(): void {
    this.workflowService.requestStopAll();
    this.scheduler_.stop();
  }

  /**
   * Publish one contained Agent's state on the Team's behalf, and republish the
   * Team aggregate that contains it.
   *
   * The role is the owner's, not the record's: this Team's leader is
   * `team_leader` and everything in its TeammateCollection is `teammate`. A
   * Dispatcher and its own TeamMates are published by the dispatcher that owns
   * them, under the roles only it can state.
   */
  private publish(
    identity: AgentEntityIdentity,
    role: TeamContainedRole,
  ): void {
    this.remember(identity.name, role, identity.status);
    this.publishTeamState(identity.updated_at);
  }

  /**
   * Republish the Team aggregate alone, for a durable record transition with
   * no identity change of its own (a status write `TeamService` made
   * directly, e.g. creation or dissolve).
   *
   * The Team that owns this projection states its own aggregate: there is no
   * second source to ask, since this roster is kept current by every
   * identity's committed observation and this Team's status is always read
   * fresh from its own record.
   */
  private publishTeamState(occurredAt: number): void {
    const team = this.mustRecord();
    this.deps.coreEvents.publish({
      schemaVersion: 1,
      kind: 'team.state',
      occurredAt,
      teamName: team.team_id,
      leaderName: team.leader_name,
      status: team.status,
      teammates: this.summary(),
    });
  }

  /** This Team's contained Agents, as a fresh summary per publication. */
  private summary(): readonly TeamStateTeammateSummary[] {
    return [...this.rosterMembers.values()];
  }

  /**
   * Take this Team's existing TeamMates into the roster once, at
   * materialization. The leader is remembered separately, by `rebuild`
   * itself once `openTeamLeader` returns it.
   */
  private async seedMembers(): Promise<void> {
    // `memberStatuses()` is `teammateCollection`'s own unfenced roster read
    // (members-only; the leader is not a member). Seeding this Team's own
    // aggregate happens while this Team is still materializing, not through
    // any caller-facing surface, so it must succeed unconditionally rather
    // than cross either admission fence.
    for (const member of await this.teammateCollection.memberStatuses()) {
      this.remember(member.name, 'teammate', member.status);
    }
  }

  private remember(
    name: string,
    role: TeamContainedRole,
    status: TeammateStatus,
  ): void {
    this.rosterMembers.set(name, { teammateName: name, role, status });
  }

  private async createLeader(
    creation: TeamLeaderCreationInput,
  ): Promise<AgentService> {
    const unbuilt = await createTeamLeaderAgentForTeam({
      deps: {
        teamId: this.id,
        teamRoot: this.deps.teamRoot,
        agentServiceFactory: this.deps.agentServiceFactory,
      },
      creation,
    });
    this.publish(unbuilt.identity, 'team_leader');
    return this.buildLeader(unbuilt);
  }

  private async buildLeader(unbuilt: UnbuiltAgent): Promise<AgentService> {
    const leader = unbuilt.build(
      await teamLeaderOptions(
        {
          team: this,
          workspace: this.mustRecord().worktree,
          mcp: this.deps.mcp,
          fence: this.deps.fence,
        },
        unbuilt.identity,
      ),
    );
    leader.events.on('state', (identity) =>
      this.publish(identity, 'team_leader'),
    );
    return leader;
  }

  /**
   * The one place this Team's durable record is written.
   *
   * Every lifecycle write this Team makes while it is alive — creation's
   * `running` transition, recovery's, the dissolve close — lands here, so the
   * in-memory record this entity answers from is never a stale copy of what is
   * on disk. It publishes only the aggregate's status transition; the `closed`
   * fact itself is a separate, later step ({@link closeFromRecord}) so a
   * dissolve or abandoned creation can destroy its children before anything
   * evicts this Team.
   */
  private async updateRecord(patch: TeamRecordUpdate): Promise<TeamRecord> {
    const previous = this.mustRecord();
    const updated = await this.deps.record.update(patch);
    // No separate field to assign: `updated` is already what
    // `deps.record.current` holds, published through it by the
    // `TeamRecordHandle.update` call above.
    // The aggregate reports the same status transitions the record itself
    // recognizes — every status write goes through this one method, so this is
    // the whole rule, stated once, for every caller (creation's `running`
    // transition and dissolve's `closed` transition included). A status the
    // store dropped because the record was already closed is not this write's
    // transition, even though `previous` was read before the closed write.
    if (patch.status === updated.status && previous.status !== updated.status) {
      this.publishTeamState(updated.updated_at);
    }
    return updated;
  }

  private mustRecord(): TeamRecord {
    const current = this.deps.record.current;
    if (current === null)
      throw new Error(`Team ${JSON.stringify(this.id)} is not booted`);
    return current;
  }

  /**
   * Resolve {@link closed} from this Team's already-`closed` record.
   *
   * Called once destroying this Team's children has run (succeeded or not),
   * never at the moment the record write itself lands — see {@link closed}'s
   * own doc for why the two are kept apart.
   */
  private closeFromRecord(): void {
    this.resolveClosed(teamClosedFact(this.mustRecord()));
  }

  /**
   * This Team's leader.
   *
   * Held for the Team's whole life once construction succeeds, so this never
   * reaches into disk or lazily rebuilds anything; reaching this on a `null`
   * `leader_` is a caller bug, not a state a Team handed to anything outside
   * itself can be in.
   */
  private mustLeader(): AgentService {
    if (this.leader_ === null) {
      throw new Error(`Team ${JSON.stringify(this.id)} has no leader`);
    }
    return this.leader_;
  }

  /**
   * This Team's leader identity status, read straight from the leader this
   * Team always holds once constructed — there is no lazy rebuild path left
   * that could ever leave this Team without one.
   */
  leaderIdentityStatus(): AgentEntityIdentityStatus {
    return this.mustLeader().current().status;
  }

  /**
   * One Team's leader as a fenced completion recipient.
   *
   * Every completion produced inside a Team goes to that Team's leader, so this
   * is resolved from ownership rather than from the producing record: one Team,
   * one leader, one recipient key for as long as the Team exists. Each step
   * observes the same fence an ordinary submission does — a Team that is
   * dissolving or already closed reports the delivery as unsupported, so the
   * completion router falls back instead of reviving a Team being torn down.
   */
  completionRecipient(): CompletionInitiator {
    return this;
  }

  async prepareCompletion(
    completion: PreparedCompletionFact,
  ): Promise<PreparedCompletionDelivery> {
    let prepared: PreparedCompletionDelivery;
    try {
      prepared = await this.admitTeam(() =>
        this.mustLeader().prepareCompletion(completion),
      );
    } catch (error) {
      if (isTeamUnavailable(error)) return this.unsupportedCompletion();
      throw error;
    }
    return Object.freeze({
      submit: async () => {
        try {
          return await this.admitTeam(() => prepared.submit());
        } catch (error) {
          if (isTeamUnavailable(error))
            return {
              status: 'unsupported' as const,
              reason: 'Team is closing or unavailable',
            };
          throw error;
        }
      },
    });
  }

  private unsupportedCompletion(): PreparedCompletionDelivery {
    const reason = 'Team is closing or unavailable';
    return Object.freeze({
      submit: async () => ({
        status: 'unsupported' as const,
        reason,
      }),
    });
  }
}

/**
 * Finish a closed Team's pending worktree cleanup using its loaded record.
 * Live dissolve, abandoned creation, and startup recovery share this operation;
 * recovery never constructs a Team. A cleanup failure leaves the pending fact
 * and its force authorization unchanged for the next start.
 */
export async function settleTeamWorktreeCleanup(
  handle: TeamRecordHandle,
  worktrees: WorktreeManager,
): Promise<void> {
  const record = handle.current;
  if (record === null || record.worktree.cleanup_state !== 'cleanup-pending')
    return;
  const cleaned = await worktrees.cleanup(
    {
      source_cwd: record.repo_cwd,
      source_repo: record.source_repo,
      worktree: record.worktree,
    },
    { force: record.worktree_cleanup_force },
  );
  if (cleaned.cleanup_state === 'retained-error') {
    throw new Error(cleaned.cleanup_error ?? 'managed worktree cleanup failed');
  }
  await handle.update({
    worktree: { ...cleaned, cleanup_error: null },
    cleanupForce: false,
  });
}
