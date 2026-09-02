import type {
  ChannelInstance,
  CoreCommandRegistry,
  DreamuxLogger,
} from '@excitedjs/dreamux-types';

import type { AgentRuntimeProviderCatalog } from '../../agent-runtime/index.js';
import type { ChannelProviderCatalog } from '../../channel/catalog.js';
import type {
  ChannelCommandBatch,
  ChannelCommandRegistrar,
  ChannelCommandSource,
} from '../../command/channel-commands.js';
import type { ConversationProjection } from '../../channel/conversation-projection.js';
import {
  createChannelCorePort,
  type ChannelCorePortLease,
} from '../../channel/core-port.js';
import type { DreamuxConfig } from '../../config/config.js';
import type { RestartIntentConsumer } from '../../daemon/restart-intent.js';
import type { DispatcherStore } from '../../state/dispatcher-store.js';
import type { AgentIdentityStore } from '../agent-entity/identity-store.js';
import type { AdmissionLedger } from '../teammate-service/admission-ledger.js';
import type { ChannelService } from '../channel-service/index.js';
import type { DispatcherCoreEventBus } from '../dispatcher-core-events/index.js';
import { ensureDispatcherWorkspace } from '../dispatcher-workspace.js';
import type { SchedulerService } from '../scheduler/service.js';
import type { TeamCollection } from '../team-collection/index.js';
import type { TeammateCollection } from '../teammate-collection/index.js';
import type { TeammateService } from '../teammate-service/index.js';
import type { TeammateAgentMcp } from '../teammate-service/types.js';
import { collectShutdownFailure } from '../shutdown-errors.js';
import {
  channelDescriptors,
  type ChannelDescriptor,
} from './channel-descriptor.js';
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
  config: DreamuxConfig;
  dispatchers: DispatcherStore;
  channelProviders: ChannelProviderCatalog;
  agentRuntimeProviders: AgentRuntimeProviderCatalog;
  identities: AgentIdentityStore;
  admissions: AdmissionLedger;
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
  /**
   * The registration half of that same port. A dispatcher owns the lifetime of
   * its Channels' Commands — it registers the whole catalog when it builds
   * them and revokes it when it stops — while a Channel session only ever
   * invokes through the narrow provider-facing registry above.
   */
  channelCommands: ChannelCommandRegistrar;
  coreEvents: DispatcherCoreEventBus;
  scheduler: SchedulerService;
  teams: TeamCollection;
  teammates: TeammateCollection;
  admittedTasks: DispatcherTaskDrain;
  workflows: DispatcherWorkflows;
  isUnavailable(): boolean;
  restartIntent(): RestartIntentConsumer | null;
}

/** Owns Dispatcher input-source preparation, startup state, and failed-start rollback. */
export class DispatcherInputSourceLifecycle {
  private agent_: TeammateService | null = null;
  private workspaceCwd: string | null = null;
  private preparing: Promise<void> | null = null;
  private starting: Promise<void> | null = null;
  private preparedChannels: Map<string, ChannelInstance> | null = null;
  /**
   * One Core port lease per initialized Channel session, held so shutdown can
   * fence Channel Command admission synchronously — before any awaited teardown
   * — rather than relying on each provider to stop calling.
   */
  private readonly channelPorts: ChannelCorePortLease[] = [];
  /**
   * The Channel Command catalog this run registered, or `null` when nothing is
   * registered. One batch per dispatcher run: it is registered whole once the
   * Channels are built, and it is the only handle that can fence, drain, and
   * revoke what it registered.
   */
  private channelCommands: ChannelCommandBatch | null = null;
  /**
   * Whether Channel admission has been fenced for this run. Read only to
   * describe a channel as `closing` rather than `ready`; the fence itself is
   * the port lease's and the registration's, not a flag anything consults.
   */
  private admissionFenced = false;
  private started = false;
  private cleanupPending = false;

  constructor(private readonly opts: DispatcherInputSourceLifecycleOptions) {}

  get agent(): TeammateService | null {
    return this.agent_;
  }

  async prepareChannels(): Promise<void> {
    this.assertAvailable();
    if (this.preparedChannels !== null || this.started) return;
    if (this.preparing !== null) return this.preparing;
    const promise = this.doPrepareChannels().finally(() => {
      this.preparing = null;
    });
    this.preparing = promise;
    return promise;
  }

  async start(): Promise<void> {
    this.assertAvailable();
    if (this.started) return;
    if (this.starting !== null) return this.starting;
    const promise = this.doStart().finally(() => {
      this.starting = null;
    });
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
   * enter Core while shutdown is converging what it already accepted. Both
   * halves are fenced together because they are the same doorway seen from two
   * sides: the port lease refuses a Channel's outbound Command, the
   * registration refuses an inbound call to a Channel's own. Event
   * subscriptions deliberately outlive this: a stopping runtime still settles,
   * and those facts are worth delivering.
   */
  closeChannelPortAdmission(): void {
    this.admissionFenced = true;
    for (const lease of this.channelPorts) lease.closeAdmission();
    this.channelCommands?.closeAdmission();
  }

  /**
   * Await every Channel Command call admitted before the fence closed.
   *
   * Separate from the fence because the two happen at different times: the
   * fence is synchronous and precedes all teardown, while this must finish
   * before the sessions those calls are running against are closed. A caller
   * that closes a session first would tear down the Channel state a call it
   * already accepted is still using.
   */
  async drainChannelCommands(): Promise<void> {
    this.closeChannelPortAdmission();
    await this.channelCommands?.drain();
  }

  /**
   * Remove this run's whole Channel Command catalog. Idempotent, and only ever
   * after the sessions behind it are closed.
   */
  private unregisterChannelCommands(): void {
    this.channelCommands?.unregister();
    this.channelCommands = null;
  }

  /** Every Command name registered for one of this dispatcher's channels. */
  channelCommandNames(channelId: string): readonly string[] {
    return this.channelCommands?.get(channelId)?.names ?? [];
  }

  /**
   * The non-sensitive read model of this dispatcher's configured Channels.
   *
   * Liveness alone would misreport the teardown window — see
   * {@link channelDescriptors} — so the registration this run holds is what
   * decides whether a Channel is still being described at all.
   */
  channelDescriptors(): ChannelDescriptor[] {
    return channelDescriptors({
      configured: this.opts.channels.configuredChannels(),
      registered: (channelId) =>
        this.channelCommands?.get(channelId) != null,
      liveStatus: (channelId) => this.opts.channels.channelStatus(channelId),
      admissionFenced: this.admissionFenced,
      commandNames: (channelId) => this.channelCommandNames(channelId),
    });
  }

  /**
   * Close instances that were built but will never be started, and tell the
   * Channel service they are gone.
   *
   * All three halves are required: the service published these instances when
   * it built them, so closing them without clearing would leave a torn-down
   * channel still answering "yes, I can serve a session tool", and an
   * initialized session holds a live subscription nothing else would revoke.
   *
   * The Command catalog these instances registered is fenced and drained
   * before they are closed, and revoked only after: a call Core already
   * accepted runs against Channel state that must still exist, and a name must
   * not resolve to an instance that is gone.
   */
  private async discardPreparedChannels(
    sessions: Map<string, ChannelInstance>,
  ): Promise<void> {
    await this.drainChannelCommands();
    this.channelPorts.length = 0;
    this.opts.coreEvents.revokeSources();
    try {
      await closeAllBuilt(sessions);
    } finally {
      this.unregisterChannelCommands();
      this.opts.channels.clear();
    }
  }

  markStopped(): void {
    this.started = false;
    // The leases belonged to the sessions this run initialized; a later start
    // initializes new ones. Keeping the old objects would fence nothing and
    // would grow with every restart.
    this.channelPorts.length = 0;
    // Same for the catalog: those definitions are served by instances this run
    // built and this stop closed. A later start registers the catalog its own
    // instances declare.
    this.unregisterChannelCommands();
  }

  markCleanupPending(): void {
    this.cleanupPending = true;
  }

  private async doPrepareChannels(): Promise<void> {
    this.assertAvailable();
    if (this.agent_ !== null && !this.agent_.isRetired()) {
      throw new Error(
        `dispatcher ${JSON.stringify(this.opts.dispatcherId)} cannot replace its Agent while prior teardown is incomplete`,
      );
    }
    const row = this.opts.dispatchers.get(this.opts.dispatcherId);
    if (row === null) {
      throw new Error(`no dispatcher '${this.opts.dispatcherId}'`);
    }
    const dispatcherConfig = this.dispatcherConfig();
    assertRunnableChannelShape(dispatcherConfig, this.opts.channelProviders);
    const workspaceCwd = await ensureDispatcherWorkspace(
      this.opts.config,
      this.opts.dispatcherId,
    );
    const identity = await ensureDispatcherRootIdentity({
      identities: this.opts.identities,
      dispatcherId: this.opts.dispatcherId,
      agentRuntime: dispatcherConfig.agentRuntime,
      cwd: workspaceCwd,
    });
    // Channels are built first because the Agent's MCP surface is assembled from
    // what they composed: a channel tool is advertised only if the instance that
    // would serve it exists. Building is also the step that can fail, so nothing
    // else is committed until it has.
    const sessions = await this.opts.channels.build();
    // Building is awaited, so a shutdown may have begun while it ran. Registering
    // after that fence would put a catalog into the registry that this run will
    // never open and that the shutdown already past this point will never revoke.
    try {
      this.assertAvailable();
    } catch (error) {
      await closeAllBuilt(sessions);
      this.opts.channels.clear();
      throw error;
    }
    try {
      // The whole dispatcher catalog, registered in one atomic step before any
      // session is initialized. Before initialization, because a session may
      // invoke Core as soon as it has its port, and a Channel that reaches its
      // own sibling's Command must not depend on build order. Atomic, because a
      // colliding name in the second Channel means this dispatcher has no valid
      // catalog at all — registering half of one would leave the failed start
      // to unwind names that are already resolvable.
      this.registerChannelCommands(sessions);
      const agent = createDispatcherAgent({
        id: this.opts.dispatcherId,
        config: this.opts.config,
        agentRuntimeProviders: this.opts.agentRuntimeProviders,
        identities: this.opts.identities,
        admissions: this.opts.admissions,
        conversationProjection: this.opts.conversationProjection,
        log: this.opts.log,
        mcp: this.opts.agentMcp(),
        identity,
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
   * Register what every built Channel declared, as one catalog.
   *
   * A Channel with no Commands contributes an empty source rather than being
   * skipped, so the batch holds one registration per built channel and the
   * lifecycle has a fence to open and close for each — including the channels
   * that only ever invoke.
   *
   * Collection and registration are two steps with an availability fence
   * between them because `definitions()` is Channel-owned code running
   * synchronously inside this call: it can reach back into the dispatcher and
   * begin a stop before the last source is even assembled. Re-checking after
   * the last provider frame returns is what keeps a catalog from landing in the
   * registry behind a fence that has already passed the point of revoking it.
   */
  private registerChannelCommands(
    sessions: Map<string, ChannelInstance>,
  ): void {
    const sources: ChannelCommandSource[] = [];
    for (const [channelId, instance] of sessions) {
      sources.push({
        channelId,
        definitions: instance.commands?.definitions() ?? [],
      });
    }
    this.assertAvailable();
    this.channelCommands = this.opts.channelCommands.registerChannelCommands(
      this.opts.dispatcherId,
      sources,
    );
    // A fence belongs to the run whose registrations it closed. This run has
    // just registered its own, and it could only reach here past
    // `assertAvailable`, so the previous run's fence stops describing these
    // channels as closing. Reset here rather than in `markStopped` so a
    // prepare-only teardown followed by a retry still reports honestly.
    this.admissionFenced = false;
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
    const sessions = this.preparedChannels ?? new Map<string, ChannelInstance>();
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
      this.started = true;
    } catch (error) {
      this.opts.workflows.closeAdmission();
      this.closeChannelPortAdmission();
      this.opts.admittedTasks.closeAdmission();
      const rollbackFailures: unknown[] = [];
      await collectShutdownFailure(rollbackFailures, () =>
        this.opts.workflows.rollbackStart());
      // Everything Core already accepted through a Channel Command settles
      // before the rollback below closes the sessions those calls are running
      // against.
      await collectShutdownFailure(rollbackFailures, () =>
        this.drainChannelCommands());
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
        }));
      // Last, and unconditionally: the whole batch this start registered goes
      // away with the instances that served it, whether or not the rest of the
      // rollback proved release.
      this.unregisterChannelCommands();
      this.preparedChannels = null;
      this.channelPorts.length = 0;
      this.started = false;
      if (rollbackFailures.length === 0 && !this.opts.isUnavailable()) {
        this.opts.admittedTasks.openAdmission();
      }
      if (rollbackFailures.length > 0) {
        this.cleanupPending = true;
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
   *
   * Its Commands begin serving at exactly the same point, and only its own:
   * before that the definitions resolve but answer `CHANNEL_COMMAND_UNAVAILABLE`,
   * because a handler needs the state the session's own start established.
   */
  private async startPreparedChannels(
    sessions: Map<string, ChannelInstance>,
  ): Promise<void> {
    const liveChannels = new Map<string, ChannelInstance>();
    for (const [channelId, instance] of sessions) {
      await instance.session.start();
      this.assertAvailable();
      this.channelCommands?.get(channelId)?.openAdmission();
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
    return sessionId !== null &&
      this.opts.restartIntent()?.hasTarget(
        this.opts.dispatcherId,
        Date.now(),
      ) === true;
  }

  private dispatcherConfig() {
    const dispatcherConfig = this.opts.config.dispatchers.find(
      (dispatcher) => dispatcher.id === this.opts.dispatcherId,
    );
    if (dispatcherConfig === undefined) {
      throw new Error(
        `dispatcher '${this.opts.dispatcherId}' has no config entry`,
      );
    }
    return dispatcherConfig;
  }

  private mustAgent(): TeammateService {
    const agent = this.agent_;
    if (agent === null) {
      throw new Error(
        `dispatcher '${this.opts.dispatcherId}' agent is not prepared`,
      );
    }
    return agent;
  }

  private assertAvailable(): void {
    if (this.cleanupPending) {
      throw new Error(
        `dispatcher ${JSON.stringify(this.opts.dispatcherId)} cannot start while prior teardown is incomplete`,
      );
    }
    if (this.opts.isUnavailable()) {
      throw new Error(`dispatcher '${this.opts.dispatcherId}' is shutting down`);
    }
  }
}
