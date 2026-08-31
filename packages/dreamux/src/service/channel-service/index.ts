/**
 * Core's whole relationship with its Channels: build them, hold them, hand a
 * caller the one object it needs, close them.
 *
 * There is no binding table behind this any more, and no route owner. A
 * Channel decides where a message goes and says so by naming a Team; Core
 * neither stores that decision nor reconstructs it, which is why nothing here
 * resolves a target or authorizes an egress.
 */
import type {
  ChannelInstance,
  ChannelSessionMcpCapability,
  DreamuxLogger,
} from '@excitedjs/dreamux-types';

import type { ChannelProviderCatalog } from '../../channel/catalog.js';
import type {
  DispatcherChannelConfig,
  DreamuxConfig,
} from '../../config/config.js';
import { errorInfo } from '../../platform/error-info.js';
import {
  dispatcherCacheDir,
  dispatcherDir,
} from '../../platform/paths.js';

export interface ChannelServiceOptions {
  dispatcherId: string;
  config: DreamuxConfig;
  channelProviders: ChannelProviderCatalog;
  channelLoggerFactory: (dispatcherId: string) => DreamuxLogger;
}

/**
 * The live channel instances are the whole of this service's state: the
 * `Map<channel_id, ChannelInstance>` and the session-MCP lookup that keys off
 * it. `DispatcherService` publishes an instance here only after its provider
 * start succeeds.
 *
 * The map holds the whole {@link ChannelInstance}, not just its session,
 * because MCP is composed beside the session rather than on it: a Channel with
 * tools carries a {@link ChannelSessionMcpCapability} that the Channel MCP
 * delegate has to be able to reach. Core stays a blind conduit either way — it
 * never names a provider's tool.
 */
export class ChannelService {
  private sessions: Map<string, ChannelInstance> | null = null;
  /**
   * Every instance {@link build} produced, whether or not its session has been
   * started and adopted yet.
   *
   * Kept beside the live map because the two answer different questions. Live
   * means "this session is connected and may be routed to". Built means "this
   * channel's instance exists, so whatever it composed exists too" — which is
   * the fact a session-target MCP tool needs, and it is true from creation.
   * Reading MCP availability off the live map instead would make a catalog
   * frozen during startup depend on how far startup happened to have got.
   */
  private built: Map<string, ChannelInstance> | null = null;

  constructor(private readonly opts: ChannelServiceOptions) {}

  /** The live instance map, or an empty map when no sessions are connected. */
  live(): Map<string, ChannelInstance> {
    return this.sessions ?? new Map();
  }

  /**
   * Build the un-started channel sessions for the dispatcher from its configured
   * channels. Each provider's already-validated `readConfig` yields the provider
   * config view, then `createSession` builds the session through the create
   * context. Sessions are NOT connected here — the caller starts them. On partial
   * failure the already-built sessions are closed.
   */
  async build(): Promise<Map<string, ChannelInstance>> {
    const providerLog = this.opts.channelLoggerFactory(this.opts.dispatcherId);
    const channelConfigs = this.channelConfigs();
    const channels = new Map<string, ChannelInstance>();
    try {
      for (const channelConfig of channelConfigs) {
        const provider = this.opts.channelProviders.resolve(channelConfig.provider);
        channels.set(
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
      for (const instance of channels.values()) {
        try {
          await instance.session.close();
        } catch {
          /* best effort: never started */
        }
      }
      throw err;
    }
    // Published only once every instance exists: the failure path above already
    // closed what it had built, and a map of closed instances must never become
    // the answer to an availability question.
    this.built = channels;
    return channels;
  }

  /** Adopt successfully-started instances as the live map. */
  adopt(channels: Map<string, ChannelInstance>): void {
    this.sessions = channels;
  }

  /** Drop both maps (start failed, prepared sessions discarded, or stop). */
  clear(): void {
    this.sessions = null;
    this.built = null;
  }

  async closeAll(log: DreamuxLogger): Promise<void> {
    const sessions = this.sessions;
    if (sessions === null) return;
    // Detach before awaiting provider shutdown. A concurrent stop now observes
    // no live map, and a later restart/adopt cannot be clobbered when this older
    // close finishes. The built map goes with it: these instances are about to
    // be closed, so nothing may still treat them as able to serve a tool.
    this.sessions = null;
    this.built = null;
    for (const [channelId, instance] of sessions) {
      try {
        await instance.session.close();
      } catch (err) {
        log.error(
          {
            dispatcher_id: this.opts.dispatcherId,
            channel_id: channelId,
            err: errorInfo(err),
          },
          'error closing bot',
        );
      }
    }
  }

  configuredChannels(): readonly DispatcherChannelConfig[] {
    return this.channelConfigs();
  }

  /**
   * The MCP capability this channel's created instance composed, or `null` when
   * there is no instance or it composed no session tools.
   *
   * Read off the built map, not the live one, because this answers a
   * composition question rather than a connectivity one: what a Channel built
   * is what it can serve, for as long as that instance lives. Returning `null`
   * rather than throwing keeps the decision with the Channel MCP delegate,
   * which is the only caller and the only layer that knows whether the tool it
   * is serving needed a session at all.
   */
  sessionMcp(channelId: string): ChannelSessionMcpCapability | null {
    return this.built?.get(channelId)?.mcp ?? null;
  }

  private channelConfigs(): DispatcherChannelConfig[] {
    const dispatcherConfig = this.opts.config.dispatchers.find(
      (dispatcher) => dispatcher.id === this.opts.dispatcherId,
    );
    return dispatcherConfig?.channels ?? [];
  }
}
