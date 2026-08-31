/**
 * This dispatcher's Channel MCP delegates, for one caller.
 *
 * Ownership stays in `channel-service` for the same reason the descriptor
 * builder used to: which channels a dispatcher has, and which of them publish
 * tools, is a core channel concern. What changed is that there is nothing left
 * to render — no subcommand, no caller flags, no base64 catalog on a command
 * line. The delegate simply *is* the channel's tool surface, in-process.
 *
 * A channel whose provider composes no MCP capability at all yields no delegate:
 * there is nothing for one to own. Whether a delegate that does exist ends up
 * advertising anything is decided later and generically, when Core freezes its
 * catalog — asking here would mean describing the provider twice and admitting
 * a different answer than the one that was inspected.
 */
import type {
  ChannelMcpCaller,
  ChannelSessionMcpCapability,
} from '@excitedjs/dreamux-types';

import type { ChannelProviderCatalog } from '../../channel/catalog.js';
import type { DispatcherChannelConfig } from '../../config/config.js';
import type { McpServerDelegate } from '../mcp/types.js';
import { createChannelMcpDelegate } from './mcp-delegate.js';

export interface ChannelMcpDelegatesInput {
  dispatcherId: string;
  channels: readonly DispatcherChannelConfig[];
  channelProviders: ChannelProviderCatalog;
  caller: ChannelMcpCaller;
  /**
   * The created-instance MCP capability of one channel. Read once per delegate,
   * because it is the proof a `session` tool has a handler and must be taken
   * before that tool can be advertised.
   */
  sessionMcp: (channelId: string) => ChannelSessionMcpCapability | null;
  dispatch: <T>(task: () => Promise<T>) => Promise<T>;
}

export function channelMcpDelegates(
  input: ChannelMcpDelegatesInput,
): McpServerDelegate[] {
  const delegates: McpServerDelegate[] = [];
  for (const channel of input.channels) {
    const provider = input.channelProviders.resolve(channel.provider);
    if (provider.mcp === undefined) continue;
    delegates.push(
      createChannelMcpDelegate({
        dispatcherId: input.dispatcherId,
        channelId: channel.id,
        provider,
        config: channel.config,
        caller: input.caller,
        sessionMcp: input.sessionMcp(channel.id),
        dispatch: input.dispatch,
      }),
    );
  }
  return delegates;
}
