/**
 * Channel provider-authoring contracts (declaration-only).
 *
 * The neutral Channel provider seam external channel packages author against.
 * Dreamux core owns binding state, routing, and authorization (binding a channel
 * to a Team is a core Team-MCP capability, not a generic Channel MCP); a channel
 * provider owns platform I/O, provider-specific tools, inbound normalization,
 * target resolution, and message ownership facts.
 *
 * These contracts are forward-looking for the channel-provider slices. They live
 * here because external channel packages must compile against
 * `@excitedjs/dreamux-types` only and must not import `@excitedjs/dreamux`.
 */
import type { DreamuxLogger } from './logger.js';
import type {
  ChannelProviderDescriptor,
  ProviderFactory,
} from './provider.js';

export interface ChannelTarget {
  target_type: string;
  target_key: string;
  bindable: boolean;
  display?: string;
  canonical_url?: string;
  meta?: Record<string, unknown>;
}

export interface ChannelToolDescriptor {
  name: string;
  description?: string;
  /**
   * Intentionally unrestricted: Dreamux types must not constrain the tool
   * schemas a provider package exposes.
   */
  inputSchema?: unknown;
}

export interface ChannelSender {
  id?: string;
  display?: string;
  meta?: Record<string, unknown>;
}

export interface ChannelInboundEnvelope {
  provider: string;
  channel_id: string;
  target: ChannelTarget;
  event_id?: string;
  message_id?: string;
  sender?: ChannelSender;
  metadata?: Record<string, unknown>;
}

export interface ChannelConfigContext {
  dispatcher_id: string;
  channel_id: string;
  provider: string;
}

export interface ChannelSessionCreateContext<TConfig = unknown> {
  dispatcher_id: string;
  channel_id: string;
  provider: string;
  config: TConfig;
  logger?: DreamuxLogger;
  state_root?: string;
  cache_root?: string;
}

export interface ChannelReplyInput {
  target: ChannelTarget;
  text: string;
  meta?: Record<string, unknown>;
}

export interface ChannelReactInput {
  target: ChannelTarget;
  message_id: string;
  reaction: string;
}

export interface ChannelToolListContext {
  dispatcher_id: string;
  channel_id: string;
}

export interface ChannelToolCall {
  name: string;
  arguments: Record<string, unknown>;
}

export interface ChannelToolContext {
  dispatcher_id: string;
  channel_id: string;
  logger?: DreamuxLogger;
}

export interface ChannelMessageTargetCheck {
  target: ChannelTarget;
  message_id: string;
  meta?: Record<string, unknown>;
}

export interface ChannelRoutes {
  deliver(envelope: ChannelInboundEnvelope): Promise<void>;
}

export interface ChannelSession {
  readonly provider: string;
  readonly channel_id: string;
  start(routes: ChannelRoutes): Promise<void>;
  close(): Promise<void>;
  resolveTarget(meta: unknown): Promise<ChannelTarget>;
  /** Send a reply. Omit entirely if the platform has no outbound reply path. */
  reply?(input: ChannelReplyInput): Promise<unknown>;
  /** Add a reaction. Omit entirely if the platform has no reaction surface. */
  react?(input: ChannelReactInput): Promise<unknown>;
  /** Provider-specific MCP tools. Omit if the provider exposes none. */
  tools?(context: ChannelToolListContext): readonly ChannelToolDescriptor[];
  /**
   * Handle a provider-specific tool call. Omit when `tools` is omitted; the two
   * go together. These optional members are absent, not no-op stubs, when the
   * platform does not support them — core feature-detects by presence.
   */
  handleTool?(
    call: ChannelToolCall,
    context: ChannelToolContext,
  ): Promise<unknown>;
  /** Decide message ownership for routing. Omit if the platform cannot. */
  messageBelongsToTarget?(
    input: ChannelMessageTargetCheck,
  ): boolean | Promise<boolean>;
}

export interface ChannelProvider<TConfig = unknown> {
  readonly ref: string;
  readonly descriptor: ChannelProviderDescriptor;
  readConfig?(
    raw: unknown,
    context: ChannelConfigContext,
  ): TConfig | Promise<TConfig>;
  createSession(context: ChannelSessionCreateContext<TConfig>): ChannelSession;
}

/**
 * The default (or `npm:pkg#export`-selected) factory export a Channel package
 * ships. Its {@link ProviderFactoryContext} carries the already-narrowed
 * {@link ChannelProviderDescriptor}, so the package assigns `provider.descriptor`
 * from the seed without a cast.
 */
export type ChannelProviderFactory<TConfig = unknown> = ProviderFactory<
  ChannelProvider<TConfig>,
  ChannelProviderDescriptor
>;
