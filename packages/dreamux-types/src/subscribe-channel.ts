/**
 * One-way subscription channel provider-authoring contracts.
 *
 * Bidirectional conversational channels (Feishu/Slack/Telegram) use
 * {@link ChannelProvider}: they have provider-local chat ids, inbound ownership,
 * reply/react, Team binding, and TeamLeader authorization. Subscription
 * channels (GitHub/Jira issue or PR feeds) are intentionally separate: they
 * publish subscribed events into Dreamux and may contribute MCP tools, but they
 * do not have chat ids, channel targets, Team binding, or reply ownership.
 */
import type { DreamuxLogger } from './logger.js';
import type {
  ProviderFactory,
  SubscribeChannelProviderDescriptor,
} from './provider.js';
import type { InboundDeliveryResult } from './turn.js';
import type {
  ChannelToolCall,
  ChannelToolDescriptor,
} from './channel.js';

export interface SubscribeChannelConfigContext {
  dispatcher_id: string;
  subscription_id: string;
  provider: string;
}

export interface SubscribeChannelSessionCreateContext<TConfig = unknown> {
  dispatcher_id: string;
  subscription_id: string;
  provider: string;
  config: TConfig;
  logger?: DreamuxLogger;
  state_root?: string;
  cache_root?: string;
}

export interface SubscribeChannelEvent {
  /** Stable provider-local event id for dedupe/recovery. */
  id: string;
  /** User-visible text or structured summary to submit to an agent runtime. */
  text: string;
  /** Optional source URL or external reference for diagnostics. */
  source_url?: string;
  /** Extra serializable metadata owned by the subscription provider. */
  metadata?: Record<string, unknown>;
}

export interface SubscribeChannelRoutes {
  /**
   * Publish a one-way subscribed event into Dreamux. Core decides where the event
   * is delivered; the subscription provider does not own Team routing policy.
   */
  publish(event: SubscribeChannelEvent): Promise<InboundDeliveryResult>;
}

export interface SubscribeChannelSession {
  readonly provider: string;
  readonly subscription_id: string;
  start(routes: SubscribeChannelRoutes): Promise<void>;
  close(): Promise<void>;
}

export interface SubscribeChannelToolContext {
  dispatcher_id: string;
  subscription_id: string;
  logger?: DreamuxLogger;
}

export interface SubscribeChannelProvider<TConfig = unknown> {
  readonly ref: string;
  readonly descriptor: SubscribeChannelProviderDescriptor;
  readConfig?(
    raw: unknown,
    context: SubscribeChannelConfigContext,
  ): TConfig | Promise<TConfig>;
  createSession(
    context: SubscribeChannelSessionCreateContext<TConfig>,
  ): SubscribeChannelSession;
  /**
   * Static provider/config tool catalog. Core owns any MCP descriptors and uses
   * this catalog as launch metadata; live subscription sessions are never a
   * metadata source. Omit when the subscription exposes no provider-specific
   * MCP tools.
   */
  tools?(config: TConfig): readonly ChannelToolDescriptor[];
  /**
   * Handle a provider-specific subscription tool call. Omit when `tools` is
   * omitted; the two go together.
   */
  handleTool?(
    call: ChannelToolCall,
    context: SubscribeChannelToolContext,
  ): Promise<unknown>;
}

export type SubscribeChannelProviderFactory<TConfig = unknown> = ProviderFactory<
  SubscribeChannelProvider<TConfig>,
  SubscribeChannelProviderDescriptor
>;
