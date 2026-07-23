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
import { homedir } from 'node:os';
import {
  installUserService,
  removeUserService,
  resolveServiceExecutable,
  selectServiceNodeBin,
  validateManagedServiceLaunch,
  withUserLocalBinPath,
  type ServiceInstallAnswers,
  type ServiceInstallResult,
  type ServiceNodeProbe,
  type ServiceRemoveResult,
} from '../onboard/service.js';
import { TransparentFileLedger } from '../onboard/ledger.js';
import type { CommandRunner, OnboardFileLedgerEntry } from '../onboard/types.js';
import type { ProviderBinCheck } from '@excitedjs/dreamux-types';
import {
  type DreamuxConfig,
  globalConfigDir,
  loadConfig,
} from '../config/config.js';
import { AgentRuntimeProviderCatalog } from '../agent-runtime/catalog.js';
import { ChannelProviderCatalog } from '../channel/catalog.js';
import {
  providerBinChecksForConfig,
  type ProviderDiagnosticCatalogs,
} from '../provider-diagnostics.js';
import { dreamuxBinPath } from '../platform/package-bin.js';
import {
  probeStandardExecDirs,
  setRuntimeConfig,
  type ExecDirProbe,
} from '../platform/paths.js';

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
  files: OnboardFileLedgerEntry[];
}

function serviceProviderBinChecks(
  config: DreamuxConfig,
  env: NodeJS.ProcessEnv,
  catalogs: ProviderDiagnosticCatalogs,
): ProviderBinCheck[] {
  return providerBinChecksForConfig({
    config,
    catalogs,
    env,
    scope: 'managedService',
  });
}

export async function runDaemonInstall(
  options: DaemonInstallOptions = {},
): Promise<DaemonInstallResult> {
  const runner = options.runner ?? new ExecaCommandRunner();
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const homeDir = options.homeDir ?? homedir();
  const dryRun = options.dryRun ?? false;
  const startService = options.startService ?? true;

  // Fail loudly when the operator has not run onboard yet — daemon install
  // re-registers an existing setup, it does not create one.
  const loaded = await loadConfig({ configDir: globalConfigDir() });
  const { config } = loaded;
  const catalogs = {
    agentRuntime: new AgentRuntimeProviderCatalog({
      registry: loaded.providerRegistry,
    }),
    channel: new ChannelProviderCatalog({
      registry: loaded.providerRegistry,
    }),
  };
  setRuntimeConfig(config);

  const fallbackDirs = await probeStandardExecDirs(
    { platform, homeDir, env },
    options.execDirProbe,
  );
  const resolveEnv = withUserLocalBinPath(env, fallbackDirs);
  const providerBinChecks = await Promise.all(
    serviceProviderBinChecks(config, env, catalogs).map(async (check) => ({
      ...check,
      bin: dryRun
        ? check.bin
        : await resolveServiceExecutable(
            check.bin,
            resolveEnv,
          ),
    })),
  );
  // Pin the managed service to a stable system Node (issue #83) rather than the
  // current process Node — otherwise running `daemon install` from a
  // version-manager Node would re-pin the service to that unstable Node.
  const nodeBin = dryRun
    ? process.execPath
    : await selectServiceNodeBin({
        platform,
        currentNodeBin: process.execPath,
        runner,
        ...(options.nodeProbe !== undefined ? { probe: options.nodeProbe } : {}),
      });
  // Persist the effective env/homeDir and captured fallback dirs (not the
  // optional raw option values) so managedServicePath renders the same PATH
  // used by provider resolution. In normal CLI use options.env is undefined, so
  // env falls back to process.env — that ambient PATH must be persisted into
  // the service unit.
  const answers: ServiceInstallAnswers = {
    configDir: globalConfigDir(),
    dreamuxBin: dreamuxBinPath(env),
    nodeBin,
    providerBinChecks,
    startService,
    dryRun,
    homeDir,
    env,
    fallbackDirs,
  };

  if (!dryRun) {
    const launch = await validateManagedServiceLaunch(answers, runner);
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
  const service = await installUserService({
    answers,
    ledger,
    runner,
    platform,
    homeDir,
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
