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
  selectServiceClaudeBin,
  selectServiceNodeBin,
  tryResolveServiceExecutable,
  validateManagedServiceLaunch,
  type ServiceInstallAnswers,
  type ServiceInstallResult,
  type ServiceNodeProbe,
  type ServiceRemoveResult,
} from '../onboard/service.js';
import { TransparentFileLedger } from '../onboard/ledger.js';
import type { CommandRunner, OnboardFileLedgerEntry } from '../onboard/types.js';
import {
  BUILTIN_CODEX_PROVIDER_REF,
  DEFAULT_CODEX_BIN,
  dispatcherCodexConfig,
  type DreamuxConfig,
  globalConfigDir,
} from '../config/config.js';
import { loadConfigWithBuiltins } from '../agent-runtime/load-config.js';
import { dreamuxBinPath } from '../platform/package-bin.js';
import { setRuntimeConfig } from '../platform/paths.js';

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

/**
 * Pick the one codex binary that seeds the managed-service unit PATH. The env
 * override wins; otherwise enabled builtin:codex dispatchers' `runtime.config.bin`
 * values are used. External-runtime-only configs do not need a Codex PATH seed.
 * The single host unit cannot encode per-dispatcher bins, so when they differ
 * the first is used and a warning names the rest instead of silently dropping
 * them — the server still resolves each dispatcher's own bin at runtime.
 */
function selectServiceCodexBin(
  config: DreamuxConfig,
  env: NodeJS.ProcessEnv,
): string | null {
  const override = env['CODEX_HOST_CODEX_BIN'];
  if (override !== undefined && override.trim() !== '') return override;
  const bins = [
    ...new Set(
      config.dispatchers
        .filter(
          (d) => d.enabled && d.runtime.provider === BUILTIN_CODEX_PROVIDER_REF,
        )
        .map((d) => dispatcherCodexConfig(d).bin),
    ),
  ];
  if (bins.length === 0) return null;
  if (bins.length > 1) {
    console.warn(
      `dreamux daemon install: enabled dispatchers declare ${bins.length} ` +
        `different runtime.config.bin values (${bins.join(', ')}); the single managed ` +
        `service unit seeds its PATH from '${bins[0]}'. Set CODEX_HOST_CODEX_BIN ` +
        `to force one binary, or ensure every runtime.config.bin resolves on PATH.`,
    );
  }
  return bins[0] ?? DEFAULT_CODEX_BIN;
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
  const { config } = await loadConfigWithBuiltins({ configDir: globalConfigDir() });
  setRuntimeConfig(config);

  // Seed the service PATH with Codex only when a host override or an enabled
  // builtin:codex dispatcher needs it. External runtime-only configs do not
  // get blocked by the old Codex CLI launch check.
  const codexBinSource = selectServiceCodexBin(config, env);
  const codexBin =
    codexBinSource === null
      ? null
      : dryRun
        ? codexBinSource
        : await resolveServiceExecutable(codexBinSource, env);
  // Best-effort: locate Claude Code so the unit PATH resolves `claude` for
  // server-hosted builtin:claude-code workers. Absent install → omit, warn,
  // and keep the codex-only daemon install working (issue #126 PR8).
  const claudeBinSource = selectServiceClaudeBin(env);
  const claudeBin = dryRun
    ? null
    : await tryResolveServiceExecutable(claudeBinSource, env);
  if (!dryRun && claudeBin === null) {
    console.warn(
      `dreamux daemon install: Claude Code binary '${claudeBinSource}' was not ` +
        'found on PATH; server-hosted builtin:claude-code TeamMate workers will ' +
        'be unavailable. Install Claude Code (or set DREAMUX_CLAUDE_BIN) and ' +
        'rerun dreamux daemon install to enable them.',
    );
  }
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
    dreamuxBin: dreamuxBinPath(env),
    nodeBin,
    ...(codexBin !== null ? { codexBin } : {}),
    ...(claudeBin !== null ? { claudeBin } : {}),
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
