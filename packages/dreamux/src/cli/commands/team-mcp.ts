import type { Argv, CommandModule } from 'yargs';

import { runTeamMcp } from '../../mcp/team-mcp.js';
import { validateDispatcherId } from '../../state/dispatcher-id.js';

interface TeamMcpArgv {
  dispatcher: string;
  adminSocket?: string;
}

export function createTeamMcpCommand(): CommandModule<{}, TeamMcpArgv> {
  return {
    command: 'team-mcp',
    describe: 'Run the dispatcher-scoped Team MCP stdio shim',
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
        }) as Argv<TeamMcpArgv>,
    handler: async (argv) => {
      await runTeamMcp({
        dispatcherId: validateDispatcherId(argv.dispatcher),
        adminSocketPath: argv.adminSocket,
      });
    },
  };
}
