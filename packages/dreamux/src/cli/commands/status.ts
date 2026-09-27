import type { CommandModule } from 'yargs';

import { runAdminCommand } from './types.js';

export function createStatusCommand(): CommandModule {
  return {
    command: 'status',
    describe: 'Show running server status',
    handler: async () => runAdminCommand('server.status'),
  };
}
