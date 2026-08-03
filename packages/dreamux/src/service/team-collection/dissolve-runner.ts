import type { AgentEntityWorktreeIdentity } from '../agent-entity/types.js';
import type { ChannelRouteOwner } from '../channel-service/index.js';
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
} from './types.js';

interface TeamDissolveRunnerOptions {
  worktrees: WorktreeManager;
  mustTeam(teamId: string): Promise<TeamRecord>;
  getService(teamId: string): Promise<TeamService>;
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
  failBeforeLogicalClose(
    operation: TeamDissolveOperation,
    publicError: TeamDissolvePublicError,
    cause: unknown,
  ): Promise<void>;
  completeFailedOpenOperation(
    operation: TeamDissolveOperation,
    error: TeamDissolveFailedError | TeamDissolveBlockedError,
  ): Promise<void>;
  finish(operation: TeamDissolveOperation): Promise<void>;
  suspend(operation: TeamDissolveOperation): void;
  requireOwner(operation: TeamDissolveOperation): Promise<ChannelRouteOwner>;
}

/** Executes one accepted operation; durable ownership stays in its controller. */
export class TeamDissolveRunner {
  constructor(private readonly opts: TeamDissolveRunnerOptions) {}

  async run(operation: TeamDissolveOperation): Promise<void> {
    const current = await this.opts.mustTeam(operation.teamId);
    if (current.dissolve?.operation_id !== operation.record.operation_id) return;
    operation.record = current.dissolve;
    if (
      current.status !== 'closed' &&
      this.suspendIfInterrupted(operation)
    ) return;
    if (operation.record.phase === 'failed' && current.status !== 'closed') {
      await this.opts.completeFailedOpenOperation(
        operation,
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
          await this.opts.deferRetry(
            operation,
            'resource-close-failed',
            error,
          );
        } else {
          await this.opts.failBeforeLogicalClose(
            operation,
            'resource-close-failed',
            error,
          );
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

    let assessment: WorktreeCleanupAssessment;
    try {
      assessment = await this.opts.assessWorktree(
        await this.opts.mustTeam(operation.teamId),
      );
    } catch (error) {
      if (this.suspendIfInterrupted(operation)) return;
      if (closeAlreadyBegan) {
        await this.opts.deferRetry(
          operation,
          'worktree-assessment-failed',
          error,
        );
      } else {
        await this.opts.failBeforeLogicalClose(
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
        await this.finishSafetyBlockedClose(operation, assessment);
      } else {
        await this.opts.failBeforeLogicalClose(
          operation,
          publicErrorForSafety(assessment.reason),
          new TeamDissolveBlockedError(assessment.reason),
        );
      }
      return;
    }

    await this.startLogicalClose(operation, assessment);
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
    operation.logical.resolve(summary);
    if (operation.record.phase === 'complete') {
      await this.opts.finish(operation);
      operation.completed.resolve(summary);
      return;
    }
    if (operation.record.phase === 'failed') {
      await this.opts.finish(operation);
      operation.completed.reject(new TeamDissolveFailedError(
        publicDissolveErrorMessage(
          operation.record.last_error ?? 'resource-close-failed',
        ),
      ));
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
    const recovered = (await this.opts.mustTeam(operation.teamId)).dissolve;
    if (recovered?.operation_id !== operation.record.operation_id) return;
    operation.record = recovered;
    if (recovered.phase === 'worktree_cleanup_pending') {
      try {
        await this.runPhysicalCleanup(operation);
      } catch (error) {
        await this.opts.deferRetry(operation, 'worktree-cleanup-failed', error);
      }
    } else if (recovered.phase === 'complete') {
      const completed = await service.status();
      await this.opts.finish(operation);
      operation.completed.resolve(completed);
    } else if (recovered.phase === 'failed') {
      await this.opts.finish(operation);
      operation.completed.reject(new TeamDissolveFailedError(
        publicDissolveErrorMessage(
          operation.record.last_error ?? 'resource-close-failed',
        ),
      ));
    }
  }

  private async startLogicalClose(
    operation: TeamDissolveOperation,
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
      const worktree: AgentEntityWorktreeIdentity = terminalWorktree ??
        (await this.opts.mustTeam(operation.teamId)).worktree;
      const logicalWorktree = terminalWorktree ?? {
        ...worktree,
        cleanup_state: 'cleanup-pending' as const,
        cleanup_error: null,
      };
      const summary = await operation.logicalClose!({
        operationId: operation.record.operation_id,
        teamId: operation.teamId,
        note: operation.record.note,
        owner: await this.opts.requireOwner(operation),
        dissolve: nextRecord,
        worktree: logicalWorktree,
      });
      operation.record = nextRecord;
      operation.logical.resolve(summary);
      if (nextRecord.phase === 'complete') {
        await this.opts.finish(operation);
        operation.completed.resolve(summary);
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
      operation.writers.map(async (writer) => writer.runtime.waitIdle!()),
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
    const team = await this.opts.mustTeam(operation.teamId);
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
      await service.completeWorktreeCleanup({
        dissolve: failed,
        worktree: { ...cleaned, cleanup_error: null },
      });
      operation.record = failed;
      await this.opts.finish(operation);
      operation.completed.reject(
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
    operation.record = complete;
    await this.opts.finish(operation);
    operation.completed.resolve(summary);
  }

  private async finishSafetyBlockedClose(
    operation: TeamDissolveOperation,
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
        operationId: operation.record.operation_id,
        teamId: operation.teamId,
        note: operation.record.note,
        owner: await this.opts.requireOwner(operation),
        dissolve: failed,
        worktree: assessment.worktree,
      });
      operation.record = failed;
      operation.logical.resolve(summary);
      await this.opts.finish(operation);
      operation.completed.reject(terminalError);
    } catch (error) {
      const latest = await this.opts.mustTeam(operation.teamId);
      if (
        latest.status === 'closed' &&
        latest.dissolve?.operation_id === operation.record.operation_id &&
        latest.dissolve.phase === 'failed'
      ) {
        operation.record = latest.dissolve;
        const summary = await (await this.opts.getService(operation.teamId)).status();
        operation.logical.resolve(summary);
        await this.opts.finish(operation);
        operation.completed.reject(terminalError);
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
