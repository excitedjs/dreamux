import type { AgentRuntimeProviderCatalog } from '../../agent-runtime/index.js';
import type { ChannelProviderCatalog } from '../../channel/catalog.js';
import type { DreamuxConfig } from '../../config/config.js';
import type { RestartIntentConsumer } from '../../daemon/restart-intent.js';
import type { DispatcherStore } from '../../state/dispatcher-store.js';
import type {
  CoreCommandRegistry,
  DreamuxLogger,
} from '@excitedjs/dreamux-types';
import { AgentIdentityStore } from '../agent-entity/identity-store.js';
import { dispatcherDir } from '../../platform/paths.js';
import { DispatcherService } from '../dispatcher-service/index.js';
import type {
  DispatcherRuntimeStatus,
  DispatcherServiceOptions,
  DispatcherSummary,
} from '../dispatcher-service/types.js';
import type { McpLeaseRegistry } from '../mcp/leases.js';
import { runtimeStatusToIdentityStatus } from '../agent-entity/types.js';
import { throwSettledFailures } from '../shutdown-errors.js';

export interface DispatchersOptions {
  config: DreamuxConfig;
  dispatchers: DispatcherStore;
  agentRuntimeProviders: AgentRuntimeProviderCatalog;
  channelProviders: ChannelProviderCatalog;
  /** The process-wide Agent-facing MCP lease registry every dispatcher mints into. */
  mcpLeases: McpLeaseRegistry;
  /** The process-wide admitted Command port every Channel session invokes through. */
  commands: CoreCommandRegistry;
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
  private readonly mcpLeases: McpLeaseRegistry;
  private readonly commands: CoreCommandRegistry;
  private readonly adminSocketPath: string | undefined;
  private readonly channelLoggerFactory: (dispatcherId: string) => DreamuxLogger;
  private readonly workflowLoggerFactory:
    | ((dispatcherId: string) => DreamuxLogger)
    | undefined;
  private readonly log: DreamuxLogger;
  /**
   * Read-only readers for each dispatcher's own root Agent identity, shared by
   * {@link summarize} and {@link status} (issue #233 / PR #282 review). Each is
   * bound to one dispatcher root here, at this composition boundary, and cached
   * so the read-model probes don't rebuild one per row. A plain reader — never a
   * DispatcherService trigger: it does not prepare or start any aggregate.
   */
  private readonly rootIdentities = new Map<string, AgentIdentityStore>();
  private restartIntent: RestartIntentConsumer | null = null;
  private accepting = true;

  constructor(opts: DispatchersOptions) {
    this.config = opts.config;
    this.dispatcherStore = opts.dispatchers;
    this.agentRuntimeProviders = opts.agentRuntimeProviders;
    this.channelProviders = opts.channelProviders;
    this.mcpLeases = opts.mcpLeases;
    this.commands = opts.commands;
    this.adminSocketPath = opts.adminSocketPath;
    this.channelLoggerFactory = opts.channelLoggerFactory;
    this.workflowLoggerFactory = opts.workflowLoggerFactory;
    this.log = opts.log;
  }

  private rootIdentity(dispatcherId: string): AgentIdentityStore {
    let store = this.rootIdentities.get(dispatcherId);
    if (store === undefined) {
      store = new AgentIdentityStore({
        dir: dispatcherDir(dispatcherId),
        dispatcherId,
        expectedName: null,
        log: this.log,
      });
      this.rootIdentities.set(dispatcherId, store);
    }
    return store;
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
          session_id: live.sessionId,
          enabled: row.enabled === 1,
        };
      }
      const identity = await this.rootIdentity(row.dispatcher_id).read();
      return {
        dispatcher_id: row.dispatcher_id,
        channel_identity: row.channel_identity,
        status: identity?.status ?? 'stopped',
        session_id: identity?.session?.id ?? null,
        enabled: row.enabled === 1,
      };
    }));
  }

  async status(id: string): Promise<DispatcherRuntimeStatus> {
    const service = this.services.get(id);
    const live = service?.liveRuntimeStatus() ?? null;
    if (live !== null) return live;
    const identity = await this.rootIdentity(id).read();
    return {
      status: identity?.status ?? null,
      sessionId: identity?.session?.id ?? null,
      lastError: identity?.last_error ?? null,
    };
  }

  async shutdown(): Promise<void> {
    this.beginShutdown();
    const results = await Promise.allSettled(
      [...this.services.values()].map((service) => service.shutdown()),
    );
    throwSettledFailures(results, 'multiple dispatchers failed to shut down');
  }

  /** Fence only already-materialized aggregates; never construct during shutdown. */
  beginShutdown(): void {
    this.accepting = false;
    for (const service of this.services.values()) service.beginShutdown();
  }

  private dispatcherOptions(id: string): DispatcherServiceOptions {
    return {
      id,
      config: this.config,
      dispatchers: this.dispatcherStore,
      agentRuntimeProviders: this.agentRuntimeProviders,
      channelProviders: this.channelProviders,
      mcpLeases: this.mcpLeases,
      commands: this.commands,
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
