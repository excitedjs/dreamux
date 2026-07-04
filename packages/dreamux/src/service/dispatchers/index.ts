import type { AgentRuntimeProviderCatalog } from '../../agent-runtime/index.js';
import type { ChannelProviderCatalog } from '../../channel/catalog.js';
import type { SubscribeChannelProviderCatalog } from '../../subscribe-channel/catalog.js';
import type { DreamuxConfig } from '../../config/config.js';
import type { RestartIntentConsumer } from '../../daemon/restart-intent.js';
import type { DispatcherStore } from '../../state/dispatcher-store.js';
import type { DreamuxLogger } from '@excitedjs/dreamux-types';
import { AgentIdentityStore } from '../agent-entity/identity-store.js';
import {
  DispatcherService,
  type DispatcherServiceOptions,
  type DispatcherSummary,
  type DispatcherRuntimeStatus,
} from '../dispatcher-service/index.js';
import { runtimeStatusToIdentityStatus } from '../agent-entity/types.js';

export interface DispatchersOptions {
  config: DreamuxConfig;
  dispatchers: DispatcherStore;
  agentRuntimeProviders: AgentRuntimeProviderCatalog;
  channelProviders: ChannelProviderCatalog;
  subscribeChannelProviders: SubscribeChannelProviderCatalog;
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
  private readonly subscribeChannelProviders: SubscribeChannelProviderCatalog;
  private readonly adminSocketPath: string | undefined;
  private readonly channelLoggerFactory: (dispatcherId: string) => DreamuxLogger;
  private readonly log: DreamuxLogger;
  private restartIntent: RestartIntentConsumer | null = null;

  constructor(opts: DispatchersOptions) {
    this.config = opts.config;
    this.dispatcherStore = opts.dispatchers;
    this.agentRuntimeProviders = opts.agentRuntimeProviders;
    this.channelProviders = opts.channelProviders;
    this.subscribeChannelProviders = opts.subscribeChannelProviders;
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

  async summarize(): Promise<DispatcherSummary[]> {
    const identities = new AgentIdentityStore({
      warn: this.log.warn.bind(this.log),
    });
    return Promise.all(this.dispatcherStore.list().map(async (row) => {
      const service = this.services.get(row.dispatcher_id);
      const live = service?.liveRuntimeStatus() ?? null;
      if (live !== null) {
        return {
          dispatcher_id: row.dispatcher_id,
          channel_identity: row.channel_identity,
          status: live.status === null
            ? 'stopped'
            : runtimeStatusToIdentityStatus(live.status),
          thread_id: live.threadId,
          enabled: row.enabled === 1,
        };
      }
      const identity = await identities.dispatcherIdentity(row.dispatcher_id);
      return {
        dispatcher_id: row.dispatcher_id,
        channel_identity: row.channel_identity,
        status: identity?.status ?? 'stopped',
        thread_id: identity?.session_id ?? null,
        enabled: row.enabled === 1,
      };
    }));
  }

  async status(id: string): Promise<DispatcherRuntimeStatus> {
    const service = this.services.get(id);
    const live = service?.liveRuntimeStatus() ?? null;
    if (live !== null) return live;
    const identities = new AgentIdentityStore({
      warn: this.log.warn.bind(this.log),
    });
    const identity = await identities.dispatcherIdentity(id);
    return {
      status: identity?.status ?? null,
      threadId: identity?.session_id ?? null,
      lastError: identity?.last_error ?? null,
    };
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
      subscribeChannelProviders: this.subscribeChannelProviders,
      ...(this.adminSocketPath !== undefined
        ? { adminSocketPath: this.adminSocketPath }
        : {}),
      channelLoggerFactory: this.channelLoggerFactory,
      log: this.log,
    };
  }
}
