import { dreamuxBinPath } from '../runtime/package-bin.js';
import type { AgentRuntimeMcpServer } from '../agent-runtime/types.js';
import type { TeamMateScheduleCallerKind } from './ledger.js';

export const TEAMMATE_MCP_SERVER_NAME = 'teammate';

export interface TeamMateMcpServerDescriptorOptions {
  dispatcherId: string;
  adminSocketPath: string;
  callerKind: TeamMateScheduleCallerKind;
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
      '--admin-socket',
      opts.adminSocketPath,
    ],
  };
}
