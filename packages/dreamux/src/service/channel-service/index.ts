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
import { ChannelSessions } from './channel-sessions.js';

export interface ChannelServiceOptions {
  dispatcherId: string;
  config: DreamuxConfig;
  channelProviders: ChannelProviderCatalog;
  channelLoggerFactory: (dispatcherId: string) => DreamuxLogger;
}

export class ChannelService {
  private readonly sessions: ChannelSessions;

  constructor(opts: ChannelServiceOptions) {
    this.sessions = new ChannelSessions({
      dispatcherId: opts.dispatcherId,
      config: opts.config,
      channelProviders: opts.channelProviders,
      channelLoggerFactory: opts.channelLoggerFactory,
    });
  }

  live(): Map<string, ChannelInstance> {
    return this.sessions.live();
  }

  build(): Promise<Map<string, ChannelInstance>> {
    return this.sessions.build();
  }

  adopt(channels: Map<string, ChannelInstance>): void {
    this.sessions.adopt(channels);
  }

  /**
   * The MCP capability one channel's created instance composed, for the Channel
   * MCP delegate.
   *
   * This is the whole of Core's involvement in a channel tool call now: hand
   * the delegate the provider object that serves it. Core no longer resolves a
   * target, proves a message belongs to one, or gates egress — a Channel owns
   * its own access rules, and the caller it needs to apply them to is carried in
   * the call context. `null` means this channel has no such object, which is
   * how a session tool it could never serve stays out of the frozen catalog.
   */
  sessionMcp(channelId: string): ChannelSessionMcpCapability | null {
    return this.sessions.sessionMcp(channelId);
  }

  configuredChannels(): readonly DispatcherChannelConfig[] {
    return this.sessions.configuredChannels();
  }

  clear(): void {
    this.sessions.clear();
  }

  closeAll(log: DreamuxLogger): Promise<void> {
    return this.sessions.closeAll(log);
  }
}
