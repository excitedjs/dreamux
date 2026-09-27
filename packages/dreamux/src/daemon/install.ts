/**
 * `daemon/` owns the managed-service lifecycle end to end: rendering and
 * installing the launchd/systemd unit (`installUserService`,
 * `registerLaunchd`, `registerSystemd`, `enableSystemdLinger`), and removing
 * it (`removeUserService`).
 *
 * `dreamux daemon install` / `daemon uninstall` (`runDaemonInstall` /
 * `runDaemonUninstall` below) re-register or remove the service from the
 * already-written dreamux config; they do not collect onboarding answers.
 * `dreamux onboard` (`onboard/run.ts`) is the other caller of
 * `installUserService`, so linger handling and unit contents stay
 * single-sourced across both entry points. `daemon uninstall` removes only
 * the service unit (never config / state / logs); that is the boundary
 * against the top-level `dreamux uninstall`.
 */

import { rm } from 'node:fs/promises';
import { join } from 'node:path';

import { AgentRuntimeProviderCatalog } from '../agent-runtime/catalog.js';
import { ChannelProviderCatalog } from '../channel/catalog.js';
import { loadConfig } from '../config/load.js';
import type { CommandRunner } from '../platform/command-runner.js';
import {
  ensureDirectory,
  ensureTextFile,
  TransparentFileLedger,
  writeTextFile,
  type FileLedger,
  type FileLedgerEntry,
} from '../platform/file-ledger.js';
import { pathExists } from '../platform/fs-errors.js';
import { dreamuxBinPath } from '../platform/package-bin.js';
import { logsRoot, stateRoot, type ExecDirProbe } from '../platform/paths.js';
import {
  resolveManagedServiceAnswers,
  validateManagedServiceLaunch,
  type ServiceInstallAnswers,
  type ServiceNodeProbe,
} from './environment.js';
import { createServiceHost, type ServiceHost } from './host.js';
import {
  launchdTarget,
  renderLaunchdPlist,
  renderSystemdUnit,
  serviceUnitPath,
  SYSTEMD_UNIT,
  type ServicePlatform,
} from './unit.js';

export interface DaemonInstallOptions {
  startService?: boolean;
  dryRun?: boolean;
  runner?: CommandRunner;
  platform?: NodeJS.Platform;
  homeDir?: string;
  uid?: number;
  env?: NodeJS.ProcessEnv;
  /** Stable-Node selection probe (tests). */
  nodeProbe?: ServiceNodeProbe;
  /** Optional Homebrew-directory presence probe (tests). */
  execDirProbe?: ExecDirProbe;
}

export interface DaemonInstallResult {
  service: ServiceInstallResult;
  files: FileLedgerEntry[];
}

export interface ServiceInstallOptions {
  answers: ServiceInstallAnswers;
  ledger: FileLedger;
  host: ServiceHost;
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

export interface ServiceRemoveOptions {
  host: ServiceHost;
  dryRun?: boolean;
}

export interface ServiceRemoveResult {
  platform: ServicePlatform;
  unitPath: string;
  /** Whether the unit file existed and was removed. */
  removed: boolean;
}

export async function runDaemonInstall(
  options: DaemonInstallOptions = {},
): Promise<DaemonInstallResult> {
  const host = createServiceHost(options);
  const env = options.env ?? process.env;
  const dryRun = options.dryRun ?? false;
  const startService = options.startService ?? true;

  // Fail loudly when the operator has not run onboard yet — daemon install
  // re-registers an existing setup, it does not create one.
  const loaded = await loadConfig();
  const { config } = loaded;
  const catalogs = {
    agentRuntime: new AgentRuntimeProviderCatalog({
      registry: loaded.providerRegistry,
    }),
    channel: new ChannelProviderCatalog({
      registry: loaded.providerRegistry,
    }),
  };

  // Persist the effective env/homeDir and captured fallback dirs (not the
  // optional raw option values) so managedServicePath renders the same PATH
  // used by provider resolution. In normal CLI use options.env is undefined, so
  // env falls back to process.env — that ambient PATH must be persisted into
  // the service unit.
  const answers = await resolveManagedServiceAnswers({
    config,
    catalogs,
    dreamuxBin: dreamuxBinPath(env),
    startService,
    dryRun,
    host,
    env,
    nodeProbe: options.nodeProbe,
    execDirProbe: options.execDirProbe,
  });

  if (!dryRun) {
    const launch = await validateManagedServiceLaunch(answers, host.runner);
    if (!launch.ok) {
      throw new Error(
        [
          'dreamux managed service launch environment is not ready',
          ...launch.errors.map((error) => `- ${error}`),
          '- rerun dreamux onboard from the desired Node/runtime install',
        ].join('\n'),
      );
    }
  }

  const ledger = new TransparentFileLedger();
  const service = await installUserService({ answers, ledger, host });
  return { service, files: ledger.entries() };
}

export interface DaemonUninstallOptions {
  dryRun?: boolean;
  runner?: CommandRunner;
  platform?: NodeJS.Platform;
  homeDir?: string;
  uid?: number;
}

export async function runDaemonUninstall(
  options: DaemonUninstallOptions = {},
): Promise<ServiceRemoveResult> {
  const host = createServiceHost(options);
  return removeUserService({ host, dryRun: options.dryRun ?? false });
}

export async function installUserService(
  options: ServiceInstallOptions,
): Promise<ServiceInstallResult> {
  const unit = serviceUnitPath(options.host.platform, options.host.homeDir);
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

async function registerLaunchd(
  unitPath: string,
  unitStatus: 'created' | 'modified' | 'unchanged',
  options: ServiceInstallOptions,
): Promise<void> {
  const serviceTarget = launchdTarget(options.host.uid);
  const domain = `gui/${options.host.uid}`;
  const loaded = await options.host.runner.check(
    'launchctl',
    ['print', serviceTarget],
    { dryRun: options.answers.dryRun },
  );
  if (!loaded) {
    await options.host.runner.run('launchctl', ['bootstrap', domain, unitPath], {
      dryRun: options.answers.dryRun,
    });
  } else if (unitStatus !== 'unchanged') {
    await options.host.runner.run('launchctl', ['bootout', serviceTarget], {
      dryRun: options.answers.dryRun,
    });
    await options.host.runner.run('launchctl', ['bootstrap', domain, unitPath], {
      dryRun: options.answers.dryRun,
    });
  }
  if (options.answers.startService) {
    await options.host.runner.run(
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
  await options.host.runner.run('systemctl', ['--user', 'daemon-reload'], {
    dryRun: options.answers.dryRun,
  });
  const enableArgs = options.answers.startService
    ? ['--user', 'enable', '--now', SYSTEMD_UNIT]
    : ['--user', 'enable', SYSTEMD_UNIT];
  await options.host.runner.run('systemctl', enableArgs, {
    dryRun: options.answers.dryRun,
  });
  options.ledger.record(
    unitPath,
    'unchanged',
    'systemd user service registered',
  );

  // `systemctl --user enable` only schedules the service for an active login
  // session. `loginctl enable-linger` makes a user service boot without a login;
  // without it "enabled" silently fails to autostart on reboot. Best-effort: a
  // strict polkit / non-root setup may deny it, but that must not fail onboard.
  const { lingerEnabled, warnings } = await enableSystemdLinger(options);
  return { lingerEnabled, warnings };
}

/** Enable systemd user lingering, best-effort. Skipped (null) on dry run. */
export async function enableSystemdLinger(
  options: Pick<ServiceInstallOptions, 'host'> & {
    answers: Pick<ServiceInstallAnswers, 'dryRun'>;
  },
): Promise<{ lingerEnabled: boolean | null; warnings: string[] }> {
  if (options.answers.dryRun) return { lingerEnabled: null, warnings: [] };
  const ok = await options.host.runner.check('loginctl', ['enable-linger']);
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

/**
 * Unregister and remove the user-level service unit only. Shared by
 * `dreamux uninstall` (also removes config/state/logs) and
 * `daemon uninstall` (removes nothing else). Unit-file removal is authoritative.
 */
export async function removeUserService(
  options: ServiceRemoveOptions,
): Promise<ServiceRemoveResult> {
  const unit = serviceUnitPath(options.host.platform, options.host.homeDir);
  const dryRun = options.dryRun ?? false;

  if (unit.platform === 'launchd') {
    const serviceTarget = launchdTarget(options.host.uid);
    const loaded = await options.host.runner.check(
      'launchctl',
      ['print', serviceTarget],
      {
        dryRun,
      },
    );
    if (loaded) {
      await runServiceBestEffort(
        options.host.runner,
        'launchctl',
        ['bootout', serviceTarget],
        dryRun,
      );
    }
  } else {
    await runServiceBestEffort(
      options.host.runner,
      'systemctl',
      ['--user', 'disable', '--now', SYSTEMD_UNIT],
      dryRun,
    );
  }

  const existed = await pathExists(unit.path);
  if (existed && !dryRun) await rm(unit.path, { force: true });

  if (unit.platform === 'systemd') {
    await runServiceBestEffort(
      options.host.runner,
      'systemctl',
      ['--user', 'daemon-reload'],
      dryRun,
    );
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
