import type { AgentRuntimeProviderCatalog } from '../../agent-runtime/index.js';
import type { ChannelProviderCatalog } from '../../channel/catalog.js';
import type { DreamuxConfig } from '../../config/config.js';
import type { RestartIntentConsumer } from '../../daemon/restart-intent.js';
import type { DispatcherStore } from '../../state/dispatcher-store.js';
import type { DreamuxLogger } from '@excitedjs/dreamux-types';
import { AgentIdentityStore } from '../agent-entity/identity-store.js';
import { DispatcherService } from '../dispatcher-service/index.js';
import type {
  DispatcherRuntimeStatus,
  DispatcherServiceOptions,
  DispatcherSummary,
} from '../dispatcher-service/types.js';
import { runtimeStatusToIdentityStatus } from '../agent-entity/types.js';
import { throwShutdownFailures } from '../shutdown-errors.js';

export interface DispatchersOptions {
  config: DreamuxConfig;
  dispatchers: DispatcherStore;
  agentRuntimeProviders: AgentRuntimeProviderCatalog;
  channelProviders: ChannelProviderCatalog;
  adminSocketPath?: string;
  channelLoggerFactory: (dispatcherId: string) => DreamuxLogger;
  workflowLoggerFactory?: (dispatcherId: string) => DreamuxLogger;
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
  private readonly workflowLoggerFactory:
    | ((dispatcherId: string) => DreamuxLogger)
    | undefined;
  private readonly log: DreamuxLogger;
  /**
   * Read-only identity reader shared by {@link summarize} and {@link status}
   * (issue #233 / PR #282 review). Built once so the read-model probes don't
   * `new` a throwaway store per dispatcher row. This is a plain path-based
   * reader, never a DispatcherService trigger — it does not prepare or start
   * any aggregate.
   */
  private readonly identities: AgentIdentityStore;
  private restartIntent: RestartIntentConsumer | null = null;
  private accepting = true;

  constructor(opts: DispatchersOptions) {
    this.config = opts.config;
    this.dispatcherStore = opts.dispatchers;
    this.agentRuntimeProviders = opts.agentRuntimeProviders;
    this.channelProviders = opts.channelProviders;
    this.adminSocketPath = opts.adminSocketPath;
    this.channelLoggerFactory = opts.channelLoggerFactory;
    this.workflowLoggerFactory = opts.workflowLoggerFactory;
    this.log = opts.log;
    this.identities = new AgentIdentityStore(opts.log);
  }

  get(id: string): DispatcherService {
    let service = this.services.get(id);
    if (service === undefined) {
      if (!this.accepting) {
        throw new Error('dreamux dispatchers are shutting down');
      }
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
      const identity = await this.identities.dispatcherIdentity(row.dispatcher_id);
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
    const identity = await this.identities.dispatcherIdentity(id);
    return {
      status: identity?.status ?? null,
      threadId: identity?.session_id ?? null,
      lastError: identity?.last_error ?? null,
    };
  }

  async shutdown(): Promise<void> {
    this.accepting = false;
    const results = await Promise.allSettled(
      [...this.services.values()].map((service) => service.shutdown()),
    );
    const failures = results
      .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
      .map((result) => result.reason);
    throwShutdownFailures(failures, 'multiple dispatchers failed to shut down');
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
      ...(this.workflowLoggerFactory !== undefined
        ? { workflowLoggerFactory: this.workflowLoggerFactory }
        : {}),
      log: this.log,
    };
  }
}
