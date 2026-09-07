import type { CommandModule } from 'yargs';

import {
  requiredDispatcherId,
  withRequiredDispatcherId,
} from './parse.js';
import {
  adminEnv,
  noopHandler,
  type CliDeps,
  type DreamuxCommand,
} from './types.js';

interface ChannelListArgv {
  id: string;
}

export function createChannelCommand(deps: CliDeps): CommandModule {
  return {
    command: 'channel <command>',
    describe: 'Inspect configured Channels',
    builder: (y) =>
      y
        .command([createChannelListCommand(deps)] as DreamuxCommand[])
        .demandCommand(1, 'Choose a channel command')
        .strict(),
    handler: noopHandler,
  };
}

function createChannelListCommand(deps: CliDeps): CommandModule<{}, ChannelListArgv> {
  return {
    command: 'list',
    describe: 'List a dispatcher\'s configured Channels and live state',
    builder: withRequiredDispatcherId,
    handler: async (argv) => {
      await deps.execEntry(
        deps.serverCtlEntry,
        ['channel', 'list', '--id', requiredDispatcherId(argv.id)],
        adminEnv(),
      );
    },
  };
}
