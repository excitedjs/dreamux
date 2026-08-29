import {
  collectShutdownFailure,
  throwShutdownFailures,
} from '../shutdown-errors.js';
import { requireLifecycleText } from '../agent-entity/types.js';
import type { SchedulerService } from '../scheduler/service.js';
import type { TeammateCollection } from '../teammate-collection/index.js';
import type { TeammateService } from '../teammate-service/index.js';
import type { TeamStore } from '../team-collection/store.js';
import type {
  TeamDissolveRecord,
  TeamRecord,
} from '../team-collection/types.js';
import type { WorkflowService } from '../workflow-service/index.js';

export interface TeamClosingDeps {
  teamId: string;
  workflows: WorkflowService;
  scheduler: SchedulerService;
  members: TeammateCollection;
  store: TeamStore;
  /**
   * The materialized TeamLeader, or `null` for a Team whose creation failed
   * before its leader existed.
   */
  leader: () => TeammateService | null;
  /** The same leader, demanded: the paths that cannot proceed without one. */
  requireLeader: () => TeammateService;
  /**
   * The Team record, read and written in place.
   *
   * A port rather than a returned value because closing writes the record more
   * than once, and every write must be readable by the Team at exactly the
   * await point it lands on.
   */
  record: {
    get: () => TeamRecord;
    set: (record: TeamRecord) => void;
  };
}

/**
 * The stop-and-close half of one Team: everything the owning TeamCollection's
 * dissolve drives, plus the host's own shutdown sweep.
 *
 * It is one unit because it is one set of collaborators reached in one order —
 * Workflows, then the scheduler, then this Team's members, then its leader —
 * with failures collected rather than thrown at the first one. The Team keeps
 * the surface; this owns what the surface does.
 */
export class TeamClosing {
  constructor(private readonly deps: TeamClosingDeps) {}

  /**
   * Stop everything in this Team except its TeamLeader.
   *
   * Dissolve is a stop-and-reclaim, never a drain, so this fences Workflow and
   * scheduler admission and terminates every runtime that could still write
   * the shared workspace. Durable members that never ran in this process are
   * materialized first: a TeamMate is stopped because it might be running, and
   * only the entity itself can answer that.
   *
   * Nothing durable is written. A Team is closed by dissolve, not by its
   * children stopping, so a Team that ends up not dissolving finds them
   * stopped and reopens them lazily like any other dormant Agent.
   */
  async stopChildRuntimesForDissolve(): Promise<void> {
    const failures: unknown[] = [];
    await this.stopChildRuntimes(failures);
    this.throwDissolveStopFailures(failures);
  }

  /** Stop every runtime in this Team, the TeamLeader last. */
  async stopRuntimesForDissolve(): Promise<void> {
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
   * Close this Team's resource half once its runtimes are already stopped.
   *
   * The owning TeamCollection has fenced admission, stopped the runtimes, and
   * rechecked the workspace; it supplies the exact durable dissolve phase and
   * shared cleanup state to commit atomically with logical closure. The stops
   * repeated here are idempotent — this is where children stop being stopped
   * runtimes and become closed members.
   */
  async closeLogically(input: {
    note: string;
    dissolve: TeamDissolveRecord;
    worktree: TeamRecord['worktree'];
  }): Promise<void> {
    requireLifecycleText(input.note, 'Team dissolve note');
    const failures: unknown[] = [];
    this.deps.workflows.closeAdmission();
    await collectShutdownFailure(failures, () => this.deps.workflows.stopAll());
    this.deps.scheduler.stop();
    const record = this.deps.record.get();
    await collectShutdownFailure(failures, async () => {
      await this.deps.members.materializeNonClosedEntities();
    });
    for (const member of this.deps.members.materializedEntities()) {
      await collectShutdownFailure(failures, async () => {
        await member.close({ note: input.note });
      });
    }
    await collectShutdownFailure(failures, async () => {
      await this.stopLeader({ note: input.note });
    });
    await collectShutdownFailure(failures, () =>
      this.deps.scheduler.deleteStoreFile());
    throwShutdownFailures(
      failures,
      `Team ${JSON.stringify(this.deps.teamId)} resources did not close for dissolve`,
    );
    const closingDissolve =
      input.dissolve.phase === 'complete' || input.dissolve.phase === 'failed'
      ? { ...input.dissolve, phase: 'closing_resources' as const }
      : input.dissolve;
    this.deps.record.set(
      await this.deps.store.update(record, {
        status: 'closed',
        closedAt: Date.now(),
        closeNote: input.note,
        worktree: input.worktree,
        dissolve: closingDissolve,
        expectedDissolveOperationId: input.dissolve.operation_id,
      }),
    );
    await this.synchronizeWorktreeCleanup(input.worktree);
    if (closingDissolve !== input.dissolve) {
      this.deps.record.set(
        await this.deps.store.update(this.deps.record.get(), {
          dissolve: input.dissolve,
          expectedDissolveOperationId: input.dissolve.operation_id,
        }),
      );
    }
  }

  /** Idempotently synchronize the Team-owned workspace fact to all borrowers. */
  async synchronizeWorktreeCleanup(
    worktree: TeamRecord['worktree'],
  ): Promise<void> {
    const members = await this.deps.members.list();
    await this.deps.requireLeader().applyWorktreeCleanup(worktree);
    for (const member of members) {
      await this.deps.members.applyWorktreeCleanup(member.name, worktree);
    }
  }

  /** Propagate the one Team-owned physical-cleanup result to every borrower. */
  async completeWorktreeCleanup(input: {
    dissolve: TeamDissolveRecord;
    worktree: TeamRecord['worktree'];
  }): Promise<void> {
    await this.synchronizeWorktreeCleanup(input.worktree);
    this.deps.record.set(
      await this.deps.store.update(this.deps.record.get(), {
        worktree: input.worktree,
        dissolve: input.dissolve,
        expectedDissolveOperationId: input.dissolve.operation_id,
      }),
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
    await collectShutdownFailure(failures, async () => {
      await this.deps.members.materializeNonClosedEntities();
    });
    for (const member of this.deps.members.materializedEntities()) {
      await collectShutdownFailure(failures, () => member.stopForHost());
    }
  }

  private throwDissolveStopFailures(failures: unknown[]): void {
    throwShutdownFailures(
      failures,
      `Team ${JSON.stringify(this.deps.teamId)} runtimes did not stop for dissolve`,
    );
  }

  private stopLeader(
    input: { note: string } = { note: 'Team stopped' },
  ): Promise<unknown> {
    return this.deps.requireLeader().close({ note: input.note });
  }
}
