import type { Argv, CommandModule } from 'yargs';

import { runSubscribeChannelMcp } from '../../mcp/subscribe-channel-mcp.js';
import { createLogger } from '../../platform/logger.js';
import { channelMcpLogPath } from '../../platform/paths.js';
import { validateDispatcherId } from '../../state/dispatcher-id.js';

interface SubscribeChannelMcpArgv {
  dispatcher: string;
  provider?: string;
  subscriptionId?: string;
  'subscription-id'?: string;
  adminSocket?: string;
  subscriptionToolsB64?: string;
}

export function createSubscribeChannelMcpCommand(): CommandModule<
  {},
  SubscribeChannelMcpArgv
> {
  return {
    command: 'subscribe-channel-mcp',
    describe: 'Run the subscription channel MCP stdio shim for a dispatcher',
    builder: buildSubscribeChannelMcpOptions,
    handler: handleSubscribeChannelMcp,
  };
}

function buildSubscribeChannelMcpOptions(
  y: Argv,
): Argv<SubscribeChannelMcpArgv> {
  return y
    .option('dispatcher', {
      type: 'string',
      demandOption: true,
      describe: 'Dispatcher id this MCP shim is scoped to',
    })
    .option('provider', {
      type: 'string',
      describe: 'SubscribeChannel provider ref this shim serves',
    })
    .option('subscription-id', {
      type: 'string',
      demandOption: true,
      describe: 'Dispatcher-local subscription id this shim serves',
    })
    .option('admin-socket', {
      type: 'string',
      describe: 'dreamux serve admin socket path',
    })
    .option('subscription-tools-b64', {
      type: 'string',
      describe:
        "Base64 JSON of the subscription's static MCP tool descriptors (provider-supplied; the shim serves tools/list from it)",
    }) as unknown as Argv<SubscribeChannelMcpArgv>;
}

async function handleSubscribeChannelMcp(
  argv: SubscribeChannelMcpArgv,
): Promise<void> {
  const dispatcherId = validateDispatcherId(argv.dispatcher);
  const subscriptionId = argv.subscriptionId ?? argv['subscription-id'];
  if (subscriptionId === undefined || subscriptionId === '') {
    throw new Error('--subscription-id is required');
  }
  const log = createLogger({
    name: `subscribe-channel-mcp/${dispatcherId}`,
    filePath: channelMcpLogPath(dispatcherId),
  });
  await runSubscribeChannelMcp({
    dispatcherId,
    providerRef: argv.provider,
    subscriptionId,
    adminSocketPath: argv.adminSocket,
    ...(argv.subscriptionToolsB64 !== undefined
      ? { tools: decodeSubscriptionTools(argv.subscriptionToolsB64) }
      : {}),
    log: (message) => log.info(message),
  });
}

function decodeSubscriptionTools(b64: string): readonly unknown[] {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(b64, 'base64').toString('utf8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}
