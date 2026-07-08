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
  DreamuxEnvironment,
  ProviderBinCheck,
  ProviderDiagnosticRunner,
  ProviderDiagnosticScope,
  ProviderDiagnosticResult,
  ProviderFactory,
  ProviderOnboard,
} from './provider.js';
import type { InboundDeliveryResult, InboundTurnInput } from './turn.js';

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
  /**
   * Deliver a normalized inbound to Dreamux core. The channel session supplies
   * the neutral turn {@link InboundTurnInput} (text/body/attrs/attachments it
   * normalized) plus the routing/identity {@link ChannelInboundEnvelope}; core
   * dedupes (on `input.sourceId`), submits the turn, and returns the neutral
   * {@link InboundDeliveryResult}. The channel session owns any platform ack or
   * reaction lifecycle around this call. A channel inbound never yields
   * `'skipped'` (that is a notice-only state), so the union is exactly the
   * inbound-delivery one.
   */
  deliver(
    input: InboundTurnInput,
    envelope: ChannelInboundEnvelope,
  ): Promise<InboundDeliveryResult>;
}

/**
 * The context core passes to {@link ChannelProvider.handleSessionlessTool}. A
 * sessionless tool runs without a live {@link ChannelSession} (e.g. listing the
 * bots in a chat before any binding exists), so it gets only neutral host
 * locators, never a session handle.
 */
export interface ChannelSessionlessToolContext {
  dispatcher_id: string;
  /** Dispatcher-local channel id whose provider owns the sessionless call. */
  channel_id: string;
  /** The per-dispatcher state root the provider may read credentials/state from. */
  state_root?: string;
  logger?: DreamuxLogger;
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

/** Channel-specific alias of the shared provider binary check. */
export type ChannelBinCheck = ProviderBinCheck;

/** Channel-specific alias of the shared provider diagnostic result. */
export type ChannelDiagnosticResult = ProviderDiagnosticResult;

/** Channel-specific alias of the shared provider diagnostic runner. */
export type ChannelDiagnosticRunner = ProviderDiagnosticRunner;

export interface ChannelDiagnosticContext<TConfig = unknown> {
  dispatcher_id: string;
  channel_id: string;
  provider: string;
  config: TConfig;
  env: DreamuxEnvironment;
  scope: ProviderDiagnosticScope;
  state_root?: string;
  cache_root?: string;
}

/**
 * Optional channel diagnostics. A provider that needs no host-visible checks may
 * omit it; core treats absence as a passing provider report.
 */
export interface ChannelDiagnostic<TConfig = unknown> {
  binChecks(context: ChannelDiagnosticContext<TConfig>): ChannelBinCheck[];
  runDiagnostic(
    context: ChannelDiagnosticContext<TConfig>,
    runner: ChannelDiagnosticRunner,
  ): Promise<ChannelDiagnosticResult>;
}

export interface ChannelProvider<TConfig = unknown> {
  readonly ref: string;
  readonly descriptor: ChannelProviderDescriptor;
  readConfig?(
    raw: unknown,
    context: ChannelConfigContext,
  ): TConfig | Promise<TConfig>;
  createSession(context: ChannelSessionCreateContext<TConfig>): ChannelSession;
  /**
   * Self-report a neutral, opaque channel identity for this config (e.g. the
   * bot app id). Core stores and displays the string but never interprets it,
   * so it never has to name a provider config field. Omit if the channel has no
   * stable identity to report.
   */
  getIdentity?(config: TConfig): string;
  /**
   * Static provider/config tool catalog. Core owns every MCP descriptor and uses
   * this catalog as launch metadata; live sessions are never a metadata source.
   * Omit when the channel exposes no provider-specific MCP tools.
   */
  tools?(config: TConfig): readonly ChannelToolDescriptor[];
  /**
   * Provider-owned onboarding. Core asks only for host envelope fields and
   * delegates provider-specific raw config collection to this capability.
   */
  onboard?: ProviderOnboard<Record<string, unknown>>;
  /** Self-reported provider diagnostics. */
  diagnostic?: ChannelDiagnostic<TConfig>;
  /**
   * Handle a tool call that has no live {@link ChannelSession} (e.g. a discovery
   * tool used before any binding exists). Omit when the channel exposes no
   * sessionless tools. Feature-detected by presence.
   */
  handleSessionlessTool?(
    name: string,
    args: Record<string, unknown>,
    context: ChannelSessionlessToolContext,
  ): Promise<unknown>;
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
