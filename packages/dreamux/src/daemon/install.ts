/**
 * `dreamux daemon install` / `daemon uninstall`.
 *
 * `install` re-registers the user-level service from the already-written
 * dreamux config (it does not collect onboarding answers). It reuses the exact
 * service slice onboard uses — `installUserService` — so linger handling and
 * the unit contents stay single-sourced. `uninstall` removes only the service
 * unit (never config / state / logs); that is the boundary against the
 * top-level `dreamux uninstall`.
 */

import { ExecaCommandRunner } from '../onboard/commands.js';
import {
  installUserService,
  removeUserService,
  resolveServiceExecutable,
  selectServiceNodeBin,
  validateManagedServiceLaunch,
  type ServiceInstallAnswers,
  type ServiceInstallResult,
  type ServiceNodeProbe,
  type ServiceRemoveResult,
} from '../onboard/service.js';
import { TransparentFileLedger } from '../onboard/ledger.js';
import type { CommandRunner, OnboardFileLedgerEntry } from '../onboard/types.js';
import { globalConfigDir, loadConfig } from '../runtime/config.js';
import { dreamuxBinPath } from '../runtime/package-bin.js';
import { setRuntimeConfig, stateRoot } from '../runtime/paths.js';

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
}

export interface DaemonInstallResult {
  service: ServiceInstallResult;
  files: OnboardFileLedgerEntry[];
}

export async function runDaemonInstall(
  options: DaemonInstallOptions = {},
): Promise<DaemonInstallResult> {
  const runner = options.runner ?? new ExecaCommandRunner();
  const env = options.env ?? process.env;
  const dryRun = options.dryRun ?? false;
  const startService = options.startService ?? true;

  // Fail loudly when the operator has not run onboard yet — daemon install
  // re-registers an existing setup, it does not create one.
  const { config } = await loadConfig({ configDir: globalConfigDir() });
  setRuntimeConfig(config);

  const codexBin = dryRun
    ? config.codex.bin
    : await resolveServiceExecutable(config.codex.bin, env);
  // Pin the managed service to a stable system Node (issue #83) rather than the
  // current process Node — otherwise running `daemon install` from a
  // version-manager Node would re-pin the service to that unstable Node.
  const nodeBin = dryRun
    ? process.execPath
    : await selectServiceNodeBin({
        platform: options.platform ?? process.platform,
        currentNodeBin: process.execPath,
        runner,
        ...(options.nodeProbe !== undefined ? { probe: options.nodeProbe } : {}),
      });
  const answers: ServiceInstallAnswers = {
    configDir: globalConfigDir(),
    runtimeDir: stateRoot(),
    codexBin,
    dreamuxBin: dreamuxBinPath(env),
    nodeBin,
    startService,
    dryRun,
  };

  if (!dryRun) {
    const launch = await validateManagedServiceLaunch(answers, runner);
    if (!launch.ok) {
      throw new Error(
        [
          'dreamux managed service launch environment is not ready',
          ...launch.errors.map((error) => `- ${error}`),
          '- rerun dreamux onboard from the desired Node/Codex install',
        ].join('\n'),
      );
    }
  }

  const ledger = new TransparentFileLedger();
  const service = await installUserService({
    answers,
    ledger,
    runner,
    platform: options.platform,
    homeDir: options.homeDir,
    uid: options.uid,
  });
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
  const runner = options.runner ?? new ExecaCommandRunner();
  return removeUserService({
    runner,
    platform: options.platform,
    homeDir: options.homeDir,
    uid: options.uid,
    dryRun: options.dryRun ?? false,
  });
}
