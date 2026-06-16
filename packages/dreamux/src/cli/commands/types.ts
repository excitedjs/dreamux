import type { CommandModule } from 'yargs';

export type ExecEntry = (
  entry: string,
  argv: string[],
  env?: NodeJS.ProcessEnv,
) => Promise<never>;

export interface CliDeps {
  serverEntry: string;
  serverCtlEntry: string;
  execEntry: ExecEntry;
}

export type DreamuxCommand = CommandModule<{}, any>;

export function adminEnv(): NodeJS.ProcessEnv {
  return { ...process.env, DREAMUX_ADMIN_CLI_NAME: 'dreamux' };
}

export function noopHandler(): void {
  // Group commands only dispatch to their subcommands.
}
