import type { CommandModule } from 'yargs';

import { requiredDispatcherId, withRequiredDispatcherId } from './parse.js';
import {
  noopHandler,
  runAdminCommand,
  type DreamuxCommand,
} from './types.js';

type DispatcherVerb = 'status';

interface DispatcherArgv {
  id: string;
}

export function createDispatcherCommand(): CommandModule {
  return {
    command: 'dispatcher <command>',
    describe: 'Manage dispatchers',
    builder: (y) =>
      y
        .command([
          createDispatcherListCommand(),
          createDispatcherVerbCommand('status'),
        ] as DreamuxCommand[])
        .demandCommand(1, 'Choose a dispatcher command')
        .strict(),
    handler: noopHandler,
  };
}

function createDispatcherListCommand(): CommandModule {
  return {
    command: 'list',
    describe: 'List configured dispatchers',
    handler: async () => runAdminCommand('dispatcher.list'),
  };
}

function createDispatcherVerbCommand(
  verb: DispatcherVerb,
): CommandModule<{}, DispatcherArgv> {
  return {
    command: verb,
    describe: 'Manage one dispatcher',
    builder: withRequiredDispatcherId,
    handler: async (argv) => {
      await runAdminCommand(`dispatcher.${verb}`, {
        dispatcher_id: requiredDispatcherId(argv.id),
      });
    },
  };
}
