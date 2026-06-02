import { existsSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';

import { globalConfigDir, loadConfig } from '../runtime/config.js';
import { runtimeRoot, setRuntimeConfig } from '../runtime/paths.js';
import { ExecaCommandRunner } from '../onboard/commands.js';
import {
  installUserService,
  LAUNCHD_LABEL,
  serviceUnitPath,
  SYSTEMD_UNIT,
  type ServiceInstallAnswers,
} from '../onboard/service.js';
import { TransparentFileLedger } from '../onboard/ledger.js';
import type {
  CommandRunner,
  OnboardFileLedgerEntry,
  ServicePlatform,
} from '../onboard/types.js';

export type DaemonAction = 'install' | 'uninstall' | 'start' | 'stop' | 'status';

export interface DaemonCommandOptions {
  action: DaemonAction;
  start?: boolean;
  dryRun?: boolean;
  runner?: CommandRunner;
  platform?: NodeJS.Platform;
  homeDir?: string;
  uid?: number;
  dreamuxBin?: string;
}

export interface DaemonStatus {
  platform: ServicePlatform;
  unitPath: string;
  installed: boolean;
  loaded: boolean;
  running: boolean;
  enabled: boolean;
  pid: number | null;
  detail: string | null;
}

export interface DaemonCommandResult {
  action: DaemonAction;
  status: DaemonStatus;
  files: Array<OnboardFileLedgerEntry | { path: string; status: 'removed'; reason: string }>;
}

export async function runDaemonCommand(
  options: DaemonCommandOptions,
): Promise<DaemonCommandResult> {
  const runner = options.runner ?? new ExecaCommandRunner();
  switch (options.action) {
    case 'install':
      return installDaemon({ ...options, runner });
    case 'uninstall':
      return uninstallDaemon({ ...options, runner });
    case 'start':
      return startDaemon({ ...options, runner });
    case 'stop':
      return stopDaemon({ ...options, runner });
    case 'status':
      return {
        action: 'status',
        status: await getDaemonStatus(options),
        files: [],
      };
  }
}

export async function getDaemonStatus(
  options: Omit<DaemonCommandOptions, 'action'> = {},
): Promise<DaemonStatus> {
  const runner = options.runner ?? new ExecaCommandRunner();
  const unit = serviceUnitPath(options.platform, options.homeDir ?? homedir());
  if (unit.platform === 'launchd') {
    return launchdStatus(unit.path, runner, options);
  }
  return systemdStatus(unit.path, runner);
}

export function printDaemonResult(result: DaemonCommandResult): void {
  for (const file of result.files) {
    console.log(`${file.status}\t${file.path}\t${file.reason}`);
  }
  console.log(formatDaemonStatus(result.status));
}

export function formatDaemonStatus(status: DaemonStatus): string {
  const parts = [
    `dreamux daemon: ${status.platform}`,
    `installed=${status.installed}`,
    `enabled=${status.enabled}`,
    `loaded=${status.loaded}`,
    `running=${status.running}`,
  ];
  if (status.pid !== null) parts.push(`pid=${status.pid}`);
  if (status.detail !== null && status.detail !== '') {
    parts.push(`detail=${status.detail}`);
  }
  parts.push(`unit=${status.unitPath}`);
  return parts.join(' ');
}

async function installDaemon(
  options: DaemonCommandOptions & { runner: CommandRunner },
): Promise<DaemonCommandResult> {
  const { answers } = loadServiceAnswers(options);
  const ledger = new TransparentFileLedger();
  await installUserService({
    answers,
    ledger,
    runner: options.runner,
    platform: options.platform,
    homeDir: options.homeDir,
    uid: options.uid,
  });
  return {
    action: 'install',
    status: await getDaemonStatus(options),
    files: ledger.entries(),
  };
}

async function uninstallDaemon(
  options: DaemonCommandOptions & { runner: CommandRunner },
): Promise<DaemonCommandResult> {
  const unit = serviceUnitPath(options.platform, options.homeDir ?? homedir());
  const before = await getDaemonStatus(options);
  const files: DaemonCommandResult['files'] = [];
  if (unit.platform === 'launchd') {
    const target = launchdTarget(options.uid);
    if (before.loaded) {
      await options.runner.run('launchctl', ['bootout', target], {
        dryRun: options.dryRun,
      });
    }
  } else if (before.installed || before.enabled || before.loaded) {
    await options.runner.run(
      'systemctl',
      ['--user', 'disable', '--now', SYSTEMD_UNIT],
      { dryRun: options.dryRun },
    );
  }
  if (existsSync(unit.path)) {
    if (!options.dryRun) rmSync(unit.path, { force: true });
    files.push({
      path: unit.path,
      status: 'removed',
      reason: `${unit.platform} unit`,
    });
  } else {
    files.push({
      path: unit.path,
      status: 'unchanged',
      reason: `${unit.platform} unit absent`,
    });
  }
  if (unit.platform === 'systemd') {
    await options.runner.run('systemctl', ['--user', 'daemon-reload'], {
      dryRun: options.dryRun,
    });
  }
  return {
    action: 'uninstall',
    status: await getDaemonStatus(options),
    files,
  };
}

async function startDaemon(
  options: DaemonCommandOptions & { runner: CommandRunner },
): Promise<DaemonCommandResult> {
  const unit = serviceUnitPath(options.platform, options.homeDir ?? homedir());
  if (!existsSync(unit.path)) {
    throw new Error(`service unit is not installed: ${unit.path}`);
  }
  if (unit.platform === 'launchd') {
    const target = launchdTarget(options.uid);
    const loaded = await options.runner.check('launchctl', ['print', target], {
      dryRun: options.dryRun,
    });
    if (!loaded) {
      await options.runner.run('launchctl', ['bootstrap', launchdDomain(options.uid), unit.path], {
        dryRun: options.dryRun,
      });
    }
    await options.runner.run('launchctl', ['kickstart', '-k', target], {
      dryRun: options.dryRun,
    });
  } else {
    await options.runner.run('systemctl', ['--user', 'start', SYSTEMD_UNIT], {
      dryRun: options.dryRun,
    });
  }
  return {
    action: 'start',
    status: await getDaemonStatus(options),
    files: [],
  };
}

async function stopDaemon(
  options: DaemonCommandOptions & { runner: CommandRunner },
): Promise<DaemonCommandResult> {
  const unit = serviceUnitPath(options.platform, options.homeDir ?? homedir());
  const before = await getDaemonStatus(options);
  if (unit.platform === 'launchd') {
    const target = launchdTarget(options.uid);
    if (before.loaded) {
      await options.runner.run('launchctl', ['bootout', target], {
        dryRun: options.dryRun,
      });
    }
  } else if (before.installed || before.loaded || before.running) {
    await options.runner.run('systemctl', ['--user', 'stop', SYSTEMD_UNIT], {
      dryRun: options.dryRun,
    });
  }
  return {
    action: 'stop',
    status: await getDaemonStatus(options),
    files: [],
  };
}

function loadServiceAnswers(options: DaemonCommandOptions): {
  answers: ServiceInstallAnswers;
  configFile: string;
} {
  const configDir = globalConfigDir();
  let loaded: ReturnType<typeof loadConfig>;
  try {
    loaded = loadConfig({ configDir });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      throw new Error(
        `dreamux config does not exist in ${configDir}; run dreamux onboard first`,
      );
    }
    throw err;
  }
  const { config, configFile } = loaded;
  setRuntimeConfig(config);
  return {
    configFile,
    answers: {
      configDir,
      runtimeDir: runtimeRoot(),
      codexBin: process.env['CODEX_HOST_CODEX_BIN'] || config.codex.bin,
      dreamuxBin:
        options.dreamuxBin ?? process.env['DREAMUX_BIN'] ?? process.argv[1],
      startService: options.start ?? false,
      dryRun: options.dryRun ?? false,
    },
  };
}

async function launchdStatus(
  unitPath: string,
  runner: CommandRunner,
  options: Omit<DaemonCommandOptions, 'action'>,
): Promise<DaemonStatus> {
  const target = launchdTarget(options.uid);
  let raw = '';
  let loaded = false;
  try {
    raw = await runner.capture('launchctl', ['print', target], {
      dryRun: options.dryRun,
    });
    loaded = true;
  } catch {
    loaded = false;
  }
  const pid = parseLaunchdPid(raw);
  return {
    platform: 'launchd',
    unitPath,
    installed: existsSync(unitPath),
    enabled: existsSync(unitPath),
    loaded,
    running: pid !== null || /\bstate = running\b/.test(raw),
    pid,
    detail: parseLaunchdDetail(raw),
  };
}

async function systemdStatus(
  unitPath: string,
  runner: CommandRunner,
): Promise<DaemonStatus> {
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
  const props = parseSystemdProperties(raw);
  return {
    platform: 'systemd',
    unitPath,
    installed: existsSync(unitPath),
    enabled,
    loaded: props['LoadState'] === 'loaded',
    running: active || props['ActiveState'] === 'active',
    pid: parsePositiveInt(props['MainPID']),
    detail: systemdDetail(props),
  };
}

function launchdTarget(uid?: number): string {
  return `${launchdDomain(uid)}/${LAUNCHD_LABEL}`;
}

function launchdDomain(uid?: number): string {
  const actualUid = uid ?? process.getuid?.();
  if (actualUid === undefined) {
    throw new Error('launchd user service control requires a numeric uid');
  }
  return `gui/${actualUid}`;
}

function parseLaunchdPid(raw: string): number | null {
  const match = raw.match(/\bpid = (\d+)/);
  if (match === null) return null;
  return parsePositiveInt(match[1]);
}

function parseLaunchdDetail(raw: string): string | null {
  const state = raw.match(/\bstate = ([^\n]+)/)?.[1]?.trim();
  const reason = raw.match(/\breason = ([^\n]+)/)?.[1]?.trim();
  return [state, reason].filter((value) => value !== undefined && value !== '')
    .join(', ') || null;
}

function parseSystemdProperties(raw: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of raw.split(/\r?\n/)) {
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    result[line.slice(0, eq)] = line.slice(eq + 1);
  }
  return result;
}

function systemdDetail(props: Record<string, string>): string | null {
  const parts = [
    props['LoadState'],
    props['ActiveState'],
    props['SubState'],
    props['Result'] !== undefined && props['Result'] !== 'success'
      ? `result=${props['Result']}`
      : undefined,
  ].filter((part) => part !== undefined && part !== '');
  return parts.join(', ') || null;
}

function parsePositiveInt(value: string | undefined): number | null {
  if (value === undefined) return null;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) return null;
  return parsed;
}
