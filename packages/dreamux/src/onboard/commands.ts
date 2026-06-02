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
}
