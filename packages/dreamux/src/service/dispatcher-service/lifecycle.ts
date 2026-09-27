import type { DreamuxLogger } from '@excitedjs/dreamux-types';

import type { CoreCommandRegistry } from '../../command/types.js';
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
import type { DispatcherCoreEventBus } from '../dispatcher-core-events/index.js';
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
  /**
   * The Server-owned admitted Command port every Channel session invokes
   * through. It is the same port the admin socket uses; a Channel never reaches
   * the raw registry.
   */
  commands: CoreCommandRegistry;
  coreEvents: DispatcherCoreEventBus;
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
 * standalone `DispatcherTaskDrain`): a single nullable `closing` fence
 * publishes before any close work runs, `admit()` is the one check every
 * externally-admitted operation crosses, and `isClosing()` is the same fact
 * `TeammateCollection`/`TeamCollection` read at construction so a spawn or a
 * Team create that was already admitted before `close()` ran can close itself
 * the instant it registers, instead of the close path trying to catch it with
 * a second sweep.
 */
export class DispatcherLifecycle {
  private workspaceCwd: string | null = null;
  /**
   * The start/close operations are each their own fence: a nullable `Promise`
   * field is the state, published before the work behind it runs. Neither is
   * reset once settled — a Dispatcher's channels and workflow/scheduler
   * admission start at most once per process lifetime, and once `close()` has
   * run this dispatcher never accepts work again (R11: no in-process restart).
   */
  private starting: Promise<void> | null = null;
  private closing: Promise<void> | null = null;
  private readonly admittedWork = new InFlightWork();

  constructor(private readonly opts: DispatcherLifecycleOptions) {}

  /** Whether `close()` has been called. Never reverts to `false`. */
  isClosing(): boolean {
    return this.closing !== null;
  }

  /**
   * Run one externally-admitted operation. The one check every Channel
   * Command, MCP call, and cron fire crosses before it runs; a task that
   * crossed it before `close()` published the fence is tracked so `close()`
   * can wait for it to settle before sweeping.
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
   * The one terminal close: publish every aggregate fence synchronously, wait
   * for whatever was already admitted to settle, then release runtime
   * authority once — a failed `start()` reuses this exact path instead of a
   * bespoke rollback.
   */
  close(): Promise<void> {
    if (this.closing !== null) return this.closing;
    // Published before any awaited work runs, so a caller reaching this
    // dispatcher from any angle — an admitted Command, a construction path's
    // own `isClosing()` read, a second `close()` call — sees the close
    // already under way rather than starting a second one.
    this.opts.channels.closeAdmission();
    // Workflows fan out to the Team scope the same way the scheduler does
    // right below: the dispatcher's own admission closes first, then each
    // Team's.
    this.opts.workflows.requestStopAll();
    this.opts.teams.closeWorkflowAdmissions();
    this.opts.scheduler.stop();
    this.opts.teams.stopSchedulers();
    const task = this.doClose();
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
   * sagas must not be asked to render an ordinary turn.
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
      await this.opts.teams.recoverWorkflows();
      this.assertAvailable();
      await this.opts.dispatcherAgent.activateIfNeeded();
      this.assertAvailable();
      // Opens external input, one already-initialized session at a time; a
      // session is published as live only after its own start returns.
      await this.opts.channels.start(() => this.assertAvailable());
      this.assertAvailable();
      await this.opts.workflows.start();
      this.assertAvailable();
      await this.opts.teams.startWorkflows();
      this.assertAvailable();
      await this.opts.scheduler.start();
      this.assertAvailable();
      await this.opts.teams.startSchedulers();
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
    // Every admitted task this dispatcher already let in is joined before
    // anything is swept: an admitted `send`/`spawn`/`createTeam` only awaits
    // its own admission (issue #63's non-blocking shape), so this converges
    // quickly rather than waiting on a Turn's natural completion, and every
    // construction path it can reach already self-closes against `isClosing()`
    // the moment it registers. That is what makes the one sweep below — run
    // only after this drain, not before it — provably sufficient: nothing can
    // still be starting a runtime by the time it runs.
    await collectShutdownFailure(failures, () => this.admittedWork.drain());
    await collectShutdownFailure(failures, () => this.opts.workflows.stopAll());
    await collectShutdownFailure(failures, () => this.opts.teams.stopForHost());
    for (const teammate of this.opts.teammates.materializedEntities()) {
      await collectShutdownFailure(failures, () => teammate.stopForHost());
    }
    await collectShutdownFailure(failures, async () => {
      await this.opts.dispatcherAgent.current?.stopForHost();
    });
    // Channel/session close runs last: it revokes this dispatcher's Core-event
    // subscriptions itself, immediately before it closes the sessions holding
    // them, and a runtime settling during the sweep above still produces facts
    // a Channel should see.
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

  private assertAvailable(): void {
    if (this.isClosing()) {
      throw new ServerShuttingDownError(
        `dispatcher '${this.opts.dispatcherId}' is shutting down`,
      );
    }
  }
}
