import { existsSync } from 'node:fs';

import { codexArgsToCli, parseCodexArgs } from '../runtime/codex-args.js';
import {
  assertNoLegacyTomlOnly,
  globalConfigFile,
  loadConfig,
  stringifyConfig,
} from '../runtime/config.js';
import {
  dispatcherAppServerControlDir,
  dispatcherCodexHome,
  dispatcherWorkspaceCodexSkillsDir,
  dispatcherWorkspaceSkillPath,
  logsRoot,
  setRuntimeConfig,
  stateRoot,
} from '../runtime/paths.js';
import {
  dispatcherCodexHomeDoctorContext,
  validateDispatcherCodexHome,
  type DispatcherCodexHomeDoctorResult,
} from '../runtime/dispatcher-codex-home.js';
import { ExecaCommandRunner } from './commands.js';
import {
  dispatcherCodexArgsJson,
  dreamuxConfigFromAnswers,
} from './config-files.js';
import { installDispatcherSkill } from './dispatcher-skill.js';
import {
  ensureDirectory,
  TransparentFileLedger,
  writeTextFile,
} from './ledger.js';
import {
  installUserService,
  managedServiceEnvironment,
  resolveServiceExecutable,
  validateManagedServiceLaunch,
} from './service.js';
import type {
  CommandRunner,
  OnboardAnswers,
  OnboardFileLedger,
  OnboardRunResult,
} from './types.js';

type EffectiveOnboardAnswers = OnboardAnswers & { nodeBin: string };

export interface RunOnboardOptions {
  answers: OnboardAnswers;
  runner?: CommandRunner;
  ledger?: OnboardFileLedger;
  platform?: NodeJS.Platform;
  homeDir?: string;
  uid?: number;
  env?: NodeJS.ProcessEnv;
}

export async function runOnboard(
  options: RunOnboardOptions,
): Promise<OnboardRunResult> {
  const answers = options.answers;
  const ledger = options.ledger ?? new TransparentFileLedger();
  const runner = options.runner ?? new ExecaCommandRunner();
  const env = options.env ?? process.env;
  const configPath = globalConfigFile({ configDir: answers.configDir });
  const existingConfig = readExistingDreamuxConfig(answers.configDir);
  const dreamuxConfig = dreamuxConfigFromAnswers(answers, existingConfig);
  const serviceCodexBin = answers.registerService && !answers.dryRun
    ? resolveServiceExecutable(dreamuxConfig.codex.bin, env)
    : dreamuxConfig.codex.bin;
  const effectiveAnswers = {
    ...answers,
    runtimeDir: stateRoot(),
    codexBin: serviceCodexBin,
    nodeBin: process.execPath,
  };
  setRuntimeConfig(dreamuxConfig);

  ensureDirectory(answers.configDir, ledger, 'dreamux config directory', {
    dryRun: answers.dryRun,
  });
  ensureDirectory(stateRoot(), ledger, 'dreamux state directory', {
    dryRun: answers.dryRun,
  });
  ensureDirectory(logsRoot(), ledger, 'dreamux logs directory', {
    dryRun: answers.dryRun,
  });
  writeTextFile(
    configPath,
    stringifyConfig(dreamuxConfig),
    ledger,
    'dreamux global config',
    { mode: 0o600, dryRun: answers.dryRun },
  );

  const codexHome = dispatcherCodexHome(answers.dispatcherId);
  ensureDirectory(codexHome, ledger, 'global Codex home', {
    dryRun: answers.dryRun,
  });
  ensureDirectory(
    dispatcherAppServerControlDir(answers.dispatcherId),
    ledger,
    'dispatcher app-server control directory',
    { dryRun: answers.dryRun },
  );
  ensureDirectory(
    effectiveAnswers.dispatcherCwd,
    ledger,
    'dispatcher cwd',
    { dryRun: answers.dryRun },
  );
  ensureDirectory(
    dispatcherWorkspaceCodexSkillsDir(effectiveAnswers.dispatcherCwd),
    ledger,
    'workspace-local Codex skills directory',
    { dryRun: answers.dryRun },
  );

  installDispatcherSkill({
    skillPath: dispatcherWorkspaceSkillPath(effectiveAnswers.dispatcherCwd),
    ledger,
    dryRun: answers.dryRun,
  });

  const doctor = runDispatcherDoctor(effectiveAnswers, dreamuxConfig, env);
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
    '- rerun dreamux onboard from the desired Node/Codex install, or pass explicit --dreamux-bin / --codex-bin values',
  ].join('\n');
}

function readExistingDreamuxConfig(configDir: string) {
  const configPath = globalConfigFile({ configDir });
  assertNoLegacyTomlOnly({ configDir });
  if (!existsSync(configPath)) return undefined;
  return loadConfig({ configDir }).config;
}

function runDispatcherDoctor(
  answers: EffectiveOnboardAnswers,
  dreamuxConfig: ReturnType<typeof dreamuxConfigFromAnswers>,
  env: NodeJS.ProcessEnv,
): DispatcherCodexHomeDoctorResult {
  const codexArgs = parseCodexArgs(dispatcherCodexArgsJson(), {
    approvalPolicy: dreamuxConfig.codex.approval_policy,
    sandboxMode: dreamuxConfig.codex.sandbox_mode,
    extraArgs: dreamuxConfig.codex.extra_args,
  });
  const codexCliArgs = codexArgsToCli(codexArgs);
  const context = dispatcherCodexHomeDoctorContext(answers.dispatcherId, {
    codexCliArgs,
    dispatcherCwd: answers.dispatcherCwd,
  });
  if (answers.dryRun) {
    return {
      ok: true,
      errors: [],
      context,
    };
  }
  const doctorEnv = answers.registerService
    ? managedServiceEnvironment(answers)
    : env;
  return validateDispatcherCodexHome(context, {
    env: doctorEnv,
    codexCliArgs,
  });
}

function formatDoctorFailure(
  answers: EffectiveOnboardAnswers,
  doctor: DispatcherCodexHomeDoctorResult,
): string {
  const lines = [
    `dispatcher '${answers.dispatcherId}' Codex home is not ready`,
    ...doctor.errors.map((error) => `- ${error}`),
  ];
  if (
    answers.registerService &&
    doctor.errors.some((error) => error.includes('missing Codex auth state'))
  ) {
    lines.push(
      '- managed service environments do not inherit your interactive shell auth token',
      `- authenticate the global Codex home before registering the service: ${answers.codexBin} login`,
    );
  }
  return lines.join('\n');
}
