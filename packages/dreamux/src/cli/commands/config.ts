import { readFile } from 'node:fs/promises';

import type { CommandModule } from 'yargs';

import {
  assertConfigFileMode,
  globalConfigFile,
  redactConfigForDisplay,
} from '../../config/config.js';
import { pathExists } from '../../platform/fs-errors.js';
import { noopHandler, type DreamuxCommand } from './types.js';

export function createConfigCommand(): CommandModule {
  return {
    command: 'config <command>',
    describe: 'Inspect config',
    builder: (y) =>
      y
        .command([
          createConfigPathCommand(),
          createConfigShowCommand(),
        ] as DreamuxCommand[])
        .demandCommand(1, 'Choose a config command')
        .strict(),
    handler: noopHandler,
  };
}

function createConfigPathCommand(): CommandModule {
  return {
    command: 'path',
    describe: 'Print the dreamux global config path',
    handler: () => {
      console.log(globalConfigFile());
    },
  };
}

function createConfigShowCommand(): CommandModule {
  return {
    command: 'show',
    describe: 'Print the dreamux global config file',
    handler: async () => {
      const file = globalConfigFile();
      if (!(await pathExists(file))) {
        throw new Error(`config file does not exist: ${file}`);
      }
      await assertConfigFileMode(file);
      const raw = await readFile(file, 'utf8');
      process.stdout.write(redactConfigForDisplay(raw, file));
    },
  };
}
