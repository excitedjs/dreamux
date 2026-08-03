import { randomUUID } from 'node:crypto';

import type { DreamuxLogger } from '@excitedjs/dreamux-types';

import { requireLifecycleText } from '../agent-entity/types.js';
import type { ChannelRouteOwner } from '../channel-service/index.js';
import type { KeyedAsyncQueue } from '../serial-queue.js';
import type { TeamLiveWriter, TeamService } from '../team-service/index.js';
import type {
  WorktreeCleanupAssessment,
  WorktreeManager,
} from '../worktree/manager.js';
import {
  TeamDissolveBlockedError,
  TeamDissolveFailedError,
  TeamDissolveInterruptedError,
  TeamUnavailableError,
  teamErrorInfo,
} from './errors.js';
import {
  TEAM_DISSOLVE_RESULT_BUDGET_MS,
  isActiveDissolve,
  newDissolveOperation,
  projectDispatcherDissolveResult,
  retryDelayMs,
  type TeamDissolveOperation,
} from './dissolve-lifecycle.js';
import {
  publicDissolveErrorMessage,
  TeamDissolveRunner,
} from './dissolve-runner.js';
import type { TeamStore } from './store.js';
import type {
  AcceptedTeamDissolve,
  TeamDissolveCleanupPendingResult,
  TeamDissolvePublicError,
  TeamDissolveRecord,
  TeamDissolveRequest,
  TeamLogicalCloseExecutor,
  TeamRecord,
  TeamSummary,
} from './types.js';
import { validateTeamId } from './types.js';

interface TeamDissolveControllerOptions {
  dispatcherId: string;
  store: TeamStore;
  worktrees: WorktreeManager;
  routeLifecycle: KeyedAsyncQueue;
  log: DreamuxLogger;
  isShuttingDown(): boolean;
  trackAcceptedOperation?<T>(task: () => Promise<T>): Promise<T>;
  mustTeam(teamId: string): Promise<TeamRecord>;
  getService(teamId: string): Promise<TeamService>;
  activateClosing(record: TeamRecord, service: TeamService): ChannelRouteOwner;
  endClosing(teamId: string, reopen: boolean): Promise<void>;
  replaceCachedRecord(teamId: string, record: TeamRecord): void;
  assertNewCloseAvailable(teamId: string): void;
}

/** The one durable dissolve state-machine capability owned by TeamCollection. */
export class TeamDissolveController {
  private readonly operations = new Map<string, TeamDissolveOperation>();
  private readonly runner: TeamDissolveRunner;

  constructor(private readonly opts: TeamDissolveControllerOptions) {
    this.runner = new TeamDissolveRunner({
      worktrees: opts.worktrees,
      mustTeam: (teamId) => opts.mustTeam(teamId),
      getService: (teamId) => opts.getService(teamId),
      assessWorktree: (record) => this.assessWorktree(record),
      persistDissolve: (operation, patch) =>
        this.persistDissolve(operation, patch),
      deferRetry: (operation, publicError, cause) =>
        this.deferRetry(operation, publicError, cause),
      scheduleRetry: (operation) => this.scheduleRetry(operation),
      failBeforeLogicalClose: (operation, publicError, cause) =>
        this.failBeforeLogicalClose(operation, publicError, cause),
      completeFailedOpenOperation: (operation, error) =>
        this.completeFailedOpenOperation(operation, error),
      finish: (operation) => this.finish(operation),
      suspend: (operation) => this.suspend(operation),
      requireOwner: (operation) => this.requireOwner(operation),
    });
  }

  /** Persist and fence before returning one idempotent accepted handle. */
  async accept(request: TeamDissolveRequest): Promise<AcceptedTeamDissolve> {
    const teamId = validateTeamId(request.teamId);
    const note = requireLifecycleText(request.note, 'Team dissolve note');
    const accept = () => this.acceptUnderLock(teamId, note, request);
    return request.decisionDeadlineAt === undefined
      ? this.opts.routeLifecycle.run(teamId, accept)
      : this.opts.routeLifecycle.runBefore(
          teamId,
          request.decisionDeadlineAt,
          accept,
          () => new TeamDissolveFailedError(
            'Team dissolve decision deadline exceeded before acceptance',
          ),
        );
  }

  private async acceptUnderLock(
    teamId: string,
    note: string,
    request: TeamDissolveRequest,
  ): Promise<AcceptedTeamDissolve> {
    const current = await this.opts.mustTeam(teamId);
    this.validateRequester(current, request);
    const priorOperationId = current.dissolve?.operation_id ?? null;
    let active = current.dissolve;
    if (active !== null && isActiveDissolve(active)) {
      const service = await this.opts.getService(teamId);
      if (
        request.requester.kind === 'collaboration_target' &&
        !active.target_handoff_ids.includes(request.requester.handoffId)
      ) {
        const joined = await this.opts.store.update(current, {
          appendTargetHandoffId: request.requester.handoffId,
          expectedDissolveOperationId: active.operation_id,
        });
        service.replaceRecord(joined);
        active = joined.dissolve!;
      }
      const operation = this.operationFor(
        teamId,
        active,
        service.liveWriters(),
      );
      this.opts.activateClosing(current, service);
      return operation.handle;
    }
    this.opts.assertNewCloseAvailable(teamId);
    if (current.status === 'closed') {
      throw new TeamUnavailableError(
        `Team ${JSON.stringify(teamId)} is closed`,
      );
    }
    const service = await this.opts.getService(teamId);
    const writers = service.liveWriters();
    this.requireIdleCapability(writers);
    const assessment = await this.assessWorktree(
      current,
      request.decisionDeadlineAt,
    ).catch((error) => {
      this.opts.log.warn(
        {
          dispatcher_id: this.opts.dispatcherId,
          team_id: teamId,
          err: teamErrorInfo(error),
        },
        'Team dissolve worktree preflight failed before acceptance',
      );
      throw new TeamDissolveFailedError('Team worktree assessment failed');
    });
    if (assessment.status === 'blocked') {
      throw new TeamDissolveBlockedError(assessment.reason);
    }
    if (
      request.decisionDeadlineAt !== undefined &&
      Date.now() >= request.decisionDeadlineAt
    ) {
      throw new TeamDissolveFailedError(
        'Team dissolve decision deadline exceeded before acceptance',
      );
    }
    const accepted: TeamDissolveRecord = {
      operation_id: randomUUID(),
      requester_kind: request.requester.kind,
      leader_name: request.requester.kind === 'team_leader'
        ? request.requester.leaderName
        : null,
      target_handoff_ids: request.requester.kind === 'collaboration_target'
        ? [request.requester.handoffId]
        : [],
      note,
      accepted_at: Date.now(),
      phase: 'waiting_for_team_idle',
      last_error: null,
      cleanup_attempts: 0,
      next_retry_at: null,
    };
    const saved = await this.opts.store.update(current, {
      dissolve: accepted,
      expectedDissolveOperationId: priorOperationId,
    });
    service.replaceRecord(saved);
    const operation = this.operationFor(teamId, accepted, writers);
    this.opts.activateClosing(saved, service);
    this.opts.log.info(
      {
        dispatcher_id: this.opts.dispatcherId,
        team_id: teamId,
        operation_id: accepted.operation_id,
        requester_kind: accepted.requester_kind,
        phase: accepted.phase,
      },
      'Team dissolve accepted',
    );
    return operation.handle;
  }

  start(
    handle: AcceptedTeamDissolve,
    logicalClose: TeamLogicalCloseExecutor,
  ): void {
    const operation = this.operations.get(handle.operationId);
    // A joined caller may publish start after the existing runner reached a
    // terminal result or shutdown suspension and removed its local operation.
    // The shared handle is already settled and restart owns any durable resume.
    if (operation === undefined) return;
    if (operation.teamId !== handle.teamId) {
      throw new Error('accepted Team dissolve handle is no longer current');
    }
    operation.logicalClose ??= logicalClose;
    this.launch(operation);
  }

  /** Restore durable gates and lifecycle work before ordinary Team work. */
  async recover(logicalClose: TeamLogicalCloseExecutor): Promise<void> {
    const toStart: TeamDissolveOperation[] = [];
    for (const record of await this.opts.store.list(this.opts.dispatcherId)) {
      if (!isActiveDissolve(record.dissolve)) continue;
      await this.opts.routeLifecycle.run(record.team_id, async () => {
        const current = await this.opts.mustTeam(record.team_id);
        const active = current.dissolve;
        if (active === null || !isActiveDissolve(active)) return;
        const service = await this.opts.getService(current.team_id);
        this.opts.activateClosing(current, service);
        const writers = current.status === 'closed'
          ? service.liveWriters()
          : await service.recoverLiveWritersForDissolve();
        this.requireIdleCapability(writers);
        const operation = this.operationFor(
          current.team_id,
          active,
          writers,
        );
        operation.needsRecoveryIdle = current.status !== 'closed';
        operation.logicalClose ??= logicalClose;
        toStart.push(operation);
      });
    }
    for (const operation of toStart) this.launch(operation);
  }

  /** Interrupt cancellable waits/timers before dispatcher admitted-task drain. */
  interruptForShutdown(): void {
    for (const operation of [...this.operations.values()]) {
      operation.interrupt.interrupt();
      if (operation.retryTimer !== null) {
        clearTimeout(operation.retryTimer);
        operation.retryTimer = null;
        this.suspend(operation);
      }
    }
  }

  /** Project bounded Dispatcher timing without cancelling durable work. */
  async dispatcherResult(
    handle: AcceptedTeamDissolve,
    budgetMs: number = TEAM_DISSOLVE_RESULT_BUDGET_MS,
  ): Promise<
    TeamSummary |
    AcceptedTeamDissolve['receipt'] |
    TeamDissolveCleanupPendingResult
  > {
    return projectDispatcherDissolveResult(handle, budgetMs);
  }

  private validateRequester(
    team: TeamRecord,
    request: TeamDissolveRequest,
  ): void {
    if (
      request.requester.kind !== 'dispatcher' &&
      request.requester.leaderName !== null &&
      request.requester.leaderName !== team.leader_name
    ) {
      throw new TeamUnavailableError(
        `Team ${JSON.stringify(team.team_id)} generation is no longer current`,
      );
    }
  }

  private operationFor(
    teamId: string,
    record: TeamDissolveRecord,
    writers: TeamLiveWriter[],
  ): TeamDissolveOperation {
    const existing = this.operations.get(record.operation_id);
    if (existing !== undefined) {
      if (existing.teamId !== teamId) {
        throw new Error('Team dissolve operation belongs to another Team');
      }
      existing.record = record;
      return existing;
    }
    this.requireIdleCapability(writers);
    const operation = newDissolveOperation({
      teamId: validateTeamId(teamId),
      record,
      writers,
    });
    this.operations.set(record.operation_id, operation);
    return operation;
  }

  private requireIdleCapability(writers: TeamLiveWriter[]): void {
    const missing = writers.find(
      (writer) => writer.runtime.waitIdle === undefined,
    );
    if (missing !== undefined) {
      throw new TeamDissolveFailedError(
        `Live Team writer ${JSON.stringify(missing.name)} does not support waitIdle`,
      );
    }
  }

  private assessWorktree(
    record: TeamRecord,
    deadlineAt?: number,
  ): Promise<WorktreeCleanupAssessment> {
    return this.opts.worktrees.assessCleanup({
      source_cwd: record.repo_cwd,
      source_repo: record.source_repo,
      worktree: record.worktree,
    }, deadlineAt === undefined ? {} : { deadlineAt });
  }

  private launch(operation: TeamDissolveOperation): void {
    if (this.operations.get(operation.record.operation_id) !== operation) return;
    if (operation.runner !== null || operation.retryTimer !== null) return;
    if (this.opts.isShuttingDown()) {
      this.suspend(operation);
      return;
    }
    if (operation.logicalClose === null) {
      throw new Error('Team dissolve logical-close executor is unavailable');
    }
    const track = this.opts.trackAcceptedOperation ??
      (<T>(task: () => Promise<T>) => Promise.resolve().then(task));
    const running = track(() => this.runner.run(operation));
    operation.runner = running;
    void running
      .catch(async (error: unknown) => {
        if (
          error instanceof TeamDissolveInterruptedError ||
          this.opts.isShuttingDown()
        ) {
          this.suspend(operation);
          return;
        }
        this.opts.log.error(
          {
            dispatcher_id: this.opts.dispatcherId,
            team_id: operation.teamId,
            operation_id: operation.record.operation_id,
            phase: operation.record.phase,
            err: teamErrorInfo(error),
          },
          'Team dissolve runner failed',
        );
        await this.reloadUnexpectedFailure(operation);
      })
      .catch((error: unknown) => {
        this.opts.log.error(
          {
            dispatcher_id: this.opts.dispatcherId,
            team_id: operation.teamId,
            operation_id: operation.record.operation_id,
            phase: operation.record.phase,
            err: teamErrorInfo(error),
          },
          'Team dissolve runner recovery failed; retry remains owner-managed',
        );
        this.scheduleInMemoryRetry(operation);
      })
      .finally(() => {
        if (operation.runner === running) operation.runner = null;
      });
  }

  /** Reload authority, then let the runner remain the sole phase interpreter. */
  private async reloadUnexpectedFailure(
    operation: TeamDissolveOperation,
  ): Promise<void> {
    const current = await this.opts.mustTeam(operation.teamId);
    if (current.dissolve?.operation_id !== operation.record.operation_id) {
      const error = new TeamDissolveFailedError('Team dissolve operation changed');
      operation.logical.reject(error);
      operation.completed.reject(error);
      this.operations.delete(operation.record.operation_id);
      return;
    }
    operation.record = current.dissolve;
    this.scheduleInMemoryRetry(operation);
  }

  private async persistDissolve(
    operation: TeamDissolveOperation,
    patch: Partial<Pick<
      TeamDissolveRecord,
      'phase' | 'last_error' | 'cleanup_attempts' | 'next_retry_at'
    >>,
  ): Promise<TeamRecord> {
    const current = await this.opts.mustTeam(operation.teamId);
    if (current.dissolve?.operation_id !== operation.record.operation_id) {
      throw new TeamDissolveFailedError('Team dissolve operation changed');
    }
    const saved = await this.opts.store.update(current, {
      dissolvePatch: patch,
      expectedDissolveOperationId: operation.record.operation_id,
    });
    const dissolve = saved.dissolve!;
    this.opts.replaceCachedRecord(operation.teamId, saved);
    operation.record = dissolve;
    if (patch.phase !== undefined && patch.phase !== current.dissolve.phase) {
      this.opts.log.info(
        {
          dispatcher_id: this.opts.dispatcherId,
          team_id: operation.teamId,
          operation_id: operation.record.operation_id,
          phase: patch.phase,
          attempt: dissolve.cleanup_attempts,
          next_retry_at: dissolve.next_retry_at,
        },
        'Team dissolve phase advanced',
      );
    }
    return saved;
  }

  private async failBeforeLogicalClose(
    operation: TeamDissolveOperation,
    publicError: TeamDissolvePublicError,
    cause: unknown,
  ): Promise<void> {
    await this.persistDissolve(operation, {
      phase: 'failed',
      last_error: publicError,
      next_retry_at: null,
    });
    const error = cause instanceof TeamDissolveBlockedError
      ? cause
      : new TeamDissolveFailedError(publicDissolveErrorMessage(publicError));
    await this.completeFailedOpenOperation(operation, error);
    this.opts.log.warn(
      {
        dispatcher_id: this.opts.dispatcherId,
        team_id: operation.teamId,
        operation_id: operation.record.operation_id,
        phase: operation.record.phase,
        error: publicError,
        err: teamErrorInfo(cause),
      },
      'Team dissolve failed before logical close; admission restored',
    );
  }

  private async completeFailedOpenOperation(
    operation: TeamDissolveOperation,
    error: TeamDissolveFailedError | TeamDissolveBlockedError,
  ): Promise<void> {
    await this.opts.endClosing(operation.teamId, true);
    operation.logical.reject(error);
    operation.completed.reject(error);
    this.operations.delete(operation.record.operation_id);
  }

  private async deferRetry(
    operation: TeamDissolveOperation,
    publicError: TeamDissolvePublicError,
    cause: unknown,
  ): Promise<void> {
    const current = await this.opts.mustTeam(operation.teamId);
    if (current.dissolve?.operation_id !== operation.record.operation_id) {
      throw new TeamDissolveFailedError('Team dissolve operation changed');
    }
    operation.record = current.dissolve;
    if (!isActiveDissolve(operation.record)) {
      throw new TeamDissolveFailedError(
        'terminal Team dissolve cannot be deferred',
      );
    }
    const attempts = operation.record.cleanup_attempts + 1;
    const nextRetryAt = Date.now() + retryDelayMs(attempts);
    await this.persistDissolve(operation, {
      last_error: publicError,
      cleanup_attempts: attempts,
      next_retry_at: nextRetryAt,
    });
    this.opts.log.warn(
      {
        dispatcher_id: this.opts.dispatcherId,
        team_id: operation.teamId,
        operation_id: operation.record.operation_id,
        phase: operation.record.phase,
        attempt: attempts,
        error: publicError,
        err: teamErrorInfo(cause),
      },
      'Team dissolve phase deferred for background retry',
    );
    this.scheduleRetry(operation);
  }

  private scheduleRetry(operation: TeamDissolveOperation): void {
    if (this.opts.isShuttingDown()) {
      this.suspend(operation);
      return;
    }
    if (operation.retryTimer !== null) clearTimeout(operation.retryTimer);
    const delay = Math.max(
      0,
      (operation.record.next_retry_at ?? Date.now()) - Date.now(),
    );
    operation.retryTimer = setTimeout(() => {
      operation.retryTimer = null;
      this.launch(operation);
    }, delay);
    operation.retryTimer.unref();
  }

  private scheduleInMemoryRetry(operation: TeamDissolveOperation): void {
    if (
      this.opts.isShuttingDown() ||
      this.operations.get(operation.record.operation_id) !== operation
    ) {
      this.suspend(operation);
      return;
    }
    operation.record = {
      ...operation.record,
      next_retry_at: Date.now() + retryDelayMs(
        operation.record.cleanup_attempts + 1,
      ),
    };
    this.scheduleRetry(operation);
  }

  private suspend(operation: TeamDissolveOperation): void {
    if (operation.retryTimer !== null) {
      clearTimeout(operation.retryTimer);
      operation.retryTimer = null;
    }
    const error = new TeamDissolveInterruptedError();
    operation.logical.reject(error);
    operation.completed.reject(error);
    this.operations.delete(operation.record.operation_id);
  }

  private async finish(operation: TeamDissolveOperation): Promise<void> {
    await this.opts.endClosing(operation.teamId, false);
    this.operations.delete(operation.record.operation_id);
    this.opts.log.info(
      {
        dispatcher_id: this.opts.dispatcherId,
        team_id: operation.teamId,
        operation_id: operation.record.operation_id,
        phase: operation.record.phase,
        cleanup_attempts: operation.record.cleanup_attempts,
      },
      'Team dissolve reached a terminal state',
    );
  }

  private async requireOwner(
    operation: TeamDissolveOperation,
  ): Promise<ChannelRouteOwner> {
    const team = await this.opts.mustTeam(operation.teamId);
    if (team.dissolve?.operation_id !== operation.record.operation_id) {
      throw new TeamDissolveFailedError('Team dissolve operation changed');
    }
    return {
      kind: 'team',
      teamName: team.team_id,
      leaderName: team.leader_name,
    };
  }
}
