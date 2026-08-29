import type {
  TeamStateTeammateSummary,
} from '@excitedjs/dreamux-types';

import {
  teamCronJobsPath,
  teamMateCollectionDir,
} from '../../platform/paths.js';
import type {
  CompletionDeliveryPolicy,
  CompletionInitiator,
} from '../completion-router/index.js';
import { collectShutdownFailure } from '../shutdown-errors.js';
import { SchedulerService } from '../scheduler/service.js';
import type { SchedulerCommands } from '../scheduler/types.js';
import { CronJobStore } from '../scheduler/store.js';
import {
  TeammateCollection,
  type CreateLockedTeammateOptions,
} from '../teammate-collection/index.js';
import type {
  SpawnTeamMateRequest,
  TeamMateSharedWorkspace,
  TeammateOps,
} from '../teammate-collection/types.js';
import {
  AgentEntityCollectionStore,
  AgentIdentityStore,
} from '../agent-entity/identity-store.js';
import type { TeammateSubmitInput } from '../teammate-service/submission.js';
import {
  AGENT_TASK_SOURCE,
  SCHEDULED_SOURCE,
} from '../submission-sources.js';
import {
  optionalLifecycleText,
  type AgentEntityIdentity,
  type AgentEntityRuntimeStatus,
  type AgentEntitySubmissionResult,
} from '../agent-entity/types.js';
import type { TeammateService } from '../teammate-service/index.js';
import {
  toSubmissionResult,
  type TurnAdmission,
} from '../teammate-service/turn-recording.js';
import type {
  TeamDissolveRecord,
  TeamRecord,
  TeamSummary,
  TeamLeaderLease,
  TeamView,
} from '../team-collection/types.js';
import {
  alignedWithLeader,
  createTeamLeaderAgentForTeam,
  restoreTeamLeaderAgentForTeam,
  teamLeaderAgentBase,
  type TeamLeaderCreationInput,
} from './leader-agent.js';
import { TeamClosing } from './closing.js';
import { asInboundDeliveryResult } from './delivery-result.js';
import { TeamRosterProjection } from './roster-projection.js';
import type { InboundDeliveryResult } from '../teammate-service/turn-recording.js';
import { teamView } from './team-view.js';
import type {
  TeamSchedulerLifecycle,
  TeamServiceCreateOutput,
  TeamServiceCreateInput,
  TeamServiceDeps,
} from './types.js';
import { WorkflowService, type WorkflowOps } from '../workflow-service/index.js';

/**
 * A single team entity (issue #233): holds its own {@link TeamRecord}, *has a*
 * leader {@link TeammateService} (Phase 4, at the team root), and OWNS its
 * members' team-scoped {@link TeammateCollection}. It exposes per-team runtime
 * and resource operations while TeamCollection owns the durable dissolve state
 * machine. Admin `team_leader` target calls are forwarded to this Team's own
 * collection (no team id — scope is baked in); the leader is never a member row.
 */
export class TeamService {
  private record: TeamRecord | null = null;
  private leader_: TeammateService | null = null;
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

  private constructor(private readonly deps: TeamServiceDeps, teamId: string) {
    this.id = teamId;
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
      admissions: deps.admissions,
      conversationProjection: deps.conversationProjection,
      completionDelivery: deps.completionDelivery,
      // Every Agent this collection holds belongs to this Team, so its
      // completions go to this Team's leader. Ownership decides it, not a field
      // on the producing record.
      initiatorFor: () => deps.teamMateCompletionInitiator(),
      isShuttingDown: deps.isShuttingDown,
      ...(deps.agentNameSuffixGenerator !== undefined
        ? { suffixGenerator: deps.agentNameSuffixGenerator }
        : {}),
      log: deps.log,
    });
    this.workflowService = new WorkflowService({
      dispatcherId: deps.dispatcherId,
      teamId,
      callerKind: 'team_leader',
      teammates: {
        createLocked: (input, options) =>
          deps.withTeamLeaderLease(this.workflowLease(), (service) =>
            service.createLockedWorkflowTeammate(input, options ?? {}),
          ),
      },
      completionDelivery: deps.completionDelivery,
      completionInitiator: () =>
        deps.availability.completionInitiator(this.mustLeader()),
      log: deps.workflowLog,
    });
    this.scheduler_ = new SchedulerService({
      ownerId: `${deps.dispatcherId}/team/${teamId}`,
      store: new CronJobStore({
        cronJobsPath: teamCronJobsPath(deps.teamRoot),
        dispatcherId: deps.dispatcherId,
      }),
      // Keep only Dispatcher admission around the scheduler itself; Team
      // admission guards each short public mutation and the final prompt
      // submission separately below.
      admit: (task) => deps.admitOperation(task),
      submitScheduled: (input) =>
        deps.availability.admit(async () => {
          // A scheduled turn proves the leader usable exactly like any other
          // ordinary submission, so it observes the same aggregate transition:
          // a reconstructed `starting` Team converges to `running` before the
          // turn reaches the runtime. Same single route-readiness path, still
          // inside the availability lease this callback already holds.
          await this.ensureRouteReady();
          return asInboundDeliveryResult(
            await this.mustLeader().submitInput({
              source: SCHEDULED_SOURCE,
              text: input.prompt,
              sourceId: input.sourceId,
            }),
          );
        }),
      log: deps.log,
    });
    this.schedulerCommands = {
      list: () => this.scheduler_.commands.list(),
      create: (input) =>
        deps.availability.admit(() => this.scheduler_.commands.create(input)),
      update: (input) =>
        deps.availability.admit(() => this.scheduler_.commands.update(input)),
      delete: (id) =>
        deps.availability.admit(() => this.scheduler_.commands.delete(id)),
    };
    this.closing = new TeamClosing({
      teamId,
      workflows: this.workflowService,
      scheduler: this.scheduler_,
      members: this.teammateCollection,
      store: deps.store,
      leader: () => this.leader_,
      requireLeader: () => this.mustLeader(),
      record: {
        get: () => this.mustRecord(),
        set: (record) => {
          this.record = record;
        },
      },
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
        worktree: input.workspace.worktree,
        intent: input.intent,
        identityPrompt,
        ...(input.skillSources !== undefined
          ? { skillSources: input.skillSources }
          : {}),
      });
      // Publish ownership before starting: cleanup retries retain the exact
      // entity/process authority even though the service is not routable yet.
      service.leader_ = leader;
      deps.trackMaterialized(service);
      await leader.activate();
      let submission: AgentEntitySubmissionResult | null = null;
      if (input.prompt !== undefined) {
        const delivery = await service.resolveLeaderCompletion(leader);
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
      team = await deps.store.update(team, { status: 'running' });
      service.record = team;
      await service.workflowService.start();
      await service.scheduler_.start();
      return {
        service,
        schedulerLifecycle: TeamService.schedulerLifecycleFor(service),
        leaderResult: { teammate: leader.status(), submission },
      };
    } catch (error) {
      const failures: unknown[] = [error];
      service.scheduler_.stop();
      await collectShutdownFailure(failures, () =>
        service.workflowService.stopAll());
      if (leader === null) {
        await collectShutdownFailure(failures, async () => {
          // Only adopt an identity this Team can prove is its own leader's;
          // anything else at that location is not ours to close.
          const durableLeader = await service.leaderIdentity.read();
          if (
            durableLeader === null ||
            !alignedWithLeader(durableLeader, team)
          ) {
            return;
          }
          leader = restoreTeamLeaderAgentForTeam(
            service.leaderAgentDeps(durableLeader),
          );
          service.leader_ = leader;
          deps.trackMaterialized(service);
        });
      }
      if (leader !== null) {
        await collectShutdownFailure(failures, async () => {
          await leader!.close({ note: 'Team creation failed' });
        });
      }
      const closedAt = Date.now();
      await collectShutdownFailure(failures, async () => {
        team = await deps.store.update(team, {
          status: 'closed',
          closedAt,
          closeNote: 'Team creation failed',
          worktree: input.workspace.worktree,
        });
        service.record = team;
      });
      if (failures.length === 1) throw error;
      throw new AggregateError(
        failures,
        `Team ${JSON.stringify(input.teamId)} creation failed and cleanup did not converge`,
      );
    }
  }

  /**
   * Rebuild one Team from its record.
   *
   * A `running` Team restores its leader from the identity already at the Team
   * root; a `starting` Team whose leader never became durable finishes what
   * creation began by asking the TeamMate layer to create it. A `closed` Team
   * never creates a leader — it is already over, and the only thing left to do
   * with a missing record is report it.
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
      service.leader_ = restoreTeamLeaderAgentForTeam(
        service.leaderAgentDeps(identity),
      );
    } else if (record.status === 'closed') {
      throw new Error(
        `TeamLeader ${JSON.stringify(record.leader_name)} does not exist`,
      );
    } else {
      service.leader_ = await service.createLeader({
        leaderName: record.leader_name,
        agentRuntime: record.leader_agent_runtime,
        sourceCwd: record.repo_cwd,
        sourceRepo: record.source_repo,
        runtimeCwd: record.runtime_cwd,
        worktree: record.worktree,
        intent: record.intent,
        identityPrompt: record.leader_identity_prompt,
        skillSources: record.leader_skill_sources,
      });
    }
    deps.trackMaterialized(service);
    return {
      service,
      schedulerLifecycle: TeamService.schedulerLifecycleFor(service),
    };
  }

  get leader(): TeammateService {
    return this.mustLeader();
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

  get leaderName(): string {
    return this.mustRecord().leader_name;
  }

  view(): TeamView {
    return teamView(this.mustRecord());
  }

  async status(): Promise<TeamSummary> {
    return {
      team: this.view(),
      leader: this.leader.status(),
      member_count: await this.memberCount(),
    };
  }

  /**
   * Materialize the TeamLeader before another service publishes this Team as a
   * routable owner. A persisted `starting` Team with a valid leader identity is
   * the recoverable tail of Team creation; only mark it running after the leader
   * can actually start.
   */
  async ensureRouteReady(): Promise<void> {
    const record = this.mustRecord();
    if (record.status === 'closed') {
      throw new Error(`Team ${JSON.stringify(this.id)} is closed`);
    }
    await this.leader.activate();
    await this.workflowService.start();
    if (record.status === 'starting') {
      this.record = await this.deps.store.update(record, { status: 'running' });
    }
  }

  /** Stop everything in this Team except its TeamLeader. */
  stopChildRuntimesForDissolve(): Promise<void> {
    return this.closing.stopChildRuntimesForDissolve();
  }

  /** Stop every runtime in this Team, the TeamLeader last. */
  stopRuntimesForDissolve(): Promise<void> {
    return this.closing.stopRuntimesForDissolve();
  }

  /** Synchronize a TeamCollection-owned durable lifecycle write into this entity. */
  replaceRecord(record: TeamRecord): void {
    if (record.team_id !== this.id) {
      throw new Error(`Team record ${JSON.stringify(record.team_id)} does not match ${JSON.stringify(this.id)}`);
    }
    this.record = record;
  }

  /** Close this Team's resource half once its runtimes are already stopped. */
  async closeLogically(input: {
    note: string;
    dissolve: TeamDissolveRecord;
    worktree: TeamRecord['worktree'];
  }): Promise<TeamSummary> {
    await this.closing.closeLogically(input);
    return this.status();
  }

  /** Idempotently synchronize the Team-owned workspace fact to all borrowers. */
  synchronizeWorktreeCleanup(
    worktree: TeamRecord['worktree'],
  ): Promise<void> {
    return this.closing.synchronizeWorktreeCleanup(worktree);
  }

  /** Propagate the one Team-owned physical-cleanup result to every borrower. */
  async completeWorktreeCleanup(input: {
    dissolve: TeamDissolveRecord;
    worktree: TeamRecord['worktree'];
  }): Promise<TeamSummary> {
    await this.closing.completeWorktreeCleanup(input);
    const summary = await this.status();
    this.deps.evict(this);
    return summary;
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
   */
  async submitToLeader(
    input: TeammateSubmitInput & { initiator?: CompletionInitiator },
  ): Promise<TurnAdmission> {
    if (this.mustRecord().status === 'closed') return { status: 'stopped' };
    // Every ordinary leader submission observes the same aggregate transition
    // route publication does: a persisted `starting` Team whose leader was
    // reconstructed here becomes `running` before any runtime submission. This
    // reuses the one route-readiness path rather than repairing status a second
    // way, and runs inside the availability lease the caller already holds.
    await this.ensureRouteReady();
    const { initiator, ...submission } = input;
    return this.mustLeader().submitInput({
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
  }

  /** The same single entry, reported as the Channel inbound delivery result. */
  async deliverToLeader(
    input: TeammateSubmitInput,
  ): Promise<InboundDeliveryResult> {
    return asInboundDeliveryResult(await this.submitToLeader(input));
  }

  sharedWorkspace(): TeamMateSharedWorkspace {
    const record = this.mustRecord();
    return {
      sourceCwd: record.repo_cwd,
      sourceRepo: record.source_repo,
      runtimeCwd: record.runtime_cwd,
      worktree: record.worktree,
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

  stopWorkflowsForClosing(): Promise<void> {
    return this.workflowService.stopAll();
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
    return this.teammateCollection.list(); // members-only; leader is `this.leader`
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

  private leaderAgentDeps(identity: AgentEntityIdentity) {
    return { ...this.leaderAgentBase(), identity };
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

  /** Where this Team's own leader reports: the dispatcher that owns the Team. */
  private leaderCompletionInitiator(): Promise<CompletionInitiator | null> {
    return this.deps.leaderCompletionInitiator();
  }

  private async resolveLeaderCompletion(
    _leader: TeammateService,
  ) {
    const initiator = await this.leaderCompletionInitiator();
    return initiator === null
      ? null
      : (
          completion: Parameters<CompletionDeliveryPolicy['deliverRuntime']>[1],
          fact: Parameters<CompletionDeliveryPolicy['deliverRuntime']>[2],
        ) => this.deps.completionDelivery.deliverRuntime(
          initiator,
          completion,
          fact,
        );
  }

  private mustRecord(): TeamRecord {
    if (this.record === null) throw new Error(`Team ${JSON.stringify(this.id)} is not booted`);
    return this.record;
  }

  private mustLeader(): TeammateService {
    if (this.leader_ === null) throw new Error(`Team ${JSON.stringify(this.id)} leader is not booted`);
    return this.leader_;
  }

  private workflowLease(): TeamLeaderLease {
    return { teamId: this.id, leaderName: this.leaderName };
  }

  private static schedulerLifecycleFor(service: TeamService): TeamSchedulerLifecycle {
    return {
      start: () => service.scheduler_.start(),
      stop: () => service.scheduler_.stop(),
    };
  }
}
