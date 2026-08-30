import { pathExists } from '../platform/fs-errors.js';
import { rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { delimiter, dirname, isAbsolute, join, resolve } from 'node:path';

import { build as buildPlist } from 'plist';
import type { ProviderBinCheck } from '@excitedjs/dreamux-types';
import { expandHome } from '../config/config.js';
import { errorMessage } from '../platform/error-info.js';
import {
  logsRoot,
  stateRoot,
} from '../platform/paths.js';
import {
  buildServicePath,
  withServicePath,
} from '../platform/service-path.js';

import {
  ensureDirectory,
  ensureTextFile,
  writeTextFile,
} from './ledger.js';
import type {
  CommandRunner,
  OnboardFileLedger,
  ServicePlatform,
} from '../onboard/types.js';
import {
  isExecutable,
  MIN_SERVICE_NODE_VERSION,
  nodeVersionSatisfies,
} from './service-node.js';

export const LAUNCHD_LABEL = 'dev.excited.dreamux';
export const SYSTEMD_UNIT = 'dreamux.service';

export {
  defaultServiceNodeProbe,
  detectServiceNodeVersionManager,
  isExecutable,
  MIN_SERVICE_NODE_VERSION,
  nodeVersionSatisfies,
  selectServiceNodeBin,
  stabilizeHomebrewCellarNode,
  stableNodeCandidates,
  versionManagerOfPath,
  type SelectServiceNodeOptions,
  type ServiceNodeProbe,
} from './service-node.js';

export interface ServiceInstallAnswers {
  configDir: string;
  /** Provider-owned binary checks the managed-service PATH must resolve. */
  providerBinChecks?: ProviderBinCheck[];
  dreamuxBin: string;
  nodeBin: string;
  startService: boolean;
  dryRun: boolean;
  /** Home directory the service runs under; resolves user-local bin dirs. Defaults to `homedir()`. */
  homeDir?: string;
  /** Environment to read XDG_BIN_HOME from; path builders never read process.env. */
  env?: NodeJS.ProcessEnv;
  /**
   * Standard fallback dirs captured once by the async onboard/daemon-install
   * entry point. Reused for provider resolution and service rendering.
   */
  fallbackDirs: string[];
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
  /** systemd `--user` only: whether linger enabled so service boots without login. null when not applicable. Non-fatal. */
  lingerEnabled: boolean | null;
  /** Non-fatal operator-facing warnings (e.g. linger could not be enabled). */
  warnings: string[];
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
  const workingDir = stateRoot();
  const logDir = logsRoot();
  const stdoutLog = join(logDir, 'daemon.stdout.log');
  const stderrLog = join(logDir, 'daemon.stderr.log');
  await ensureDirectory(
    workingDir,
    options.ledger,
    'managed service working directory',
    { dryRun: options.answers.dryRun },
  );
  await ensureDirectory(logDir, options.ledger, 'daemon log directory', {
    dryRun: options.answers.dryRun,
  });
  await ensureTextFile(stdoutLog, '', options.ledger, 'daemon stdout log', {
    mode: 0o600,
    dryRun: options.answers.dryRun,
  });
  await ensureTextFile(stderrLog, '', options.ledger, 'daemon stderr log', {
    mode: 0o600,
    dryRun: options.answers.dryRun,
  });

  const content =
    unit.platform === 'launchd'
      ? renderLaunchdPlist(options.answers, stdoutLog, stderrLog)
      : renderSystemdUnit(options.answers, stdoutLog, stderrLog);
  const unitStatus = await writeTextFile(
    unit.path,
    content,
    options.ledger,
    `${unit.platform} unit`,
    {
      mode: 0o600,
      dryRun: options.answers.dryRun,
    },
  );

  let lingerEnabled: boolean | null = null;
  const warnings: string[] = [];
  if (unit.platform === 'launchd') {
    await registerLaunchd(unit.path, unitStatus, options);
  } else {
    const systemd = await registerSystemd(unit.path, options);
    lingerEnabled = systemd.lingerEnabled;
    warnings.push(...systemd.warnings);
  }

  return {
    platform: unit.platform,
    unitPath: unit.path,
    registered: true,
    started: options.answers.startService,
    lingerEnabled,
    warnings,
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
  const home = answers.homeDir ?? homedir();
  // Unit PATH: stable dirs → captured session PATH → fallbacks (see managedServicePath).
  const env: Record<string, string> = {
    DREAMUX_CONFIG_DIR: answers.configDir,
    HOME: home,
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

  for (const check of serviceProviderBinChecks(answers)) {
    if (!(await runner.check(check.bin, check.args, { env }))) {
      errors.push(
        `managed service cannot execute provider binary '${check.name}' at ${check.bin}`,
      );
    }
  }

  return {
    ok: errors.length === 0,
    errors,
  };
}

export async function resolveServiceExecutable(
  command: string,
  env: NodeJS.ProcessEnv,
): Promise<string> {
  const trimmed = command.trim();
  if (trimmed === '') {
    throw new Error('managed service executable path is empty');
  }
  if (trimmed.includes('/') || trimmed.startsWith('~')) {
    const candidate = resolve(expandHome(trimmed));
    await assertExecutable(candidate, command);
    return candidate;
  }

  for (const dir of (env['PATH'] ?? '').split(delimiter)) {
    if (dir === '') continue;
    const candidate = join(dir, trimmed);
    if (await isExecutable(candidate)) return candidate;
  }

  throw new Error(
    `managed service cannot resolve executable '${command}' from PATH; pass an absolute path and rerun dreamux onboard`,
  );
}

/**
 * Builds the resolve-time effective PATH used to resolve bare provider/agent
 * binaries during `onboard`/`daemon install`. Captured session PATH leads, then
 * the caller's captured fresh-install fallback dirs.
 * Stable Dreamux-owned dirs are added at service render time (see
 * managedServicePath). Delegates to {@link withServicePath} in
 * platform/service-path.ts. Never mutates env.
 */
export function withUserLocalBinPath(
  env: NodeJS.ProcessEnv,
  fallbackDirs: string[],
): NodeJS.ProcessEnv {
  const sessionPath = env['PATH'] ?? '';
  return withServicePath(env, { stableDirs: [], sessionPath, fallbackDirs });
}

function managedServicePath(answers: ServiceInstallAnswers): string {
  // Service PATH order: stable Dreamux-owned dirs (Node bin, provider bin dirs,
  // dreamux bin) → captured session PATH (original order) → fresh-install
  // fallback dirs from platform/service-path.ts. De-duped via buildServicePath.
  // Never reads process.env; platform/homeDir/env passed explicitly.
  const stableDirs = [
    dirname(answers.nodeBin),
    ...serviceProviderBinChecks(answers).flatMap((check) => absoluteDir(check.bin)),
    ...absoluteDir(answers.dreamuxBin),
  ];
  const sessionPath = answers.env?.['PATH'] ?? '';
  return buildServicePath({
    stableDirs,
    sessionPath,
    fallbackDirs: answers.fallbackDirs,
  });
}

function serviceProviderBinChecks(
  answers: ServiceInstallAnswers,
): ProviderBinCheck[] {
  const checks = new Map<string, ProviderBinCheck>();
  for (const check of answers.providerBinChecks ?? []) {
    checks.set(`${check.name}\0${check.bin}\0${check.args.join('\0')}`, check);
  }
  return [...checks.values()];
}

function absoluteDir(path: string): string[] {
  return isAbsolute(path) ? [dirname(path)] : [];
}

async function assertExecutable(path: string, label: string): Promise<void> {
  if (await isExecutable(path)) return;
  throw new Error(`managed service executable is not runnable: ${label}`);
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
): Promise<{ lingerEnabled: boolean | null; warnings: string[] }> {
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

  // `systemctl --user enable` only schedules the service for an active login
  // session. `loginctl enable-linger` makes a user service boot without a login;
  // without it "enabled" silently fails to autostart on reboot. Best-effort: a
  // strict polkit / non-root setup may deny it, but that must not fail onboard.
  const { lingerEnabled, warnings } = await enableSystemdLinger(options);
  return { lingerEnabled, warnings };
}

/** Enable systemd user lingering, best-effort. Skipped (null) on dry run. */
export async function enableSystemdLinger(
  options: Pick<ServiceInstallOptions, 'runner'> & {
    answers: Pick<ServiceInstallAnswers, 'dryRun'>;
  },
): Promise<{ lingerEnabled: boolean | null; warnings: string[] }> {
  if (options.answers.dryRun) return { lingerEnabled: null, warnings: [] };
  const ok = await options.runner.check('loginctl', ['enable-linger']);
  if (ok) return { lingerEnabled: true, warnings: [] };
  return {
    lingerEnabled: false,
    warnings: [
      'could not enable systemd lingering (loginctl enable-linger); the service ' +
        'will not start at boot until you log in. Enable it manually with: ' +
        'loginctl enable-linger',
    ],
  };
}

export interface ServiceRemoveOptions {
  runner: CommandRunner;
  platform?: NodeJS.Platform;
  homeDir?: string;
  uid?: number;
  dryRun?: boolean;
}

export interface ServiceRemoveResult {
  platform: ServicePlatform;
  unitPath: string;
  /** Whether the unit file existed and was removed. */
  removed: boolean;
}

/**
 * Unregister and remove the user-level service unit only. Shared by
 * `dreamux uninstall` (also removes config/state/logs) and
 * `daemon uninstall` (removes nothing else). Unit-file removal is authoritative.
 */
export async function removeUserService(
  options: ServiceRemoveOptions,
): Promise<ServiceRemoveResult> {
  const homeDir = options.homeDir ?? homedir();
  const unit = serviceUnitPath(options.platform, homeDir);
  const dryRun = options.dryRun ?? false;

  if (unit.platform === 'launchd') {
    const uid = options.uid ?? process.getuid?.();
    if (uid === undefined) {
      throw new Error('launchd user service uninstall requires a numeric uid');
    }
    const serviceTarget = `gui/${uid}/${LAUNCHD_LABEL}`;
    const loaded = await options.runner.check('launchctl', ['print', serviceTarget], {
      dryRun,
    });
    if (loaded) {
      await runServiceBestEffort(options.runner, 'launchctl', ['bootout', serviceTarget], dryRun);
    }
  } else {
    await runServiceBestEffort(
      options.runner,
      'systemctl',
      ['--user', 'disable', '--now', SYSTEMD_UNIT],
      dryRun,
    );
  }

  const existed = await pathExists(unit.path);
  if (existed && !dryRun) await rm(unit.path, { force: true });

  if (unit.platform === 'systemd') {
    await runServiceBestEffort(options.runner, 'systemctl', ['--user', 'daemon-reload'], dryRun);
  }

  return { platform: unit.platform, unitPath: unit.path, removed: existed };
}

async function runServiceBestEffort(
  runner: CommandRunner,
  command: string,
  args: string[],
  dryRun: boolean,
): Promise<void> {
  try {
    await runner.run(command, args, { dryRun });
  } catch {
    /* The unit may already be absent or stopped; file removal is authoritative. */
  }
}

function systemdEscapeArg(value: string): string {
  if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(value)) return value;
  return `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
}

function systemdEscapeEnv(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll(' ', '\\x20');
}
