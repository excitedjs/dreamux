/**
 * Service-manager lifecycle wrappers for the `dreamux daemon` command group.
 *
 * These talk to the native user-level service manager directly (Linux
 * `systemctl --user`, macOS `launchctl`) — not the admin socket — so they work
 * even when the server is down. Each verb maps to the platform's idiom:
 *
 *   verb     | systemd --user                       | launchd (gui/<uid>/<label>)
 *   ---------|--------------------------------------|----------------------------
 *   start    | start dreamux.service                | kickstart (bootstrap if unloaded)
 *   stop     | stop dreamux.service                 | bootout (KeepAlive would relaunch a kill)
 *   restart  | restart dreamux.service              | kickstart -k (bootstrap if unloaded)
 *
 * launchd's KeepAlive=true relaunches a plain `kill`, so a stop that *stays*
 * stopped is a `bootout`; start/restart then re-bootstrap when needed.
 */

import { homedir } from 'node:os';

import { LAUNCHD_LABEL, serviceUnitPath, SYSTEMD_UNIT } from '../onboard/service.js';
import type { CommandRunner, ServicePlatform } from '../onboard/types.js';

export type DaemonVerb = 'start' | 'stop' | 'restart';

export interface ServiceControlOptions {
  runner: CommandRunner;
  platform?: NodeJS.Platform;
  homeDir?: string;
  uid?: number;
  dryRun?: boolean;
}

export interface ServiceControlResult {
  platform: ServicePlatform;
  verb: DaemonVerb;
  /** Commands actually issued (command + args), in order. */
  commands: Array<{ command: string; args: string[] }>;
}

export async function controlUserService(
  verb: DaemonVerb,
  options: ServiceControlOptions,
): Promise<ServiceControlResult> {
  const homeDir = options.homeDir ?? homedir();
  const unit = serviceUnitPath(options.platform, homeDir);
  const dryRun = options.dryRun ?? false;
  const commands: Array<{ command: string; args: string[] }> = [];

  if (unit.platform === 'systemd') {
    const args = ['--user', verb, SYSTEMD_UNIT];
    await options.runner.run('systemctl', args, { dryRun });
    commands.push({ command: 'systemctl', args });
    return { platform: 'systemd', verb, commands };
  }

  const uid = options.uid ?? process.getuid?.();
  if (uid === undefined) {
    throw new Error('launchd user service control requires a numeric uid');
  }
  const target = `gui/${uid}/${LAUNCHD_LABEL}`;
  const loaded = await options.runner.check('launchctl', ['print', target], { dryRun });

  if (verb === 'stop') {
    if (loaded) {
      const args = ['bootout', target];
      await options.runner.run('launchctl', args, { dryRun });
      commands.push({ command: 'launchctl', args });
    }
    return { platform: 'launchd', verb, commands };
  }

  if (!loaded) {
    const args = ['bootstrap', `gui/${uid}`, unit.path];
    await options.runner.run('launchctl', args, { dryRun });
    commands.push({ command: 'launchctl', args });
    if (verb === 'start') return { platform: 'launchd', verb, commands };
  }
  const args = verb === 'restart' ? ['kickstart', '-k', target] : ['kickstart', target];
  await options.runner.run('launchctl', args, { dryRun });
  commands.push({ command: 'launchctl', args });
  return { platform: 'launchd', verb, commands };
}
