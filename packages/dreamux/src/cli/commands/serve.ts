import type { CommandModule } from 'yargs';

import type { CliDeps } from './types.js';

export function createServeCommand(deps: CliDeps): CommandModule {
  return {
    command: 'serve',
    describe: 'Run the local server in the foreground',
    handler: async () => deps.execEntry(deps.serverEntry, []),
  };
}
