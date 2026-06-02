import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { DispatcherRepo } from '../db/repository.js';
import { openDatabase } from '../db/schema.js';
import { codexArgsToCli, parseCodexArgs } from '../runtime/codex-args.js';
import {
  dispatcherAppServerControlDir,
  dispatcherCodexConfigPath,
  dispatcherCodexCwd,
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
  buildDispatcherCodexConfigToml,
  buildDreamuxConfigToml,
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
  const dreamuxConfig = dreamuxConfigFromAnswers(answers);
  setRuntimeConfig(dreamuxConfig);

  if (!answers.registerService) {
    preflightAuth(answers, env);
  }

  const configPath = join(answers.configDir, 'config.toml');
  ensureDirectory(answers.configDir, ledger, 'dreamux config directory', {
    dryRun: answers.dryRun,
  });
  ensureDirectory(answers.runtimeDir, ledger, 'dreamux runtime directory', {
    dryRun: answers.dryRun,
  });
  writeTextFile(
    configPath,
    buildDreamuxConfigToml(answers),
    ledger,
    'dreamux global config',
    { mode: 0o600, dryRun: answers.dryRun },
  );

  const codexHome = dispatcherCodexHome(answers.dispatcherId);
  const codexConfigPath = dispatcherCodexConfigPath(answers.dispatcherId);
  ensureDirectory(codexHome, ledger, 'dispatcher private CODEX_HOME', {
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
    dispatcherCodexCwd(answers.dispatcherId),
    ledger,
    'dispatcher app-server cwd',
    { dryRun: answers.dryRun },
  );

  await installCodexmuxPlugin({
    answers,
    codexHome,
    ledger,
    runner,
  });
  writeTextFile(
    codexConfigPath,
    buildDispatcherCodexConfigToml({
      codexHomeConfigPath: codexConfigPath,
      model: answers.codexModel,
      marketplaceName: answers.codexMarketplaceName,
      marketplaceSource: answers.codexMarketplaceSource,
      pluginRef: answers.codexPluginRef,
    }),
    ledger,
    'dispatcher private Codex config',
    { mode: 0o600, dryRun: answers.dryRun },
  );

  await installClaudemuxPlugin({
    answers,
    codexHome,
    ledger,
    runner,
  });

  registerDispatcher(answers, ledger);

  const doctor = runDispatcherDoctor(answers, dreamuxConfig, env);
  if (!answers.dryRun && !doctor.ok) {
    throw new Error(formatDoctorFailure(answers, doctor));
  }

  const service = answers.registerService
    ? await installUserService({
        answers,
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
      bot_secret_ref: answers.botSecretRef,
      codex_args_json: dispatcherCodexArgsJson(),
      codex_cwd: dispatcherCodexCwd(answers.dispatcherId),
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
    `dispatcher '${answers.dispatcherId}' private CODEX_HOME is not ready`,
    ...doctor.errors.map((error) => `- ${error}`),
  ];
  if (
    answers.registerService &&
    doctor.errors.some((error) => error.includes('missing dispatcher Codex auth state'))
  ) {
    lines.push(
      '- managed service environments do not inherit your interactive shell auth token',
      `- authenticate the private dispatcher Codex home before registering the service: CODEX_HOME=${doctor.context.codexHome} ${answers.codexBin} login`,
    );
  }
  return lines.join('\n');
}

function preflightAuth(answers: OnboardAnswers, env: NodeJS.ProcessEnv): void {
  if (answers.dryRun) return;
  const value = env[answers.authEnvVar];
  if (value !== undefined && value.trim() !== '') return;
  throw new Error(
    `missing dispatcher Codex auth env var ${answers.authEnvVar}; ` +
      'onboard does not write API secrets into the private CODEX_HOME',
  );
}
