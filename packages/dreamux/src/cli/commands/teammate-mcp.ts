import type { Argv, CommandModule } from 'yargs';

import { runTeamMateMcp } from '../../mcp/teammate-mcp.js';
import { createLogger } from '../../platform/logger.js';
import { teammateMcpLogPath } from '../../platform/paths.js';
import { validateDispatcherId } from '../../state/dispatcher-id.js';

type TeamMateMcpCallerKind = 'dispatcher' | 'team_leader' | 'teammate';

interface TeamMateMcpArgv {
  dispatcher: string;
  caller: TeamMateMcpCallerKind;
  teamId?: string;
  leaderName?: string;
  adminSocket?: string;
}

export function createTeamMateMcpCommand(): CommandModule<{}, TeamMateMcpArgv> {
  return {
    command: 'teammate-mcp',
    describe: 'Run the dispatcher-scoped TeamMate scheduling MCP stdio shim',
    builder: buildTeamMateMcpOptions,
    handler: handleTeamMateMcp,
  };
}

function buildTeamMateMcpOptions(y: Argv): Argv<TeamMateMcpArgv> {
  return y
    .option('dispatcher', {
      type: 'string',
      demandOption: true,
      describe: 'Dispatcher id this MCP shim is scoped to',
    })
    .option('caller', {
      type: 'string',
      choices: ['dispatcher', 'team_leader', 'teammate'] as const,
      default: 'dispatcher' as const,
      describe: 'Dreamux-controlled caller kind for nested-dispatch enforcement',
    })
    .option('team-id', {
      type: 'string',
      describe: 'Team id for team_leader caller scope',
    })
    .option('leader-name', {
      type: 'string',
      describe: 'Leader TeamMate identity name for team_leader caller scope',
    })
    .option('admin-socket', {
      type: 'string',
      describe: 'dreamux serve admin socket path',
    }) as Argv<TeamMateMcpArgv>;
}

async function handleTeamMateMcp(argv: TeamMateMcpArgv): Promise<void> {
  const dispatcherId = validateDispatcherId(argv.dispatcher);
  const log = createLogger({
    name: `teammate-mcp/${dispatcherId}`,
    filePath: teammateMcpLogPath(dispatcherId),
  });
  await runTeamMateMcp({
    dispatcherId,
    callerKind: argv.caller,
    teamId: argv.teamId,
    leaderName: argv.leaderName,
    adminSocketPath: argv.adminSocket,
    log: (message) => log.info(message),
  });
}
