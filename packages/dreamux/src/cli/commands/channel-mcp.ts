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
    describe: 'Run the channel MCP stdio shim for a dispatcher or TeamLeader caller scope',
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
  // Fail loud when the catalog is missing or malformed: the channel MCP never
  // serves a silently substituted empty tool set. runChannelMcp validates the
  // decoded catalog's shape; here we only guarantee a non-empty decode input.
  if (argv.channelToolsB64 === undefined || argv.channelToolsB64 === '') {
    throw new Error(
      'channel-mcp requires --channel-tools-b64 (the provider-supplied tool catalog)',
    );
  }
  await runChannelMcp({
    dispatcherId,
    providerRef: argv.provider,
    channelId: argv.channelId ?? argv.channel,
    callerKind: argv.caller,
    teamId: argv.teamId,
    leaderName: argv.leaderName,
    adminSocketPath: argv.adminSocket,
    tools: decodeChannelTools(argv.channelToolsB64),
    log: (message) => log.info(message),
  });
}

function decodeChannelTools(b64: string): readonly unknown[] {
  if (!isCanonicalBase64(b64)) {
    throw new Error('--channel-tools-b64 must be valid canonical base64');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(b64, 'base64').toString('utf8'));
  } catch (err) {
    throw new Error(
      `--channel-tools-b64 did not decode to valid JSON: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
  if (!Array.isArray(parsed)) {
    throw new Error('--channel-tools-b64 must decode to a JSON array of tool descriptors');
  }
  return parsed;
}

function isCanonicalBase64(value: string): boolean {
  if (value.length === 0 || value.length % 4 !== 0) return false;
  return /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
    value,
  );
}
