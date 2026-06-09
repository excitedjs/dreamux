import { dreamuxBinPath } from '../../platform/package-bin.js';
import type { AgentRuntimeMcpServer } from '../../agent-runtime/types.js';

export const TEAM_MCP_SERVER_NAME = 'team';

export interface TeamMcpServerDescriptorOptions {
  dispatcherId: string;
  adminSocketPath: string;
  command?: string;
  env?: NodeJS.ProcessEnv;
}

export function teamMcpServerDescriptor(
  opts: TeamMcpServerDescriptorOptions,
): AgentRuntimeMcpServer {
  const command = opts.command ?? dreamuxBinPath(opts.env);
  return {
    name: TEAM_MCP_SERVER_NAME,
    command,
    args: [
      'team-mcp',
      '--dispatcher',
      opts.dispatcherId,
      '--admin-socket',
      opts.adminSocketPath,
    ],
  };
}
