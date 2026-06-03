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

import {
  assertConfigFileMode,
  globalConfigFile,
  redactConfigForDisplay,
} from '../runtime/config.js';
import { validateDispatcherId } from '../runtime/dispatcher-id.js';
import { runOnboard } from '../onboard/run.js';
import {
  runUninstall,
  type UninstallRunResult,
} from '../onboard/uninstall.js';
import {
  collectOnboardAnswers,
  type OnboardCliOptions,
} from '../onboard/wizard.js';
import type { OnboardRunResult } from '../onboard/types.js';
import { printDoctorResult, runDreamuxDoctor } from './doctor.js';
import { runFeishuMcp } from '../mcp/feishu-mcp.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVER_ENTRY = join(HERE, 'server.js');
const SERVER_CTL_ENTRY = join(HERE, 'server-ctl.js');

type DispatcherVerb = 'remove' | 'status' | 'start' | 'stop';

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

function requiredString(value: unknown, name: string): string {
  if (typeof value === 'string' && value.trim() !== '') return value;
  throw new Error(`missing required option --${name}`);
}

function requiredDispatcherId(value: unknown): string {
  return validateDispatcherId(requiredString(value, 'id'));
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
            describe: 'Secret reference, usually config:<dispatcher-id>',
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
          requiredDispatcherId(argv.id),
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
          ['dispatcher', verb, '--id', requiredDispatcherId(argv.id)],
          adminEnv(),
        );
      },
    )
    .demandCommand(1, 'Choose a dispatcher command')
    .strict();
}

function buildOnboardCommand(y: Argv): Argv {
  return y
    .option('yes', {
      type: 'boolean',
      describe: 'Accept defaults and require non-default values via options',
    })
    .option('dry-run', {
      type: 'boolean',
      describe: 'Print the planned file ledger without writing or registering',
    })
    .option('config-dir', {
      type: 'string',
      describe: 'dreamux global config directory',
    })
    .option('runtime-dir', {
      type: 'string',
      describe: 'dreamux runtime directory',
    })
    .option('dispatcher-id', {
      type: 'string',
      describe: 'Dispatcher id to create or update',
    })
    .option('dispatcher-cwd', {
      type: 'string',
      describe: 'Working directory used when starting the dispatcher Codex app-server',
    })
    .option('codex-bin', {
      type: 'string',
      describe: 'Codex CLI binary or absolute path',
    })
    .option('bot-app-id', {
      type: 'string',
      describe: 'Channel bot app id',
    })
    .option('bot-app-secret', {
      type: 'string',
      describe: 'Channel bot app secret written to dreamux config',
    })
    .option('register-service', {
      type: 'boolean',
      describe: 'Write and register the user-level service',
    })
    .option('start-service', {
      type: 'boolean',
      describe: 'Start the service after registration',
    })
    .option('dreamux-bin', {
      type: 'string',
      describe: 'Absolute dreamux bin path used by the service unit',
    });
}

async function handleOnboard(argv: unknown): Promise<void> {
  const answers = await collectOnboardAnswers(argv as OnboardCliOptions);
  const result = await runOnboard({ answers });
  printOnboardResult(result);
}

function buildUninstallCommand(y: Argv): Argv {
  return y
    .option('dry-run', {
      type: 'boolean',
      describe: 'Print the planned removals without deleting or unregistering',
    })
    .option('config-dir', {
      type: 'string',
      describe: 'dreamux global config directory',
    })
    .option('runtime-dir', {
      type: 'string',
      describe: 'Legacy option ignored; uninstall removes dreamux state/log paths',
    });
}

async function handleUninstall(argv: unknown): Promise<void> {
  const args = argv as {
    dryRun?: boolean;
    configDir?: string;
    runtimeDir?: string;
  };
  const result = await runUninstall({
    dryRun: args.dryRun,
    configDir: args.configDir,
    runtimeDir: args.runtimeDir,
  });
  printUninstallResult(result);
}

function printOnboardResult(result: OnboardRunResult): void {
  console.log('dreamux onboard file ledger:');
  for (const entry of result.files) {
    console.log(`${entry.status}\t${entry.path}\t${entry.reason}`);
  }
  console.log(
    result.doctor.ok
      ? 'dreamux onboard doctor: ok'
      : `dreamux onboard doctor: failed (${result.doctor.errors.length} error(s))`,
  );
  if (result.service !== null) {
    console.log(
      `dreamux onboard service: ${result.service.platform} ${result.service.unitPath}`,
    );
  }
}

function printUninstallResult(result: UninstallRunResult): void {
  for (const warning of result.warnings) {
    console.error(`warning: ${warning}`);
  }
  console.log('dreamux uninstall file ledger:');
  for (const entry of result.entries) {
    console.log(`${entry.status}\t${entry.path}\t${entry.reason}`);
  }
  console.log(
    `dreamux uninstall service: ${result.service.platform} ${result.service.unitPath}`,
  );
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
        assertConfigFileMode(file);
        const raw = readFileSync(file, 'utf8');
        process.stdout.write(redactConfigForDisplay(raw, file));
      },
    )
    .demandCommand(1, 'Choose a config command')
    .strict();
}

function buildFeishuMcpCommand(
  y: Argv,
): Argv<{ dispatcher: string; adminSocket?: string }> {
  return y
    .option('dispatcher', {
      type: 'string',
      demandOption: true,
      describe: 'Dispatcher id this MCP shim is scoped to',
    })
    .option('admin-socket', {
      type: 'string',
      describe: 'dreamux serve admin socket path',
    }) as Argv<{ dispatcher: string; adminSocket?: string }>;
}

async function main(): Promise<void> {
  await yargs(hideBin(process.argv))
    .scriptName('dreamux')
    .usage('$0 <command> [options]')
    .command(
      'onboard',
      'Run first-time setup',
      buildOnboardCommand,
      handleOnboard,
    )
    .command(
      'uninstall',
      'Remove files and user service created by onboard',
      buildUninstallCommand,
      handleUninstall,
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
      (yy) =>
        yy.option('json', {
          type: 'boolean',
          describe: 'Print machine-readable JSON',
        }),
      async (argv) => {
        const result = await runDreamuxDoctor();
        if (argv.json === true) {
          console.log(JSON.stringify(result, null, 2));
        } else {
          printDoctorResult(result);
        }
        if (!result.ok) process.exitCode = 1;
      },
    )
    .command(
      'dispatcher <command>',
      'Manage dispatchers',
      buildDispatcherCommands,
    )
    .command(
      'feishu-mcp',
      'Run the dispatcher-scoped Feishu MCP stdio shim',
      buildFeishuMcpCommand,
      async (argv) => {
        await runFeishuMcp({
          dispatcherId: validateDispatcherId(argv.dispatcher),
          adminSocketPath: argv.adminSocket,
        });
      },
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
