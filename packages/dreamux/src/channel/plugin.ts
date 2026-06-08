/**
 * Future subscription-channel plugin boundary.
 *
 * Feishu is not implemented through this provider seam. It is a built-in
 * bidirectional conversational channel under `feishu-channel.ts`. This file is
 * intentionally interface-only for later subscription-style channels that
 * contribute MCP tools and push subscribed events to dispatcher/team agents.
 */

import type { AgentRuntimeMcpServer } from '../agent-runtime/types.js';
import type { ProviderDescriptor } from '../registry/index.js';

export interface SubscriptionChannelMcpContext {
  dispatcherId: string;
  adminSocketPath: string;
}

export interface SubscriptionChannelEvent {
  /** Stable channel-local event id for dedupe/recovery. */
  id: string;
  /** User-visible text or structured summary to submit to an agent runtime. */
  text: string;
  /** Optional source URL or external reference for diagnostics. */
  sourceUrl?: string;
  /** Extra serializable metadata owned by the channel plugin. */
  metadata?: Record<string, unknown>;
}

export interface SubscriptionChannelPlugin {
  readonly ref: string;
  readonly descriptor: ProviderDescriptor;
  mcpServerDescriptors(
    context: SubscriptionChannelMcpContext,
  ): readonly AgentRuntimeMcpServer[];
  start(routes: {
    publish(event: SubscriptionChannelEvent): Promise<void>;
  }): Promise<void>;
  stop(): Promise<void>;
}
