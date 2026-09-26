import { execa } from 'execa';

/**
 * Abstraction over running a host shell command. Onboarding, service
 * install/uninstall, and provider diagnostics all shell out to check or
 * launch external processes; this interface lets those call sites accept a
 * fake runner in tests instead of spawning a real process.
 */
export interface CommandRunner {
  run(
    command: string,
    args: string[],
    options?: {
      cwd?: string;
      env?: NodeJS.ProcessEnv;
      dryRun?: boolean;
    },
  ): Promise<void>;
  check(
    command: string,
    args: string[],
    options?: {
      cwd?: string;
      env?: NodeJS.ProcessEnv;
      dryRun?: boolean;
    },
  ): Promise<boolean>;
  capture(
    command: string,
    args: string[],
    options?: {
      cwd?: string;
      env?: NodeJS.ProcessEnv;
      dryRun?: boolean;
    },
  ): Promise<string>;
}

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
