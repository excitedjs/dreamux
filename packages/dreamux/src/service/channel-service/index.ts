/**
 * Core's whole relationship with its Channels: build them, hold them, hand a
 * caller the one object it needs, close them.
 *
 * There is no binding table behind this any more, and no route owner. A
 * Channel decides where a message goes and says so by naming a Team; Core
 * neither stores that decision nor reconstructs it, which is why nothing here
 * resolves a target or authorizes an egress.
 *
 * This is also the single owner of a channel session's whole lifecycle, not
 * just its live/built maps: the runnable-shape guard, the per-session
 * initialize/start sequencing, the Core port lease that fences a session's
 * Command admission, and the Channel MCP delegate assembly all live here too,
 * because each one reads the same configured-channel/provider facts this
 * class already holds. A dispatcher-scoped caller (`DispatcherService`,
 * `DispatcherLifecycle`) drives this class through its lifecycle
 * verbs; it holds no channel state of its own.
 */
import type { WorkAdmission, WorkFence } from '../../platform/work-fence.js';
import type {
  ChannelInstance,
  ChannelMcpCaller,
  ChannelSessionMcpCapability,
  DreamuxLogger,
} from '@excitedjs/dreamux-types';

import { errorInfo } from '@excitedjs/dreamux-utils';
import type {
  ChannelProviderCatalog,
  RegisteredChannelProvider,
} from '../../channel/catalog.js';
import type { CoreCommandRegistry } from '../../command/types.js';
import type {
  DispatcherChannelConfig,
  DispatcherConfig,
} from '../../config/config.js';
import { dispatcherCacheDir, dispatcherDir } from '../../platform/paths.js';
import {
  collectShutdownFailure,
  throwShutdownFailures,
} from '../../platform/shutdown-errors.js';
import type { DispatcherCoreEventBus } from '../dispatcher-core-events/index.js';
import type { McpServerDelegate } from '../mcp/types.js';
import {
  createChannelCorePort,
  type ChannelCorePortLease,
} from './core-port.js';
import { createChannelMcpDelegate } from './mcp-delegate.js';

/** Public Channel inventory fields, independent of provider configuration. */
export interface ChannelMetadata {
  channel_id: string;
  provider: string;
  identity: string;
  live: boolean;
}

export interface ChannelServiceOptions {
  dispatcherId: string;
  /**
   * This dispatcher's own config entry, resolved once by the caller that
   * already looked it up (`Dispatchers.dispatcherOptions()`) rather than
   * re-derived here from a live `ConfigReader`. `dispatchers[]` is never
   * touched by `config.agents.replace`, so there is no live fact this class
   * would otherwise need to observe.
   */
  dispatcher: DispatcherConfig;
  channelProviders: ChannelProviderCatalog;
  /** File-backed loggers are allocated only when channel sessions are built. */
  channelLoggerFactory: (dispatcherId: string) => DreamuxLogger;
  /** This dispatcher's live Core-fact bus: every initialized session's event source, and the one place a stop revokes them all. */
  coreEvents: DispatcherCoreEventBus;
  /**
   * The Server-owned admitted Command port every Channel session invokes
   * through. It is the same port the admin socket uses; a Channel never
   * reaches the raw registry.
   */
  commands: CoreCommandRegistry;
  log: DreamuxLogger;
}

/**
 * One configured channel's whole runtime state: the instance {@link build}
 * produced, the Core port lease {@link initialize} minted for it (`null`
 * until then), and whether {@link start} has opened its external input yet.
 *
 * A single entry answers both "built" and "live" questions instead of two
 * parallel maps: `sessionMcp`/`mcpDelegates` read every entry regardless of
 * `live`, because a channel's MCP composition exists from creation, while
 * `list()`'s `live` field and the entry a stop closes both need the flag.
 */
interface ChannelEntry {
  readonly instance: ChannelInstance;
  portLease: ChannelCorePortLease | null;
  live: boolean;
}

export class ChannelService {
  private readonly entries = new Map<string, ChannelEntry>();
  /**
   * Resolved from the catalog at most once per channel id, whichever caller
   * asks first — {@link assertRunnable}, {@link build}, or an MCP delegate
   * assembly for a Team leader launched before this dispatcher's own channels
   * ever prepare. Providers never change after config load, so there is no
   * invalidation to do.
   */
  private readonly providers = new Map<string, RegisteredChannelProvider>();
  private readonly channelConfigs_: readonly DispatcherChannelConfig[];

  constructor(private readonly opts: ChannelServiceOptions) {
    this.channelConfigs_ = opts.dispatcher.channels;
  }

  private provider(
    channelConfig: DispatcherChannelConfig,
  ): RegisteredChannelProvider {
    let resolved = this.providers.get(channelConfig.id);
    if (resolved === undefined) {
      resolved = this.opts.channelProviders.resolve(channelConfig.provider);
      this.providers.set(channelConfig.id, resolved);
    }
    return resolved;
  }

  /**
   * Fail loud on any configured channel whose provider does not resolve to a
   * loaded implementation (issue #209 multi-channel config).
   *
   * Config accepts the general multi-channel shape — a channel may name any
   * registered provider — so a channel is RUNNABLE when its provider resolves
   * here; core names no concrete provider, so any builtin or npm channel
   * provider that loaded is runnable. This is the single intended runtime
   * boundary where an "accepted by config, not yet runnable" shape fails
   * loud: state construction (the dispatcher store) stays fail-soft so the
   * failure surfaces here at launch, not earlier during seeding.
   */
  assertRunnable(): void {
    for (const channelConfig of this.channelConfigs_) {
      try {
        this.provider(channelConfig);
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        throw new Error(
          `dispatcher '${this.opts.dispatcherId}' channel ${JSON.stringify(channelConfig.provider)} is not runnable: ${reason}`,
        );
      }
    }
  }

  /**
   * Build the un-started channel sessions for the dispatcher from its
   * configured channels. Each provider's already-validated `readConfig`
   * yields the provider config view, then `createSession` builds the session
   * through the create context. Sessions are NOT connected here — the caller
   * initializes and starts them. On partial failure the already-built
   * sessions are closed and nothing is published.
   */
  async build(): Promise<Map<string, ChannelInstance>> {
    const providerLog = this.opts.channelLoggerFactory(this.opts.dispatcherId);
    const built = new Map<string, ChannelInstance>();
    try {
      for (const channelConfig of this.channelConfigs_) {
        const { implementation: provider } = this.provider(channelConfig);
        built.set(
          channelConfig.id,
          await provider.createSession({
            dispatcher_id: this.opts.dispatcherId,
            channel_id: channelConfig.id,
            provider: channelConfig.provider,
            config: channelConfig.config,
            logger: providerLog,
            state_root: dispatcherDir(this.opts.dispatcherId),
            cache_root: dispatcherCacheDir(this.opts.dispatcherId),
          }),
        );
      }
    } catch (err) {
      await closeBestEffort(built);
      throw err;
    }
    // Published only once every instance exists: the failure path above
    // already closed what it had built, and a map of closed instances must
    // never become the answer to an availability question.
    for (const [channelId, instance] of built) {
      this.entries.set(channelId, { instance, portLease: null, live: false });
    }
    return built;
  }

  /**
   * Hand every built session its Core port.
   *
   * This is the step that makes subscribe-before-admission provable: a
   * session attaches its event consumer here, while its own external input is
   * still closed, so nothing Core recovers or settles later can precede the
   * subscription that observes it. The contract forbids opening external I/O
   * from `initialize`, which is why this and {@link start} are separate
   * calls at all. Sequential and in configuration order, so a mid-loop
   * failure leaves every earlier session's lease already fenceable.
   */
  async initialize(fence: Pick<WorkFence, 'assertOpen'>): Promise<void> {
    for (const [channelId, entry] of this.entries) {
      const events = this.opts.coreEvents.createSource(channelId);
      const lease = createChannelCorePort({
        registry: this.opts.commands,
        dispatcherId: this.opts.dispatcherId,
        channelId,
        events: events.source,
        log: this.opts.log,
      });
      entry.portLease = lease;
      await entry.instance.session.initialize(lease.port);
      fence.assertOpen();
    }
  }

  /**
   * Open external input, one already-initialized session at a time.
   *
   * `start` takes nothing further: the session was given its Core port at
   * `initialize`, and what it does with external traffic — routing, binding,
   * presentation — is the Channel's own. A session is published as live only
   * after its own start returns.
   */
  async start(fence: Pick<WorkFence, 'assertOpen'>): Promise<void> {
    for (const entry of this.entries.values()) {
      await entry.instance.session.start();
      fence.assertOpen();
      entry.live = true;
    }
  }

  /**
   * Fence every session's Command admission, synchronously and idempotently.
   *
   * Published before any awaited teardown so an initialized session cannot
   * enter Core while shutdown is converging what it already accepted. Event
   * subscriptions deliberately outlive this: a stopping runtime still
   * settles, and those facts are worth delivering.
   */
  closeAdmission(): void {
    for (const entry of this.entries.values()) {
      entry.portLease?.closeAdmission();
    }
  }

  /**
   * Close every entry — live or only built — and report every failure
   * instead of swallowing it.
   *
   * An entry is removed only once its own `session.close()` resolves: a
   * transient close failure (a socket blip) then leaves that entry in the map
   * rather than losing the only handle a retried `closeAll()` could reach it
   * through — the dispatcher-level close retry (`DispatcherLifecycle`) relies
   * on this to converge a channel that failed on a first attempt. No new
   * session is ever built for an id already in the map (`build()` runs once,
   * before `initialize`/`start`, and is never called again on a live
   * dispatcher), so an entry left behind by a failed close is never clobbered
   * by a concurrent rebuild. Admission is fenced synchronously ahead of any
   * await, whether or not the caller
   * already fenced it, and is safe to repeat on a retry (`closeAdmission()`
   * is idempotent). Subscriptions stay attached through everything above — a
   * runtime settling during close still produces facts a Channel should see
   * — and are revoked once, here, immediately before the sessions holding
   * them are closed: any earlier would drop a fact a stopping runtime was
   * about to settle, and any later would let a closed session's stale
   * subscription observe something. `revokeSources()` is safe to repeat on a
   * retry too — it clears its own set and has nothing left to revoke once a
   * first attempt already emptied it.
   */
  async closeAll(): Promise<void> {
    for (const entry of this.entries.values())
      entry.portLease?.closeAdmission();
    this.opts.coreEvents.revokeSources();
    const failures: unknown[] = [];
    for (const [channelId, entry] of [...this.entries]) {
      await collectShutdownFailure(failures, async () => {
        try {
          await entry.instance.session.close();
          this.entries.delete(channelId);
        } catch (err) {
          this.opts.log.error(
            {
              dispatcher_id: this.opts.dispatcherId,
              channel_id: channelId,
              err: errorInfo(err),
            },
            'error closing bot',
          );
          throw err;
        }
      });
    }
    throwShutdownFailures(
      failures,
      `channels for dispatcher ${JSON.stringify(this.opts.dispatcherId)} failed to close`,
    );
  }

  /** Public Channel metadata in configuration order, without starting sessions. */
  list(): ChannelMetadata[] {
    return this.channelConfigs_.map((channelConfig): ChannelMetadata => ({
      channel_id: channelConfig.id,
      provider: channelConfig.provider,
      identity: channelConfig.identity ?? '',
      live: this.entries.get(channelConfig.id)?.live ?? false,
    }));
  }

  /**
   * This dispatcher's Channel MCP delegates, for one caller.
   *
   * A channel whose provider composes no MCP capability at all yields no
   * delegate: there is nothing for one to own. Whether a delegate that does
   * exist ends up advertising anything is decided later and generically, when
   * Core freezes its catalog.
   */
  mcpDelegates(
    caller: ChannelMcpCaller,
    fence: Pick<WorkAdmission, 'admit'>,
    callerScope?: {
      admitLeaderTools<T>(operation: () => Promise<T>): Promise<T>;
      assertOpen(): void;
    },
  ): McpServerDelegate[] {
    const delegates: McpServerDelegate[] = [];
    for (const channelConfig of this.channelConfigs_) {
      const { id: providerId, implementation: provider } =
        this.provider(channelConfig);
      if (provider.mcp === undefined) continue;
      delegates.push(
        createChannelMcpDelegate({
          dispatcherId: this.opts.dispatcherId,
          providerId,
          channelId: channelConfig.id,
          provider,
          config: channelConfig.config,
          caller,
          sessionMcp: this.sessionMcp(channelConfig.id),
          fence,
          callerScope,
        }),
      );
    }
    return delegates;
  }

  /**
   * The MCP capability this channel's created instance composed, or `null`
   * when there is no instance or it composed no session tools.
   *
   * Read regardless of `live`, because this answers a composition question
   * rather than a connectivity one: what a Channel built is what it can
   * serve, for as long as that instance lives.
   */
  private sessionMcp(channelId: string): ChannelSessionMcpCapability | null {
    return this.entries.get(channelId)?.instance.mcp ?? null;
  }
}

/** Close whatever sessions a failed {@link ChannelService.build} produced. */
async function closeBestEffort(
  channels: Map<string, ChannelInstance>,
): Promise<void> {
  for (const instance of channels.values()) {
    try {
      await instance.session.close();
    } catch {
      /* best effort: never started */
    }
  }
}
