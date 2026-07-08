import { dreamuxBinPath } from '../../platform/package-bin.js';
import type { AgentRuntimeMcpServer } from '@excitedjs/dreamux-types';

export const COLLABORATION_SPACE_MCP_SERVER_NAME = 'collaboration_space';

export interface CollaborationSpaceMcpServerDescriptorOptions {
  dispatcherId: string;
  adminSocketPath: string;
  command?: string;
  env?: NodeJS.ProcessEnv;
}

export function collaborationSpaceMcpServerDescriptor(
  opts: CollaborationSpaceMcpServerDescriptorOptions,
): AgentRuntimeMcpServer {
  const command = opts.command ?? dreamuxBinPath(opts.env);
  return {
    name: COLLABORATION_SPACE_MCP_SERVER_NAME,
    command,
    args: [
      'collaboration-space-mcp',
      '--dispatcher',
      opts.dispatcherId,
      '--admin-socket',
      opts.adminSocketPath,
    ],
  };
}
