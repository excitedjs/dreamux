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
import type { AgentRuntimeMcpServer } from './agent-runtime.js';
import type { DreamuxLogger } from './logger.js';
import type {
  ProviderFactory,
  SubscribeChannelProviderDescriptor,
} from './provider.js';
import type { InboundDeliveryResult } from './turn.js';

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

export interface SubscribeChannelMcpDescriptorContext {
  /** The Dreamux bin command a subscription MCP shim is spawned as. */
  command: string;
  /** The admin Unix-socket path the shim forwards tool calls to. */
  adminSocketPath: string;
  dispatcher_id: string;
  provider: string;
  subscription_id: string;
}

export interface SubscribeChannelSession {
  readonly provider: string;
  readonly subscription_id: string;
  start(routes: SubscribeChannelRoutes): Promise<void>;
  close(): Promise<void>;
  /**
   * Optional MCP servers contributed by the subscription provider. These tools
   * are provider capabilities, not Team binding or chat reply tools.
   */
  mcpServerDescriptors?(
    context: SubscribeChannelMcpDescriptorContext,
  ): readonly AgentRuntimeMcpServer[];
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
}

export type SubscribeChannelProviderFactory<TConfig = unknown> = ProviderFactory<
  SubscribeChannelProvider<TConfig>,
  SubscribeChannelProviderDescriptor
>;
