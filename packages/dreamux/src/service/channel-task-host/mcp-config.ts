import type { AgentRuntimeMcpServer } from '@excitedjs/dreamux-types';

import { dreamuxBinPath } from '../../platform/package-bin.js';

export function taskAttemptMcpServerDescriptor(input: {
  dispatcherId: string;
  teamId: string;
  leaderName: string;
  adminSocketPath: string;
  command?: string;
  env?: NodeJS.ProcessEnv;
}): AgentRuntimeMcpServer {
  return {
    name: 'attempt',
    command: input.command ?? dreamuxBinPath(input.env),
    args: [
      'team-mcp',
      '--dispatcher',
      input.dispatcherId,
      '--admin-socket',
      input.adminSocketPath,
      '--caller',
      'team_leader',
      '--team-id',
      input.teamId,
      '--leader-name',
      input.leaderName,
      '--task-attempt',
    ],
  };
}
