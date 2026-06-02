import { existsSync } from 'node:fs';

import { DispatcherRepo } from '../db/repository.js';
import { openDatabase } from '../db/schema.js';
import { codexArgsToCli, parseCodexArgs } from '../runtime/codex-args.js';
import {
  BUILT_IN_DEFAULTS,
  globalConfigDir,
  globalConfigFile,
  loadConfig,
  type DreamuxConfig,
} from '../runtime/config.js';
import {
  dispatcherCodexHomeDoctorContext,
  validateDispatcherCodexHome,
  type DispatcherCodexHomeDoctorResult,
} from '../runtime/dispatcher-codex-home.js';
import {
  databasePath as runtimeDatabasePath,
  runtimeRoot,
  setRuntimeConfig,
} from '../runtime/paths.js';
import { ExecaCommandRunner } from '../onboard/commands.js';
import { managedServiceEnvironment } from '../onboard/service.js';
import type { CommandRunner } from '../onboard/types.js';
import { getDaemonStatus, type DaemonStatus } from './daemon.js';

export interface DoctorOptions {
  env?: NodeJS.ProcessEnv;
  runner?: CommandRunner;
  platform?: NodeJS.Platform;
  homeDir?: string;
  uid?: number;
}

export interface DoctorCheck {
  name: string;
  ok: boolean;
  detail: string;
}

export interface DispatcherDoctorReport {
  id: string;
  foreground: DispatcherCodexHomeDoctorResult;
  managedService: DispatcherCodexHomeDoctorResult | null;
}

export interface DreamuxDoctorResult {
  ok: boolean;
  configFile: string;
  runtimeDir: string;
  databasePath: string;
  daemon: DaemonStatus;
  checks: DoctorCheck[];
  dispatchers: DispatcherDoctorReport[];
}

export async function runDreamuxDoctor(
  options: DoctorOptions = {},
): Promise<DreamuxDoctorResult> {
  const runner = options.runner ?? new ExecaCommandRunner();
  const checks: DoctorCheck[] = [];
  const configDir = globalConfigDir();
  const { config, configFile } = readConfigForDoctor(configDir, checks);
  setRuntimeConfig(config);

  checks.push({
    name: 'runtime directory',
    ok: existsSync(runtimeRoot()),
    detail: runtimeRoot(),
  });

  const dbPath = runtimeDatabasePath();
  checks.push({
    name: 'runtime database',
    ok: existsSync(dbPath),
    detail: dbPath,
  });

  checks.push({
    name: 'codex binary',
    ok: await runner.check(config.codex.bin, ['--help']),
    detail: config.codex.bin,
  });

  const daemon = await getDaemonStatus({
    runner,
    platform: options.platform,
    homeDir: options.homeDir,
    uid: options.uid,
  });
  checks.push({
    name: 'user service',
    ok: true,
    detail: daemon.installed
      ? `installed at ${daemon.unitPath}`
      : `not installed at ${daemon.unitPath}`,
  });

  const dispatchers = existsSync(dbPath)
    ? readDispatchers(config, options.env ?? process.env, daemon)
    : [];
  if (dispatchers.length === 0) {
    checks.push({
      name: 'dispatchers',
      ok: false,
      detail: 'no dispatchers are configured',
    });
  }

  const ok =
    checks.every((check) => check.ok) &&
    dispatchers.every((dispatcher) =>
      dispatcher.foreground.ok &&
      (dispatcher.managedService === null || dispatcher.managedService.ok),
    );
  return {
    ok,
    configFile,
    runtimeDir: runtimeRoot(),
    databasePath: dbPath,
    daemon,
    checks,
    dispatchers,
  };
}

export function printDoctorResult(result: DreamuxDoctorResult): void {
  console.log(`dreamux doctor: ${result.ok ? 'ok' : 'failed'}`);
  console.log(`config: ${result.configFile}`);
  console.log(`runtime: ${result.runtimeDir}`);
  console.log(`database: ${result.databasePath}`);
  for (const check of result.checks) {
    console.log(`${check.ok ? 'ok' : 'fail'}\t${check.name}\t${check.detail}`);
  }
  for (const dispatcher of result.dispatchers) {
    printDispatcherDoctor(dispatcher);
  }
}

function readConfigForDoctor(
  configDir: string,
  checks: DoctorCheck[],
): { config: DreamuxConfig; configFile: string } {
  try {
    const loaded = loadConfig({ configDir });
    checks.push({
      name: 'config',
      ok: true,
      detail: loaded.configFile,
    });
    return loaded;
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    checks.push({
      name: 'config',
      ok: false,
      detail,
    });
    return {
      config: BUILT_IN_DEFAULTS,
      configFile: globalConfigFile({ configDir }),
    };
  }
}

function readDispatchers(
  config: DreamuxConfig,
  env: NodeJS.ProcessEnv,
  daemon: DaemonStatus,
): DispatcherDoctorReport[] {
  const db = openDatabase({ path: runtimeDatabasePath() });
  try {
    const repo = new DispatcherRepo(db);
    return repo.list().map((row) => {
      const codexArgs = parseCodexArgs(row.codex_args_json, {
        approvalPolicy: config.codex.approval_policy,
        sandboxMode: config.codex.sandbox_mode,
        extraArgs: config.codex.extra_args,
      });
      const codexCliArgs = codexArgsToCli(codexArgs);
      const context = dispatcherCodexHomeDoctorContext(row.dispatcher_id, {
        codexCliArgs,
      });
      const foreground = validateDispatcherCodexHome(context, {
        env,
        codexCliArgs,
      });
      const managedService = daemon.installed
        ? validateDispatcherCodexHome(context, {
            env: managedServiceEnvironment({
              configDir: globalConfigDir(),
              runtimeDir: runtimeRoot(),
              codexBin: process.env['CODEX_HOST_CODEX_BIN'] || config.codex.bin,
              dreamuxBin: process.env['DREAMUX_BIN'] ?? process.argv[1],
              startService: false,
              dryRun: false,
            }),
            codexCliArgs,
          })
        : null;
      return {
        id: row.dispatcher_id,
        foreground,
        managedService,
      };
    });
  } finally {
    db.close();
  }
}

function printDispatcherDoctor(dispatcher: DispatcherDoctorReport): void {
  printCodexHomeDoctor(`dispatcher ${dispatcher.id} foreground`, dispatcher.foreground);
  if (dispatcher.managedService !== null) {
    printCodexHomeDoctor(
      `dispatcher ${dispatcher.id} managed-service`,
      dispatcher.managedService,
    );
  }
}

function printCodexHomeDoctor(
  name: string,
  result: DispatcherCodexHomeDoctorResult,
): void {
  console.log(`${result.ok ? 'ok' : 'fail'}\t${name}\t${result.context.codexHome}`);
  for (const error of result.errors) {
    console.log(`fail\t${name}\t${error}`);
  }
}
