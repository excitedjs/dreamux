import { pathExists } from '../platform/fs-errors.js';

import { codexArgsToCli, parseCodexArgs } from '../agent-runtime/builtin/codex/args.js';
import {
  assertNoLegacyTomlOnly,
  globalConfigFile,
  stringifyConfig,
} from '../config/config.js';
import { loadConfigWithBuiltins } from '../agent-runtime/load-config.js';
import {
  dispatcherDir,
  logsRoot,
  setRuntimeConfig,
  stateRoot,
} from '../platform/paths.js';
import {
  dispatcherCodexHome,
  dispatcherWorkspaceCodexSkillsDir,
} from '../agent-runtime/builtin/codex/paths.js';
import {
  dispatcherCodexHomeDoctorContext,
  validateDispatcherCodexHome,
  type DispatcherCodexHomeDoctorResult,
} from '../agent-runtime/builtin/codex/codex-home.js';
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
  selectServiceClaudeBin,
  selectServiceNodeBin,
  tryResolveServiceExecutable,
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
  // answers.codexBin (onboard prompt / --codex-bin) is persisted into the
  // dispatcher's referenced agents[] entry (agents[].config.bin) and used to
  // seed the managed-service PATH so the unit can resolve codex; it is not
  // pinned as an env override.
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
  // Best-effort: locate Claude Code so the unit PATH resolves `claude` for
  // server-hosted builtin:claude-code workers (issue #126 PR8). Absent install
  // → omit; onboard still completes for codex-only setups.
  const serviceClaudeBin =
    answers.registerService && !answers.dryRun
      ? await tryResolveServiceExecutable(selectServiceClaudeBin(env), env)
      : null;
  const effectiveAnswers = {
    ...answers,
    codexBin: serviceCodexBin,
    nodeBin: serviceNodeBin,
    ...(serviceClaudeBin !== null ? { claudeBin: serviceClaudeBin } : {}),
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
  return (await loadConfigWithBuiltins({ configDir })).config;
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
