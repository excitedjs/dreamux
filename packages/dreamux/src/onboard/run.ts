import { pathExists } from '../platform/fs-errors.js';

import type { AgentRuntimeDoctorResult } from '@excitedjs/dreamux-types';
import {
  assertNoLegacyTomlOnly,
  globalConfigFile,
  loadConfig,
  stringifyConfig,
} from '../config/config.js';
import {
  dispatcherDir,
  logsRoot,
  setRuntimeConfig,
  stateRoot,
} from '../platform/paths.js';
import { AgentRuntimeProviderCatalog } from '../agent-runtime/catalog.js';
import { dispatcherHostPaths } from '../agent-runtime/host-paths.js';
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
} from './service.js';
import type {
  CommandRunner,
  OnboardAnswers,
  OnboardFileLedger,
  OnboardRunResult,
} from './types.js';

type EffectiveOnboardAnswers = OnboardAnswers & {
  nodeBin: string;
  runtimeBins: string[];
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
}

export async function runOnboard(
  options: RunOnboardOptions,
): Promise<OnboardRunResult> {
  const answers = options.answers;
  const ledger = options.ledger ?? new TransparentFileLedger();
  const runner = options.runner ?? new ExecaCommandRunner();
  const env = options.env ?? process.env;
  const configPath = globalConfigFile({ configDir: answers.configDir });
  const existingConfig = await readExistingDreamuxConfig(answers.configDir);
  const dreamuxConfig = dreamuxConfigFromAnswers(answers, existingConfig);
  // The default bootstrap persists the selected runtime binary in the
  // provider-owned agents[].config block and seeds the managed-service PATH with
  // that binary. Provider diagnostics perform the actual runtime-specific checks.
  const serviceRuntimeBin = answers.registerService && !answers.dryRun
    ? await resolveServiceExecutable(answers.codexBin, env)
    : answers.codexBin;
  const serviceNodeBin = answers.registerService && !answers.dryRun
    ? await selectServiceNodeBin({
        platform: options.platform ?? process.platform,
        currentNodeBin: process.execPath,
        runner,
        probe: options.nodeProbe,
      })
    : process.execPath;
  const effectiveAnswers = {
    ...answers,
    nodeBin: serviceNodeBin,
    runtimeBins: [serviceRuntimeBin],
  };
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
    effectiveAnswers.dispatcherCwd,
    ledger,
    'dispatcher cwd',
    { dryRun: answers.dryRun },
  );
  // Bundled Dreamux skills are no longer symlinked into the workspace
  // (`<cwd>/.codex/skills`) at onboard time (issue #209 slice 6). Core now
  // injects them at runtime by role via the create context's `skillSources`
  // capability, so onboarding creates no skill dir or symlinks. Pre-existing old
  // symlinks are left untouched; `dreamux uninstall` reports but does not remove
  // them.

  const doctor = await runDispatcherDoctor(effectiveAnswers, env, runner);
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
        platform: options.platform,
        homeDir: options.homeDir,
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
  return (await loadConfig({ configDir })).config;
}

async function runDispatcherDoctor(
  answers: EffectiveOnboardAnswers,
  env: NodeJS.ProcessEnv,
  runner: CommandRunner,
): Promise<AgentRuntimeDoctorResult> {
  if (answers.dryRun) {
    return {
      ok: true,
      errors: [],
      detail: 'dry run',
    };
  }
  const loaded = await loadConfig({ configDir: answers.configDir });
  setRuntimeConfig(loaded.config);
  const dispatcher = loaded.config.dispatchers.find(
    (entry) => entry.id === answers.dispatcherId,
  );
  if (dispatcher === undefined) {
    return {
      ok: false,
      detail: answers.dispatcherId,
      errors: [`onboarded dispatcher '${answers.dispatcherId}' was not found in config`],
    };
  }
  const catalog = new AgentRuntimeProviderCatalog({
    registry: loaded.providerRegistry,
  });
  const diagnostic = catalog.resolve(dispatcher.runtime.provider).diagnostic;
  if (diagnostic === undefined) {
    return {
      ok: true,
      detail: `${dispatcher.runtime.provider} has no runtime diagnostic`,
      errors: [],
    };
  }
  const doctorEnv = answers.registerService
    ? managedServiceEnvironment(answers)
    : env;
  return await diagnostic.runDiagnostic(
    {
      runtime_id: dispatcher.id,
      config: dispatcher.runtime.config,
      env: doctorEnv,
      scope: answers.registerService ? 'managedService' : 'foreground',
      paths: dispatcherHostPaths,
    },
    runner,
  );
}

function formatDoctorFailure(
  answers: EffectiveOnboardAnswers,
  doctor: AgentRuntimeDoctorResult,
): string {
  const lines = [
    `dispatcher '${answers.dispatcherId}' runtime is not ready`,
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
