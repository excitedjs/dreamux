/**
 * `dreamux` — the single public CLI entry point.
 *
 * Issue #18 replaces the old package-global aliases with one bin. This file
 * owns the command tree and delegates implementation slices to focused
 * modules where the runtime already exists.
 */

import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import yargs, { type Argv } from 'yargs';
import { hideBin } from 'yargs/helpers';

import { globalConfigFile } from '../runtime/config.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVER_ENTRY = join(HERE, 'server.js');
const SERVER_CTL_ENTRY = join(HERE, 'server-ctl.js');

type DispatcherVerb = 'remove' | 'status' | 'start' | 'stop';
type DaemonVerb = 'install' | 'uninstall' | 'start' | 'stop' | 'status';

async function execEntry(
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
}

function adminEnv(): NodeJS.ProcessEnv {
  return { ...process.env, DREAMUX_ADMIN_CLI_NAME: 'dreamux' };
}

function notImplemented(command: string): never {
  throw new Error(`${command} is not implemented in this serve-foundation build`);
}

function requiredString(value: unknown, name: string): string {
  if (typeof value === 'string' && value.trim() !== '') return value;
  throw new Error(`missing required option --${name}`);
}

function optionalString(value: unknown): string | null {
  if (typeof value !== 'string' || value === '') return null;
  return value;
}

function withRequiredDispatcherId<T>(y: Argv<T>): Argv<T & { id: string }> {
  return y.option('id', {
    type: 'string',
    demandOption: true,
    describe: 'Dispatcher id',
  }) as Argv<T & { id: string }>;
}

function buildDispatcherCommands(y: Argv): Argv {
  return y
    .command(
      'list',
      'List configured dispatchers',
      (yy) => yy,
      async () => execEntry(SERVER_CTL_ENTRY, ['dispatcher', 'list'], adminEnv()),
    )
    .command(
      'add',
      'Add a dispatcher',
      (yy) =>
        yy
          .option('id', {
            type: 'string',
            demandOption: true,
            describe: 'Dispatcher id',
          })
          .option('bot-app-id', {
            type: 'string',
            demandOption: true,
            describe: 'Channel bot app id',
          })
          .option('bot-secret-ref', {
            type: 'string',
            demandOption: true,
            describe: 'Secret reference, for example env:BOT_SECRET_NAME',
          })
          .option('codex-args-json', {
            type: 'string',
            describe: 'Dispatcher-specific Codex argument JSON',
          })
          .option('codex-cwd', {
            type: 'string',
            describe: 'Override dispatcher app-server cwd',
          }),
      async (argv) => {
        const args = [
          'dispatcher',
          'add',
          '--id',
          requiredString(argv.id, 'id'),
          '--bot-app-id',
          requiredString(argv.botAppId, 'bot-app-id'),
          '--bot-secret-ref',
          requiredString(argv.botSecretRef, 'bot-secret-ref'),
        ];
        const codexArgsJson = optionalString(argv.codexArgsJson);
        if (codexArgsJson !== null) {
          args.push('--codex-args-json', codexArgsJson);
        }
        const codexCwd = optionalString(argv.codexCwd);
        if (codexCwd !== null) args.push('--codex-cwd', codexCwd);
        await execEntry(SERVER_CTL_ENTRY, args, adminEnv());
      },
    )
    .command(
      ['remove', 'status', 'start', 'stop'],
      'Manage one dispatcher',
      withRequiredDispatcherId,
      async (argv) => {
        const verb = requiredString(argv._[1], 'dispatcher verb') as DispatcherVerb;
        await execEntry(
          SERVER_CTL_ENTRY,
          ['dispatcher', verb, '--id', requiredString(argv.id, 'id')],
          adminEnv(),
        );
      },
    )
    .demandCommand(1, 'Choose a dispatcher command')
    .strict();
}

function buildDaemonCommands(y: Argv): Argv {
  return y
    .command(
      ['install', 'uninstall', 'start', 'stop', 'status'],
      'Manage the user-level service',
      (yy) => yy,
      (argv) => notImplemented(`dreamux daemon ${requiredString(argv._[1], 'daemon verb') as DaemonVerb}`),
    )
    .demandCommand(1, 'Choose a daemon command')
    .strict();
}

function buildConfigCommands(y: Argv): Argv {
  return y
    .command(
      'path',
      'Print the dreamux global config path',
      (yy) => yy,
      () => {
        console.log(globalConfigFile());
      },
    )
    .command(
      'show',
      'Print the dreamux global config file',
      (yy) => yy,
      () => {
        const file = globalConfigFile();
        if (!existsSync(file)) {
          throw new Error(`config file does not exist: ${file}`);
        }
        process.stdout.write(readFileSync(file, 'utf8'));
      },
    )
    .demandCommand(1, 'Choose a config command')
    .strict();
}

async function main(): Promise<void> {
  await yargs(hideBin(process.argv))
    .scriptName('dreamux')
    .usage('$0 <command> [options]')
    .command(
      'onboard',
      'Run first-time setup',
      (yy) => yy,
      () => notImplemented('dreamux onboard'),
    )
    .command(
      'serve',
      'Run the local server in the foreground',
      (yy) => yy,
      async () => execEntry(SERVER_ENTRY, []),
    )
    .command(
      'status',
      'Show running server status',
      (yy) => yy,
      async () => execEntry(SERVER_CTL_ENTRY, ['server', 'status'], adminEnv()),
    )
    .command(
      'doctor',
      'Run setup diagnostics',
      (yy) => yy,
      () => notImplemented('dreamux doctor'),
    )
    .command(
      'daemon <command>',
      'Manage the user-level service',
      buildDaemonCommands,
    )
    .command(
      'dispatcher <command>',
      'Manage dispatchers',
      buildDispatcherCommands,
    )
    .command('config <command>', 'Inspect config', buildConfigCommands)
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
