import type {
  ChannelInstance,
  CoreCommandRegistry,
  DreamuxLogger,
  LaunchDraft,
} from '@excitedjs/dreamux-types';
import type { AsyncSeriesHook } from 'tapable';

import type { AgentRuntimeProviderCatalog } from '../../agent-runtime/index.js';
import type { ChannelProviderCatalog } from '../../channel/catalog.js';
import type { ConversationProjection } from '../dispatcher-core-events/conversation-projection.js';
import {
  createChannelCorePort,
  type ChannelCorePortLease,
} from '../channel-service/core-port.js';
import type { ConfigReader } from '../../config/service.js';
import type { RestartIntentConsumer } from './restart-intent.js';
import type { DispatcherStore } from '../../state/dispatcher-store.js';
import type { AgentIdentityStore } from '../agent/store.js';
import type { AgentEntityIdentity } from '../agent/identity.js';
import type { AgentServiceFactory } from '../agent/factory.js';
import type { ChannelService } from '../channel-service/index.js';
import type { DispatcherCoreEventBus } from '../dispatcher-core-events/index.js';
import { ensureDispatcherWorkspace } from '../dispatcher-workspace.js';
import type { SchedulerService } from '../scheduler/service.js';
import type { TeamCollection } from '../team-collection/index.js';
import type { TeammateCollection } from '../agent/index.js';
import type { AgentService } from '../agent/service.js';
import type { TeammateAgentMcp } from '../agent/service-types.js';
import { collectShutdownFailure } from '../../platform/shutdown-errors.js';
import type { DispatcherWorkflows } from './dispatcher-workflows.js';
import { createDispatcherAgent } from './agent.js';
import { ensureDispatcherRootIdentity } from './identity.js';
import type { DispatcherTaskDrain } from './inbound-task-drain.js';
import { rollbackFailedInputSourceStart } from './input-source-start-rollback.js';
import { closeAllBuilt } from './runtime-helpers.js';
import { assertRunnableChannelShape } from './runnable-channel.js';
import { injectRestartNoticeIfNeeded } from './restart-notice.js';

interface DispatcherInputSourceLifecycleOptions {
  dispatcherId: string;
  config: ConfigReader;
  dispatchers: DispatcherStore;
  channelProviders: ChannelProviderCatalog;
  agentRuntimeProviders: AgentRuntimeProviderCatalog;
  identities: AgentIdentityStore;
  onPersisted: (identity: AgentEntityIdentity) => void;
  agentServiceFactory: AgentServiceFactory;
  conversationProjection: ConversationProjection;
  log: DreamuxLogger;
  channels: ChannelService;
  /**
   * The dispatcher Agent's own MCP surface, built fresh per launch by the
   * dispatcher that owns the objects behind it. A supplier rather than a value
   * because the delegates close over live services this lifecycle is still
   * constructing when it is itself constructed.
   */
  agentMcp: () => TeammateAgentMcp;
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
  admittedTasks: DispatcherTaskDrain;
  workflows: DispatcherWorkflows;
  /** The Dispatcher's `beforeLaunch` hook, run at each Agent construction. */
  beforeLaunch: AsyncSeriesHook<[LaunchDraft]>;
  isUnavailable(): boolean;
  restartIntent(): RestartIntentConsumer | null;
}

/** Owns Dispatcher input-source preparation, startup state, and failed-start rollback. */
export class DispatcherInputSourceLifecycle {
  private agent_: AgentService | null = null;
  private workspaceCwd: string | null = null;
  /**
   * The prepare/start operation is its own fence: a nullable `Promise` field
   * is the state, published before the work behind it runs. Neither is reset
   * once settled — a Dispatcher's channels and workflow/scheduler admission
   * start at most once per process lifetime, so a second caller always joins
   * the same settled promise (resolved or rejected) rather than re-running
   * prepare/start.
   */
  private preparing: Promise<void> | null = null;
  private starting: Promise<void> | null = null;
  private preparedChannels: Map<string, ChannelInstance> | null = null;
  /**
   * One Core port lease per initialized Channel session, held so shutdown can
   * fence Channel Command admission synchronously — before any awaited teardown
   * — rather than relying on each provider to stop calling.
   */
  private readonly channelPorts: ChannelCorePortLease[] = [];

  constructor(private readonly opts: DispatcherInputSourceLifecycleOptions) {}

  get agent(): AgentService | null {
    return this.agent_;
  }

  async prepareChannels(): Promise<void> {
    this.assertAvailable();
    if (this.preparedChannels !== null) return;
    if (this.preparing !== null) return this.preparing;
    const promise = this.doPrepareChannels();
    this.preparing = promise;
    return promise;
  }

  async start(): Promise<void> {
    this.assertAvailable();
    if (this.starting !== null) return this.starting;
    const promise = this.doStart();
    this.starting = promise;
    return promise;
  }

  async waitForSettledStart(): Promise<void> {
    if (this.preparing !== null) await this.preparing.catch(() => {});
    if (this.starting !== null) await this.starting.catch(() => {});
  }

  async closePreparedChannels(): Promise<void> {
    if (this.preparedChannels === null) return;
    const sessions = this.preparedChannels;
    this.preparedChannels = null;
    await this.discardPreparedChannels(sessions);
  }

  /**
   * Fence Channel Command admission, synchronously and idempotently.
   *
   * Published before any awaited teardown so an initialized session cannot
   * enter Core while shutdown is converging what it already accepted. Event
   * subscriptions deliberately outlive this: a stopping runtime still settles,
   * and those facts are worth delivering.
   */
  closeChannelPortAdmission(): void {
    for (const lease of this.channelPorts) lease.closeAdmission();
  }

  /**
   * Close instances that were built but will never be started, and tell the
   * Channel service they are gone.
   *
   * All three halves are required: the service published these instances when
   * it built them, so closing them without clearing would leave a torn-down
   * channel still answering "yes, I can serve a session tool", and an
   * initialized session holds a live subscription nothing else would revoke.
   */
  private async discardPreparedChannels(
    sessions: Map<string, ChannelInstance>,
  ): Promise<void> {
    this.closeChannelPortAdmission();
    this.channelPorts.length = 0;
    this.opts.coreEvents.revokeSources();
    try {
      await closeAllBuilt(sessions);
    } finally {
      this.opts.channels.clear();
    }
  }

  markStopped(): void {
    // The leases were held only to fence this run's Channel sessions; once
    // stopped, nothing needs them, and keeping the array would leak references.
    this.channelPorts.length = 0;
  }

  private async doPrepareChannels(): Promise<void> {
    this.assertAvailable();
    const row = this.opts.dispatchers.get(this.opts.dispatcherId);
    if (row === null) {
      throw new Error(`no dispatcher '${this.opts.dispatcherId}'`);
    }
    const dispatcherConfig = this.dispatcherConfig();
    assertRunnableChannelShape(dispatcherConfig, this.opts.channelProviders);
    const workspaceCwd = await ensureDispatcherWorkspace(
      this.opts.config.current(),
      this.opts.dispatcherId,
    );
    const identity = await ensureDispatcherRootIdentity({
      identities: this.opts.identities,
      dispatcherId: this.opts.dispatcherId,
      agentRuntime: dispatcherConfig.agentRuntime,
      cwd: workspaceCwd,
      onPersisted: this.opts.onPersisted,
    });
    // Channels are built first because the Agent's MCP surface is assembled from
    // what they composed: a channel tool is advertised only if the instance that
    // would serve it exists. Building is also the step that can fail, so nothing
    // else is committed until it has.
    const sessions = await this.opts.channels.build();
    try {
      const agent = await createDispatcherAgent({
        id: this.opts.dispatcherId,
        config: this.opts.config,
        agentRuntimeProviders: this.opts.agentRuntimeProviders,
        identities: this.opts.identities,
        onPersisted: this.opts.onPersisted,
        agentServiceFactory: this.opts.agentServiceFactory,
        conversationProjection: this.opts.conversationProjection,
        log: this.opts.log,
        mcp: this.opts.agentMcp(),
        identity,
        beforeLaunch: this.opts.beforeLaunch,
      });
      this.assertAvailable();
      await this.initializeChannelSessions(sessions);
      this.workspaceCwd = workspaceCwd;
      this.agent_ = agent;
      this.preparedChannels = sessions;
    } catch (error) {
      await this.discardPreparedChannels(sessions);
      throw error;
    }
  }

  /**
   * Hand every built session its Core port.
   *
   * This is the step that makes subscribe-before-admission provable: a session
   * attaches its event consumer here, while its own external input is still
   * closed, so nothing Core recovers or settles later can precede the
   * subscription that observes it. The contract forbids opening external I/O
   * from `initialize`, which is why the two are separate calls at all.
   */
  private async initializeChannelSessions(
    sessions: Map<string, ChannelInstance>,
  ): Promise<void> {
    for (const [channelId, instance] of sessions) {
      const events = this.opts.coreEvents.createSource(channelId);
      const lease = createChannelCorePort({
        registry: this.opts.commands,
        dispatcherId: this.opts.dispatcherId,
        channelId,
        events: events.source,
        log: this.opts.log,
      });
      this.channelPorts.push(lease);
      await instance.session.initialize(lease.port);
      this.assertAvailable();
    }
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
   */
  private async doStart(): Promise<void> {
    this.assertAvailable();
    await this.prepareChannels();
    this.assertAvailable();
    const sessions =
      this.preparedChannels ?? new Map<string, ChannelInstance>();
    try {
      await this.opts.teams.recoverWorktreeCleanup();
      this.assertAvailable();
      await this.opts.workflows.recover();
      this.assertAvailable();
      if (this.shouldStartRuntimeForResumeNotice()) {
        await this.startAgentRuntime();
      }
      this.assertAvailable();
      await this.startPreparedChannels(sessions);
      this.preparedChannels = null;
      this.assertAvailable();
      await this.opts.workflows.start();
      this.assertAvailable();
      await this.opts.scheduler.start();
      this.assertAvailable();
      await this.opts.teams.startSchedulers();
      this.assertAvailable();
    } catch (error) {
      this.opts.workflows.closeAdmission();
      this.closeChannelPortAdmission();
      this.opts.admittedTasks.closeAdmission();
      const rollbackFailures: unknown[] = [];
      await collectShutdownFailure(rollbackFailures, () =>
        this.opts.workflows.rollbackStart(),
      );
      await collectShutdownFailure(rollbackFailures, () =>
        rollbackFailedInputSourceStart({
          dispatcherId: this.opts.dispatcherId,
          sessions,
          channels: this.opts.channels,
          coreEvents: this.opts.coreEvents,
          scheduler: this.opts.scheduler,
          teams: this.opts.teams,
          teammates: this.opts.teammates,
          admittedTasks: this.opts.admittedTasks,
          agent: this.agent_,
          log: this.opts.log,
        }),
      );
      this.preparedChannels = null;
      this.channelPorts.length = 0;
      if (rollbackFailures.length === 0 && !this.opts.isUnavailable()) {
        this.opts.admittedTasks.openAdmission();
      }
      if (rollbackFailures.length > 0) {
        throw new AggregateError(
          [error, ...rollbackFailures],
          `dispatcher ${JSON.stringify(this.opts.dispatcherId)} start failed and rollback did not complete`,
        );
      }
      throw error;
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
   * Open external input, one already-initialized session at a time.
   *
   * `start` takes nothing: the session was given its Core port at initialize,
   * and what it does with external traffic — routing, binding, presentation —
   * is the Channel's own. A session is published as live only after its own
   * start returns.
   */
  private async startPreparedChannels(
    sessions: Map<string, ChannelInstance>,
  ): Promise<void> {
    const liveChannels = new Map<string, ChannelInstance>();
    for (const [channelId, instance] of sessions) {
      await instance.session.start();
      this.assertAvailable();
      liveChannels.set(channelId, instance);
      this.opts.channels.adopt(liveChannels);
    }
    if (sessions.size === 0) this.opts.channels.adopt(liveChannels);
  }

  private async startAgentRuntime(): Promise<void> {
    if (this.mustAgent().runtimeStatus() !== null) return;
    await this.mustAgent().activate();
    await injectRestartNoticeIfNeeded({
      dispatcherId: this.opts.dispatcherId,
      agent: this.mustAgent(),
      restartIntent: this.opts.restartIntent(),
      now: Date.now(),
      log: this.opts.log,
    });
  }

  private shouldStartRuntimeForResumeNotice(): boolean {
    const sessionId = this.agent_?.current().session_id ?? null;
    return (
      sessionId !== null &&
      this.opts
        .restartIntent()
        ?.hasTarget(this.opts.dispatcherId, Date.now()) === true
    );
  }

  private dispatcherConfig() {
    const dispatcherConfig = this.opts.config
      .current()
      .dispatchers.find(
        (dispatcher) => dispatcher.id === this.opts.dispatcherId,
      );
    if (dispatcherConfig === undefined) {
      throw new Error(
        `dispatcher '${this.opts.dispatcherId}' has no config entry`,
      );
    }
    return dispatcherConfig;
  }

  private mustAgent(): AgentService {
    const agent = this.agent_;
    if (agent === null) {
      throw new Error(
        `dispatcher '${this.opts.dispatcherId}' agent is not prepared`,
      );
    }
    return agent;
  }

  private assertAvailable(): void {
    if (this.opts.isUnavailable()) {
      throw new Error(
        `dispatcher '${this.opts.dispatcherId}' is shutting down`,
      );
    }
  }
}
