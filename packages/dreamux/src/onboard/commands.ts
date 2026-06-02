import { execa } from 'execa';

import type { CommandRunner } from './types.js';

export class ExecaCommandRunner implements CommandRunner {
  async run(
    command: string,
    args: string[],
    options: {
      cwd?: string;
      env?: NodeJS.ProcessEnv;
      dryRun?: boolean;
    } = {},
  ): Promise<void> {
    if (options.dryRun) return;
    await execa(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: 'inherit',
    });
  }

  async check(
    command: string,
    args: string[],
    options: {
      cwd?: string;
      env?: NodeJS.ProcessEnv;
      dryRun?: boolean;
    } = {},
  ): Promise<boolean> {
    if (options.dryRun) return false;
    const result = await execa(command, args, {
      cwd: options.cwd,
      env: options.env,
      reject: false,
      stdout: 'ignore',
      stderr: 'ignore',
    });
    return result.exitCode === 0;
  }

  async capture(
    command: string,
    args: string[],
    options: {
      cwd?: string;
      env?: NodeJS.ProcessEnv;
      dryRun?: boolean;
    } = {},
  ): Promise<string> {
    if (options.dryRun) return '';
    const result = await execa(command, args, {
      cwd: options.cwd,
      env: options.env,
    });
    return result.stdout;
  }
}
