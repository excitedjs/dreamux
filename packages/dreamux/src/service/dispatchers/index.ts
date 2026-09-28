import type { AgentRuntimeProviderCatalog } from '../../agent-runtime/index.js';
import type { ChannelProviderCatalog } from '../../channel/catalog.js';
import type { DispatcherConfig } from '../../config/config.js';
import type { ConfigReader } from '../../config/service.js';
import type { RestartIntentConsumer } from '../dispatcher-service/restart-intent.js';
import type { DispatcherStore } from '../../state/dispatcher-store.js';
import type { Dispatcher, DreamuxLogger } from '@excitedjs/dreamux-types';
import type { CoreCommandRegistry } from '../../command/types.js';
import type { SyncHook } from 'tapable';
import { readAgentIdentity } from '../agent/store.js';
import type { AgentEntityIdentity } from '../agent/identity.js';
import { dispatcherDir } from '../../platform/paths.js';
import {
  DispatcherService,
  type DispatcherServiceOptions,
} from '../dispatcher-service/index.js';
import type {
  DispatcherRuntimeStatus,
  DispatcherSummary,
} from '../dispatcher-service/types.js';
import type { McpLeaseRegistry } from '../mcp/leases.js';
import { identityStatusToRuntimeStatus } from '../dispatcher-service/agent.js';
import { throwSettledFailures } from '../../platform/shutdown-errors.js';
import { errorInfo } from '@excitedjs/dreamux-utils';

export interface DispatchersOptions {
  config: ConfigReader;
  dispatchers: DispatcherStore;
  agentRuntimeProviders: AgentRuntimeProviderCatalog;
  channelProviders: ChannelProviderCatalog;
  /** The process-wide Agent-facing MCP lease registry every dispatcher mints into. */
  mcpLeases: McpLeaseRegistry;
  /**
   * The one restart marker this process loaded at boot (issue #78), resolved
   * once by `server.ts` before this collection is constructed. A constructor
   * value rather than a setter: every `DispatcherService` this collection
   * builds afterward receives the same already-loaded consumer directly.
   */
  restartIntent: RestartIntentConsumer;
  /** The process-wide admitted Command port every Channel session invokes through. */
  commands: CoreCommandRegistry;
  homePathPrefixes: readonly string[];
  adminSocketPath?: string;
  channelLoggerFactory: (dispatcherId: string) => DreamuxLogger;
  workflowLoggerFactory?: ((dispatcherId: string) => DreamuxLogger) | undefined;
  /** The host `dispatcher` hook, fired once per constructed DispatcherService. */
  dispatcherHook: SyncHook<[Dispatcher]>;
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
  private readonly config: ConfigReader;
  private readonly dispatcherStore: DispatcherStore;
  private readonly agentRuntimeProviders: AgentRuntimeProviderCatalog;
  private readonly channelProviders: ChannelProviderCatalog;
  private readonly mcpLeases: McpLeaseRegistry;
  private readonly commands: CoreCommandRegistry;
  private readonly homePathPrefixes: readonly string[];
  private readonly adminSocketPath: string | undefined;
  private readonly channelLoggerFactory: (
    dispatcherId: string,
  ) => DreamuxLogger;
  private readonly workflowLoggerFactory:
    ((dispatcherId: string) => DreamuxLogger) | undefined;
  private readonly dispatcherHook: SyncHook<[Dispatcher]>;
  private readonly log: DreamuxLogger;
  private readonly restartIntent: RestartIntentConsumer;
  private accepting = true;

  constructor(opts: DispatchersOptions) {
    this.config = opts.config;
    this.dispatcherStore = opts.dispatchers;
    this.agentRuntimeProviders = opts.agentRuntimeProviders;
    this.channelProviders = opts.channelProviders;
    this.mcpLeases = opts.mcpLeases;
    this.restartIntent = opts.restartIntent;
    this.commands = opts.commands;
    this.homePathPrefixes = opts.homePathPrefixes;
    this.adminSocketPath = opts.adminSocketPath;
    this.channelLoggerFactory = opts.channelLoggerFactory;
    this.workflowLoggerFactory = opts.workflowLoggerFactory;
    this.dispatcherHook = opts.dispatcherHook;
    this.log = opts.log;
  }

  /**
   * A stateless snapshot read of one dispatcher's own root Agent identity, for
   * {@link summarize} and {@link status}'s fallback when no live runtime
   * status exists. Fresh every call rather than cached: `DispatcherService`
   * owns the writing store once it materializes, so this collection never
   * needs — and must never hold — its own committed copy of the same file.
   */
  private rootIdentity(
    dispatcherId: string,
  ): Promise<AgentEntityIdentity | null> {
    return readAgentIdentity({
      dir: dispatcherDir(dispatcherId),
      dispatcherId,
      expectedName: null,
      log: this.log,
    });
  }

  get(id: string): DispatcherService {
    let service = this.services.get(id);
    if (service === undefined) {
      if (!this.accepting) {
        throw new Error('dreamux dispatchers are shutting down');
      }
      service = new DispatcherService(this.dispatcherOptions(id));
      this.services.set(id, service);
      // After `set`, so a tap that re-enters `get(id)` receives this object.
      // Every tap and every plugin-added interceptor on this hook is isolated
      // at hook construction (`isolatedTaps`), so `call` never throws.
      this.dispatcherHook.call(service);
    }
    return service;
  }

  async summarize(): Promise<DispatcherSummary[]> {
    return Promise.all(
      this.dispatcherStore.list().map(async (row) => {
        const service = this.services.get(row.dispatcher_id);
        const live = service?.liveRuntimeStatus() ?? null;
        if (live !== null) {
          return {
            dispatcher_id: row.dispatcher_id,
            channel_identity: row.channel_identity,
            status: live.status,
            session_id: live.sessionId,
            enabled: row.enabled === 1,
          };
        }
        const identity = await this.rootIdentity(row.dispatcher_id);
        return {
          dispatcher_id: row.dispatcher_id,
          channel_identity: row.channel_identity,
          status: identityStatusToRuntimeStatus(identity?.status ?? null),
          session_id: identity?.session_id ?? null,
          enabled: row.enabled === 1,
        };
      }),
    );
  }

  async status(id: string): Promise<DispatcherRuntimeStatus> {
    const service = this.services.get(id);
    const live = service?.liveRuntimeStatus() ?? null;
    if (live !== null) return live;
    const identity = await this.rootIdentity(id);
    return {
      status: identityStatusToRuntimeStatus(identity?.status ?? null),
      sessionId: identity?.session_id ?? null,
      lastError: identity?.last_error ?? null,
    };
  }

  /**
   * Start every enabled dispatcher — the counterpart to {@link shutdown}.
   * Sequential and log-and-continue, not aggregate-and-throw: one
   * dispatcher's start failure must not stop the others from starting or
   * abort the whole boot (`Server.start()` used to run this exact loop
   * itself).
   */
  async start(): Promise<void> {
    for (const row of this.dispatcherStore.listEnabled()) {
      try {
        await this.get(row.dispatcher_id).start();
      } catch (err) {
        this.log.error(
          {
            dispatcher_id: row.dispatcher_id,
            err: errorInfo(err),
          },
          'dispatcher failed to start',
        );
      }
    }
  }

  /**
   * Close every already-materialized dispatcher (R10/R11: one terminal close,
   * no separate begin/end phase). `accepting` is fenced first, synchronously,
   * so nothing new can materialize once this has started; never construct a
   * dispatcher during shutdown.
   */
  async shutdown(): Promise<void> {
    this.accepting = false;
    const results = await Promise.allSettled(
      [...this.services.values()].map((service) => service.close()),
    );
    throwSettledFailures(results, 'multiple dispatchers failed to shut down');
  }

  /**
   * The one canonical read of this dispatcher's own config entry — resolved
   * here, once, rather than by each of `DispatcherService` and
   * `ChannelService` re-deriving the same
   * `config.current().dispatchers.find(...)` lookup independently. The
   * message matches `configuredDispatcherCwd`'s own fail-loud text for the
   * same fact, since this is now the earlier of the two checks to run.
   */
  private dispatcherConfig(id: string): DispatcherConfig {
    const dispatcher = this.config
      .current()
      .dispatchers.find((entry) => entry.id === id);
    if (dispatcher === undefined) {
      throw new Error(`dispatcher ${JSON.stringify(id)} is not configured`);
    }
    return dispatcher;
  }

  private dispatcherOptions(id: string): DispatcherServiceOptions {
    return {
      id,
      dispatcher: this.dispatcherConfig(id),
      config: this.config,
      dispatchers: this.dispatcherStore,
      agentRuntimeProviders: this.agentRuntimeProviders,
      channelProviders: this.channelProviders,
      mcpLeases: this.mcpLeases,
      restartIntent: this.restartIntent,
      commands: this.commands,
      homePathPrefixes: this.homePathPrefixes,
      adminSocketPath: this.adminSocketPath,
      channelLoggerFactory: this.channelLoggerFactory,
      workflowLoggerFactory: this.workflowLoggerFactory,
      log: this.log,
    };
  }
}
