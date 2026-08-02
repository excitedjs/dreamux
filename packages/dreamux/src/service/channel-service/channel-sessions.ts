import type {
  AgentRuntimeMcpServer,
  ChannelSession,
  ChannelTarget,
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
import {
  channelMcpServerDescriptorsForCaller,
  type ChannelMcpCallerScope,
} from './mcp-descriptors.js';

interface ChannelToolInvocation {
  /** Provider ref carried by the channel MCP descriptor. Used to select/verify the session. */
  providerRef?: string;
  /** Provider-owned tool name, forwarded opaquely (core never enumerates it). */
  name: string;
  /** Raw provider-owned tool arguments, forwarded opaquely to the session. */
  arguments: unknown;
  /** Which channel's bot the egress leaves through (issue #209). Omitted → primary. */
  channelId?: string;
}

interface ChannelSessionsOptions {
  dispatcherId: string;
  config: DreamuxConfig;
  channelProviders: ChannelProviderCatalog;
  channelLoggerFactory: (dispatcherId: string) => DreamuxLogger;
  adminSocketPath?: string;
}

/**
 * The channel service's live channel sessions (issue #233 Phase 5): the
 * `Map<channel_id, ChannelSession>` together with the channel-tool dispatch,
 * target resolution, and MCP descriptor assembly that key off it.
 * `ChannelService` owns one instance and `DispatcherService` publishes sessions
 * here only after their provider start succeeds. Core stays a blind MCP conduit
 * — it never names a provider's tool.
 */
class ChannelSessions {
  private sessions: Map<string, ChannelSession> | null = null;

  constructor(private readonly opts: ChannelSessionsOptions) {}

  /** The live session map, or an empty map when no sessions are connected. */
  live(): Map<string, ChannelSession> {
    return this.sessions ?? new Map();
  }

  isLive(): boolean {
    return this.sessions !== null && this.sessions.size > 0;
  }

  /**
   * Build the un-started channel sessions for the dispatcher from its configured
   * channels. Each provider's already-validated `readConfig` yields the provider
   * config view, then `createSession` builds the session through the create
   * context. Sessions are NOT connected here — the caller starts them. On partial
   * failure the already-built sessions are closed.
   */
  async build(): Promise<Map<string, ChannelSession>> {
    const providerLog = this.opts.channelLoggerFactory(this.opts.dispatcherId);
    const channelConfigs = this.channelConfigs();
    const channels = new Map<string, ChannelSession>();
    try {
      for (const channelConfig of channelConfigs) {
        const provider = this.opts.channelProviders.resolve(channelConfig.provider);
        channels.set(
          channelConfig.id,
          provider.createSession({
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
      for (const session of channels.values()) {
        try {
          await session.close();
        } catch {
          /* best effort: never started */
        }
      }
      throw err;
    }
    return channels;
  }

  /** Adopt successfully-started sessions as the live map. */
  adopt(channels: Map<string, ChannelSession>): void {
    this.sessions = channels;
  }

  /** Drop the live map (start failed or stop). */
  clear(): void {
    this.sessions = null;
  }

  async closeAll(log: DreamuxLogger): Promise<void> {
    const sessions = this.sessions;
    if (sessions === null) return;
    // Detach before awaiting provider shutdown. A concurrent stop now observes
    // no live map, and a later restart/adopt cannot be clobbered when this older
    // close finishes.
    this.sessions = null;
    for (const [channelId, session] of sessions) {
      try {
        await session.close();
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

  channelMcpServerDescriptorsForCaller(
    scope: ChannelMcpCallerScope,
  ): AgentRuntimeMcpServer[] {
    return channelMcpServerDescriptorsForCaller({
      dispatcherId: this.opts.dispatcherId,
      channels: this.configuredChannels(),
      channelProviders: this.opts.channelProviders,
      ...(this.opts.adminSocketPath !== undefined
        ? { adminSocketPath: this.opts.adminSocketPath }
        : {}),
      scope,
    });
  }

  configuredChannels(): readonly DispatcherChannelConfig[] {
    return this.channelConfigs();
  }

  /**
   * Invoke a provider-owned channel tool, forwarding raw `{name, arguments}` to
   * the channel provider seam. A live session handles it via `session.handleTool`;
   * with no live session the provider's `handleSessionlessTool` is tried instead.
   */
  async invokeTool(input: ChannelToolInvocation): Promise<unknown> {
    const sessions = this.sessions;
    if (sessions === null || sessions.size === 0) {
      return this.invokeSessionlessTool(
        input.providerRef,
        input.channelId,
        input.name,
        input.arguments,
      );
    }
    const session = this.sessionFor(sessions, input.channelId, input.providerRef);
    if (session.handleTool === undefined) {
      throw new Error(
        `channel '${session.channel_id}' exposes no provider tool surface`,
      );
    }
    return session.handleTool(
      {
        name: input.name,
        arguments: (input.arguments ?? {}) as Record<string, unknown>,
      },
      { dispatcher_id: this.opts.dispatcherId, channel_id: session.channel_id },
    );
  }

  /**
   * Whether a live channel session observed a message for a target — the routing
   * ownership fact the TeamLeader egress gate keys off.
   */
  async messageBelongsToTarget(
    target: ChannelTarget,
    messageId: string,
    channelId?: string,
  ): Promise<boolean> {
    const sessions = this.sessions;
    if (sessions === null) return false;
    const selected =
      channelId === undefined
        ? sessions.values()
        : [this.sessionFor(sessions, channelId)].values();
    for (const session of selected) {
      const decide = session.messageBelongsToTarget;
      if (decide === undefined) continue;
      if (await decide.call(session, { target, message_id: messageId })) {
        return true;
      }
    }
    return false;
  }

  /**
   * Resolve a provider selector to a `ChannelTarget` via the live channel
   * session. Requires a running dispatcher — both call paths (bind tool, inbound
   * router) run only while a channel session is live.
   */
  async resolveTarget(
    meta: unknown,
    channelId?: string,
    providerRef?: string,
  ): Promise<ChannelTarget> {
    return this.sessionFor(this.mustSessions(), channelId, providerRef).resolveTarget(
      meta,
    );
  }

  private async invokeSessionlessTool(
    providerRef: string | undefined,
    channelId: string | undefined,
    name: string,
    args: unknown,
  ): Promise<unknown> {
    const channelConfig = this.channelConfigFor(providerRef, channelId);
    const provider = this.opts.channelProviders.resolve(channelConfig.provider);
    if (provider.handleSessionlessTool === undefined) {
      throw new Error(
        `channel provider '${provider.ref}' exposes no sessionless tool surface`,
      );
    }
    return provider.handleSessionlessTool(
      name,
      (args ?? {}) as Record<string, unknown>,
      {
        dispatcher_id: this.opts.dispatcherId,
        channel_id: channelConfig.id,
        state_root: dispatcherDir(this.opts.dispatcherId),
        logger: this.opts.channelLoggerFactory(this.opts.dispatcherId),
      },
    );
  }

  private channelConfigFor(
    providerRef?: string,
    channelId?: string,
  ): DispatcherChannelConfig {
    const dispatcherId = this.opts.dispatcherId;
    const channels = this.channelConfigs();
    let channelConfig: DispatcherChannelConfig | undefined;

    if (channelId !== undefined) {
      channelConfig = channels.find((channel) => channel.id === channelId);
      if (channelConfig === undefined) {
        throw new Error(
          `dispatcher '${dispatcherId}' has no configured channel '${channelId}'`,
        );
      }
    } else if (providerRef !== undefined) {
      channelConfig = channels.find((channel) => channel.provider === providerRef);
      if (channelConfig === undefined) {
        throw new Error(
          `dispatcher '${dispatcherId}' has no configured channel for provider '${providerRef}'`,
        );
      }
    } else {
      channelConfig = channels[0];
      if (channelConfig === undefined) {
        throw new Error(`dispatcher '${dispatcherId}' has no configured channel`);
      }
    }

    if (providerRef !== undefined && channelConfig.provider !== providerRef) {
      throw new Error(
        `dispatcher '${dispatcherId}' channel '${channelConfig.id}' is provider '${channelConfig.provider}', not '${providerRef}'`,
      );
    }
    return channelConfig;
  }

  private sessionFor(
    sessions: Map<string, ChannelSession>,
    channelId?: string,
    providerRef?: string,
  ): ChannelSession {
    const dispatcherId = this.opts.dispatcherId;
    let session: ChannelSession | undefined;
    if (channelId !== undefined) {
      session = sessions.get(channelId);
      if (session === undefined) {
        throw new Error(
          `dispatcher '${dispatcherId}' has no live channel '${channelId}'`,
        );
      }
    } else if (providerRef !== undefined) {
      session = Array.from(sessions.values()).find(
        (candidate) => candidate.provider === providerRef,
      );
      if (session === undefined) {
        throw new Error(
          `dispatcher '${dispatcherId}' has no live channel for provider '${providerRef}'`,
        );
      }
    } else {
      session = sessions.values().next().value;
      if (session === undefined) {
        throw new Error(
          `dispatcher '${dispatcherId}' has no live channel session`,
        );
      }
    }

    if (providerRef !== undefined && session.provider !== providerRef) {
      throw new Error(
        `dispatcher '${dispatcherId}' channel '${session.channel_id}' is provider '${session.provider}', not '${providerRef}'`,
      );
    }
    return session;
  }

  private mustSessions(): Map<string, ChannelSession> {
    const sessions = this.sessions;
    if (sessions === null) {
      throw new Error(`dispatcher '${this.opts.dispatcherId}' is not running`);
    }
    return sessions;
  }

  private channelConfigs(): DispatcherChannelConfig[] {
    const dispatcherConfig = this.opts.config.dispatchers.find(
      (dispatcher) => dispatcher.id === this.opts.dispatcherId,
    );
    return dispatcherConfig?.channels ?? [];
  }
}

export type { ChannelSessionsOptions, ChannelToolInvocation };
export { ChannelSessions };
