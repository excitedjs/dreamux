import type { AgentEntityWorktreeIdentity } from '../agent-entity/types.js';
import type { TeamService } from '../team-service/index.js';
import type {
  WorktreeCleanupAssessment,
  WorktreeCleanupBlockedReason,
  WorktreeManager,
} from '../worktree/manager.js';
import {
  TeamDissolveBlockedError,
  TeamDissolveFailedError,
} from './errors.js';
import type { TeamDissolveOperation } from './dissolve-lifecycle.js';
import type {
  AcceptedTeamLogicalClose,
  TeamDissolvePublicError,
  TeamDissolveRecord,
  TeamRecord,
  TeamSummary,
} from './types.js';

interface TeamDissolveRunnerOptions {
  worktrees: WorktreeManager;
  getService(teamId: string): Promise<TeamService>;
  /** Controller-owned authoritative generation check and snapshot refresh. */
  loadCurrent(operation: TeamDissolveOperation): Promise<TeamRecord>;
  assessWorktree(record: TeamRecord): Promise<WorktreeCleanupAssessment>;
  persistDissolve(
    operation: TeamDissolveOperation,
    patch: Partial<Pick<
      TeamDissolveRecord,
      'phase' | 'last_error' | 'cleanup_attempts' | 'next_retry_at'
    >>,
  ): Promise<TeamRecord>;
  deferRetry(
    operation: TeamDissolveOperation,
    publicError: TeamDissolvePublicError,
    cause: unknown,
  ): Promise<void>;
  scheduleRetry(operation: TeamDissolveOperation): void;
  failOpen(
    operation: TeamDissolveOperation,
    publicError: TeamDissolvePublicError,
    cause: unknown,
  ): Promise<void>;
  /** Abandon an accepted operation whose post-stop work is worth keeping. */
  blockAfterStop(
    operation: TeamDissolveOperation,
    publicError: TeamDissolvePublicError,
    cause: unknown,
  ): Promise<void>;
  closeResources(input: AcceptedTeamLogicalClose): Promise<TeamSummary>;
  logicalClosed(operation: TeamDissolveOperation, summary: TeamSummary): void;
  finishClosed(
    operation: TeamDissolveOperation,
    summary: TeamSummary,
  ): Promise<void>;
  suspend(operation: TeamDissolveOperation): void;
}

/** Stateless phase executor; its controller owns all lifecycle settlement. */
export class TeamDissolveRunner {
  constructor(private readonly opts: TeamDissolveRunnerOptions) {}

  /**
   * Stop, then decide, then close.
   *
   * Acceptance already fenced this Team and, for a self-dissolve, already
   * stopped its children. What is left is unconditional: stop every runtime
   * that could still write the shared workspace, and only then look at it. The
   * check before acceptance answered "may this start"; this one answers "is it
   * still true now that nothing is running", which is the only version of the
   * answer a destructive reclaim can act on.
   *
   * A `force` operation skips the question. The caller already said the local
   * work is expendable, and asking again would only produce an answer nobody
   * is allowed to act on.
   */
  async run(operation: TeamDissolveOperation): Promise<void> {
    const current = await this.opts.loadCurrent(operation);
    if (
      current.status !== 'closed' &&
      this.suspendIfInterrupted(operation)
    ) return;
    if (operation.record.phase === 'failed' && current.status !== 'closed') {
      await this.opts.failOpen(
        operation,
        operation.record.last_error ?? 'resource-close-failed',
        new TeamDissolveFailedError(publicDissolveErrorMessage(
          operation.record.last_error ?? 'resource-close-failed',
        )),
      );
      return;
    }
    if (current.status === 'closed') {
      await this.resumeClosedTeam(operation, current);
      return;
    }

    try {
      const service = await this.opts.getService(operation.teamId);
      await service.stopRuntimesForDissolve();
    } catch (error) {
      await this.opts.deferRetry(operation, 'resource-close-failed', error);
      return;
    }
    if (this.suspendIfInterrupted(operation)) return;

    if (
      operation.record.next_retry_at !== null &&
      operation.record.next_retry_at > Date.now()
    ) {
      this.opts.scheduleRetry(operation);
      return;
    }

    // Re-read through the controller once everything is stopped. This is both
    // the authoritative operation-generation check and the snapshot the
    // required second non-destructive worktree assessment reads.
    const revalidated = await this.opts.loadCurrent(operation);
    let assessment: WorktreeCleanupAssessment;
    try {
      assessment = await this.opts.assessWorktree(revalidated);
    } catch (error) {
      if (this.suspendIfInterrupted(operation)) return;
      await this.opts.failOpen(operation, 'worktree-assessment-failed', error);
      return;
    }
    if (this.suspendIfInterrupted(operation)) return;
    if (assessment.status === 'blocked') {
      if (!operation.record.force) {
        await this.opts.blockAfterStop(
          operation,
          publicErrorForSafety(assessment.reason),
          new TeamDissolveBlockedError(assessment.reason),
        );
        return;
      }
      // Still asked, because the same call is what proves this is a managed
      // worktree that exists and is registered to this Team's repository.
      // `force` overrides only the refusal, not the resolution behind it.
      assessment = { status: 'eligible' };
    }

    await this.startLogicalClose(operation, revalidated, assessment);
  }

  private suspendIfInterrupted(operation: TeamDissolveOperation): boolean {
    if (!operation.interrupt.isInterrupted()) return false;
    this.opts.suspend(operation);
    return true;
  }

  private async resumeClosedTeam(
    operation: TeamDissolveOperation,
    current: TeamRecord,
  ): Promise<void> {
    const service = await this.opts.getService(operation.teamId);
    const summary = await service.status();
    this.opts.logicalClosed(operation, summary);
    if (operation.record.phase === 'complete') {
      await this.opts.finishClosed(operation, summary);
      return;
    }
    if (operation.record.phase === 'failed') {
      await this.opts.finishClosed(operation, summary);
      return;
    }
    if (
      operation.record.next_retry_at !== null &&
      operation.record.next_retry_at > Date.now()
    ) {
      this.opts.scheduleRetry(operation);
      return;
    }
    try {
      await service.synchronizeWorktreeCleanup(current.worktree);
      if (
        operation.record.phase === 'closing_resources' &&
        current.worktree.cleanup_state !== 'cleanup-pending'
      ) {
        await this.opts.persistDissolve(operation, isSafetyRetained(
          current.worktree.cleanup_state,
        ) ? {
            phase: 'failed',
            last_error: publicErrorForSafety(current.worktree.cleanup_state),
            next_retry_at: null,
          } : {
            phase: 'complete',
            last_error: null,
            next_retry_at: null,
          });
      }
    } catch (error) {
      await this.opts.deferRetry(operation, 'resource-close-failed', error);
      return;
    }
    const recovered = await this.opts.loadCurrent(operation);
    const recoveredPhase = recovered.dissolve!.phase;
    if (recoveredPhase === 'worktree_cleanup_pending') {
      try {
        await this.runPhysicalCleanup(operation);
      } catch (error) {
        await this.opts.deferRetry(operation, 'worktree-cleanup-failed', error);
      }
    } else if (recoveredPhase === 'complete') {
      await this.opts.finishClosed(operation, await service.status());
    } else if (recoveredPhase === 'failed') {
      await this.opts.finishClosed(operation, await service.status());
    }
  }

  private async startLogicalClose(
    operation: TeamDissolveOperation,
    current: TeamRecord,
    assessment: WorktreeCleanupAssessment,
  ): Promise<void> {
    try {
      await this.opts.persistDissolve(operation, {
        phase: 'closing_resources',
        last_error: null,
        next_retry_at: null,
      });
      const terminalWorktree =
        assessment.status === 'terminal' ? assessment.worktree : null;
      const nextRecord: TeamDissolveRecord = {
        ...operation.record,
        phase: terminalWorktree === null
          ? 'worktree_cleanup_pending'
          : 'complete',
        last_error: null,
        next_retry_at: null,
      };
      const worktree = terminalWorktree ?? current.worktree;
      const logicalWorktree = terminalWorktree ?? {
        ...worktree,
        cleanup_state: 'cleanup-pending' as const,
        cleanup_error: null,
      };
      const summary = await this.opts.closeResources({
        operationId: operation.operationId,
        teamId: operation.teamId,
        note: operation.record.note,
        dissolve: nextRecord,
        worktree: logicalWorktree,
      });
      await this.opts.loadCurrent(operation);
      this.opts.logicalClosed(operation, summary);
      if (operation.record.phase === 'complete') {
        await this.opts.finishClosed(operation, summary);
        return;
      }
      try {
        await this.runPhysicalCleanup(operation);
      } catch (error) {
        await this.opts.deferRetry(operation, 'worktree-cleanup-failed', error);
      }
    } catch (error) {
      await this.opts.deferRetry(operation, 'resource-close-failed', error);
    }
  }

  private async runPhysicalCleanup(
    operation: TeamDissolveOperation,
  ): Promise<void> {
    const team = await this.opts.loadCurrent(operation);
    const service = await this.opts.getService(operation.teamId);
    const cleaned = await this.opts.worktrees.cleanup(
      {
        source_cwd: team.repo_cwd,
        source_repo: team.source_repo,
        worktree: team.worktree,
      },
      { force: operation.record.force },
    );
    if (cleaned.cleanup_state === 'retained-error') {
      await this.opts.deferRetry(
        operation,
        'worktree-cleanup-failed',
        new Error(cleaned.cleanup_error ?? 'managed worktree cleanup failed'),
      );
      return;
    }
    if (isSafetyRetained(cleaned.cleanup_state)) {
      const failed: TeamDissolveRecord = {
        ...operation.record,
        phase: 'failed',
        last_error: publicErrorForSafety(cleaned.cleanup_state),
        next_retry_at: null,
      };
      const summary = await service.completeWorktreeCleanup({
        dissolve: failed,
        worktree: { ...cleaned, cleanup_error: null },
      });
      await this.opts.loadCurrent(operation);
      await this.opts.finishClosed(operation, summary);
      return;
    }
    const complete: TeamDissolveRecord = {
      ...operation.record,
      phase: 'complete',
      last_error: null,
      next_retry_at: null,
    };
    const summary = await service.completeWorktreeCleanup({
      dissolve: complete,
      worktree: { ...cleaned, cleanup_error: null },
    });
    await this.opts.loadCurrent(operation);
    await this.opts.finishClosed(operation, summary);
  }

}

function isSafetyRetained(
  state: AgentEntityWorktreeIdentity['cleanup_state'],
): state is
  | 'retained-dirty'
  | 'retained-unmerged'
  | 'retained-unique-commits' {
  return state === 'retained-dirty' ||
    state === 'retained-unmerged' ||
    state === 'retained-unique-commits';
}

export function publicErrorForSafety(
  state: WorktreeCleanupBlockedReason |
    'retained-dirty' |
    'retained-unmerged' |
    'retained-unique-commits',
): TeamDissolvePublicError {
  switch (state) {
    case 'dirty':
    case 'retained-dirty':
      return 'worktree-dirty';
    case 'unmerged':
    case 'retained-unmerged':
      return 'worktree-unmerged';
    case 'retained-unique-commits':
      return 'worktree-unique-commits';
  }
}

export function publicDissolveErrorMessage(
  error: TeamDissolvePublicError,
): string {
  switch (error) {
    case 'worktree-dirty':
      return 'Managed worktree has uncommitted or untracked changes';
    case 'worktree-unmerged':
      return 'Managed worktree has unresolved merge entries';
    case 'worktree-unique-commits':
      return 'Managed worktree has commits that are not preserved on another ref';
    case 'worktree-assessment-failed':
      return 'Team worktree assessment failed';
    case 'resource-close-failed':
      return 'Team resources could not be closed';
    case 'worktree-cleanup-failed':
      return 'Managed worktree cleanup failed';
  }
}
