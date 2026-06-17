import type { AgentRuntimeProviderCatalog } from '../agent-runtime/index.js';
import type { ChannelProviderCatalog } from '../channel/catalog.js';
import type { DreamuxConfig } from '../config/config.js';
import type { RestartIntentConsumer } from '../daemon/restart-intent.js';
import type { DispatcherStore } from '../state/dispatcher-store.js';
import type { DreamuxLogger } from '@excitedjs/dreamux-types';
import {
  DispatcherService,
  type DispatcherServiceOptions,
} from './dispatcher-instance.js';
export { DispatcherService } from './dispatcher-instance.js';
export { TeamService } from './team/service.js';
import type { DispatcherSummary } from './dispatcher/service.js';
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

/**
 * The process-level dispatcher collection (issue #233): a thin factory + cache
 * over per-dispatcher {@link DispatcherService} aggregates plus process-wide
 * shutdown/restart hooks. It owns no teammate/team/channel state — each
 * `DispatcherService` builds and owns its own object graph (collections, stores,
 * worktree manager, router, runtime). This collection only keys them by id.
 */
export class Dispatchers {
  private readonly services = new Map<string, DispatcherService>();
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
  }

  get(id: string): DispatcherService {
    let service = this.services.get(id);
    if (service === undefined) {
      service = new DispatcherService(this.dispatcherOptions(id));
      service.setRestartIntent(this.restartIntent);
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
    for (const service of this.services.values()) {
      await service.shutdown();
    }
  }

  private dispatcherOptions(id: string): DispatcherServiceOptions {
    return {
      id,
      config: this.config,
      dispatchers: this.dispatcherStore,
      agentRuntimeProviders: this.agentRuntimeProviders,
      channelProviders: this.channelProviders,
      ...(this.adminSocketPath !== undefined
        ? { adminSocketPath: this.adminSocketPath }
        : {}),
      channelLoggerFactory: this.channelLoggerFactory,
      log: this.log,
    };
  }
}
