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
  TeamDissolveInterruptedError,
} from './errors.js';
import type { TeamDissolveOperation } from './dissolve-lifecycle.js';
import type {
  TeamDissolvePublicError,
  TeamDissolveRecord,
  TeamRecord,
  TeamSummary,
} from './types.js';

type TeamDissolveTerminalError =
  | TeamDissolveFailedError
  | TeamDissolveBlockedError;

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
  logicalClosed(operation: TeamDissolveOperation, summary: TeamSummary): void;
  finishClosed(
    operation: TeamDissolveOperation,
    summary: TeamSummary,
    error: TeamDissolveTerminalError | null,
  ): Promise<void>;
  suspend(operation: TeamDissolveOperation): void;
}

/** Stateless phase executor; its controller owns all lifecycle settlement. */
export class TeamDissolveRunner {
  constructor(private readonly opts: TeamDissolveRunnerOptions) {}

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

    const closeAlreadyBegan = operation.record.phase !== 'waiting_for_team_idle';
    if (
      operation.record.phase === 'waiting_for_team_idle' ||
      operation.needsRecoveryIdle
    ) {
      try {
        await this.waitForTeamIdle(operation);
        operation.needsRecoveryIdle = false;
      } catch (error) {
        if (error instanceof TeamDissolveInterruptedError) {
          this.opts.suspend(operation);
          return;
        }
        if (closeAlreadyBegan) {
          await this.opts.deferRetry(operation, 'resource-close-failed', error);
        } else {
          await this.opts.failOpen(operation, 'resource-close-failed', error);
        }
        return;
      }
    }
    if (this.suspendIfInterrupted(operation)) return;

    if (
      operation.record.next_retry_at !== null &&
      operation.record.next_retry_at > Date.now()
    ) {
      this.opts.scheduleRetry(operation);
      return;
    }

    // Re-read through the controller after every writer is idle. This is both
    // the authoritative operation-generation check and the snapshot used by
    // the required second non-destructive worktree assessment.
    const revalidated = await this.opts.loadCurrent(operation);
    let assessment: WorktreeCleanupAssessment;
    try {
      assessment = await this.opts.assessWorktree(revalidated);
    } catch (error) {
      if (this.suspendIfInterrupted(operation)) return;
      if (closeAlreadyBegan) {
        await this.opts.deferRetry(
          operation,
          'worktree-assessment-failed',
          error,
        );
      } else {
        await this.opts.failOpen(
          operation,
          'worktree-assessment-failed',
          error,
        );
      }
      return;
    }
    if (this.suspendIfInterrupted(operation)) return;
    if (assessment.status === 'blocked') {
      if (closeAlreadyBegan) {
        await this.finishSafetyBlockedClose(
          operation,
          revalidated,
          assessment,
        );
      } else {
        await this.opts.failOpen(
          operation,
          publicErrorForSafety(assessment.reason),
          new TeamDissolveBlockedError(assessment.reason),
        );
      }
      return;
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
      await this.opts.finishClosed(operation, summary, null);
      return;
    }
    if (operation.record.phase === 'failed') {
      await this.opts.finishClosed(
        operation,
        summary,
        new TeamDissolveFailedError(publicDissolveErrorMessage(
          operation.record.last_error ?? 'resource-close-failed',
        )),
      );
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
      await this.opts.finishClosed(operation, await service.status(), null);
    } else if (recoveredPhase === 'failed') {
      await this.opts.finishClosed(
        operation,
        await service.status(),
        new TeamDissolveFailedError(publicDissolveErrorMessage(
          operation.record.last_error ?? 'resource-close-failed',
        )),
      );
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
      const summary = await operation.logicalClose!({
        operationId: operation.operationId,
        teamId: operation.teamId,
        note: operation.record.note,
        owner: {
          kind: 'team',
          teamName: current.team_id,
          leaderName: operation.leaderName,
        },
        dissolve: nextRecord,
        worktree: logicalWorktree,
      });
      await this.opts.loadCurrent(operation);
      this.opts.logicalClosed(operation, summary);
      if (operation.record.phase === 'complete') {
        await this.opts.finishClosed(operation, summary, null);
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

  private async waitForTeamIdle(
    operation: TeamDissolveOperation,
  ): Promise<void> {
    const interrupt = operation.interrupt;
    if (interrupt.isInterrupted()) throw new TeamDissolveInterruptedError();
    const idle = Promise.all(
      operation.writers.map(async (writer) => writer.waitIdle!()),
    ).then(() => 'idle' as const);
    void idle.catch(() => undefined);
    const result = await Promise.race([
      idle,
      interrupt.promise.then(() => 'interrupted' as const),
    ]);
    if (result === 'interrupted') throw new TeamDissolveInterruptedError();
  }

  private async runPhysicalCleanup(
    operation: TeamDissolveOperation,
  ): Promise<void> {
    const team = await this.opts.loadCurrent(operation);
    const service = await this.opts.getService(operation.teamId);
    const cleaned = await this.opts.worktrees.cleanup({
      source_cwd: team.repo_cwd,
      source_repo: team.source_repo,
      worktree: team.worktree,
    });
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
      await this.opts.finishClosed(
        operation,
        summary,
        new TeamDissolveFailedError('Managed worktree became unsafe to delete'),
      );
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
    await this.opts.finishClosed(operation, summary, null);
  }

  private async finishSafetyBlockedClose(
    operation: TeamDissolveOperation,
    current: TeamRecord,
    assessment: Extract<WorktreeCleanupAssessment, { status: 'blocked' }>,
  ): Promise<void> {
    const publicError = publicErrorForSafety(assessment.reason);
    const failed: TeamDissolveRecord = {
      ...operation.record,
      phase: 'failed',
      last_error: publicError,
      next_retry_at: null,
    };
    const terminalError = new TeamDissolveBlockedError(assessment.reason);
    try {
      const summary = await operation.logicalClose!({
        operationId: operation.operationId,
        teamId: operation.teamId,
        note: operation.record.note,
        owner: {
          kind: 'team',
          teamName: current.team_id,
          leaderName: operation.leaderName,
        },
        dissolve: failed,
        worktree: assessment.worktree,
      });
      await this.opts.loadCurrent(operation);
      await this.opts.finishClosed(operation, summary, terminalError);
    } catch (error) {
      const latest = await this.opts.loadCurrent(operation);
      if (latest.status === 'closed' && operation.record.phase === 'failed') {
        const summary = await (await this.opts.getService(operation.teamId)).status();
        await this.opts.finishClosed(operation, summary, terminalError);
        return;
      }
      await this.opts.deferRetry(operation, publicError, error);
    }
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
    case 'unique-commits':
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
