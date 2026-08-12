import type { DreamuxLogger } from '@excitedjs/dreamux-types';

import { errorInfo, errorMessage } from '../../platform/error-info.js';
import type { CompletionEnvelope } from '../completion-router/index.js';
import type {
  OwnedTeammateOps,
  OwnedTeammateOwner,
} from '../teammate-collection/owned-teammates.js';
import { WorkflowJournal } from './journal.js';
import type {
  WorkflowAgentOptions,
} from './protocol.js';
import type { Deferred } from './run-support.js';
import {
  type WorkflowShutdownTakeoverKind,
  WorkflowOwnerReleaseError,
  WorkflowRunTerminal,
} from './run-terminal.js';
import type { WorkflowRunStore } from './store.js';
import type {
  WorkflowAgentRecord,
  WorkflowRunRecord,
  WorkflowTerminalStatus,
} from './types.js';

/** One established workflow agent call: durable record plus lifecycle gates. */
export interface AgentCall {
  record: WorkflowAgentRecord;
  options: WorkflowAgentOptions;
  submissionReady: Deferred<void>;
  settled: Deferred<void>;
  completed: boolean;
}

export interface WorkflowRunFinalizerDeps {
  record: WorkflowRunRecord;
  journal: WorkflowJournal;
  store: WorkflowRunStore;
  ownedTeammates: Pick<OwnedTeammateOps, 'releaseAllOwned'>;
  owner: OwnedTeammateOwner;
  stopRunner: () => Promise<void>;
  terminal: WorkflowRunTerminal;
  calls: Map<number, AgentCall>;
  runnerMessageTasks: Set<Promise<void>>;
  agentTasks: Set<Promise<void>>;
  mutationTail: () => Promise<void>;
  mutate: <T>(task: () => Promise<T>) => Promise<T>;
  now: () => number;
  settleTerminal: (completion: CompletionEnvelope) => Promise<void>;
  discardTerminal: () => void;
  /**
   * Evict the live entity, reporting the shutdown takeover kind, if any, and
   * the detached terminal-routing settle (non-null exactly for
   * `routing-detached` takeovers) whose guaranteed terminal resolution
   * proves the routing barrier.
   */
  evict: (
    takeover: WorkflowShutdownTakeoverKind | null,
    detachedSettle: Promise<void> | null,
  ) => void;
  log: DreamuxLogger;
}

/**
 * The one shared terminal finalization flow (issue #328): runner stop, the
 * publication cutoff, the deadline-bounded natural-settle grace, the owner
 * release prerequisite, the synchronous stopped claim, and the durable
 * terminal commit. Owner release failure rejects the whole attempt
 * pre-terminal so no false terminal fact is ever persisted.
 */
export class WorkflowRunFinalizer {
  constructor(private readonly deps: WorkflowRunFinalizerDeps) {}

  async finalize(
    requestedStatus: WorkflowTerminalStatus,
    result: unknown,
    requestedError: string | null,
  ): Promise<void> {
    let status = requestedStatus;
    let error = requestedError;
    const cleanupErrors: unknown[] = [];
    await this.deps.stopRunner().catch((runnerError: unknown) => {
      cleanupErrors.push(runnerError);
    });
    while (this.deps.runnerMessageTasks.size > 0) {
      await Promise.allSettled([...this.deps.runnerMessageTasks]);
    }

    // Publication cutoff: every established call must have passed its spawn
    // boundary (`submissionReady`) or settled/completed before the owner set
    // is snapshotted, so an in-flight `spawnOwned` cannot publish a new owned
    // TeamMate after release. This is outside the natural-settle grace budget;
    // shutdown may interrupt it.
    if (
      !(await this.deps.terminal.waitUnlessShutdown(
        this.waitForPublicationCutoff(),
      ))
    ) {
      await this.finishInterrupted(status, result, error, cleanupErrors);
      return;
    }

    // Submitted calls may settle naturally only for the deadline's remaining
    // time; a natural attempt without a stop intent keeps the unbounded drain.
    if (!(await this.waitForGrace())) {
      await this.finishInterrupted(status, result, error, cleanupErrors);
      return;
    }

    if (this.deps.terminal.shutdownRequested) {
      await this.finishInterrupted(status, result, error, cleanupErrors);
      return;
    }

    // Owner release is the truthful terminal prerequisite for every normal
    // terminal status, including natural completed/failed. A failure rejects
    // the whole attempt pre-terminal: no `end`, terminal record, delivery, or
    // eviction; the run stays process-live with durable `running` status and
    // closed admission, retryable against the original deadline.
    await this.deps.ownedTeammates
      .releaseAllOwned(this.deps.owner)
      .catch((releaseError: unknown) => {
        throw new WorkflowOwnerReleaseError(errorMessage(releaseError));
      });

    if (this.deps.terminal.shutdownRequested) {
      await this.finishInterrupted(status, result, error, cleanupErrors);
      return;
    }

    // Immediately after successful release, without an intervening await,
    // claim every still-incomplete call as stopped; late callbacks lose to
    // the existing completed-call guard. Persist ordinary result events and
    // drain whatever the claims unblocked.
    await this.claimIncompleteCalls(this.deps.now());
    await this.deps.mutationTail();
    await this.drainAgentTasks();

    await this.commitTerminal(status, result, error, cleanupErrors);
  }

  /**
   * Wait until every established call has passed its spawn boundary or
   * settled, so an in-flight `spawnOwned` cannot publish a new owned TeamMate
   * after the release snapshot. A queued call resolves through its admission
   * rejection (never spawns); a mid-spawn call resolves when the spawn
   * returns, published or not.
   */
  private async waitForPublicationCutoff(): Promise<void> {
    const waits: Promise<unknown>[] = [];
    for (const call of this.deps.calls.values()) {
      if (call.completed) continue;
      waits.push(Promise.race([
        call.submissionReady.promise,
        call.settled.promise,
      ]));
    }
    await Promise.all(waits);
  }

  /**
   * Await agent-task drain bounded by the first stop intent's immutable
   * deadline (when one exists). A natural attempt that began before any stop
   * intent adopts the deadline if a stop joins while the drain is in
   * progress. Returns false when shutdown interrupted the wait.
   */
  private async waitForGrace(): Promise<boolean> {
    const drained = this.drainAgentTasks().then(() => true);
    const graceExpiry = this.deps.terminal.stopDeadlineSignal.then(async () => {
      const deadline = this.deps.terminal.stopDeadline;
      if (deadline === null) return true;
      const remaining = deadline - this.deps.now();
      if (remaining <= 0) return true;
      await sleep(remaining);
      return true;
    });
    const outcome = await this.deps.terminal.waitUnlessShutdown(
      Promise.race([drained, graceExpiry]),
    );
    return outcome ?? false;
  }

  /**
   * Shutdown takeover: freeze unresolved calls, persist the terminal record,
   * and leave a per-run release that has not begun to the collection-wide
   * sweep. A release already in progress is joined before this point.
   */
  private async finishInterrupted(
    status: WorkflowTerminalStatus,
    result: unknown,
    error: string | null,
    cleanupErrors: unknown[],
  ): Promise<void> {
    this.freezeAgentCalls(this.deps.now());
    await this.deps.mutationTail();
    this.deps.terminal.markShutdownTakeover('frozen');
    await this.commitTerminal(status, result, error, cleanupErrors);
  }

  /**
   * Claim every still-incomplete call as `stopped` and persist one ordinary
   * `result` journal event per claimed call before any other await. The
   * synchronous completed flag wins the race against late settle callbacks.
   */
  private async claimIncompleteCalls(settledAt: number): Promise<void> {
    const claimed: AgentCall[] = [];
    for (const call of this.deps.calls.values()) {
      if (call.completed) continue;
      call.completed = true;
      call.record.status = 'stopped';
      call.record.settled_at = settledAt;
      claimed.push(call);
    }
    if (claimed.length === 0) return;
    this.deps.record.updated_at = settledAt;
    try {
      await this.deps.mutate(async () => {
        for (const call of claimed) {
          await this.deps.journal.append({
            kind: 'result',
            index: call.record.index,
            status: 'stopped',
            settled_at: call.record.settled_at ?? settledAt,
          });
        }
        await this.deps.store.write(this.deps.record);
      });
    } finally {
      for (const call of claimed) {
        call.submissionReady.resolve();
        call.settled.resolve();
      }
    }
  }

  /** Shared terminal commit: end journal, durable record, routing, eviction. */
  private async commitTerminal(
    status: WorkflowTerminalStatus,
    result: unknown,
    error: string | null,
    cleanupErrors: unknown[],
  ): Promise<void> {
    const record = this.deps.record;
    if (cleanupErrors.length > 0) {
      this.deps.log.warn(
        {
          run_id: record.run_id,
          errors: cleanupErrors.map(errorInfo),
        },
        'workflow terminal cleanup had failures',
      );
      error ??= cleanupErrors.map(errorMessage).join('; ');
    }

    const endedAt = this.deps.now();
    record.status = status;
    record.result = status === 'completed' ? result : null;
    record.error = error;
    record.ended_at = endedAt;
    record.updated_at = endedAt;
    try {
      await this.deps.journal.append({
        kind: 'end',
        status,
        ended_at: endedAt,
      });
    } catch (journalError) {
      status = 'failed';
      error = `workflow journal append failed: ${errorMessage(journalError)}`;
      record.status = status;
      record.result = null;
      record.error = error;
    }
    await this.deps.store.write(record);

    const completionResult = JSON.stringify(
      {
        run_id: record.run_id,
        status,
        result: record.result,
        error: record.error,
        agents: record.agents
          .filter((agent) => agent.name !== null)
          .map((agent) => ({ index: agent.index, name: agent.name })),
      },
      null,
      2,
    );
    let detachedSettle: Promise<void> | null = null;
    try {
      if (this.deps.terminal.shutdownRequested) {
        // Shutdown discarded terminal routing before it began; the owner
        // sweep resolves this takeover kind.
        this.deps.terminal.markShutdownTakeover('frozen');
        this.deps.discardTerminal();
      } else {
        const settleTask = this.deps.settleTerminal({
          kind: 'workflow',
          source: 'workflow',
          id: record.run_id,
          status,
          result: completionResult,
        });
        if (!(await this.deps.terminal.waitUnlessShutdown(settleTask))) {
          // Terminal routing had already started and is now detached. The
          // owner sweep cannot prove it, so the takeover starts as
          // 'routing-detached'; the router contract guarantees settle()
          // always resolves with a terminal outcome
          // (accepted/unsupported/dropped/thrown/exhausted), so the handoff
          // below clears the tombstone once the detached settle resolves.
          this.deps.terminal.markShutdownTakeover('routing-detached');
          detachedSettle = settleTask;
          void settleTask.catch((settleError: unknown) => {
            this.deps.log.error(
              { run_id: record.run_id, err: errorInfo(settleError) },
              'workflow terminal delivery failed during shutdown',
            );
          });
        }
      }
    } finally {
      this.deps.log.info(
        {
          run_id: record.run_id,
          status,
          agent_count: record.agents.length,
          err: error === null ? undefined : { message: error },
        },
        'workflow run terminal',
      );
      this.deps.evict(this.deps.terminal.takeoverKind, detachedSettle);
    }
  }

  private async drainAgentTasks(): Promise<void> {
    while (this.deps.agentTasks.size > 0) {
      await Promise.allSettled([...this.deps.agentTasks]);
    }
  }

  private freezeAgentCalls(settledAt: number): void {
    for (const call of this.deps.calls.values()) {
      if (call.completed) continue;
      call.completed = true;
      call.record.status = 'stopped';
      call.record.settled_at = settledAt;
      call.submissionReady.resolve();
      call.settled.resolve();
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
