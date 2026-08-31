import type { DreamuxLogger } from '@excitedjs/dreamux-types';

import {
  collectShutdownFailure,
  throwShutdownFailures,
} from '../shutdown-errors.js';
import type { SchedulerService } from '../scheduler/service.js';
import type { TeammateCollection } from '../teammate-collection/index.js';
import type { TeammateService } from '../teammate-service/index.js';
import type { AgentEntityWorktreeIdentity } from '../agent-entity/types.js';
import {
  teamErrorInfo,
  TeamDissolveBlockedError,
  TeamDissolveFailedError,
} from '../team-collection/errors.js';
import type {
  TeamDissolveCommand,
  TeamRecord,
} from '../team-collection/types.js';
import type {
  WorktreeCleanupAssessment,
  WorktreeManager,
} from '../worktree/manager.js';
import type { WorkflowService } from '../workflow-service/index.js';

export interface TeamClosingDeps {
  teamId: string;
  dispatcherId: string;
  workflows: WorkflowService;
  scheduler: SchedulerService;
  members: TeammateCollection;
  worktrees: WorktreeManager;
  /** The Team's current durable record, as the Team itself reads it. */
  record: () => TeamRecord;
  /**
   * The Team's single durable record write. Closing never writes the record
   * itself: one owner, one path, so what this half decides and what the entity
   * answers from can never drift apart.
   */
  commit: (patch: {
    status?: TeamRecord['status'];
    closedAt?: number | null;
    closeNote?: string | null;
    worktree?: AgentEntityWorktreeIdentity;
    cleanupForce?: boolean;
  }) => Promise<TeamRecord>;
  log: DreamuxLogger;
  /**
   * The materialized TeamLeader, or `null` for a Team whose creation failed
   * before its leader existed.
   */
  leader: () => TeammateService | null;
  /**
   * Close this Team's leader for the dissolve, and let the wrapper go.
   *
   * Attempting the close is what ends that object's usefulness: finished or
   * not, its phase no longer answers for the durable leader identity. The Team
   * drops it here so the next ordinary use materializes a leader from disk
   * rather than reusing one that already left.
   */
  closeLeaderForDissolve: (note: string) => Promise<void>;
}

/**
 * The stop-and-close half of one Team: the dissolve sequence itself, plus the
 * host's own shutdown sweep.
 *
 * It is one unit because it is one set of collaborators reached in one order —
 * Workflows, then the scheduler, then this Team's members, then its leader —
 * with failures collected rather than thrown at the first one. The Team keeps
 * the surface, holds the fence, and owns the single durable write this asks it
 * for; this owns what the surface does.
 */
export class TeamClosing {
  constructor(private readonly deps: TeamClosingDeps) {}

  /**
   * Decide, then stop, then close.
   *
   * What "decide" means depends on who asked. A Dispatcher checks the workspace
   * before anything stops: a refusal must leave the Team exactly as it found
   * it, so a dirty checkout abandons the dissolve rather than half-dismantling a
   * working Team. A TeamLeader cannot ask that question about itself — it is a
   * writer, and so is every TeamMate it started — so it stops its children,
   * then asks while it is still alive to be told the answer. `force` replaces
   * the question rather than answering it.
   *
   * Nobody is waiting on the answer: the Team already gave its caller a receipt
   * and runs this behind it. Returning means the closed record is durable.
   */
  async dissolve(input: TeamDissolveCommand): Promise<void> {
    let worktree: AgentEntityWorktreeIdentity;
    if (!input.force && input.requester === 'dispatcher') {
      // Nothing has stopped yet, so a refusal here costs the Team nothing.
      await this.requireReclaimableWorktree();
    }
    try {
      worktree = await this.stopForDissolve(input);
    } catch (error) {
      // No closed record was written, so this Team is not dissolved. Nothing
      // the dissolve already did is taken back: the record decides, and
      // everything under it stays exactly as this attempt left it. Only the
      // admission this raised is given back, so the Team is reachable again
      // through the ordinary path and rebuilds from what is on disk.
      await this.reopenAdmission();
      throw error;
    }
    // The record below is what makes this Team closed.
    try {
      await this.deps.commit({
        status: 'closed',
        closedAt: Date.now(),
        closeNote: input.note,
        worktree,
        cleanupForce:
          worktree.cleanup_state === 'cleanup-pending' && input.force,
      });
    } catch (error) {
      // The only thing that closes a Team did not land, so this Team still
      // exists — over resources that really are closed. None of them is put
      // back: its leader and its members are materialized again from the
      // identities still on disk, the ordinary way, whenever something next
      // reaches them.
      await this.reopenAdmission();
      throw error;
    }
  }

  /**
   * Decide, then stop, and report the workspace fact the closed record carries.
   *
   * Every remaining refusal happens before anything durable is written, so a
   * Team refused here is untouched. A Team that leaves this method has stopped
   * and really closed its resources; the only step left is stating it.
   */
  private async stopForDissolve(
    input: TeamDissolveCommand,
  ): Promise<AgentEntityWorktreeIdentity> {
    if (!input.force && input.requester === 'team_leader') {
      await this.stopChildRuntimesForDissolve();
      await this.requireReclaimableWorktree();
    }
    await this.stopRuntimesForDissolve();
    // The only assessment a destructive reclaim may act on: the earlier one
    // answered "may this start", this one answers "is it still true now that
    // nothing is running".
    const assessment = await this.assessWorktree();
    if (assessment.status === 'blocked' && !input.force) {
      throw new TeamDissolveBlockedError(assessment.reason);
    }
    await this.closeResources(input.note);
    return assessment.status === 'terminal'
      ? assessment.worktree
      : {
          ...this.deps.record().worktree,
          cleanup_state: 'cleanup-pending',
          cleanup_error: null,
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
    const record = this.deps.record();
    try {
      return await this.deps.worktrees.assessCleanup({
        source_cwd: record.repo_cwd,
        source_repo: record.source_repo,
        worktree: record.worktree,
      });
    } catch (error) {
      this.deps.log.warn(
        {
          dispatcher_id: this.deps.dispatcherId,
          team_id: this.deps.teamId,
          err: teamErrorInfo(error),
        },
        'Team dissolve worktree assessment failed',
      );
      throw new TeamDissolveFailedError('Team worktree assessment failed');
    }
  }

  private async requireReclaimableWorktree(): Promise<void> {
    const assessment = await this.assessWorktree();
    if (assessment.status === 'blocked') {
      throw new TeamDissolveBlockedError(assessment.reason);
    }
  }

  /**
   * Stop everything in this Team except its TeamLeader.
   *
   * Dissolve is a stop-and-reclaim, never a drain, so this fences Workflow and
   * scheduler admission and terminates every runtime that could still write
   * the shared workspace. Only members this process holds are reached, because
   * they are the only ones running: a TeamMate runs in the process that
   * materialized it, so a durable record nobody materialized is already idle.
   *
   * Nothing durable is written. A Team is closed by dissolve, not by its
   * children stopping, so a Team that ends up not dissolving finds them
   * stopped and reopens them lazily like any other dormant Agent.
   */
  private async stopChildRuntimesForDissolve(): Promise<void> {
    const failures: unknown[] = [];
    await this.stopChildRuntimes(failures);
    this.throwDissolveStopFailures(failures);
  }

  /** Stop every runtime in this Team, the TeamLeader last. */
  private async stopRuntimesForDissolve(): Promise<void> {
    const failures: unknown[] = [];
    await this.stopChildRuntimes(failures);
    // Read the nullable leader, not the demanded one: a Team whose creation
    // failed before its leader existed has none, and demanding one would abort
    // the stop.
    const leader = this.deps.leader();
    if (leader !== null) {
      await collectShutdownFailure(failures, () => leader.stopForHost());
    }
    this.throwDissolveStopFailures(failures);
  }

  /**
   * Close every resource this Team holds, once its runtimes are already
   * stopped.
   *
   * The stops repeated here are idempotent — this is where children stop being
   * stopped runtimes and become closed members, live ones through their own
   * entity and dormant records where they lie. It writes nothing durable about
   * the Team itself: the Team commits its own closed record once this returns,
   * so a resource that refuses to close leaves an open Team rather than a
   * closed one with live children. Nothing here is undone if that commit never
   * lands: every close is durable, and an Agent this closed is materialized
   * again from the identity still at its own location, exactly as a Team that
   * had never dissolved materializes a dormant one.
   *
   * Cancelling scheduled work is part of closing the scheduler rather than a
   * postscript to a durable close, because a dissolve that stopped the
   * scheduler and then failed to commit must not leave jobs a later `start()`
   * would arm again. That the jobs are gone from a Team which stayed open is
   * the price of cancelling them for real. A deletion that fails is the one
   * thing here that must stop the dissolve: the surviving file is the durable
   * fact, and only an open Team is ever rebuilt to see it again.
   */
  private async closeResources(note: string): Promise<void> {
    const failures: unknown[] = [];
    this.deps.workflows.closeAdmission();
    await collectShutdownFailure(failures, () => this.deps.workflows.stopAll());
    this.deps.scheduler.stop();
    await collectShutdownFailure(failures, () =>
      this.deps.scheduler.deleteStoreFile());
    await collectShutdownFailure(failures, () =>
      this.deps.members.closeAllForDissolve(note));
    await collectShutdownFailure(failures, () =>
      this.deps.closeLeaderForDissolve(note));
    throwShutdownFailures(
      failures,
      `Team ${JSON.stringify(this.deps.teamId)} resources did not close for dissolve`,
    );
  }

  /**
   * Give up on a Team whose creation failed, and report why.
   *
   * The record was already published, so the Team exists: it is closed rather
   * than removed, and the concrete name stays taken. Every step is attempted
   * and its failure collected, because a creation that could not be undone
   * cleanly must still say what originally went wrong.
   */
  async abandonCreation(input: {
    cause: unknown;
    note: string;
    worktree: AgentEntityWorktreeIdentity;
    /** Adopt a leader this Team can prove is its own, if one became durable. */
    adoptDurableLeader: () => Promise<void>;
    /**
     * Finish the physical reclamation the closed record now asks for, through
     * the same record-only path a dissolve and a later start use.
     */
    settleWorktree: () => Promise<void>;
  }): Promise<never> {
    const failures: unknown[] = [input.cause];
    this.deps.scheduler.stop();
    await collectShutdownFailure(failures, () => this.deps.workflows.stopAll());
    await collectShutdownFailure(failures, input.adoptDurableLeader);
    const leader = this.deps.leader();
    if (leader !== null) {
      await collectShutdownFailure(failures, async () => {
        await leader.close({ note: input.note });
      });
    }
    let closed = false;
    await collectShutdownFailure(failures, async () => {
      await this.deps.commit({
        status: 'closed',
        closedAt: Date.now(),
        closeNote: input.note,
        worktree: input.worktree,
      });
      closed = true;
    });
    // Only the durable record can ask for the reclaim, and only after it says
    // closed. If the commit did not land, the checkout stays exactly as it is
    // and this Team keeps whatever it prepared.
    if (closed) await collectShutdownFailure(failures, input.settleWorktree);
    if (failures.length === 1) throw input.cause;
    throw new AggregateError(
      failures,
      `Team ${JSON.stringify(this.deps.teamId)} creation failed and cleanup did not converge`,
    );
  }

  /**
   * Take back the admission a failed dissolve fenced, and nothing else.
   *
   * This is not a rollback. Both services start from what is actually on disk:
   * the Workflow runs this stopped are already terminal there, and the
   * scheduler arms whatever cron store survived, which after a completed
   * resource close is none. Reopening only means an open Team can be reached
   * again — what it finds when it is reached is whatever the dissolve really
   * left behind.
   */
  private async reopenAdmission(): Promise<void> {
    await this.deps.workflows.start();
    await this.deps.scheduler.start();
  }

  /**
   * Give back the runtime authority this Team holds, without closing it.
   *
   * Only Agents this process actually materialized are reached: a Team's
   * durable members that never ran hold nothing to release, and materializing
   * them here would make a host stop touch entities it never started. Nothing
   * durable is written — a Team is closed by dissolve, never by a process
   * stopping. One failure never prevents the remaining resources from being
   * released.
   */
  async stopForHost(): Promise<void> {
    const failures: unknown[] = [];
    await collectShutdownFailure(failures, () => this.deps.workflows.stopAll());
    for (const member of this.deps.members.materializedEntities()) {
      await collectShutdownFailure(failures, () => member.stopForHost());
    }
    // Read the nullable leader, not the demanded one: a Team whose creation
    // failed before its leader existed has none, and demanding one would abort
    // the sweep.
    const leader = this.deps.leader();
    if (leader !== null) {
      await collectShutdownFailure(failures, () => leader.stopForHost());
    }
    throwShutdownFailures(
      failures,
      `multiple runtimes in Team ${JSON.stringify(this.deps.teamId)} failed to stop`,
    );
  }

  private async stopChildRuntimes(failures: unknown[]): Promise<void> {
    this.deps.workflows.closeAdmission();
    await collectShutdownFailure(failures, () => this.deps.workflows.stopAll());
    this.deps.scheduler.stop();
    await collectShutdownFailure(failures, () =>
      this.deps.members.stopAllForDissolve());
  }

  private throwDissolveStopFailures(failures: unknown[]): void {
    throwShutdownFailures(
      failures,
      `Team ${JSON.stringify(this.deps.teamId)} runtimes did not stop for dissolve`,
    );
  }
}
