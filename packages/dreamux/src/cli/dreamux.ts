/**
 * `dreamux` — the single public CLI entry point.
 *
 * Issue #18 replaces the old package-global aliases with one bin. This file
 * owns only root parser setup. Every top-level command is registered through a
 * yargs CommandModule from `commands/`.
 */

import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';

import { createDreamuxCommands } from './commands/index.js';

async function main(): Promise<void> {
  await yargs(hideBin(process.argv))
    .scriptName('dreamux')
    .usage('$0 <command> [options]')
    .command(createDreamuxCommands())
    .demandCommand(1, 'Choose a command')
    .strict()
    .help()
    .alias('h', 'help')
    .fail((msg, err) => {
      const message = err instanceof Error ? err.message : msg;
      if (message !== undefined && message !== '') {
        console.error(`dreamux: ${message}`);
      }
      process.exit(err instanceof Error ? 1 : 2);
    })
    .parseAsync();
}

main().catch((err) => {
  console.error(`dreamux: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
