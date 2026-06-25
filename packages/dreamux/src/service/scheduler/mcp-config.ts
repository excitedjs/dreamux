import type { AgentRuntimeMcpServer } from '@excitedjs/dreamux-types';

import { dreamuxBinPath } from '../../platform/package-bin.js';
import { adminSocketPath as defaultAdminSocketPath } from '../../platform/paths.js';

export function cronMcpServerDescriptor(input: {
  dispatcherId: string;
  adminSocketPath?: string;
}): AgentRuntimeMcpServer {
  return {
    name: 'cron',
    command: dreamuxBinPath(),
    args: [
      'cron-mcp',
      '--dispatcher',
      input.dispatcherId,
      '--admin-socket',
      input.adminSocketPath ?? defaultAdminSocketPath(),
    ],
  };
}
