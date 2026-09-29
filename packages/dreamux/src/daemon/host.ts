import { homedir } from 'node:os';

import {
  ExecaCommandRunner,
  type CommandRunner,
} from '../platform/command-runner.js';

/**
 * The resolved identity a managed-service operation runs under: the shell
 * command runner, the OS platform selecting launchd vs systemd, the home
 * directory the unit path derives from, and (launchd only) the numeric uid
 * the `gui/<uid>` bootstrap domain needs. Every managed-service entry point
 * (install, uninstall, control, status, doctor) builds one via
 * {@link createServiceHost} instead of re-deriving its own four defaults.
 */
export interface ServiceHost {
  runner: CommandRunner;
  platform: NodeJS.Platform;
  homeDir: string;
  uid: number | undefined;
}

/**
 * Resolve a `ServiceHost` from caller-supplied overrides (tests pass a fake
 * runner/probe; production CLI entry points pass nothing and get the real
 * shell runner, current platform, home dir, and uid).
 */
export function createServiceHost(
  overrides: Partial<ServiceHost> = {},
): ServiceHost {
  return {
    runner: overrides.runner ?? new ExecaCommandRunner(),
    platform: overrides.platform ?? process.platform,
    homeDir: overrides.homeDir ?? homedir(),
    uid: overrides.uid ?? process.getuid?.(),
  };
}
