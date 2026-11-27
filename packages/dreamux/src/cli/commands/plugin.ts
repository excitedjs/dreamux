import type { Argv, CommandModule } from 'yargs';

import { addPlugin, listPlugins, removePlugin } from '../../plugin/manage.js';
import { runPluginCommand } from '../../plugin/run.js';
import { ExecaCommandRunner } from '../../platform/command-runner.js';
import { noopHandler, type DreamuxCommand } from './types.js';

interface PluginNameArgv {
  name: string;
}

/**
 * Printed after a command changed `plugins[]` or `dispatchers[]`: the running
 * daemon keeps what it loaded at its start.
 */
export const RESTART_HINT =
  'Takes effect the next time the daemon starts: dreamux daemon restart';

export function createPluginCommand(): CommandModule {
  return {
    command: 'plugin <command>',
    describe:
      'Manage plugins. `dreamux plugin run <name> [args..]` runs the ' +
      "plugin's own command line and is not parsed by Dreamux",
    builder: (y) =>
      y
        .command([
          createAddCommand(),
          createRemoveCommand(),
          createListCommand(),
        ] as DreamuxCommand[])
        .demandCommand(1, 'Choose a plugin command')
        .strict(),
    handler: noopHandler,
  };
}

/**
 * `plugin run` gives the plugin everything after the package name, options
 * included, so it is read before the argument parser sees it.
 */
export async function forwardPluginRun(
  argv: readonly string[],
): Promise<number> {
  const [name, ...args] = argv;
  if (name === undefined) {
    throw new Error('usage: dreamux plugin run <npm package name> [args..]');
  }
  return runPluginCommand(name, args);
}

function createAddCommand(): CommandModule<{}, PluginNameArgv> {
  return {
    command: 'add <name>',
    describe: 'Install a plugin into the plugin directory and register it',
    builder: withPluginName,
    handler: async (argv) => {
      const result = await addPlugin(argv.name, new ExecaCommandRunner());
      const done = [
        ...(result.installed ? ['installed'] : []),
        ...(result.registered ? ['registered'] : []),
      ];
      if (done.length === 0) {
        console.log(`dreamux plugin add: ${result.ref} is already registered`);
        return;
      }
      console.log(`dreamux plugin add: ${done.join(' and ')} ${result.ref}`);
      console.log(RESTART_HINT);
    },
  };
}

function createRemoveCommand(): CommandModule<{}, PluginNameArgv> {
  return {
    command: 'remove <name>',
    describe: 'Unregister a plugin and uninstall it from the plugin directory',
    builder: withPluginName,
    handler: async (argv) => {
      const { ref } = await removePlugin(argv.name, new ExecaCommandRunner());
      console.log(`dreamux plugin remove: unregistered ${ref}`);
      console.log(RESTART_HINT);
    },
  };
}

function createListCommand(): CommandModule {
  return {
    command: 'list',
    describe: 'List registered plugins',
    handler: async () => {
      for (const row of await listPlugins()) {
        console.log(
          row.error === undefined
            ? `${row.ref}\t${row.name}\tproviders: ${row.providers.join(', ') || 'none'}`
            : `${row.ref}\tcannot be loaded: ${row.error}`,
        );
      }
    },
  };
}

function withPluginName(y: Argv<{}>): Argv<PluginNameArgv> {
  return y.positional('name', {
    type: 'string',
    demandOption: true,
    describe: 'npm package name of the plugin',
  }) as Argv<PluginNameArgv>;
}
