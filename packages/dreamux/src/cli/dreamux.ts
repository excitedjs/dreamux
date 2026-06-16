/**
 * `dreamux` — the single public CLI entry point.
 *
 * Issue #18 replaces the old package-global aliases with one bin. This file
 * owns only root parser setup. Every top-level command is registered through a
 * yargs CommandModule from `commands/`.
 */

import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';

import {
  createDreamuxCommands,
  type CliDeps,
  type ExecEntry,
} from './commands/index.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVER_ENTRY = join(HERE, 'server.js');
const SERVER_CTL_ENTRY = join(HERE, 'server-ctl.js');

const execEntry: ExecEntry = async function execEntry(
  entry: string,
  argv: string[],
  env: NodeJS.ProcessEnv = process.env,
): Promise<never> {
  const child = spawn(process.execPath, [entry, ...argv], {
    env,
    stdio: 'inherit',
  });
  await new Promise<void>((_resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (signal !== null) {
        process.kill(process.pid, signal);
        return;
      }
      process.exit(code ?? 0);
    });
  });
  process.exit(0);
};

async function main(): Promise<void> {
  const deps: CliDeps = {
    serverEntry: SERVER_ENTRY,
    serverCtlEntry: SERVER_CTL_ENTRY,
    execEntry,
  };

  await yargs(hideBin(process.argv))
    .scriptName('dreamux')
    .usage('$0 <command> [options]')
    .command(createDreamuxCommands(deps))
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
