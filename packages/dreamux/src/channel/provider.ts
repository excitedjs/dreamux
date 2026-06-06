/**
 * Channel provider boundary (issue #110 PR4).
 *
 * A Channel provider owns its channel's execution behavior: connection
 * lifecycle, the channel-owned MCP surface contributed to the dispatcher
 * runtime, provider-specific access/trust semantics, and outbound capabilities
 * (reply, react) when it chooses to expose them. Dreamux core consumes the
 * capabilities a provider declares; it does not classify channels as one-way or
 * two-way, and it does not own channel access policy. See
 * `.agents/decisions/channel-provider.md`.
 *
 * Reply and react are deliberately optional: a dispatcher can reply only when
 * the provider exposes the reply capability. An inbound-only channel simply
 * omits them and declares no reply/react capability — core handles their
 * absence loudly (see {@link ChannelCapabilityError}) instead of assuming every
 * channel is two-way.
 *
 * Phase 1 ships exactly one channel provider, `builtin:feishu`. The connection
 * and access shapes are still Feishu-typed at this boundary; widening them into
 * fully channel-neutral types is deferred until the second channel provider
 * lands, when there is a concrete second shape to generalize against.
 */

import type { ProviderDescriptor } from '../registry/index.js';
import type { AgentRuntimeMcpServer } from '../agent-runtime/types.js';
import type {
  DispatcherAccessState,
  DreamuxFeishuGateInput,
  DreamuxFeishuGateResult,
} from './feishu-gate.js';
import type {
  CreateBotOptions,
  FeishuBot,
  FeishuInboundRoutes,
} from '../feishu/bot.js';

/**
 * Capability kinds a Channel provider can expose. These match the `kind` of the
 * capability descriptors declared on the registry's builtin channel providers
 * (`src/registry/builtins.ts`); the channel-provider test asserts they stay in
 * sync so the two declarations cannot drift.
 */
export const CHANNEL_CAPABILITY = {
  /** Contributes a channel-owned MCP server to the dispatcher runtime. */
  mcpServer: 'mcpServer',
  /** Sends an outbound reply into the channel. */
  reply: 'reply',
  /** Adds a reaction to a channel message. */
  react: 'react',
  /** Owns access/trust gating for inbound events. */
  access: 'access',
} as const;

export type ChannelCapabilityKind =
  (typeof CHANNEL_CAPABILITY)[keyof typeof CHANNEL_CAPABILITY];

/**
 * A live channel connection for one dispatcher. Phase 1 aliases the Feishu bot
 * surface directly; this is the seam that future channels widen.
 */
export type ChannelConnection = FeishuBot;

/** Inbound route handlers a channel delivers events through. */
export type ChannelInboundRoutes = FeishuInboundRoutes;

/**
 * Host-supplied context for building a channel's MCP server descriptors: the
 * dispatcher id and the admin socket the channel MCP server calls back on.
 */
export interface ChannelMcpContext {
  dispatcherId: string;
  adminSocketPath: string;
}

/** Channel-neutral reply request, translated by the provider to its transport. */
export interface ChannelReplyInput {
  chatId: string;
  text: string;
  replyToMessageId?: string;
  mentionUserIds?: string[];
}

export interface ChannelReplyResult {
  messageIds: string[];
}

export interface ChannelReactInput {
  messageId: string;
  emoji: string;
}

export interface ChannelReactResult {
  reactionId: string;
}

/** Provider-owned access/trust semantics for a channel. */
export interface ChannelAccessOps {
  load(dispatcherId: string): Promise<DispatcherAccessState>;
  save(dispatcherId: string, state: DispatcherAccessState): Promise<void>;
  gate(
    input: DreamuxFeishuGateInput,
    state: DispatcherAccessState,
  ): DreamuxFeishuGateResult;
}

/** Thrown when core invokes a capability the provider does not expose. */
export class ChannelCapabilityError extends Error {
  constructor(
    readonly ref: string,
    readonly capability: string,
  ) {
    super(
      `channel provider ${JSON.stringify(ref)} does not expose the ` +
        `${JSON.stringify(capability)} capability`,
    );
    this.name = 'ChannelCapabilityError';
  }
}

/**
 * A Channel provider. The Phase 1 `builtin:feishu` implementation wraps the
 * existing Feishu lifecycle, MCP, access, reply, and reaction logic behind this
 * boundary so the server no longer constructs that surface by hard-coded name.
 */
export interface ChannelProvider {
  /** Normalized provider ref, e.g. `builtin:feishu`. */
  readonly ref: string;
  /** The capability registry descriptor for this provider. */
  readonly descriptor: ProviderDescriptor;
  /** Whether the provider declares a given capability. */
  hasCapability(kind: ChannelCapabilityKind): boolean;
  /**
   * The channel-owned MCP server descriptors contributed to the dispatcher
   * runtime. These are runtime-neutral (`AgentRuntimeMcpServer`); the selected
   * agent runtime provider translates them into runtime-specific args (e.g.
   * Codex `mcp_servers.*`). The channel does not emit runtime CLI args itself.
   */
  mcpServerDescriptors(context: ChannelMcpContext): AgentRuntimeMcpServer[];
  /** Open a channel connection for one dispatcher. */
  createConnection(opts: CreateBotOptions): ChannelConnection;
  /** Provider-owned access/trust semantics. */
  readonly access: ChannelAccessOps;
  /**
   * Send an outbound reply. Present only when the provider exposes the reply
   * capability; core checks {@link hasCapability} before calling and throws
   * {@link ChannelCapabilityError} otherwise — it never assumes reply exists.
   */
  reply?(
    connection: ChannelConnection,
    input: ChannelReplyInput,
  ): Promise<ChannelReplyResult>;
  /**
   * Add a reaction. Present only when the provider exposes the react
   * capability; gated the same way as {@link reply}.
   */
  react?(
    connection: ChannelConnection,
    input: ChannelReactInput,
  ): Promise<ChannelReactResult>;
}
