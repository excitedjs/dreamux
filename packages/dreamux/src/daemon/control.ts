/**
 * Service-manager lifecycle wrappers for the `dreamux daemon` command group.
 *
 * These talk to the native user-level service manager directly (Linux
 * `systemctl --user`, macOS `launchctl`, Windows Task Scheduler), so control
 * remains available when the server is down. Windows also checks the admin
 * endpoint before reporting a completed start/restart. Each verb maps to the
 * platform's idiom:
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
import { controlWindowsService } from './windows.js';

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
  /** Lifecycle commands issued (command + args), excluding status queries. */
  commands: Array<{ command: string; args: string[] }>;
  /** An external controller must finish after this service-owned caller exits. */
  handedOff?: boolean;
}

export async function controlUserService(
  verb: DaemonVerb,
  options: ServiceControlOptions,
): Promise<ServiceControlResult> {
  const host = createServiceHost(options);
  const dryRun = options.dryRun ?? false;
  const commands: Array<{ command: string; args: string[] }> = [];

  if (host.platform === 'win32') {
    return {
      platform: 'windows',
      verb,
      ...(await controlWindowsService(verb, host.runner, dryRun)),
    };
  }

  const unit = serviceUnitPath(host.platform, host.homeDir);

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
