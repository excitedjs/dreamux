import type { Argv, CommandModule } from 'yargs';

import { runCollaborationSpaceMcp } from '../../mcp/collaboration-space-mcp.js';
import { validateDispatcherId } from '../../state/dispatcher-id.js';

interface CollaborationSpaceMcpArgv {
  dispatcher: string;
  adminSocket?: string;
}

export function createCollaborationSpaceMcpCommand(): CommandModule<
  {},
  CollaborationSpaceMcpArgv
> {
  return {
    command: 'collaboration-space-mcp',
    describe: 'Run the collaboration_space MCP stdio shim',
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
        }) as Argv<CollaborationSpaceMcpArgv>,
    handler: async (argv) => {
      await runCollaborationSpaceMcp({
        dispatcherId: validateDispatcherId(argv.dispatcher),
        adminSocketPath: argv.adminSocket,
      });
    },
  };
}
