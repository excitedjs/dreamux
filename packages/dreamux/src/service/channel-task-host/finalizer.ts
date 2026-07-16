import type { DreamuxLogger } from '@excitedjs/dreamux-types';

import type { ChannelService } from '../channel-service/index.js';
import type { TeamCollection } from '../team-collection/index.js';
import {
  cleanupEvent,
  taskChannelTarget,
  taskTeamProvisionInput,
} from './provisioning.js';
import type { TaskHostStore } from './store.js';
import {
  leaderResource,
  memberResources,
  resourceEvent,
  teamResource,
  worktreeResource,
} from './resources.js';

const RETRY_ERROR_CODE = 'TASK_FINALIZER_RETRY_REQUIRED';

export class TaskTargetFinalizer {
  private readonly inFlight = new Map<string, Promise<void>>();
  private readonly retryTimers = new Map<
    string,
    ReturnType<typeof setTimeout>
  >();
  private readonly retryAttempts = new Map<string, number>();
  private stopped = false;

  constructor(private readonly opts: {
    store: TaskHostStore;
    channels: ChannelService;
    teams: TeamCollection;
    log: DreamuxLogger;
    runExclusive: <T>(targetId: string, task: () => Promise<T>) => Promise<T>;
    retryDelayMs?: (attempt: number) => number;
    onRecovered?: () => Promise<void>;
  }) {}

  resume(): void {
    this.stopped = false;
  }

  stop(): void {
    this.stopped = true;
    for (const timer of this.retryTimers.values()) clearTimeout(timer);
    this.retryTimers.clear();
  }

  start(targetId: string): void {
    if (this.stopped || this.inFlight.has(targetId)) return;
    this.clearRetryTimer(targetId);
    const task = this.opts.runExclusive(targetId, () => this.finalize(targetId));
    const tracked = task.finally(() => {
      if (this.inFlight.get(targetId) === tracked) {
        this.inFlight.delete(targetId);
      }
    });
    this.inFlight.set(targetId, tracked);
    void tracked.then(
      () => this.retryAttempts.delete(targetId),
      (error) => {
        this.opts.log.error(
          { target_id: targetId, err: errorInfo(error) },
          'task target finalizer failed',
        );
        this.scheduleRetry(targetId);
      },
    );
  }

  async run(targetId: string): Promise<void> {
    this.clearRetryTimer(targetId);
    this.start(targetId);
    const current = this.inFlight.get(targetId);
    if (current !== undefined) await current;
  }

  /** Wait only for attempts already executing; deferred retries resume on restart. */
  async drain(): Promise<void> {
    while (this.inFlight.size > 0) {
      await Promise.allSettled([...this.inFlight.values()]);
    }
  }

  private async finalize(targetId: string): Promise<void> {
    let record = this.opts.store.get(targetId);
    if (record === null || record.terminal === null || record.phase === 'finalized') {
      return;
    }
    if (
      record.terminal.outcome !== 'cancelled' &&
      !record.submission_view.quiescent
    ) {
      return;
    }
    if (record.phase === 'terminal') {
      record = await this.opts.store.updateTarget(
        targetId,
        record.revision,
        (next) => {
          next.phase = 'finalizing';
          next.finalizer = {
            step: 'pending',
            attempts: (next.finalizer?.attempts ?? 0) + 1,
            last_error_code: null,
          };
        },
        (next) => [
          { payload: { kind: 'task.lifecycle', phase: 'finalizing' } },
          { payload: { kind: 'cleanup.lifecycle', status: 'started' } },
          resourceEvent(teamResource(next, 'closing')),
          resourceEvent(leaderResource(next, 'closing')),
          ...memberResources(next, 'closing').map(resourceEvent),
          resourceEvent(worktreeResource(next, 'cleaning')),
        ],
      );
    }

    try {
      if (record.finalizer?.step === 'pending') {
        await this.opts.channels.releaseResolvedTargetIfClaimed({
          claimId: record.team.route_claim_id,
          channelId: record.channel_id,
          target: taskChannelTarget(record),
        });
        record = await this.opts.store.updateTarget(
          targetId,
          null,
          (next) => {
            if (next.finalizer !== null) {
              next.finalizer.step = 'route_released';
              next.finalizer.last_error_code = null;
            }
          },
          [{ payload: { kind: 'task.lifecycle', phase: 'finalizing' } }],
        );
      }

      if (record.finalizer?.step === 'route_released') {
        const cleanup = record.binding === null
          ? { status: 'deleted' as const }
          : cleanupEvent((await this.opts.teams.finalizeTaskProvisioning(
              taskTeamProvisionInput(record),
            )).cleanup.cleanup_state);
        record = await this.opts.store.updateTarget(
          targetId,
          null,
          (next) => {
            if (next.finalizer !== null) {
              next.finalizer.step = 'team_closed';
              next.finalizer.last_error_code = null;
              next.finalizer.cleanup_status = cleanup.status;
              if (cleanup.reason !== undefined) {
                next.finalizer.cleanup_reason = cleanup.reason;
              } else {
                delete next.finalizer.cleanup_reason;
              }
            }
          },
          (next) => [
            resourceEvent(teamResource(next, 'closed')),
            resourceEvent(leaderResource(next, 'closed')),
            ...memberResources(next, 'closed').map(resourceEvent),
            resourceEvent(worktreeResource(next, cleanup.status, cleanup.reason)),
            {
              payload: {
                kind: 'cleanup.lifecycle' as const,
                status: 'completed' as const,
              },
            },
          ],
        );
      }

      if (record.finalizer?.step === 'team_closed') {
        await this.opts.store.updateTarget(
          targetId,
          null,
          (next) => {
            next.phase = 'finalized';
            if (next.finalizer !== null) {
              next.finalizer.step = 'completed';
              next.finalizer.last_error_code = null;
            }
          },
          [{ payload: { kind: 'task.lifecycle', phase: 'finalized' } }],
        );
      }
      await this.restoreHostStatus();
      await this.opts.onRecovered?.();
    } catch (error) {
      await this.recordFailure(targetId);
      throw error;
    }
  }

  private async recordFailure(targetId: string): Promise<void> {
    const latest = this.opts.store.get(targetId);
    if (
      latest === null ||
      latest.phase === 'finalized' ||
      latest.finalizer?.last_error_code === RETRY_ERROR_CODE
    ) {
      return;
    }
    await this.opts.store.updateTarget(
      targetId,
      null,
      (next) => {
        next.phase = 'finalizing';
        next.finalizer = {
          step: next.finalizer?.step ?? 'pending',
          attempts: (next.finalizer?.attempts ?? 0) + 1,
          last_error_code: RETRY_ERROR_CODE,
          ...(next.finalizer?.cleanup_status !== undefined
            ? { cleanup_status: next.finalizer.cleanup_status }
            : {}),
          ...(next.finalizer?.cleanup_reason !== undefined
            ? { cleanup_reason: next.finalizer.cleanup_reason }
            : {}),
        };
      },
      [{
        payload: {
          kind: 'host.lifecycle',
          status: 'degraded',
          code: RETRY_ERROR_CODE,
        },
      }, {
        payload: {
          kind: 'task.lifecycle',
          phase: 'finalizing',
          blocked_code: RETRY_ERROR_CODE,
          retryable: true,
        },
      }],
    );
  }

  private async restoreHostStatus(): Promise<void> {
    if (this.opts.store.hostStatusCode !== RETRY_ERROR_CODE) return;
    const hasPendingFailure = this.opts.store.list().some(
      (target) => target.finalizer?.last_error_code === RETRY_ERROR_CODE,
    );
    if (!hasPendingFailure) await this.opts.store.appendHostStatus('ready');
  }

  private scheduleRetry(targetId: string): void {
    if (this.stopped || this.retryTimers.has(targetId)) return;
    const attempt = (this.retryAttempts.get(targetId) ?? 0) + 1;
    this.retryAttempts.set(targetId, attempt);
    const delay = this.opts.retryDelayMs?.(attempt) ??
      Math.min(30_000, 1_000 * (2 ** Math.min(attempt - 1, 5)));
    const timer = setTimeout(() => {
      this.retryTimers.delete(targetId);
      this.start(targetId);
    }, delay);
    timer.unref?.();
    this.retryTimers.set(targetId, timer);
  }

  private clearRetryTimer(targetId: string): void {
    const timer = this.retryTimers.get(targetId);
    if (timer !== undefined) clearTimeout(timer);
    this.retryTimers.delete(targetId);
  }
}

function errorInfo(error: unknown): Record<string, unknown> {
  return error instanceof Error
    ? { type: error.name, message: error.message }
    : { value: String(error) };
}
