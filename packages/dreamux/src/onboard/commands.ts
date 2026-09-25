import { execa } from 'execa';

import type { CommandRunner } from '../onboard/types.js';

interface CommandOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  dryRun?: boolean;
}

export class ExecaCommandRunner implements CommandRunner {
  async run(
    command: string,
    args: string[],
    options: CommandOptions = {},
  ): Promise<void> {
    if (options.dryRun) return;
    await execa(command, args, {
      ...execaEnvironment(options),
      stdio: 'inherit',
    });
  }

  async check(
    command: string,
    args: string[],
    options: CommandOptions = {},
  ): Promise<boolean> {
    if (options.dryRun) return false;
    const result = await execa(command, args, {
      ...execaEnvironment(options),
      reject: false,
      stdout: 'ignore',
      stderr: 'ignore',
    });
    return result.exitCode === 0;
  }

  async capture(
    command: string,
    args: string[],
    options: CommandOptions = {},
  ): Promise<string> {
    if (options.dryRun) return '';
    const result = await execa(command, args, {
      ...execaEnvironment(options),
    });
    return result.stdout;
  }
}

function execaEnvironment(options: CommandOptions): {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  extendEnv: boolean;
} {
  // Spreads the two fields conditionally rather than widening this return
  // type to `| undefined`: the result feeds execa's own `Options.cwd?: string
  // | URL` (no explicit `undefined`), so an omitted key is required here,
  // not just tolerated.
  return {
    ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
    ...(options.env !== undefined ? { env: options.env } : {}),
    extendEnv: options.env === undefined,
  };
}
