import type { Argv, CommandModule } from 'yargs';

import { runTeamMcp } from '../../mcp/team-mcp.js';
import { validateDispatcherId } from '../../state/dispatcher-id.js';

interface TeamMcpArgv {
  dispatcher: string;
  adminSocket?: string;
  caller?: 'dispatcher' | 'team_leader';
  teamId?: string;
  leaderName?: string;
  taskAttempt?: boolean;
}

export function createTeamMcpCommand(): CommandModule<{}, TeamMcpArgv> {
  return {
    command: 'team-mcp',
    describe: 'Run the Team MCP stdio shim',
    builder: (y) =>
      y
        .option('dispatcher', {
          type: 'string',
          demandOption: true,
          describe: 'Dispatcher id this MCP shim is scoped to',
        })
        .option('admin-socket', {
          type: 'string',
          describe: 'dreamux serve admin socket path',
        })
        .option('caller', {
          type: 'string',
          choices: ['dispatcher', 'team_leader'] as const,
          default: 'dispatcher' as const,
          describe: 'Caller projection for this Team MCP shim',
        })
        .option('team-id', {
          type: 'string',
          describe: 'Team id when this Team MCP shim runs for a TeamLeader',
        })
        .option('leader-name', {
          type: 'string',
          describe: 'TeamLeader name when this Team MCP shim runs for a TeamLeader',
        })
        .option('task-attempt', {
          type: 'boolean',
          default: false,
          describe: 'Expose only the scoped task-attempt terminal tool',
        }) as Argv<TeamMcpArgv>,
    handler: async (argv) => {
      await runTeamMcp({
        dispatcherId: validateDispatcherId(argv.dispatcher),
        callerKind: argv.caller ?? 'dispatcher',
        teamId: argv.teamId,
        leaderName: argv.leaderName,
        taskAttemptOnly: argv.taskAttempt === true,
        adminSocketPath: argv.adminSocket,
      });
    },
  };
}
