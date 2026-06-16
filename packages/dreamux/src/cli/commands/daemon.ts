import type { Argv, CommandModule } from 'yargs';

import {
  runDaemonInstall,
  runDaemonUninstall,
  type DaemonInstallResult,
} from '../../daemon/install.js';
import {
  DEFAULT_RESTART_ANNOUNCE,
  notifyResumedRestart,
} from '../../daemon/restart-intent.js';
import {
  controlUserService,
  type DaemonVerb,
} from '../../daemon/service-control.js';
import { ExecaCommandRunner } from '../../onboard/commands.js';
import { validateDispatcherId } from '../../state/dispatcher-id.js';
import { printServiceWarnings } from './service-output.js';
import { noopHandler, type DreamuxCommand } from './types.js';

interface DaemonInstallArgv {
  start?: boolean;
  dryRun?: boolean;
}

interface DaemonUninstallArgv {
  dryRun?: boolean;
}

interface DaemonRestartArgv {
  notifyResumed?: boolean;
  dispatcher?: string[];
  announce?: string;
}

export function createDaemonCommand(): CommandModule {
  return {
    command: 'daemon <command>',
    describe: 'Manage the dreamux user-level service',
    builder: (y) =>
      y
        .command([
          createDaemonInstallCommand(),
          createDaemonUninstallCommand(),
          createDaemonStartCommand(),
          createDaemonStopCommand(),
          createDaemonRestartCommand(),
        ] as DreamuxCommand[])
        .demandCommand(1, 'Choose a daemon command')
        .strict(),
    handler: noopHandler,
  };
}

function createDaemonInstallCommand(): CommandModule<{}, DaemonInstallArgv> {
  return {
    command: 'install',
    describe: 'Register (or re-register) the user-level service from config',
    builder: (y) =>
      y
        .option('start', {
          type: 'boolean',
          default: true,
          describe: 'Start the service after registration',
        })
        .option('dry-run', {
          type: 'boolean',
          describe: 'Print the planned actions without writing or registering',
        }) as Argv<DaemonInstallArgv>,
    handler: async (argv) => {
      const result = await runDaemonInstall({
        startService: argv.start !== false,
        dryRun: argv.dryRun === true,
      });
      printDaemonInstallResult(result);
    },
  };
}

function createDaemonUninstallCommand(): CommandModule<{}, DaemonUninstallArgv> {
  return {
    command: 'uninstall',
    describe:
      'Remove the user-level service unit only (keeps config, run, cache, state, logs)',
    builder: (y) =>
      y.option('dry-run', {
        type: 'boolean',
        describe: 'Print the planned removal without unregistering',
      }) as Argv<DaemonUninstallArgv>,
    handler: async (argv) => {
      const result = await runDaemonUninstall({
        dryRun: argv.dryRun === true,
      });
      console.log(
        `dreamux daemon uninstall: ${result.platform} unit ${result.removed ? 'removed' : 'absent'} at ${result.unitPath}`,
      );
    },
  };
}

function createDaemonStartCommand(): CommandModule {
  return {
    command: 'start',
    describe: 'Start the user-level service',
    handler: async () => runDaemonControl('start'),
  };
}

function createDaemonStopCommand(): CommandModule {
  return {
    command: 'stop',
    describe: 'Stop the user-level service',
    handler: async () => runDaemonControl('stop'),
  };
}

function createDaemonRestartCommand(): CommandModule<{}, DaemonRestartArgv> {
  return {
    command: 'restart',
    describe: 'Restart the user-level service',
    builder: (y) =>
      y
        .option('notify-resumed', {
          type: 'boolean',
          describe:
            'After the restart, inject a one-shot notice into the named resumed dispatcher(s)',
        })
        .option('dispatcher', {
          type: 'string',
          array: true,
          describe:
            'Dispatcher id to notify (required with --notify-resumed; repeatable)',
        })
        .option('announce', {
          type: 'string',
          describe: `Notice text to inject (default: "${DEFAULT_RESTART_ANNOUNCE}")`,
        }) as Argv<DaemonRestartArgv>,
    handler: handleDaemonRestart,
  };
}

async function runDaemonControl(verb: DaemonVerb): Promise<void> {
  const result = await controlUserService(verb, {
    runner: new ExecaCommandRunner(),
  });
  const issued = result.commands
    .map((cmd) => `${cmd.command} ${cmd.args.join(' ')}`)
    .join('; ');
  console.log(
    `dreamux daemon ${verb}: ${result.platform}${issued === '' ? ' (no-op)' : ` (${issued})`}`,
  );
}

async function handleDaemonRestart(argv: DaemonRestartArgv): Promise<void> {
  if (argv.notifyResumed !== true) {
    await runDaemonControl('restart');
    return;
  }

  const targets = (argv.dispatcher ?? []).map((id) => validateDispatcherId(id));
  if (targets.length === 0) {
    throw new Error('--notify-resumed requires at least one --dispatcher <id>');
  }
  console.log(
    `dreamux daemon restart: will notify resumed dispatcher(s) ${targets.join(', ')}`,
  );
  await notifyResumedRestart({
    targets,
    ...(argv.announce !== undefined ? { announce: argv.announce } : {}),
    now: Date.now(),
    runControl: () => runDaemonControl('restart'),
  });
}

function printDaemonInstallResult(result: DaemonInstallResult): void {
  console.log('dreamux daemon install file ledger:');
  for (const entry of result.files) {
    console.log(`${entry.status}\t${entry.path}\t${entry.reason}`);
  }
  console.log(
    `dreamux daemon install service: ${result.service.platform} ${result.service.unitPath}`,
  );
  printServiceWarnings(result.service.lingerEnabled, result.service.warnings);
}
