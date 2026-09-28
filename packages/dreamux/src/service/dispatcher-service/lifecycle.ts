import type { DreamuxLogger } from '@excitedjs/dreamux-types';

import { errorInfo } from '@excitedjs/dreamux-utils';
import type { ConfigReader } from '../../config/service.js';
import { ServerShuttingDownError } from '../../platform/errors.js';
import { InFlightWork } from '../../platform/in-flight-work.js';
import {
  collectShutdownFailure,
  throwShutdownFailures,
} from '../../platform/shutdown-errors.js';
import type { DispatcherStore } from '../../state/dispatcher-store.js';
import type { ChannelService } from '../channel-service/index.js';
import { ensureDispatcherWorkspace } from '../dispatcher-workspace.js';
import type { SchedulerService } from '../scheduler/index.js';
import type { TeamCollection } from '../team/index.js';
import type { TeammateCollection } from '../agent/index.js';
import type { WorkflowService } from '../workflow-service/index.js';
import type { DispatcherAgent } from './agent.js';

interface DispatcherLifecycleOptions {
  dispatcherId: string;
  config: ConfigReader;
  dispatchers: DispatcherStore;
  log: DreamuxLogger;
  channels: ChannelService;
  /** This dispatcher's own agent, built here once channels are ready. */
  dispatcherAgent: DispatcherAgent;
  scheduler: SchedulerService;
  teams: TeamCollection;
  teammates: TeammateCollection;
  workflows: WorkflowService;
}

/**
 * Owns Dispatcher input-source preparation, startup state, and the one
 * terminal close.
 *
 * This is also the dispatcher's one admission gate (folding the former
 * standalone `DispatcherTaskDrain`): a single boolean fence publishes before
 * any close work runs, `admit()` is the one check every externally-admitted
 * operation crosses, and `isClosing()` is the same fact
 * `TeammateCollection`/`TeamCollection` read at construction so a spawn or a
 * Team create that was already admitted before `close()` ran can close itself
 * the instant it registers, rather than running unstopped until a sweep
 * reaches it.
 */
export class DispatcherLifecycle {
  private workspaceCwd: string | null = null;
  /**
   * The start operation's own fence: a nullable `Promise` field is the state,
   * published before the work behind it runs. Never reset once settled — a
   * Dispatcher's channels and workflow/scheduler admission start at most once
   * per process lifetime.
   */
  private starting: Promise<void> | null = null;
  /**
   * The permanent admission fence (R11: no in-process restart, so this never
   * reverts to `false` once `close()` publishes it). Kept as its own field
   * rather than derived from `closing` below: `isClosing()` is a fact
   * `admit()`, `TeammateCollection`, and `TeamCollection` all read directly,
   * and it must hold even during the gap between a failed release and a
   * retried one, which is exactly when `closing` is momentarily `null`.
   */
  private closed = false;
  /**
   * The current — or last-attempted — release task. A resource release can
   * fail transiently (a socket blip closing one channel session) with every
   * other resource released cleanly; caching that rejection forever would
   * leave the dispatcher fenced against all future work with no way to finish
   * tearing down. Cleared on rejection so a later `close()` call re-runs the
   * release sweep; every step it awaits is idempotent, so a retry after
   * partial success re-releases nothing twice. Never cleared on success —
   * nothing is left to release twice once every step already returned
   * cleanly. This is a fence-plus-task pair rather than one nullable
   * `Promise` field only because `isClosing()` cannot itself revert across a
   * retry (see `closed` above); an ordinary same-object operation (dissolve,
   * host stop, start) has no such external reader and stays one field.
   */
  private closing: Promise<void> | null = null;
  private readonly admittedWork = new InFlightWork();

  constructor(private readonly opts: DispatcherLifecycleOptions) {}

  /** Whether `close()` has been called. Never reverts to `false`. */
  isClosing(): boolean {
    return this.closed;
  }

  /**
   * Run one externally-admitted operation. The one check every Channel
   * Command, MCP call, and cron fire crosses before it runs; a task that
   * crossed it before `close()` published the fence is tracked so `close()`
   * can join it once its own sweep has stopped every runtime it can reach.
   */
  admit<T>(task: () => Promise<T>): Promise<T> {
    this.assertAvailable();
    return this.admittedWork.track(Promise.resolve().then(task));
  }

  async start(): Promise<void> {
    this.assertAvailable();
    if (this.starting !== null) return this.starting;
    const promise = this.doStart();
    this.starting = promise;
    return promise;
  }

  /**
   * The one terminal close: publish the permanent admission fence
   * synchronously, then run (or retry) the release sweep — stop every
   * runtime, wait for whatever was already admitted to settle, sweep once
   * more, release channels. A failed `start()` reuses this exact path instead
   * of a bespoke rollback.
   */
  close(): Promise<void> {
    if (this.closing !== null) return this.closing;
    if (!this.closed) {
      this.closed = true;
      // Published before any awaited work runs, so a caller reaching this
      // dispatcher from any angle — an admitted Command, a construction
      // path's own `isClosing()` read, a second `close()` call — sees the
      // close already under way rather than starting a second one. Guarded by
      // `closed` rather than repeated on every retry: each of these is a
      // one-time admission fence, not a resource to release, so a later retry
      // has nothing further to publish here.
      this.opts.channels.closeAdmission();
      // The dispatcher's own Workflow and scheduler admission close first;
      // one call then closes every Team's own (each Team owns composing its
      // own Workflow-close + scheduler-stop, the same pair `stopChildRuntimes`
      // already composes for dissolve).
      this.opts.workflows.requestStopAll();
      this.opts.scheduler.stop();
      this.opts.teams.stopAdmissions();
    }
    const task = this.doClose().catch((error: unknown) => {
      // The admission fence above stays published forever; only this release
      // attempt is retryable, so a later `close()` call re-runs `doClose()`
      // instead of replaying this same rejection.
      this.closing = null;
      throw error;
    });
    this.closing = task;
    return task;
  }

  /**
   * Bring the dispatcher up in the one order the boundary requires.
   *
   * Sessions are constructed and initialized first, with external input still
   * closed, so every subscription is attached before Core recovers anything.
   * Recovery then runs against live event pumps. Channels open their external
   * I/O next, and ordinary Workflow, scheduler, and cron admission opens only
   * after all of them have started — a Channel that is still resuming its own
   * sagas must not be asked to render an ordinary turn. Team Workflow
   * recovery belongs to the recovery half (`teams.recover()`), and Team
   * admission opens with the dispatcher's own.
   *
   * Every step from the dispatcher-row lookup on is inside the one `try`:
   * whatever this attempt built partially — channels adopted so far, an agent
   * runtime maybe activated — is torn down by `closeAfterFailedTransition`
   * regardless of which step failed, so a shape failure caught this early
   * (an unrunnable channel provider, a missing dispatcher row) leaves this
   * dispatcher closed rather than stuck forever in neither state.
   */
  private async doStart(): Promise<void> {
    this.assertAvailable();
    try {
      const row = this.opts.dispatchers.get(this.opts.dispatcherId);
      if (row === null) {
        throw new Error(`no dispatcher '${this.opts.dispatcherId}'`);
      }
      this.opts.channels.assertRunnable();
      const workspaceCwd = await ensureDispatcherWorkspace(
        this.opts.config.current(),
        this.opts.dispatcherId,
      );
      // Channels are built first because the Agent's MCP surface is assembled
      // from what they composed: a channel tool is advertised only if the
      // instance that would serve it exists. Building is also the step that
      // can fail, so nothing else is committed until it has. `ChannelService`
      // itself is the one owner of the built instances from this point on
      // (its own `entries` map), so this method holds no copy of its own.
      await this.opts.channels.build();
      // Hands every built session its Core port, subscribing it before its
      // external input can open (see the ordering note below).
      await this.opts.channels.initialize(() => this.assertAvailable());
      this.assertAvailable();
      // Built last: `DispatcherAgent.build()` commits the agent as its own
      // final step, so a failure anywhere above — channel build or
      // initialize — leaves no agent for `mustAgent()`/`status()` to find,
      // matching this block's all-or-nothing commit.
      await this.opts.dispatcherAgent.build(workspaceCwd);
      this.workspaceCwd = workspaceCwd;
      await this.opts.teams.recoverWorktreeCleanup();
      this.assertAvailable();
      await this.opts.workflows.recover();
      this.assertAvailable();
      await this.opts.teams.recover();
      this.assertAvailable();
      await this.opts.dispatcherAgent.activateIfNeeded();
      this.assertAvailable();
      // Opens external input, one already-initialized session at a time; a
      // session is published as live only after its own start returns.
      await this.opts.channels.start(() => this.assertAvailable());
      this.assertAvailable();
      await this.opts.workflows.start();
      this.assertAvailable();
      await this.opts.scheduler.start();
      this.assertAvailable();
      await this.opts.teams.startAdmissions();
      this.assertAvailable();
    } catch (error) {
      await this.closeAfterFailedTransition(error);
    }

    const row = this.opts.dispatchers.get(this.opts.dispatcherId);
    this.opts.log.info(
      {
        dispatcher_id: this.opts.dispatcherId,
        channel_identity: row?.channel_identity ?? '',
        cwd: this.workspaceCwd,
      },
      'dispatcher ready',
    );
  }

  /**
   * A failed `start()` gives back exactly what a normal close does — there is
   * no separate rollback path. Whatever partial state this attempt built
   * (channels adopted so far, an agent runtime maybe activated) is torn down
   * by the same `close()` a stop uses; only the original failure is
   * reported, unless `close()` itself also fails, in which case both are
   * reported together.
   */
  private async closeAfterFailedTransition(error: unknown): Promise<never> {
    const closeFailures: unknown[] = [];
    await collectShutdownFailure(closeFailures, () => this.close());
    if (closeFailures.length > 0) {
      throw new AggregateError(
        [error, ...closeFailures],
        `dispatcher ${JSON.stringify(this.opts.dispatcherId)} failed to start and did not close cleanly`,
      );
    }
    throw error;
  }

  private async doClose(): Promise<void> {
    const failures: unknown[] = [];
    // Stop every runtime this dispatcher's containers currently hold before
    // joining admitted work below: an admitted `send`/`spawn` can be sitting
    // inside a runtime start with no timeout of its own (codex `thread/start`
    // is one such call), so draining first would wait on exactly the runtime
    // this sweep exists to kill. Stopping first is what makes the runtime's
    // own teardown (which tears down its RPC client and rejects that pending
    // start) the thing that unblocks the drain, matching R10: kill first,
    // never wait for a natural end.
    await this.sweepRuntimes(failures);
    // Every admitted task this dispatcher already let in is joined here, now
    // that the sweep above has stopped every runtime it could reach.
    await collectShutdownFailure(failures, () => this.admittedWork.drain());
    // A second, idempotent pass of the same sweep: a pre-fence admission that
    // had not yet reached its runtime start during the first sweep can still
    // start — or, since `stopForHost()` fences admission only for its own
    // convergence and never moves the entity's phase, restart — a runtime
    // while the drain above was converging. Register-time self-close
    // (`TeammateCollection`/`TeamCollection`) only covers a brand-new entity's
    // first submission; it does not cover an already-materialized entity's
    // pre-fence admission reviving its runtime after the first sweep already
    // passed it by. Every step this repeats is idempotent (phase checks,
    // cached tasks, collections that keep what they stopped), so repeating it
    // costs nothing when there was nothing left to catch. What this cannot
    // catch: such an admission whose revived start never returns (codex
    // `thread/start` has no timeout) holds the drain above, so this pass is
    // never reached.
    await this.sweepRuntimes(failures);
    // Channel/session close runs last: it revokes this dispatcher's Core-event
    // subscriptions itself, immediately before it closes the sessions holding
    // them, and a runtime settling during either sweep above still produces
    // facts a Channel should see.
    await collectShutdownFailure(failures, () => this.opts.channels.closeAll());
    if (failures.length > 0) {
      for (const failure of failures) {
        this.opts.log.error(
          { dispatcher_id: this.opts.dispatcherId, err: errorInfo(failure) },
          'error stopping dispatcher resource',
        );
      }
    }
    throwShutdownFailures(
      failures,
      `dispatcher ${JSON.stringify(this.opts.dispatcherId)} failed to close`,
    );
  }

  /**
   * Stop every runtime this dispatcher's Workflow, Team, TeamMate, and
   * dispatcher-agent containers currently hold. Called twice around the
   * admitted-work drain in {@link doClose}; safe to repeat because every step
   * is independently idempotent.
   */
  private async sweepRuntimes(failures: unknown[]): Promise<void> {
    await collectShutdownFailure(failures, () => this.opts.workflows.stopAll());
    await collectShutdownFailure(failures, () => this.opts.teams.stopForHost());
    await collectShutdownFailure(failures, () => this.opts.teammates.stop());
    await collectShutdownFailure(failures, async () => {
      await this.opts.dispatcherAgent.current?.stopForHost();
    });
  }

  private assertAvailable(): void {
    if (this.isClosing()) {
      throw new ServerShuttingDownError(
        `dispatcher '${this.opts.dispatcherId}' is shutting down`,
      );
    }
  }
}
