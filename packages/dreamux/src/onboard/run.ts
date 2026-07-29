import { pathExists } from '../platform/fs-errors.js';
import { homedir } from 'node:os';
import { parseProviderRef } from '../registry/index.js';

import type { ProviderBinCheck } from '@excitedjs/dreamux-types';
import {
  assertNoLegacyTomlOnly,
  globalConfigFile,
  loadConfigJson,
  loadConfig,
  stringifyConfig,
  type DreamuxConfig,
  type LoadConfigResult,
} from '../config/config.js';
import {
  dispatcherDir,
  logsRoot,
  probeStandardExecDirs,
  setRuntimeConfig,
  stateRoot,
  type ExecDirProbe,
} from '../platform/paths.js';
import { AgentRuntimeProviderCatalog } from '../agent-runtime/catalog.js';
import { ChannelProviderCatalog } from '../channel/catalog.js';
import {
  providerBinChecksForConfig,
  runDispatcherProviderDiagnostics,
  type ProviderDiagnosticCatalogs,
  type ProviderDiagnosticReport,
} from '../provider-diagnostics.js';
import { ExecaCommandRunner } from './commands.js';
import { dreamuxConfigFromAnswers } from './config-files.js';
import {
  ensureDirectory,
  TransparentFileLedger,
  writeTextFile,
} from './ledger.js';
import {
  installUserService,
  managedServiceEnvironment,
  resolveServiceExecutable,
  selectServiceNodeBin,
  type ServiceNodeProbe,
  validateManagedServiceLaunch,
  withUserLocalBinPath,
} from './service.js';
import type {
  CommandRunner,
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
  const runner = options.runner ?? new ExecaCommandRunner();
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const homeDir = options.homeDir ?? homedir();
  const configPath = globalConfigFile({ configDir: answers.configDir });
  const existingConfig = await readExistingDreamuxConfig(answers.configDir);
  const dreamuxConfig = dreamuxConfigFromAnswers(answers, existingConfig);
  const serviceNodeBin = answers.registerService && !answers.dryRun
    ? await selectServiceNodeBin({
        platform,
        currentNodeBin: process.execPath,
        runner,
        probe: options.nodeProbe,
      })
    : process.execPath;
  setRuntimeConfig(dreamuxConfig);

  await ensureDirectory(answers.configDir, ledger, 'dreamux config directory', {
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
  await ensureDirectory(
    answers.dispatcherCwd,
    ledger,
    'dispatcher cwd',
    { dryRun: answers.dryRun },
  );
  // Bundled Dreamux skills are no longer symlinked into the workspace
  // (`<cwd>/.codex/skills`) at onboard time (issue #209 slice 6). Core now
  // injects them at runtime by role via the create context's `skillSources`
  // capability, so onboarding creates no skill dir or symlinks. Pre-existing old
  // symlinks are outside Dreamux-owned state and are left untouched; operators
  // may delete them manually.

  const loaded = answers.dryRun
    ? {
        ...(await loadConfigJson(
          JSON.parse(stringifyConfig(dreamuxConfig)) as unknown,
          configPath,
          {
            configDir: answers.configDir,
            providerPluginLoadMode: 'installed-only',
          },
        )),
        configFile: configPath,
      }
    : await loadConfig({
        configDir: answers.configDir,
        providerPluginLoadMode: 'materialize',
      });
  setRuntimeConfig(loaded.config);
  const catalogs = catalogsFromLoadedConfig(loaded);
  const fallbackDirs = answers.registerService
    ? await probeStandardExecDirs(
        { platform, homeDir, env },
        options.execDirProbe,
      )
    : [];
  const providerBinChecks =
    answers.registerService && !answers.dryRun
      ? await resolveProviderBinChecks(
          loaded.config,
          catalogs,
          env,
          fallbackDirs,
        )
      : [];
  // Persist the effective env/homeDir and captured fallback dirs (not the
  // optional raw option values) so managedServicePath renders the same PATH
  // used by provider resolution. In normal CLI use options.env is undefined, so
  // env falls back to process.env — that ambient PATH must be persisted into
  // the service unit.
  const effectiveAnswers = {
    ...answers,
    nodeBin: serviceNodeBin,
    providerBinChecks,
    homeDir,
    env,
    fallbackDirs,
  };

  const doctor = await runDispatcherDoctor(
    effectiveAnswers,
    loaded,
    catalogs,
    env,
    runner,
  );
  if (!effectiveAnswers.dryRun && !doctor.ok) {
    throw new Error(formatDoctorFailure(effectiveAnswers, doctor));
  }
  if (effectiveAnswers.registerService && !effectiveAnswers.dryRun) {
    const serviceLaunch = await validateManagedServiceLaunch(
      effectiveAnswers,
      runner,
    );
    if (!serviceLaunch.ok) {
      throw new Error(formatServiceLaunchFailure(serviceLaunch.errors));
    }
  }

  const service = effectiveAnswers.registerService
    ? await installUserService({
        answers: effectiveAnswers,
        ledger,
        runner,
        platform,
        homeDir,
        uid: options.uid,
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

async function readExistingDreamuxConfig(configDir: string) {
  const configPath = globalConfigFile({ configDir });
  await assertNoLegacyTomlOnly({ configDir });
  if (!(await pathExists(configPath))) return undefined;
  const loaded = await loadConfig({
    configDir,
    providerPluginLoadMode: 'installed-only',
  });
  return loaded.config;
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

async function resolveProviderBinChecks(
  config: DreamuxConfig,
  catalogs: ProviderDiagnosticCatalogs,
  env: NodeJS.ProcessEnv,
  fallbackDirs: string[],
): Promise<ProviderBinCheck[]> {
  const checks = providerBinChecksForConfig({
    config,
    catalogs,
    env,
    scope: 'managedService',
  });
  // Bare provider binaries (e.g. a `local-agent` installed to
  // $HOME/.local/bin) resolve against the effective service PATH, which the
  // service unit also includes. Resolve against that augmented PATH so the
  // daemon-install preflight and the running service agree. process.env is
  // never mutated; platform/homeDir/env are passed explicitly by the caller.
  const resolveEnv = withUserLocalBinPath(env, fallbackDirs);
  return await Promise.all(
    checks.map(async (check) => ({
      ...check,
      bin: await resolveServiceExecutable(check.bin, resolveEnv),
    })),
  );
}

async function runDispatcherDoctor(
  answers: EffectiveOnboardAnswers,
  loaded: LoadConfigResult,
  catalogs: ProviderDiagnosticCatalogs,
  env: NodeJS.ProcessEnv,
  runner: CommandRunner,
): Promise<OnboardDoctorResult> {
  if (answers.dryRun) {
    const selectedNpmPackages = selectedAnswerNpmPackages(answers);
    const missingPlugins = loaded.providerPluginDiagnostics.filter(
      (diagnostic) =>
        !diagnostic.ok && selectedNpmPackages.has(diagnostic.packageName),
    );
    if (missingPlugins.length > 0) {
      return {
        ok: false,
        errors: missingPlugins.map(
          (diagnostic) =>
            `provider plugin ${diagnostic.packageName}: ${diagnostic.error ?? 'no selected generation'}`,
        ),
        detail: 'dry run cannot install npm provider plugins',
        reports: [],
      };
    }
    return {
      ok: true,
      errors: [],
      detail: 'dry run',
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
      errors: [`onboarded dispatcher '${answers.dispatcherId}' was not found in config`],
      reports: [],
    };
  }
  const doctorEnv = answers.registerService
    ? managedServiceEnvironment(answers)
    : env;
  const reports = await runDispatcherProviderDiagnostics(
    {
      dispatcher,
      catalogs,
      runner,
      env: doctorEnv,
      scope: answers.registerService ? 'managedService' : 'foreground',
    },
  );
  const errors = providerDiagnosticErrors(reports);
  return {
    ok: errors.length === 0,
    detail: `${reports.length} provider diagnostic(s)`,
    errors,
    reports,
  };
}

function selectedAnswerNpmPackages(answers: EffectiveOnboardAnswers): Set<string> {
  const refs = [
    answers.agentRuntime.provider,
    ...answers.channels.map((channel) => channel.provider),
  ];
  const packages = new Set<string>();
  for (const raw of refs) {
    const ref = parseProviderRef(raw);
    if (ref.source === 'npm') packages.add(ref.package);
  }
  return packages;
}

function providerDiagnosticErrors(reports: ProviderDiagnosticReport[]): string[] {
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
