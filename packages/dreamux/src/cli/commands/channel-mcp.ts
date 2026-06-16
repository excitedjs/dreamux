import type { Argv, CommandModule } from 'yargs';

import { runChannelMcp } from '../../mcp/channel-mcp.js';
import { createLogger } from '../../platform/logger.js';
import { channelMcpLogPath } from '../../platform/paths.js';
import { validateDispatcherId } from '../../state/dispatcher-id.js';

interface ChannelMcpArgv {
  dispatcher: string;
  provider?: string;
  channelId?: string;
  channel?: string;
  caller?: 'dispatcher' | 'team_leader';
  teamId?: string;
  leaderName?: string;
  adminSocket?: string;
  channelToolsB64?: string;
}

export function createChannelMcpCommand(): CommandModule<{}, ChannelMcpArgv> {
  return {
    command: 'channel-mcp',
    describe: 'Run the dispatcher-scoped channel MCP stdio shim',
    builder: buildChannelMcpOptions,
    handler: handleChannelMcp,
  };
}

function buildChannelMcpOptions(y: Argv): Argv<ChannelMcpArgv> {
  return y
    .option('dispatcher', {
      type: 'string',
      demandOption: true,
      describe: 'Dispatcher id this MCP shim is scoped to',
    })
    .option('provider', {
      type: 'string',
      describe: 'Channel provider ref this shim serves',
    })
    .option('channel-id', {
      type: 'string',
      alias: 'channel',
      describe: 'Dispatcher-local channel id this shim serves',
    })
    .option('admin-socket', {
      type: 'string',
      describe: 'dreamux serve admin socket path',
    })
    .option('caller', {
      type: 'string',
      choices: ['dispatcher', 'team_leader'] as const,
      default: 'dispatcher' as const,
      describe: 'Dreamux-controlled caller kind for channel scope enforcement',
    })
    .option('team-id', {
      type: 'string',
      describe: 'Team id for team_leader caller scope',
    })
    .option('leader-name', {
      type: 'string',
      describe: 'Leader TeamMate identity name for team_leader caller scope',
    })
    .option('channel-tools-b64', {
      type: 'string',
      describe:
        "Base64 JSON of the channel's static MCP tool descriptors (provider-supplied; the shim serves tools/list from it)",
    }) as Argv<ChannelMcpArgv>;
}

async function handleChannelMcp(argv: ChannelMcpArgv): Promise<void> {
  const dispatcherId = validateDispatcherId(argv.dispatcher);
  const log = createLogger({
    name: `channel-mcp/${dispatcherId}`,
    filePath: channelMcpLogPath(dispatcherId),
  });
  await runChannelMcp({
    dispatcherId,
    providerRef: argv.provider,
    channelId: argv.channelId ?? argv.channel,
    callerKind: argv.caller,
    teamId: argv.teamId,
    leaderName: argv.leaderName,
    adminSocketPath: argv.adminSocket,
    ...(argv.channelToolsB64 !== undefined
      ? { tools: decodeChannelTools(argv.channelToolsB64) }
      : {}),
    log: (message) => log.info(message),
  });
}

function decodeChannelTools(b64: string): readonly unknown[] {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(b64, 'base64').toString('utf8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}
