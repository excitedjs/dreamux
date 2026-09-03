import type {
  TeamStateTeammateSummary,
} from '@excitedjs/dreamux-types';

import type { CompletionInitiator } from '../completion-router/index.js';
import type { SchedulerService } from '../scheduler/service.js';
import type { SchedulerCommands } from '../scheduler/types.js';
import type { TeamStore } from '../team-collection/store.js';
import type { TeammateCollection } from '../teammate-collection/index.js';
import type { CreateLockedTeammateOptions } from '../teammate-collection/index.js';
import type {
  SpawnTeamMateRequest,
  TeamWorkspaceLoan,
  TeammateOps,
} from '../teammate-collection/types.js';
import { AgentIdentityStore } from '../agent-entity/identity-store.js';
import type { TeammateSubmitInput } from '../teammate-service/submission.js';
import {
  AGENT_TASK_SOURCE,
  SCHEDULED_SOURCE,
} from '../submission-sources.js';
import {
  optionalLifecycleText,
  requireLifecycleText,
  type AgentEntityRuntimeStatus,
  type AgentEntitySubmissionResult,
} from '../agent-entity/types.js';
import type { TeammateService } from '../teammate-service/index.js';
import {
  asInboundDeliveryResult,
  toSubmissionResult,
  type TurnAdmission,
} from '../teammate-service/turn-recording.js';
import type {
  TeamDissolveCommand,
  TeamDissolveReceipt,
  TeamRecord,
  TeamSummary,
  TeamView,
} from '../team-collection/types.js';
import {
  teamErrorInfo,
  TeamClosedError,
} from '../team-collection/errors.js';
import {
  alignedWithLeader,
  createTeamLeaderAgentForTeam,
  leaderForOpenTeam,
  restoreTeamLeaderAgentForTeam,
  teamLeaderAgentBase,
  type TeamLeaderCreationInput,
} from './leader-agent.js';
import { TeamClosing } from './closing.js';
import { TeamWorktreeCleanup } from '../team-collection/worktree-cleanup.js';
import {
  TeamClosedPublisher,
  type TeamClosedListener,
} from './closed-fact.js';
import {
  resolveTeamLeaderCompletionDelivery,
  TeamLeaderCompletionTargets,
} from './completion-targets.js';
import {
  buildTeamMembers,
  buildTeamScheduler,
  buildTeamWorkflows,
} from './collaborators.js';
import { TeamRosterProjection } from './roster-projection.js';
import { teamView } from './team-view.js';
import type {
  TeamClosedSubscription,
  TeamSchedulerLifecycle,
  TeamServiceCreateOutput,
  TeamServiceCreateInput,
  TeamServiceDeps,
} from './types.js';
import type { WorkflowService, WorkflowOps } from '../workflow-service/index.js';

/**
 * A single team entity (issue #233): holds its own {@link TeamRecord}, *has a*
 * leader {@link TeammateService} (Phase 4, at the team root), and OWNS its
 * members' team-scoped {@link TeammateCollection}. It owns every per-team
 * runtime and resource operation, dissolve included, and is the only writer of
 * its own record. Admin `team_leader` target calls are forwarded to this Team's
 * own collection (no team id — scope is baked in); the leader is never a member
 * row.
 */
export class TeamService {
  private record: TeamRecord | null = null;
  private leader_: TeammateService | null = null;
  private leaderBuild: Promise<TeammateService> | null = null;
  private readonly roster: TeamRosterProjection;
  readonly id: string;
  /** The TeamLeader's identity storage, bound to this Team's root. */
  private readonly leaderIdentity: AgentIdentityStore;
  /** The team's OWN members collection (`teamScope: team_id`, issue #233).
   * Its concrete class owns the lifecycle methods driven by the team; the PUBLIC
   * surface stays the narrow `teammates` admin ops — never expose internal verbs. */
  private readonly teammateCollection: TeammateCollection;
  private readonly scheduler_: SchedulerService;
  private readonly schedulerCommands: SchedulerCommands;
  private readonly workflowService: WorkflowService;
  /** This Team's stop-and-close half. */
  private readonly closing: TeamClosing;
  /** The record-direct reclamation this Team's dissolve ends with. */
  private readonly cleanup: TeamWorktreeCleanup;
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
  private readonly closed: TeamClosedPublisher;

  private constructor(
    private readonly deps: TeamServiceDeps,
    teamId: string,
  ) {
    this.id = teamId;
    this.closed = new TeamClosedPublisher(deps.log);
    this.leaderTargets = new TeamLeaderCompletionTargets({
      admit: (task) => this.admit(task),
      prepareLeaderCompletion: async (completion) =>
        (await this.leaderService()).prepareCompletion(completion),
    });
    // Constructed before the identity stores below: their persistence hooks
    // publish through it.
    this.roster = new TeamRosterProjection({
      teamId,
      store: deps.store,
      ...(deps.coreEvents !== undefined ? { coreEvents: deps.coreEvents } : {}),
      record: () => this.record,
    });
    // The leader lives at the Team root itself; its TeamMates live one level
    // below, in this Team's own `teammate/` collection. Both roots are composed
    // once here, from the root this Team was constructed with.
    this.leaderIdentity = new AgentIdentityStore({
      dir: deps.teamRoot,
      dispatcherId: deps.dispatcherId,
      expectedName: null,
      log: deps.log,
      onPersisted: (identity) => this.roster.publish(identity, 'team_leader'),
    });
    this.teammateCollection = buildTeamMembers({
      deps,
      teamId,
      onPersisted: (identity) => this.roster.publish(identity, 'teammate'),
      leaderCompletionTarget: () => this.leaderTargets.current(),
    });
    this.workflowService = buildTeamWorkflows({
      deps,
      teamId,
      // This Team owns its Workflow scope, so a Workflow's TeamMate is created
      // by this Team directly rather than by asking its owner for a way back in.
      createLocked: (input, options) =>
        this.createLockedWorkflowTeammate(input, options ?? {}),
      leaderCompletionTarget: () => this.leaderTargets.current(),
    });
    const scheduler = buildTeamScheduler({
      dispatcherId: deps.dispatcherId,
      teamId,
      teamRoot: deps.teamRoot,
      admitOperation: (task) => deps.admitOperation(task),
      admit: (task) => this.admit(task),
      // A scheduled turn is an ordinary leader submission and takes the one
      // entry every other invoker takes, aggregate transition included.
      submitScheduled: async (input) =>
        asInboundDeliveryResult(
          await this.submitToLeader({
            source: SCHEDULED_SOURCE,
            text: input.prompt,
            sourceId: input.sourceId,
          }),
        ),
      log: deps.log,
    });
    this.scheduler_ = scheduler.service;
    this.schedulerCommands = scheduler.commands;
    this.closing = new TeamClosing({
      teamId,
      dispatcherId: deps.dispatcherId,
      workflows: this.workflowService,
      scheduler: this.scheduler_,
      members: this.teammateCollection,
      worktrees: deps.worktrees,
      record: () => this.mustRecord(),
      commit: (patch) => this.updateRecord(patch),
      log: deps.log,
      leader: () => this.leader_,
      closeLeaderForDissolve: async (note) => {
        const leader = await this.leaderService();
        this.leader_ = null;
        await leader.close({ note });
      },
    });
    this.cleanup = new TeamWorktreeCleanup({
      store: deps.store,
      worktrees: deps.worktrees,
    });
  }

  /**
   * Create one Team at this concrete name, or report the name as taken.
   *
   * `null` means a valid Team record already occupies the candidate: nothing
   * was created and the caller should allocate another name. Every other
   * failure throws.
   */
  static async createNew(
    deps: TeamServiceDeps,
    input: TeamServiceCreateInput,
  ): Promise<TeamServiceCreateOutput<TeamService> | null> {
    const service = new TeamService(deps, input.teamId);
    const identityPrompt = optionalLifecycleText(
      input.identity,
      'TeamLeader identity',
    );
    const leaderName = await deps.names.allocate({
      kind: 'team-leader',
      base: input.teamId,
      teamSlug: input.teamId,
      ...(deps.agentNameSuffixGenerator !== undefined
        ? { generateSuffix: deps.agentNameSuffixGenerator }
        : {}),
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
    let team = published;
    service.record = team;
    let leader: TeammateService | null = null;
    try {
      // The TeamMate layer owns identity creation: the Team hands over its own
      // creation inputs and gets back a started leader, rather than assembling
      // and persisting an Agent identity itself.
      leader = await service.createLeader({
        leaderName,
        agentRuntime: input.leaderAgentRuntime,
        sourceCwd: input.workspace.sourceCwd,
        sourceRepo: input.workspace.sourceRepo,
        runtimeCwd: input.workspace.runtimeCwd,
        intent: input.intent,
        identityPrompt,
        ...(input.skillSources !== undefined
          ? { skillSources: input.skillSources }
          : {}),
      });
      service.leader_ = leader;
      await leader.activate();
      let submission: AgentEntitySubmissionResult | null = null;
      if (input.prompt !== undefined) {
        const delivery = await resolveTeamLeaderCompletionDelivery({
          initiator: deps.leaderCompletionInitiator,
          completionDelivery: deps.completionDelivery,
        });
        submission = toSubmissionResult(
          await leader.submitInput({
            source: AGENT_TASK_SOURCE,
            text: input.prompt,
            ...(delivery !== null ? { deliverCompletion: delivery } : {}),
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
      team = await service.updateRecord({ status: 'running' });
      await service.workflowService.start();
      await service.scheduler_.start();
      return {
        service,
        schedulerLifecycle: TeamService.schedulerLifecycleFor(service),
        leaderResult: { teammate: leader.status(), submission },
      };
    } catch (error) {
      return await service.closing.abandonCreation({
        cause: error,
        note: 'Team creation failed',
        // The Team exists and is being closed, so its record answers for the
        // checkout — but only for one this creation actually made. A checkout
        // that was already there was never this attempt's to reclaim.
        worktree: input.workspace.createdCheckout
          ? {
              ...input.workspace.worktree,
              cleanup_state: 'cleanup-pending',
              cleanup_error: null,
            }
          : input.workspace.worktree,
        settleWorktree: () => service.cleanup.settle(input.teamId),
        adoptDurableLeader: async () => {
          if (service.leader_ !== null) return;
          // Only adopt an identity this Team can prove is its own leader's;
          // anything else at that location is not ours to close.
          const durable = await service.leaderIdentity.read();
          if (durable === null || !alignedWithLeader(durable, team)) return;
          service.leader_ = restoreTeamLeaderAgentForTeam({
            ...service.leaderAgentBase(),
            identity: durable,
          });
        },
      });
    }
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
  ): Promise<{
    service: TeamService;
    schedulerLifecycle: TeamSchedulerLifecycle;
  }> {
    const service = new TeamService(deps, record.team_id);
    service.record = record;
    const identity = await service.leaderIdentity.read();
    const restorable = identity !== null && alignedWithLeader(identity, record);
    // Seed before the leader branch below: creating a leader publishes the
    // aggregate from this roster, and an aggregate that omitted the Team's
    // existing members would be a false fact, not a partial one.
    await service.roster.seed(restorable ? identity : null, () =>
      service.members());
    if (restorable && identity !== null) {
      // Aligned: take the identity exactly as stored — no restamp, no rewrite.
      service.leader_ = restoreTeamLeaderAgentForTeam({
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
    return {
      service,
      schedulerLifecycle: TeamService.schedulerLifecycleFor(service),
    };
  }

  onClosed(listener: TeamClosedListener): TeamClosedSubscription {
    return this.closed.subscribe(listener);
  }

  get scheduler(): SchedulerCommands {
    return this.schedulerCommands;
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

  view(): TeamView {
    return teamView(this.mustRecord());
  }

  async status(): Promise<TeamSummary> {
    return {
      team: this.view(),
      leader: (await this.leaderService()).status(),
      member_count: await this.memberCount(),
    };
  }

  /**
   * Run one caller operation inside this Team's work fence.
   *
   * From the moment a dissolve raises the fence, and permanently once this Team
   * is durably closed, the Team takes no new work. Dissolve is a
   * stop-and-reclaim rather than a drain, so this refuses rather than queues.
   */
  async admit<T>(task: () => Promise<T>): Promise<T> {
    if (this.dissolveTask !== null) {
      throw new TeamClosedError(`Team ${JSON.stringify(this.id)} is closing`);
    }
    if (this.mustRecord().status === 'closed') {
      throw new TeamClosedError(`Team ${JSON.stringify(this.id)} is closed`);
    }
    return task();
  }

  /**
   * Submit this Team's dissolve.
   *
   * The answer is the submission, not the outcome: once this Team owns the one
   * background operation that will stop it, close it, and reclaim its checkout,
   * the caller is done. Nothing about assessing a workspace, terminating
   * runtimes, or removing a checkout is worth holding a tool call open for, and
   * no persisted phase survives the process that ran it — a run that ends
   * mid-dissolve simply leaves an open Team whose children reopen lazily.
   *
   * Whoever asks, it is one operation: a second submission joins the first
   * rather than dismantling the same Team twice, and a dissolve that was
   * refused can be asked again.
   */
  dissolve(input: TeamDissolveCommand): TeamDissolveReceipt {
    const note = requireLifecycleText(input.note, 'Team dissolve note');
    if (this.dissolveTask === null) {
      // Published before it runs, so nothing it does — including failing at
      // once — can happen while this Team still looks open. Observed, never
      // awaited: the operation belongs to this Team, so its failure is this
      // Team's to report rather than an unhandled rejection.
      const task = Promise.resolve().then(() => this.runDissolve({ ...input, note }));
      this.dissolveTask = task;
      void task.catch(() => {});
    }
    return { accepted: true, team_name: this.id, status: 'submitted' };
  }

  /**
   * Stop, close, and reclaim — the whole dissolve, behind the receipt.
   *
   * The fence goes up before the first await, so from the moment a dissolve is
   * submitted the Team takes no new work. A failure lowers it again and is
   * stated here, where it happens: the receipt was already given and cannot be
   * revised, so the Team simply stays open and can be asked again.
   */
  private async runDissolve(input: TeamDissolveCommand): Promise<void> {
    try {
      await this.closing.dissolve(input);
    } catch (error) {
      this.dissolveTask = null;
      this.logDissolveFailure('Team dissolve failed', error);
      throw error;
    }
    // This Team is over and already dropped by its owner; what is left is
    // physical, and the record it left behind is the whole input. A failure
    // leaves the pending fact standing for the next start to finish, so it is
    // reported rather than raised.
    try {
      await this.cleanup.settle(this.id);
    } catch (error) {
      this.logDissolveFailure('Team managed worktree cleanup failed', error);
    }
  }

  private logDissolveFailure(message: string, error: unknown): void {
    this.deps.log.error(
      {
        dispatcher_id: this.dispatcherId,
        team_id: this.id,
        err: teamErrorInfo(error),
      },
      message,
    );
  }

  /** Give back the runtime authority this Team holds, without closing it. */
  stopForHost(): Promise<void> {
    return this.closing.stopForHost();
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
   * stayed on its opening label with no error (found live, 2026-09-03).
   *
   * A persisted `starting` Team with a valid leader identity is the
   * recoverable tail of Team creation, and it converges the way creation
   * converges: `running` once its leader has taken a turn, not before.
   */
  async submitToLeader(
    input: TeammateSubmitInput & { initiator?: CompletionInitiator },
  ): Promise<TurnAdmission> {
    return this.admit(async () => {
      const { initiator, ...submission } = input;
      const admission = await (await this.leaderService()).submitInput({
        ...submission,
        ...(initiator !== undefined
          ? {
              deliverCompletion: (completion, fact) =>
                this.deps.completionDelivery.deliverRuntime(
                  initiator,
                  completion,
                  fact,
                ),
            }
          : {}),
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
    this.workflowService.closeAdmission();
  }

  startWorkflowAdmission(): Promise<void> {
    return this.workflowService.start();
  }

  recoverWorkflows(): Promise<void> {
    return this.workflowService.recover();
  }

  async memberCount(): Promise<number> {
    return (await this.members()).length;
  }

  private async members(): Promise<AgentEntityRuntimeStatus[]> {
    return this.teammateCollection.list(); // members-only; the leader is not a member
  }

  /**
   * Ask the TeamMate layer to create this Team's leader from the Team's own
   * creation inputs. The Team never writes an Agent identity itself.
   */
  private async createLeader(
    creation: TeamLeaderCreationInput,
  ): Promise<TeammateService> {
    return createTeamLeaderAgentForTeam({
      ...this.leaderAgentBase(),
      creation,
    });
  }

  private leaderAgentBase() {
    return teamLeaderAgentBase({
      deps: this.deps,
      teamId: this.id,
      identities: this.leaderIdentity,
    });
  }

  /** This Team's contained Agents, as a fresh summary per publication. */
  teammatesSummary(): readonly TeamStateTeammateSummary[] {
    return this.roster.summary();
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
    const updated = await this.deps.store.update(previous, patch);
    this.record = updated;
    // The write that closes the record is what ends this Team, so the fact is
    // stated exactly where it becomes true — once, on the transition.
    if (previous.status !== 'closed' && updated.status === 'closed') {
      this.closed.publish(updated);
    }
    return updated;
  }

  private mustRecord(): TeamRecord {
    if (this.record === null) throw new Error(`Team ${JSON.stringify(this.id)} is not booted`);
    return this.record;
  }

  /** This Team's leader, materialized from the identity at its root when this Team is holding none, and built once however many ordinary uses ask at the same time — two would be two Agents over one identity. */
  private async leaderService(): Promise<TeammateService> {
    if (this.leader_ !== null) return this.leader_;
    this.leaderBuild ??= leaderForOpenTeam({
      ...this.leaderAgentBase(),
      record: this.mustRecord(),
    }).finally(() => { this.leaderBuild = null; });
    this.leader_ = await this.leaderBuild;
    return this.leader_;
  }

  private static schedulerLifecycleFor(service: TeamService): TeamSchedulerLifecycle {
    return {
      start: () => service.scheduler_.start(),
      stop: () => service.scheduler_.stop(),
    };
  }
}
