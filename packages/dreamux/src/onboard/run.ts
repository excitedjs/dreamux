import { access } from 'node:fs/promises';

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

type EffectiveOnboardAnswers = OnboardAnswers & { nodeBin: string };

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
  // answers.codexBin (onboard prompt / --codex-bin) is persisted into the new
  // dispatcher's dispatchers[].codex.bin and used to seed the managed-service
  // PATH so the unit can resolve codex; it is not pinned as an env override.
  const serviceCodexBin = answers.registerService && !answers.dryRun
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
    codexBin: serviceCodexBin,
    nodeBin: serviceNodeBin,
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

  const codexHome = dispatcherCodexHome(answers.dispatcherId);
  await ensureDirectory(codexHome, ledger, 'global Codex home', {
    dryRun: answers.dryRun,
  });
  await ensureDirectory(
    dispatcherAppServerControlDir(answers.dispatcherId),
    ledger,
    'dispatcher app-server control directory',
    { dryRun: answers.dryRun },
  );
  await ensureDirectory(
    effectiveAnswers.dispatcherCwd,
    ledger,
    'dispatcher cwd',
    { dryRun: answers.dryRun },
  );
  await ensureDirectory(
    dispatcherWorkspaceCodexSkillsDir(effectiveAnswers.dispatcherCwd),
    ledger,
    'workspace-local Codex skills directory',
    { dryRun: answers.dryRun },
  );

  await installDispatcherSkill({
    dispatcherCwd: effectiveAnswers.dispatcherCwd,
    ledger,
    dryRun: answers.dryRun,
  });

  const doctor = await runDispatcherDoctor(effectiveAnswers, env);
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

async function readExistingDreamuxConfig(configDir: string) {
  const configPath = globalConfigFile({ configDir });
  await assertNoLegacyTomlOnly({ configDir });
  if (!(await pathExists(configPath))) return undefined;
  return (await loadConfig({ configDir })).config;
}

/** Async existence probe — the fs/promises replacement for `existsSync`. */
async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function runDispatcherDoctor(
  answers: EffectiveOnboardAnswers,
  env: NodeJS.ProcessEnv,
): Promise<DispatcherCodexHomeDoctorResult> {
  // The onboarded dispatcher is created with default codex settings, which
  // dispatcherCodexArgsJson() already encodes — there is no global-default
  // layer to merge anymore.
  const codexArgs = parseCodexArgs(dispatcherCodexArgsJson());
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
  return await validateDispatcherCodexHome(context, {
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
