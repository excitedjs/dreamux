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

import type { CommandRunner } from '../platform/command-runner.js';
import { createServiceHost } from './host.js';
import {
  launchdTarget,
  serviceUnitPath,
  SYSTEMD_UNIT,
  type ServicePlatform,
} from './unit.js';

export type DaemonVerb = 'start' | 'stop' | 'restart';

export interface ServiceControlOptions {
  runner?: CommandRunner;
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
  const host = createServiceHost(options);
  const unit = serviceUnitPath(host.platform, host.homeDir);
  const dryRun = options.dryRun ?? false;
  const commands: Array<{ command: string; args: string[] }> = [];

  if (unit.platform === 'systemd') {
    const args = ['--user', verb, SYSTEMD_UNIT];
    await host.runner.run('systemctl', args, { dryRun });
    commands.push({ command: 'systemctl', args });
    return { platform: 'systemd', verb, commands };
  }

  const target = launchdTarget(host.uid);
  const domain = `gui/${host.uid}`;
  const loaded = await host.runner.check('launchctl', ['print', target], {
    dryRun,
  });

  if (verb === 'stop') {
    if (loaded) {
      const args = ['bootout', target];
      await host.runner.run('launchctl', args, { dryRun });
      commands.push({ command: 'launchctl', args });
    }
    return { platform: 'launchd', verb, commands };
  }

  if (!loaded) {
    const args = ['bootstrap', domain, unit.path];
    await host.runner.run('launchctl', args, { dryRun });
    commands.push({ command: 'launchctl', args });
    if (verb === 'start') return { platform: 'launchd', verb, commands };
  }
  const args =
    verb === 'restart' ? ['kickstart', '-k', target] : ['kickstart', target];
  await host.runner.run('launchctl', args, { dryRun });
  commands.push({ command: 'launchctl', args });
  return { platform: 'launchd', verb, commands };
}
