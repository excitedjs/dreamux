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

type DispatcherVerb = 'status' | 'start';

interface DispatcherArgv {
  id: string;
}

export function createDispatcherCommand(deps: CliDeps): CommandModule {
  return {
    command: 'dispatcher <command>',
    describe: 'Manage dispatchers',
    builder: (y) =>
      y
        .command([
          createDispatcherListCommand(deps),
          createDispatcherVerbCommand(deps, 'status'),
          createDispatcherVerbCommand(deps, 'start'),
        ] as DreamuxCommand[])
        .demandCommand(1, 'Choose a dispatcher command')
        .strict(),
    handler: noopHandler,
  };
}

function createDispatcherListCommand(deps: CliDeps): CommandModule {
  return {
    command: 'list',
    describe: 'List configured dispatchers',
    handler: async () =>
      deps.execEntry(deps.serverCtlEntry, ['dispatcher', 'list'], adminEnv()),
  };
}

function createDispatcherVerbCommand(
  deps: CliDeps,
  verb: DispatcherVerb,
): CommandModule<{}, DispatcherArgv> {
  return {
    command: verb,
    describe: 'Manage one dispatcher',
    builder: withRequiredDispatcherId,
    handler: async (argv) => {
      await deps.execEntry(
        deps.serverCtlEntry,
        [
          'dispatcher',
          verb,
          '--id',
          requiredDispatcherId(argv.id),
        ],
        adminEnv(),
      );
    },
  };
}
