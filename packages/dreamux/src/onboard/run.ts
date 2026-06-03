import { existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import { DispatcherRepo } from '../db/repository.js';
import { openDatabase } from '../db/schema.js';
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
  dispatcherCodexPluginsDir,
  databasePath,
  setRuntimeConfig,
} from '../runtime/paths.js';
import {
  dispatcherCodexHomeDoctorContext,
  validateDispatcherCodexHome,
  type DispatcherCodexHomeDoctorResult,
} from '../runtime/dispatcher-codex-home.js';
import { ExecaCommandRunner } from './commands.js';
import {
  dispatcherBotSecretRef,
  dispatcherCodexArgsJson,
  dreamuxConfigFromAnswers,
} from './config-files.js';
import {
  ensureDirectory,
  recordFileTreeChanges,
  snapshotFiles,
  TransparentFileLedger,
  writeTextFile,
} from './ledger.js';
import { installUserService, managedServiceEnvironment } from './service.js';
import {
  installClaudemuxPlugin,
  installCodexmuxPlugin,
} from './plugins.js';
import type {
  CommandRunner,
  OnboardAnswers,
  OnboardFileLedger,
  OnboardRunResult,
} from './types.js';

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
  const effectiveAnswers = {
    ...answers,
    runtimeDir: dreamuxConfig.runtime_dir,
    codexBin: dreamuxConfig.codex.bin,
  };
  setRuntimeConfig(dreamuxConfig);

  ensureDirectory(answers.configDir, ledger, 'dreamux config directory', {
    dryRun: answers.dryRun,
  });
  ensureDirectory(effectiveAnswers.runtimeDir, ledger, 'dreamux runtime directory', {
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
  ensureDirectory(codexHome, ledger, 'operator Codex home', {
    dryRun: answers.dryRun,
  });
  ensureDirectory(
    dispatcherCodexPluginsDir(answers.dispatcherId),
    ledger,
    'dispatcher Codex plugins directory',
    { dryRun: answers.dryRun },
  );
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

  await installCodexmuxPlugin({
    answers: effectiveAnswers,
    codexHome,
    ledger,
    runner,
  });

  await installClaudemuxPlugin({
    answers: effectiveAnswers,
    codexHome,
    ledger,
    runner,
  });

  registerDispatcher(effectiveAnswers, ledger);

  const doctor = runDispatcherDoctor(effectiveAnswers, dreamuxConfig, env);
  if (!effectiveAnswers.dryRun && !doctor.ok) {
    throw new Error(formatDoctorFailure(effectiveAnswers, doctor));
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

function readExistingDreamuxConfig(configDir: string) {
  const configPath = globalConfigFile({ configDir });
  assertNoLegacyTomlOnly({ configDir });
  if (!existsSync(configPath)) return undefined;
  return loadConfig({ configDir }).config;
}

function registerDispatcher(
  answers: OnboardAnswers,
  ledger: OnboardFileLedger,
): void {
  const dbPath = databasePath();
  ensureDirectory(dirname(dbPath), ledger, 'dispatcher database directory', {
    dryRun: answers.dryRun,
  });
  if (answers.dryRun) {
    ledger.record(dbPath, 'created', 'dispatcher database');
    return;
  }
  mkdirSync(dirname(dbPath), { recursive: true });
  const before = snapshotFiles(dirname(dbPath));
  const db = openDatabase({ path: dbPath });
  try {
    new DispatcherRepo(db).upsert({
      dispatcher_id: answers.dispatcherId,
      bot_app_id: answers.botAppId,
      bot_secret_ref: dispatcherBotSecretRef(answers.dispatcherId),
      codex_args_json: dispatcherCodexArgsJson(),
      codex_cwd: answers.dispatcherCwd,
    });
  } finally {
    db.close();
  }
  recordFileTreeChanges(dirname(dbPath), before, ledger, 'dispatcher database');
}

function runDispatcherDoctor(
  answers: OnboardAnswers,
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
  answers: OnboardAnswers,
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
      `- authenticate the Codex home before registering the service: CODEX_HOME=${doctor.context.codexHome} ${answers.codexBin} login`,
    );
  }
  return lines.join('\n');
}
