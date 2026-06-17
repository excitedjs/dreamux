import type { AgentRuntimeProviderCatalog } from '../agent-runtime/index.js';
import type { ChannelProviderCatalog } from '../channel/catalog.js';
import type { DreamuxConfig } from '../config/config.js';
import type { RestartIntentConsumer } from '../daemon/restart-intent.js';
import { adminSocketPath as defaultAdminSocketPath } from '../platform/paths.js';
import type { DispatcherStore } from '../state/dispatcher-store.js';
import type { DreamuxLogger } from '@excitedjs/dreamux-types';
import {
  DispatcherService,
  type DispatcherServiceOptions,
} from './dispatcher-instance.js';
export { DispatcherService } from './dispatcher-instance.js';
export { TeamService } from './team/service.js';
import {
  DispatcherRuntimeService,
  type DispatcherSummary,
} from './dispatcher/service.js';
import { CompletionRouter } from './teammate/completion-router.js';
import { TeamCollection } from './team/service.js';
import { teammateMcpServerDescriptor } from './teammate/mcp-config.js';
import { TeammateCollection } from './teammate/service.js';
export { ChannelToolAuthorizationError } from './errors.js';

export interface DispatchersOptions {
  config: DreamuxConfig;
  dispatchers: DispatcherStore;
  agentRuntimeProviders: AgentRuntimeProviderCatalog;
  channelProviders: ChannelProviderCatalog;
  adminSocketPath?: string;
  channelLoggerFactory: (dispatcherId: string) => DreamuxLogger;
  log: DreamuxLogger;
}

export class Dispatchers {
  private readonly teammates: TeammateCollection;
  private readonly teams: TeamCollection;
  private readonly services = new Map<string, DispatcherService>();
  private readonly routers = new Map<string, CompletionRouter>();
  private readonly config: DreamuxConfig;
  private readonly dispatcherStore: DispatcherStore;
  private readonly agentRuntimeProviders: AgentRuntimeProviderCatalog;
  private readonly channelProviders: ChannelProviderCatalog;
  private readonly adminSocketPath: string | undefined;
  private readonly channelLoggerFactory: (dispatcherId: string) => DreamuxLogger;
  private readonly log: DreamuxLogger;
  private restartIntent: RestartIntentConsumer | null = null;

  constructor(opts: DispatchersOptions) {
    this.config = opts.config;
    this.dispatcherStore = opts.dispatchers;
    this.agentRuntimeProviders = opts.agentRuntimeProviders;
    this.channelProviders = opts.channelProviders;
    this.adminSocketPath = opts.adminSocketPath;
    this.channelLoggerFactory = opts.channelLoggerFactory;
    this.log = opts.log;
    this.teammates = new TeammateCollection({
      config: opts.config,
      dispatchers: opts.dispatchers,
      agentRuntimeProviders: opts.agentRuntimeProviders,
      mcpServersForTeamMate: ({ dispatcherId, identity }) =>
        identity.role === 'team_leader'
          ? [
              teammateMcpServerDescriptor({
                dispatcherId,
                callerKind: 'team_leader',
                teamId: identity.team_id ?? '',
                adminSocketPath: opts.adminSocketPath ?? defaultAdminSocketPath(),
              }),
              ...this.get(dispatcherId).channelMcpServerDescriptorsForCaller({
                callerKind: 'team_leader',
                team_id: identity.team_id ?? '',
                leader_name: identity.name,
              }),
            ]
          : [],
      routerFor: (id) => this.routerFor(id),
      initiatorFor: (id, producer) => this.get(id).initiatorFor(producer),
      log: opts.log,
    });
    this.teams = new TeamCollection({
      teammates: this.teammates,
    });
  }

  get(id: string): DispatcherService {
    let service = this.services.get(id);
    if (service === undefined) {
      service = new DispatcherService(this.dispatcherOptions(id));
      this.services.set(id, service);
    }
    return service;
  }

  setRestartIntent(consumer: RestartIntentConsumer | null): void {
    this.restartIntent = consumer;
    for (const service of this.services.values()) {
      service.setRestartIntent(consumer);
    }
  }

  summarize(): DispatcherSummary[] {
    return this.dispatcherStore.list().map((row) => {
      const service = this.services.get(row.dispatcher_id);
      return (
        service?.summary(row) ?? {
          dispatcher_id: row.dispatcher_id,
          channel_identity: row.channel_identity,
          status: row.status,
          thread_id: row.thread_id,
          enabled: row.enabled === 1,
        }
      );
    });
  }

  async shutdown(): Promise<void> {
    await this.teammates.stopAll();
    for (const service of this.services.values()) {
      await service.shutdown();
    }
  }

  /**
   * The per-dispatcher delivery router (issue #233). One instance per dispatcher
   * id, created lazily; the process-wide `TeammateCollection` reaches it via the
   * injected `routerFor` callback so it stays a singleton while delivery topology
   * stays per-dispatcher.
   */
  private routerFor(id: string): CompletionRouter {
    let router = this.routers.get(id);
    if (router === undefined) {
      router = new CompletionRouter({ dispatcherId: id, log: this.log });
      this.routers.set(id, router);
    }
    return router;
  }

  private dispatcherOptions(id: string): DispatcherServiceOptions {
    const dispatcherRuntime = new DispatcherRuntimeService({
      id,
      config: this.config,
      dispatchers: this.dispatcherStore,
      agentRuntimeProviders: this.agentRuntimeProviders,
      channelProviders: this.channelProviders,
      log: this.log,
      channelLoggerFactory: this.channelLoggerFactory,
      ...(this.adminSocketPath !== undefined
        ? { adminSocketPath: this.adminSocketPath }
        : {}),
      routeChannelInput: (channelId, turn, envelope, hooks) =>
        this.get(id).routeChannelInput(channelId, turn, envelope, hooks),
    });
    dispatcherRuntime.setRestartIntent(this.restartIntent);
    return {
      id,
      config: this.config,
      dispatcherRuntime,
      teammates: this.teammates,
      teams: this.teams,
    };
  }
}
