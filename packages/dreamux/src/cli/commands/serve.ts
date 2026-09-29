import type { CommandModule } from 'yargs';

import { runServe } from '../server.js';

export function createServeCommand(): CommandModule {
  return {
    command: 'serve',
    describe: 'Run the local server in the foreground',
    handler: async () => runServe(),
  };
}
