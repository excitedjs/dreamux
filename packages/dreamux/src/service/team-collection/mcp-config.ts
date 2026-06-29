import { dreamuxBinPath } from '../../platform/package-bin.js';
import type { AgentRuntimeMcpServer } from '@excitedjs/dreamux-types';

export const TEAM_MCP_SERVER_NAME = 'team';

export interface TeamMcpServerDescriptorOptions {
  dispatcherId: string;
  adminSocketPath: string;
  callerKind?: 'dispatcher' | 'team_leader';
  teamId?: string;
  leaderName?: string;
  command?: string;
  env?: NodeJS.ProcessEnv;
}

export function teamMcpServerDescriptor(
  opts: TeamMcpServerDescriptorOptions,
): AgentRuntimeMcpServer {
  const command = opts.command ?? dreamuxBinPath(opts.env);
  const callerKind = opts.callerKind ?? 'dispatcher';
  const callerArgs =
    callerKind === 'team_leader'
      ? [
          '--caller',
          'team_leader',
          '--team-id',
          requiredOption(opts.teamId, 'teamId'),
          '--leader-name',
          requiredOption(opts.leaderName, 'leaderName'),
        ]
      : [];
  return {
    name: TEAM_MCP_SERVER_NAME,
    command,
    args: [
      'team-mcp',
      '--dispatcher',
      opts.dispatcherId,
      '--admin-socket',
      opts.adminSocketPath,
      ...callerArgs,
    ],
  };
}

function requiredOption(value: string | undefined, name: string): string {
  if (value === undefined || value === '') {
    throw new Error(`${name} is required for TeamLeader Team MCP descriptor`);
  }
  return value;
}
