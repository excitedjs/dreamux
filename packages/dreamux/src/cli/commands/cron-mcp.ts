import type { Argv, CommandModule } from 'yargs';

import { runCronMcp } from '../../mcp/cron-mcp.js';
import { createLogger } from '../../platform/logger.js';
import { cronMcpLogPath } from '../../platform/paths.js';
import { validateDispatcherId } from '../../state/dispatcher-id.js';

interface CronMcpArgv {
  dispatcher: string;
  team?: string;
  adminSocket?: string;
}

export function createCronMcpCommand(): CommandModule<{}, CronMcpArgv> {
  return {
    command: 'cron-mcp',
    describe: 'Run the cron MCP stdio shim for a dispatcher or TeamLeader caller scope',
    builder: (y) =>
      y
        .option('dispatcher', {
          type: 'string',
          demandOption: true,
          describe: 'Dispatcher id this MCP shim is scoped to',
        })
        .option('team', {
          type: 'string',
          describe: 'Team id when this cron MCP shim is scoped to a TeamLeader',
        })
        .option('admin-socket', {
          type: 'string',
          describe: 'dreamux serve admin socket path',
        }) as Argv<CronMcpArgv>,
    handler: async (argv) => {
      const dispatcherId = validateDispatcherId(argv.dispatcher);
      const log = createLogger({
        name: `cron-mcp/${dispatcherId}`,
        filePath: cronMcpLogPath(dispatcherId),
      });
      await runCronMcp({
        dispatcherId,
        teamId: argv.team,
        adminSocketPath: argv.adminSocket,
        log: (message) => log.info(message),
      });
    },
  };
}
