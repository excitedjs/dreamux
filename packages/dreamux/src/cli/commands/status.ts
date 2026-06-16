import type { CommandModule } from 'yargs';

import { adminEnv, type CliDeps } from './types.js';

export function createStatusCommand(deps: CliDeps): CommandModule {
  return {
    command: 'status',
    describe: 'Show running server status',
    handler: async () =>
      deps.execEntry(deps.serverCtlEntry, ['server', 'status'], adminEnv()),
  };
}
