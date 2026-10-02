/**
 * Managed-service status: read the installed unit's on-disk definition plus
 * live service-manager state. Used by `dreamux doctor`.
 */

import { readFile } from 'node:fs/promises';

import type { CommandRunner } from '../platform/command-runner.js';
import { pathExists } from '../platform/fs-errors.js';
import { createServiceHost, type ServiceHost } from './host.js';
import {
  launchdTarget,
  parseLaunchdDetail,
  parseLaunchdPid,
  parseLaunchdPlist,
  parsePositiveInt,
  parseSystemdProperties,
  parseSystemdUnit,
  serviceUnitPath,
  SYSTEMD_UNIT,
  systemdDetail,
} from './unit.js';

export interface ServiceStatus {
  platform: 'launchd' | 'systemd';
  unitPath: string;
  installed: boolean;
  loaded: boolean;
  running: boolean;
  enabled: boolean;
  pid: number | null;
  detail: string | null;
  environment: Record<string, string> | null;
  execStart: string[] | null;
}

export async function getServiceStatus(
  options: Partial<ServiceHost> = {},
): Promise<ServiceStatus> {
  const host = createServiceHost(options);
  const unit = serviceUnitPath(host.platform, host.homeDir);
  if (unit.platform === 'launchd') {
    return launchdStatus(unit.path, host.runner, host.uid);
  }
  return systemdStatus(unit.path, host.runner);
}

async function launchdStatus(
  unitPath: string,
  runner: CommandRunner,
  uid?: number,
): Promise<ServiceStatus> {
  const installed = await pathExists(unitPath);
  const target = launchdTarget(uid);
  let raw = '';
  let loaded = false;
  try {
    raw = await runner.capture('launchctl', ['print', target]);
    loaded = true;
  } catch {
    loaded = false;
  }
  const pid = parseLaunchdPid(raw);
  const unitFile = installed
    ? parseLaunchdPlist(await readFile(unitPath, 'utf8'))
    : { environment: null, execStart: null };
  return {
    platform: 'launchd',
    unitPath,
    installed,
    enabled: installed,
    loaded,
    running: pid !== null || /\bstate = running\b/.test(raw),
    pid,
    detail: parseLaunchdDetail(raw),
    environment: unitFile.environment,
    execStart: unitFile.execStart,
  };
}

async function systemdStatus(
  unitPath: string,
  runner: CommandRunner,
): Promise<ServiceStatus> {
  const enabled = await runner.check('systemctl', [
    '--user',
    'is-enabled',
    SYSTEMD_UNIT,
  ]);
  const active = await runner.check('systemctl', [
    '--user',
    'is-active',
    SYSTEMD_UNIT,
  ]);
  let raw = '';
  try {
    raw = await runner.capture('systemctl', [
      '--user',
      'show',
      SYSTEMD_UNIT,
      '--property=LoadState,ActiveState,SubState,MainPID,Result',
    ]);
  } catch {
    raw = '';
  }
  const installed = await pathExists(unitPath);
  const unitFile = installed
    ? parseSystemdUnit(await readFile(unitPath, 'utf8'))
    : { environment: null, execStart: null };
  const props = parseSystemdProperties(raw);
  return {
    platform: 'systemd',
    unitPath,
    installed,
    enabled,
    loaded: props['LoadState'] === 'loaded',
    running: active || props['ActiveState'] === 'active',
    pid: parsePositiveInt(props['MainPID']),
    detail: systemdDetail(props),
    environment: unitFile.environment,
    execStart: unitFile.execStart,
  };
}
