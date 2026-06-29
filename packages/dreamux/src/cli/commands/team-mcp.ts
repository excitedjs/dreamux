import type { Argv, CommandModule } from 'yargs';

import { runTeamMcp } from '../../mcp/team-mcp.js';
import { validateDispatcherId } from '../../state/dispatcher-id.js';

interface TeamMcpArgv {
  dispatcher: string;
  adminSocket?: string;
  caller?: 'dispatcher' | 'team_leader';
  teamId?: string;
  leaderName?: string;
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
          describe: 'Team id for TeamLeader-scoped Team MCP',
        })
        .option('leader-name', {
          type: 'string',
          describe: 'TeamLeader name for TeamLeader-scoped Team MCP',
        }) as Argv<TeamMcpArgv>,
    handler: async (argv) => {
      await runTeamMcp({
        dispatcherId: validateDispatcherId(argv.dispatcher),
        callerKind: argv.caller ?? 'dispatcher',
        teamId: argv.teamId,
        leaderName: argv.leaderName,
        adminSocketPath: argv.adminSocket,
      });
    },
  };
}
