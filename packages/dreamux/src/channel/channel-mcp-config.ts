/**
 * Server descriptor for the core-hosted Channel MCP shim (issue #209 slice 8).
 *
 * Mirrors `teamMcpServerDescriptor`: it points the agent runtime at the Dreamux
 * bin + admin socket + the `channel-mcp` subcommand. The Channel MCP is
 * core-owned (binding state / routing / authorization), so the descriptor lives
 * in core, not in a channel-provider package.
 */
import { dreamuxBinPath } from '../platform/package-bin.js';
import type { AgentRuntimeMcpServer } from '../agent-runtime/types.js';

export const CHANNEL_MCP_SERVER_NAME = 'channel';

export interface ChannelMcpServerDescriptorOptions {
  dispatcherId: string;
  adminSocketPath: string;
  command?: string;
  env?: NodeJS.ProcessEnv;
}

export function channelMcpServerDescriptor(
  opts: ChannelMcpServerDescriptorOptions,
): AgentRuntimeMcpServer {
  const command = opts.command ?? dreamuxBinPath(opts.env);
  return {
    name: CHANNEL_MCP_SERVER_NAME,
    command,
    args: [
      'channel-mcp',
      '--dispatcher',
      opts.dispatcherId,
      '--admin-socket',
      opts.adminSocketPath,
    ],
  };
}
