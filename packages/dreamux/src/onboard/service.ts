import { accessSync, constants } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, dirname, isAbsolute, join, resolve } from 'node:path';

import { build as buildPlist } from 'plist';
import { expandHome } from '../runtime/config.js';
import { logsRoot, stateRoot } from '../runtime/paths.js';

import {
  ensureDirectory,
  ensureTextFile,
  writeTextFile,
} from './ledger.js';
import type {
  CommandRunner,
  OnboardFileLedger,
  ServicePlatform,
} from './types.js';

export const LAUNCHD_LABEL = 'dev.excited.dreamux';
export const SYSTEMD_UNIT = 'dreamux.service';
export const MIN_SERVICE_NODE_VERSION = '22.7.0';
export const SERVICE_PATH_DEFAULTS = ['/usr/local/bin', '/usr/bin', '/bin'];

export interface ServiceInstallAnswers {
  configDir: string;
  runtimeDir: string;
  codexBin: string;
  dreamuxBin: string;
  nodeBin: string;
  startService: boolean;
  dryRun: boolean;
}

export interface ServiceInstallOptions {
  answers: ServiceInstallAnswers;
  ledger: OnboardFileLedger;
  runner: CommandRunner;
  platform?: NodeJS.Platform;
  homeDir?: string;
  uid?: number;
}

export interface ServiceInstallResult {
  platform: ServicePlatform;
  unitPath: string;
  registered: boolean;
  started: boolean;
}

export function serviceUnitPath(
  platform: NodeJS.Platform = process.platform,
  homeDir = homedir(),
): { platform: ServicePlatform; path: string } {
  if (platform === 'darwin') {
    return {
      platform: 'launchd',
      path: join(homeDir, 'Library', 'LaunchAgents', `${LAUNCHD_LABEL}.plist`),
    };
  }
  if (platform === 'linux') {
    return {
      platform: 'systemd',
      path: join(homeDir, '.config', 'systemd', 'user', SYSTEMD_UNIT),
    };
  }
  throw new Error(
    `dreamux onboard supports user-level services on macOS and Linux only (got ${platform})`,
  );
}

export async function installUserService(
  options: ServiceInstallOptions,
): Promise<ServiceInstallResult> {
  const homeDir = options.homeDir ?? homedir();
  const unit = serviceUnitPath(options.platform, homeDir);
  const logDir = logsRoot();
  const stdoutLog = join(logDir, 'daemon.stdout.log');
  const stderrLog = join(logDir, 'daemon.stderr.log');
  ensureDirectory(logDir, options.ledger, 'daemon log directory', {
    dryRun: options.answers.dryRun,
  });
  ensureTextFile(stdoutLog, '', options.ledger, 'daemon stdout log', {
    mode: 0o600,
    dryRun: options.answers.dryRun,
  });
  ensureTextFile(stderrLog, '', options.ledger, 'daemon stderr log', {
    mode: 0o600,
    dryRun: options.answers.dryRun,
  });

  const content =
    unit.platform === 'launchd'
      ? renderLaunchdPlist(options.answers, stdoutLog, stderrLog)
      : renderSystemdUnit(options.answers, stdoutLog, stderrLog);
  const unitStatus = writeTextFile(
    unit.path,
    content,
    options.ledger,
    `${unit.platform} unit`,
    {
      mode: 0o600,
      dryRun: options.answers.dryRun,
    },
  );

  if (unit.platform === 'launchd') {
    await registerLaunchd(unit.path, unitStatus, options);
  } else {
    await registerSystemd(unit.path, options);
  }

  return {
    platform: unit.platform,
    unitPath: unit.path,
    registered: true,
    started: options.answers.startService,
  };
}

export function renderLaunchdPlist(
  answers: ServiceInstallAnswers,
  stdoutLog: string,
  stderrLog: string,
): string {
  return buildPlist({
    Label: LAUNCHD_LABEL,
    ProgramArguments: [answers.dreamuxBin, 'serve'],
    RunAtLoad: true,
    KeepAlive: true,
    WorkingDirectory: stateRoot(),
    EnvironmentVariables: managedServiceEnvironment(answers),
    StandardOutPath: stdoutLog,
    StandardErrorPath: stderrLog,
  });
}

export function renderSystemdUnit(
  answers: ServiceInstallAnswers,
  stdoutLog: string,
  stderrLog: string,
): string {
  return `[Unit]
Description=dreamux dispatcher daemon

[Service]
Type=simple
ExecStart=${systemdEscapeArg(answers.dreamuxBin)} serve
WorkingDirectory=${systemdEscapeArg(stateRoot())}
${Object.entries(managedServiceEnvironment(answers))
  .map(([key, value]) => `Environment=${key}=${systemdEscapeEnv(value)}`)
  .join('\n')}
Restart=on-failure
RestartSec=2s
StandardOutput=append:${stdoutLog}
StandardError=append:${stderrLog}

[Install]
WantedBy=default.target
`;
}

export function managedServiceEnvironment(
  answers: ServiceInstallAnswers,
): Record<string, string> {
  const env: Record<string, string> = {
    DREAMUX_CONFIG_DIR: answers.configDir,
    HOME: homedir(),
    CODEX_HOST_CODEX_BIN: answers.codexBin,
    DREAMUX_NODE_BIN: answers.nodeBin,
    PATH: managedServicePath(answers),
  };
  return env;
}

export interface ServiceLaunchValidationResult {
  ok: boolean;
  errors: string[];
}

export async function validateManagedServiceLaunch(
  answers: ServiceInstallAnswers,
  runner: CommandRunner,
): Promise<ServiceLaunchValidationResult> {
  const env = managedServiceEnvironment(answers);
  const errors: string[] = [];

  try {
    const version = await runner.capture(answers.nodeBin, ['--version'], { env });
    if (!nodeVersionSatisfies(version)) {
      errors.push(
        `managed service Node must be >=${MIN_SERVICE_NODE_VERSION}: ${answers.nodeBin} reported ${version.trim() || '<empty>'}`,
      );
    }
  } catch (err) {
    errors.push(
      `managed service cannot execute Node at ${answers.nodeBin}: ${errorMessage(err)}`,
    );
  }

  if (!(await runner.check(answers.dreamuxBin, ['--help'], { env }))) {
    errors.push(
      `managed service cannot execute dreamux launcher at ${answers.dreamuxBin}`,
    );
  }

  if (!(await runner.check(answers.codexBin, ['--help'], { env }))) {
    errors.push(
      `managed service cannot execute Codex CLI at ${answers.codexBin}`,
    );
  }

  return {
    ok: errors.length === 0,
    errors,
  };
}

export function resolveServiceExecutable(
  command: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const trimmed = command.trim();
  if (trimmed === '') {
    throw new Error('managed service executable path is empty');
  }
  if (trimmed.includes('/') || trimmed.startsWith('~')) {
    const candidate = resolve(expandHome(trimmed));
    assertExecutable(candidate, command);
    return candidate;
  }

  for (const dir of (env['PATH'] ?? '').split(delimiter)) {
    if (dir === '') continue;
    const candidate = join(dir, trimmed);
    if (isExecutable(candidate)) return candidate;
  }

  throw new Error(
    `managed service cannot resolve executable '${command}' from PATH; pass an absolute path and rerun dreamux onboard`,
  );
}

export function nodeVersionSatisfies(raw: string): boolean {
  const match = raw.trim().match(/^v?(\d+)\.(\d+)\.(\d+)/);
  if (match === null) return false;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  if (!Number.isInteger(major) || !Number.isInteger(minor)) return false;
  if (major > 22) return true;
  return major === 22 && minor >= 7;
}

function managedServicePath(answers: ServiceInstallAnswers): string {
  const dirs = [
    dirname(answers.nodeBin),
    ...absoluteDir(answers.codexBin),
    ...absoluteDir(answers.dreamuxBin),
    ...SERVICE_PATH_DEFAULTS,
  ];
  return uniqueNonEmpty(dirs).join(delimiter);
}

function absoluteDir(path: string): string[] {
  return isAbsolute(path) ? [dirname(path)] : [];
}

function uniqueNonEmpty(values: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    if (value === '' || seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
}

function assertExecutable(path: string, label: string): void {
  if (isExecutable(path)) return;
  throw new Error(`managed service executable is not runnable: ${label}`);
}

function isExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function registerLaunchd(
  unitPath: string,
  unitStatus: 'created' | 'modified' | 'unchanged',
  options: ServiceInstallOptions,
): Promise<void> {
  const uid = options.uid ?? process.getuid?.();
  if (uid === undefined) {
    throw new Error('launchd user service registration requires a numeric uid');
  }
  const serviceTarget = `gui/${uid}/${LAUNCHD_LABEL}`;
  const loaded = await options.runner.check(
    'launchctl',
    ['print', serviceTarget],
    { dryRun: options.answers.dryRun },
  );
  if (!loaded) {
    await options.runner.run(
      'launchctl',
      ['bootstrap', `gui/${uid}`, unitPath],
      { dryRun: options.answers.dryRun },
    );
  } else if (unitStatus !== 'unchanged') {
    await options.runner.run('launchctl', ['bootout', serviceTarget], {
      dryRun: options.answers.dryRun,
    });
    await options.runner.run(
      'launchctl',
      ['bootstrap', `gui/${uid}`, unitPath],
      { dryRun: options.answers.dryRun },
    );
  }
  if (options.answers.startService) {
    await options.runner.run(
      'launchctl',
      ['kickstart', '-k', serviceTarget],
      { dryRun: options.answers.dryRun },
    );
  }
}

async function registerSystemd(
  unitPath: string,
  options: ServiceInstallOptions,
): Promise<void> {
  await options.runner.run('systemctl', ['--user', 'daemon-reload'], {
    dryRun: options.answers.dryRun,
  });
  const enableArgs = options.answers.startService
    ? ['--user', 'enable', '--now', SYSTEMD_UNIT]
    : ['--user', 'enable', SYSTEMD_UNIT];
  await options.runner.run('systemctl', enableArgs, {
    dryRun: options.answers.dryRun,
  });
  options.ledger.record(unitPath, 'unchanged', 'systemd user service registered');
}

function systemdEscapeArg(value: string): string {
  if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(value)) return value;
  return `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
}

function systemdEscapeEnv(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll(' ', '\\x20');
}
