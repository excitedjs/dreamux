import { homedir } from 'node:os';
import { join } from 'node:path';

import { build as buildPlist } from 'plist';

import {
  ensureDirectory,
  ensureTextFile,
  writeTextFile,
} from './ledger.js';
import type {
  CommandRunner,
  OnboardAnswers,
  OnboardFileLedger,
  ServicePlatform,
} from './types.js';

const LAUNCHD_LABEL = 'dev.excited.dreamux';
const SYSTEMD_UNIT = 'dreamux.service';

export interface ServiceInstallOptions {
  answers: OnboardAnswers;
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
  const logDir = join(options.answers.runtimeDir, 'logs');
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
  writeTextFile(unit.path, content, options.ledger, `${unit.platform} unit`, {
    mode: 0o600,
    dryRun: options.answers.dryRun,
  });

  if (unit.platform === 'launchd') {
    await registerLaunchd(unit.path, options);
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
  answers: OnboardAnswers,
  stdoutLog: string,
  stderrLog: string,
): string {
  return buildPlist({
    Label: LAUNCHD_LABEL,
    ProgramArguments: [answers.dreamuxBin, 'serve'],
    RunAtLoad: true,
    KeepAlive: true,
    WorkingDirectory: answers.runtimeDir,
    EnvironmentVariables: {
      DREAMUX_CONFIG_DIR: answers.configDir,
      CODEX_HOST_RUNTIME_DIR: answers.runtimeDir,
      CODEX_HOST_CODEX_BIN: answers.codexBin,
    },
    StandardOutPath: stdoutLog,
    StandardErrorPath: stderrLog,
  });
}

export function renderSystemdUnit(
  answers: OnboardAnswers,
  stdoutLog: string,
  stderrLog: string,
): string {
  return `[Unit]
Description=dreamux dispatcher daemon

[Service]
Type=simple
ExecStart=${systemdEscapeArg(answers.dreamuxBin)} serve
WorkingDirectory=${systemdEscapeArg(answers.runtimeDir)}
Environment=DREAMUX_CONFIG_DIR=${systemdEscapeEnv(answers.configDir)}
Environment=CODEX_HOST_RUNTIME_DIR=${systemdEscapeEnv(answers.runtimeDir)}
Environment=CODEX_HOST_CODEX_BIN=${systemdEscapeEnv(answers.codexBin)}
Restart=on-failure
RestartSec=2s
StandardOutput=append:${stdoutLog}
StandardError=append:${stderrLog}

[Install]
WantedBy=default.target
`;
}

async function registerLaunchd(
  unitPath: string,
  options: ServiceInstallOptions,
): Promise<void> {
  const uid = options.uid ?? process.getuid?.();
  if (uid === undefined) {
    throw new Error('launchd user service registration requires a numeric uid');
  }
  await options.runner.run(
    'launchctl',
    ['bootstrap', `gui/${uid}`, unitPath],
    { dryRun: options.answers.dryRun },
  );
  if (options.answers.startService) {
    await options.runner.run(
      'launchctl',
      ['kickstart', '-k', `gui/${uid}/${LAUNCHD_LABEL}`],
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
