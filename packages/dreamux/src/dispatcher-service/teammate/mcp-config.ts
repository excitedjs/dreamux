import { dreamuxBinPath } from '../../platform/package-bin.js';
import type { AgentRuntimeMcpServer } from '../../agent-runtime/types.js';

export const TEAMMATE_MCP_SERVER_NAME = 'teammate';

export interface TeamMateMcpServerDescriptorOptions {
  dispatcherId: string;
  adminSocketPath: string;
  callerKind: 'dispatcher' | 'team_leader' | 'teammate';
  teamId?: string;
  leaderName?: string;
  feishuScope?: 'team';
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
      ...(opts.leaderName !== undefined ? ['--leader-name', opts.leaderName] : []),
      ...(opts.feishuScope !== undefined ? ['--feishu-scope', opts.feishuScope] : []),
      '--admin-socket',
      opts.adminSocketPath,
    ],
  };
}
