import type { AgentRuntimeMcpServer } from '@excitedjs/dreamux-types';

import { dreamuxBinPath } from '../../platform/package-bin.js';
import { adminSocketPath as defaultAdminSocketPath } from '../../platform/paths.js';

export function cronMcpServerDescriptor(input: {
  dispatcherId: string;
  teamId?: string;
  adminSocketPath?: string;
}): AgentRuntimeMcpServer {
  const teamArgs = input.teamId !== undefined ? ['--team', input.teamId] : [];
  return {
    name: 'cron',
    command: dreamuxBinPath(),
    args: [
      'cron-mcp',
      '--dispatcher',
      input.dispatcherId,
      ...teamArgs,
      '--admin-socket',
      input.adminSocketPath ?? defaultAdminSocketPath(),
    ],
  };
}
