import { dreamuxBinPath } from '../../platform/package-bin.js';
import type { AgentRuntimeMcpServer } from '@excitedjs/dreamux-types';
import type { TeamMateMcpCallerKind } from '../../mcp/teammate-mcp.js';

export const TEAMMATE_MCP_SERVER_NAME = 'teammate';

export interface TeamMateMcpServerDescriptorOptions {
  dispatcherId: string;
  adminSocketPath: string;
  callerKind: TeamMateMcpCallerKind;
  teamId?: string;
  command?: string;
  env?: NodeJS.ProcessEnv;
}

export function teammateMcpServerDescriptor(
  opts: TeamMateMcpServerDescriptorOptions,
): AgentRuntimeMcpServer {
  const command = opts.command ?? dreamuxBinPath(opts.env);
  return {
    name: TEAMMATE_MCP_SERVER_NAME,
    command,
    args: [
      'teammate-mcp',
      '--dispatcher',
      opts.dispatcherId,
      '--caller',
      opts.callerKind,
      ...(opts.teamId !== undefined ? ['--team-id', opts.teamId] : []),
      '--admin-socket',
      opts.adminSocketPath,
    ],
  };
}
