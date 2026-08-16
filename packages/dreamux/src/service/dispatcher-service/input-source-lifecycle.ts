import type { ChannelSession, DreamuxLogger } from '@excitedjs/dreamux-types';

import type { AgentRuntimeProviderCatalog } from '../../agent-runtime/index.js';
import type { ChannelProviderCatalog } from '../../channel/catalog.js';
import type { DreamuxConfig } from '../../config/config.js';
import type { RestartIntentConsumer } from '../../daemon/restart-intent.js';
import type { DispatcherStore } from '../../state/dispatcher-store.js';
import type { AgentIdentityStore } from '../agent-entity/identity-store.js';
import type { AgentTurnsStore } from '../agent-entity/turns-store.js';
import type { ChannelService } from '../channel-service/index.js';
import type { CollaborationSpaceService } from '../collaboration-space/index.js';
import type { DispatcherCoreEventBus } from '../dispatcher-core-events/index.js';
import { ensureDispatcherWorkspace } from '../dispatcher-workspace.js';
import type { SchedulerService } from '../scheduler/service.js';
import type { TeamCollection } from '../team-collection/index.js';
import type { TeammateCollection } from '../teammate-collection/index.js';
import type { TeammateService } from '../teammate-service/index.js';
import { collectShutdownFailure } from '../shutdown-errors.js';
import type { DispatcherWorkflows } from './dispatcher-workflows.js';
import { createDispatcherAgent } from './agent.js';
import { handleCollaborationTargetLifecycle } from './collaboration-routing.js';
import { ensureDispatcherRootIdentity } from './identity.js';
import type { DispatcherTaskDrain } from './inbound-task-drain.js';
import { rollbackFailedInputSourceStart } from './input-source-start-rollback.js';
import { dispatcherMcpServerDescriptors } from './mcp-descriptors.js';
import { closeAllBuilt } from './runtime-helpers.js';
import { assertRunnableChannelShape } from './runnable-channel.js';
import type { DispatcherScopedChannelRouting } from './scoped-channel-routing.js';
import { injectRestartNoticeIfNeeded } from './restart-notice.js';

interface DispatcherInputSourceLifecycleOptions {
  dispatcherId: string;
  config: DreamuxConfig;
  dispatchers: DispatcherStore;
  channelProviders: ChannelProviderCatalog;
  agentRuntimeProviders: AgentRuntimeProviderCatalog;
  identities: AgentIdentityStore;
  turnsStore: AgentTurnsStore;
  log: DreamuxLogger;
  channels: ChannelService;
  adminSocketPath: string;
  channelRoutes: DispatcherScopedChannelRouting;
  collaborationSpaces: CollaborationSpaceService;
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
  private preparedChannels: Map<string, ChannelSession> | null = null;
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
    await closeAllBuilt(this.preparedChannels);
    this.preparedChannels = null;
  }

  markStopped(): void {
    this.started = false;
  }

  markCleanupPending(): void {
    this.cleanupPending = true;
  }

  markCleanupComplete(): void {
    this.cleanupPending = false;
  }

  dispatcherAgentRuntime(): string {
    return this.dispatcherConfig().agentRuntime;
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
    const agent = createDispatcherAgent({
      id: this.opts.dispatcherId,
      config: this.opts.config,
      agentRuntimeProviders: this.opts.agentRuntimeProviders,
      identities: this.opts.identities,
      turnsStore: this.opts.turnsStore,
      log: this.opts.log,
      mcpServers: dispatcherMcpServerDescriptors({
        dispatcherId: this.opts.dispatcherId,
        channels: this.opts.channels.configuredChannels(),
        channelProviders: this.opts.channelProviders,
        adminSocketPath: this.opts.adminSocketPath,
      }),
      identity,
    });
    const sessions = await this.opts.channels.build();
    try {
      this.assertAvailable();
      this.workspaceCwd = workspaceCwd;
      this.agent_ = agent;
      this.preparedChannels = sessions;
    } catch (error) {
      await closeAllBuilt(sessions);
      throw error;
    }
  }

  private async doStart(): Promise<void> {
    this.assertAvailable();
    await this.opts.collaborationSpaces.recoverTeamDissolves();
    this.assertAvailable();
    await this.opts.workflows.recover();
    try {
      await this.prepareChannels();
    } catch (error) {
      this.opts.teams.stopSchedulers();
      throw error;
    }
    this.assertAvailable();
    const sessions = this.preparedChannels ?? new Map<string, ChannelSession>();
    try {
      await this.opts.workflows.start();
      this.assertAvailable();
      if (this.shouldStartRuntimeForResumeNotice()) {
        await this.startAgentRuntime();
      }
      this.assertAvailable();
      await this.opts.collaborationSpaces.resumePendingTargets();
      this.assertAvailable();
      await this.startPreparedChannels(sessions);
      this.preparedChannels = null;
      this.assertAvailable();
      await this.opts.scheduler.start();
      this.assertAvailable();
      await this.opts.teams.startSchedulers();
      this.assertAvailable();
      this.started = true;
    } catch (error) {
      this.opts.workflows.closeAdmission();
      this.opts.channelRoutes.revokeSessionLeases();
      this.opts.admittedTasks.closeAdmission();
      const rollbackFailures: unknown[] = [];
      await collectShutdownFailure(rollbackFailures, () =>
        this.opts.workflows.rollbackStart());
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
          collaborationSpaces: this.opts.collaborationSpaces,
          agent: this.agent_,
          log: this.opts.log,
        }));
      this.preparedChannels = null;
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

  private async startPreparedChannels(
    sessions: Map<string, ChannelSession>,
  ): Promise<void> {
    const liveChannels = new Map<string, ChannelSession>();
    for (const [channelId, session] of sessions) {
      const coreEvents = this.opts.coreEvents.createSource(channelId);
      const strictRoutes = this.opts.channelRoutes.createSessionLease(channelId);
      await session.start({
        deliver: (turn, envelope) =>
          this.opts.channelRoutes.route(channelId, turn, envelope),
        targetLifecycle: (event) =>
          handleCollaborationTargetLifecycle({
            dispatcherId: this.opts.dispatcherId,
            dispatcherAgentRuntime: this.dispatcherAgentRuntime(),
            channelId,
            event,
            channels: this.opts.channels,
            collaborationSpaces: this.opts.collaborationSpaces,
            log: this.opts.log,
          }),
        coreEvents: coreEvents.source,
        ensureCollaborationTarget: strictRoutes.ensure,
        deliverExact: strictRoutes.deliverExact,
      });
      this.assertAvailable();
      liveChannels.set(channelId, session);
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
