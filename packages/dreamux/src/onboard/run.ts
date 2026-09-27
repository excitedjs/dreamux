import { pathExists } from '../platform/fs-errors.js';

import type { ProviderBinCheck } from '@excitedjs/dreamux-types';
import { globalConfigFile, stringifyConfig } from '../config/config.js';
import {
  assertNoLegacyTomlOnly,
  loadConfig,
  type LoadConfigResult,
} from '../config/load.js';
import {
  dispatcherDir,
  dreamuxRoot,
  logsRoot,
  stateRoot,
  type ExecDirProbe,
} from '../platform/paths.js';
import { AgentRuntimeProviderCatalog } from '../agent-runtime/catalog.js';
import { ChannelProviderCatalog } from '../channel/catalog.js';
import {
  runDispatcherProviderDiagnostics,
  type ProviderDiagnosticCatalogs,
  type ProviderDiagnosticReport,
} from '../provider-diagnostics.js';
import type { CommandRunner } from '../platform/command-runner.js';
import { dreamuxConfigFromAnswers } from './config-files.js';
import {
  ensureDirectory,
  TransparentFileLedger,
  writeTextFile,
} from './ledger.js';
import {
  managedServiceEnvironment,
  resolveManagedServiceAnswers,
  type ServiceNodeProbe,
  validateManagedServiceLaunch,
} from '../daemon/environment.js';
import { createServiceHost } from '../daemon/host.js';
import { installUserService } from '../daemon/install.js';
import type {
  OnboardAnswers,
  OnboardDoctorResult,
  OnboardFileLedger,
  OnboardRunResult,
} from '../onboard/types.js';

type EffectiveOnboardAnswers = OnboardAnswers & {
  nodeBin: string;
  providerBinChecks: ProviderBinCheck[];
  fallbackDirs: string[];
};

export interface RunOnboardOptions {
  answers: OnboardAnswers;
  runner?: CommandRunner;
  ledger?: OnboardFileLedger;
  platform?: NodeJS.Platform;
  homeDir?: string;
  uid?: number;
  env?: NodeJS.ProcessEnv;
  nodeProbe?: ServiceNodeProbe;
  /** Optional Homebrew-directory presence probe (tests). */
  execDirProbe?: ExecDirProbe;
}

export async function runOnboard(
  options: RunOnboardOptions,
): Promise<OnboardRunResult> {
  const answers = options.answers;
  const ledger = options.ledger ?? new TransparentFileLedger();
  const host = createServiceHost(options);
  const env = options.env ?? process.env;
  const configPath = globalConfigFile();
  const existingConfig = await readExistingDreamuxConfig();
  const dreamuxConfig = dreamuxConfigFromAnswers(answers, existingConfig);

  await ensureDirectory(dreamuxRoot(), ledger, 'dreamux config directory', {
    dryRun: answers.dryRun,
  });
  await ensureDirectory(stateRoot(), ledger, 'dreamux state directory', {
    dryRun: answers.dryRun,
  });
  await ensureDirectory(logsRoot(), ledger, 'dreamux logs directory', {
    dryRun: answers.dryRun,
  });
  await writeTextFile(
    configPath,
    stringifyConfig(dreamuxConfig),
    ledger,
    'dreamux global config',
    { mode: 0o600, dryRun: answers.dryRun },
  );

  await ensureDirectory(
    dispatcherDir(answers.dispatcherId),
    ledger,
    'dispatcher state directory',
    { dryRun: answers.dryRun },
  );
  await ensureDirectory(answers.dispatcherCwd, ledger, 'dispatcher cwd', {
    dryRun: answers.dryRun,
  });
  // Bundled Dreamux skills are no longer symlinked into the workspace
  // (`<cwd>/.codex/skills`) at onboard time (issue #209 slice 6). Core now
  // injects them at runtime by role via the create context's `skillSources`
  // capability, so onboarding creates no skill dir or symlinks. Pre-existing old
  // symlinks are outside Dreamux-owned state and are left untouched; operators
  // may delete them manually.

  const loaded = answers.dryRun ? null : await loadConfig();
  const catalogs = loaded === null ? null : catalogsFromLoadedConfig(loaded);
  // Persist the effective env/homeDir and captured fallback dirs (not the
  // optional raw option values) so managedServicePath renders the same PATH
  // used by provider resolution. In normal CLI use options.env is undefined, so
  // env falls back to process.env — that ambient PATH must be persisted into
  // the service unit. Skip the pipeline entirely when the operator opted out
  // of the managed service — there is nothing to resolve.
  const { nodeBin, providerBinChecks, fallbackDirs } = answers.registerService
    ? await resolveManagedServiceAnswers({
        config: loaded?.config ?? null,
        catalogs,
        dreamuxBin: answers.dreamuxBin,
        startService: answers.startService,
        dryRun: answers.dryRun,
        host,
        env,
        nodeProbe: options.nodeProbe,
        execDirProbe: options.execDirProbe,
      })
    : {
        nodeBin: process.execPath,
        providerBinChecks: [] as ProviderBinCheck[],
        fallbackDirs: [] as string[],
      };
  const effectiveAnswers = {
    ...answers,
    nodeBin,
    providerBinChecks,
    homeDir: host.homeDir,
    env,
    fallbackDirs,
  };

  const doctor = await runDispatcherDoctor(
    effectiveAnswers,
    loaded,
    catalogs,
    env,
    host.runner,
  );
  if (!effectiveAnswers.dryRun && !doctor.ok) {
    throw new Error(formatDoctorFailure(effectiveAnswers, doctor));
  }
  if (effectiveAnswers.registerService && !effectiveAnswers.dryRun) {
    const serviceLaunch = await validateManagedServiceLaunch(
      effectiveAnswers,
      host.runner,
    );
    if (!serviceLaunch.ok) {
      throw new Error(formatServiceLaunchFailure(serviceLaunch.errors));
    }
  }

  const service = effectiveAnswers.registerService
    ? await installUserService({
        answers: effectiveAnswers,
        ledger,
        host,
      })
    : null;

  return {
    files: ledger.entries(),
    doctor,
    service,
  };
}

function formatServiceLaunchFailure(errors: string[]): string {
  return [
    'dreamux managed service launch environment is not ready',
    ...errors.map((error) => `- ${error}`),
    '- rerun dreamux onboard from the desired Node/runtime install, or pass explicit binary paths',
  ].join('\n');
}

async function readExistingDreamuxConfig() {
  const configPath = globalConfigFile();
  await assertNoLegacyTomlOnly();
  if (!(await pathExists(configPath))) return undefined;
  return (await loadConfig()).config;
}

function catalogsFromLoadedConfig(
  loaded: LoadConfigResult,
): ProviderDiagnosticCatalogs {
  return {
    agentRuntime: new AgentRuntimeProviderCatalog({
      registry: loaded.providerRegistry,
    }),
    channel: new ChannelProviderCatalog({
      registry: loaded.providerRegistry,
    }),
  };
}

async function runDispatcherDoctor(
  answers: EffectiveOnboardAnswers,
  loaded: LoadConfigResult | null,
  catalogs: ProviderDiagnosticCatalogs | null,
  env: NodeJS.ProcessEnv,
  runner: CommandRunner,
): Promise<OnboardDoctorResult> {
  if (answers.dryRun) {
    return {
      ok: true,
      errors: [],
      detail: 'dry run',
      reports: [],
    };
  }
  if (loaded === null || catalogs === null) {
    return {
      ok: false,
      detail: answers.dispatcherId,
      errors: ['onboard config was not loaded after writing'],
      reports: [],
    };
  }
  const dispatcher = loaded.config.dispatchers.find(
    (entry) => entry.id === answers.dispatcherId,
  );
  if (dispatcher === undefined) {
    return {
      ok: false,
      detail: answers.dispatcherId,
      errors: [
        `onboarded dispatcher '${answers.dispatcherId}' was not found in config`,
      ],
      reports: [],
    };
  }
  const doctorEnv = answers.registerService
    ? managedServiceEnvironment(answers)
    : env;
  const reports = await runDispatcherProviderDiagnostics({
    config: loaded.config,
    dispatcher,
    catalogs,
    runner,
    env: doctorEnv,
    scope: answers.registerService ? 'managedService' : 'foreground',
  });
  const errors = providerDiagnosticErrors(reports);
  return {
    ok: errors.length === 0,
    detail: `${reports.length} provider diagnostic(s)`,
    errors,
    reports,
  };
}

function providerDiagnosticErrors(
  reports: ProviderDiagnosticReport[],
): string[] {
  return reports.flatMap((report) => {
    const prefix = `${report.kind} ${report.id} (${report.provider})`;
    if (report.result.errors.length > 0) {
      return report.result.errors.map((error) => `${prefix}: ${error}`);
    }
    return report.result.ok ? [] : [`${prefix}: ${report.result.detail}`];
  });
}

function formatDoctorFailure(
  answers: EffectiveOnboardAnswers,
  doctor: OnboardDoctorResult,
): string {
  const lines = [
    `dispatcher '${answers.dispatcherId}' providers are not ready`,
    ...doctor.errors.map((error) => `- ${error}`),
  ];
  if (
    answers.registerService &&
    doctor.errors.some((error) => /auth/i.test(error))
  ) {
    lines.push(
      '- managed service environments do not inherit your interactive shell auth token',
      '- authenticate the selected runtime before registering the service',
    );
  }
  return lines.join('\n');
}
