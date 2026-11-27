import type { Argv, CommandModule } from 'yargs';

import { addChannel } from '../../onboard/channel-add.js';
import { noopHandler, type DreamuxCommand } from './types.js';
import { printOnboardResult } from './onboard.js';
import { RESTART_HINT } from './plugin.js';

interface ChannelNameArgv {
  name: string;
}

export function createChannelCommand(): CommandModule {
  return {
    command: 'channel <command>',
    describe: 'Wire a channel into the configuration',
    builder: (y) =>
      y
        .command([createChannelAddCommand()] as DreamuxCommand[])
        .demandCommand(1, 'Choose a channel command')
        .strict(),
    handler: noopHandler,
  };
}

function createChannelAddCommand(): CommandModule<{}, ChannelNameArgv> {
  return {
    command: 'add <name>',
    describe: 'Create a new Dispatcher with one channel of a registered plugin',
    builder: (y) =>
      y.positional('name', {
        type: 'string',
        demandOption: true,
        describe: 'npm package name of the registered plugin',
      }) as Argv<ChannelNameArgv>,
    handler: async (argv) => {
      const result = await addChannel(argv.name);
      console.log(`dreamux channel add: dispatcher ${result.dispatcher_id}`);
      printOnboardResult(result);
      console.log(RESTART_HINT);
    },
  };
}
