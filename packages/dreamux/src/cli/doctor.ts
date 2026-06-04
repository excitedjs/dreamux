import { existsSync } from 'node:fs';
import { homedir } from 'node:os';

import { codexArgsToCli, parseCodexArgs } from '../runtime/codex-args.js';
import {
  BUILT_IN_DEFAULTS,
  type DispatcherConfig,
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
  dispatcherCodexCwd,
  setRuntimeConfig,
  stateRoot,
} from '../runtime/paths.js';
import { ExecaCommandRunner } from '../onboard/commands.js';
import {
  LAUNCHD_LABEL,
  managedServiceEnvironment,
  serviceUnitPath,
  SYSTEMD_UNIT,
} from '../onboard/service.js';
import type { CommandRunner } from '../onboard/types.js';

export interface DoctorOptions {
  env?: NodeJS.ProcessEnv;
  runner?: CommandRunner;
  platform?: NodeJS.Platform;
  homeDir?: string;
  uid?: number;
}

export interface ServiceStatus {
  platform: 'launchd' | 'systemd';
  unitPath: string;
  installed: boolean;
  loaded: boolean;
  running: boolean;
  enabled: boolean;
  pid: number | null;
  detail: string | null;
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
  stateDir: string;
  service: ServiceStatus;
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
    name: 'state directory',
    ok: existsSync(stateRoot()),
    detail: stateRoot(),
  });

  checks.push({
    name: 'codex binary',
    ok: await runner.check(config.codex.bin, ['--help']),
    detail: config.codex.bin,
  });

  const service = await getServiceStatus({
    runner,
    platform: options.platform,
    homeDir: options.homeDir,
    uid: options.uid,
  });
  checks.push({
    name: 'user service',
    ok: true,
    detail: service.installed
      ? `installed at ${service.unitPath}`
      : `not installed at ${service.unitPath}`,
  });

  const dispatchers = readDispatchers(config, options.env ?? process.env, service);
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
    stateDir: stateRoot(),
    service,
    checks,
    dispatchers,
  };
}

export function printDoctorResult(result: DreamuxDoctorResult): void {
  console.log(`dreamux doctor: ${result.ok ? 'ok' : 'failed'}`);
  console.log(`config: ${result.configFile}`);
  console.log(`state: ${result.stateDir}`);
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
  service: ServiceStatus,
): DispatcherDoctorReport[] {
  return config.dispatchers.map((dispatcher) => {
    const codexArgs = parseCodexArgs(dispatcherCodexArgsJson(dispatcher), {
      approvalPolicy: config.codex.approval_policy,
      sandboxMode: config.codex.sandbox_mode,
      extraArgs: config.codex.extra_args,
    });
    const codexCliArgs = codexArgsToCli(codexArgs);
    const context = dispatcherCodexHomeDoctorContext(dispatcher.id, {
      codexCliArgs,
      dispatcherCwd: dispatcher.cwd ?? dispatcherCodexCwd(dispatcher.id),
    });
    const foreground = validateDispatcherCodexHome(context, {
      env,
      codexCliArgs,
    });
    const managedService = service.installed
      ? validateDispatcherCodexHome(context, {
          env: managedServiceEnvironment({
            configDir: globalConfigDir(),
            runtimeDir: stateRoot(),
            codexBin: process.env['CODEX_HOST_CODEX_BIN'] || config.codex.bin,
            dreamuxBin: process.env['DREAMUX_BIN'] ?? process.argv[1],
            startService: false,
            dryRun: false,
          }),
          codexCliArgs,
        })
      : null;
    return {
      id: dispatcher.id,
      foreground,
      managedService,
    };
  });
}

function dispatcherCodexArgsJson(dispatcher: DispatcherConfig): string {
  return JSON.stringify({
    ...(dispatcher.codex.approval_policy !== null
      ? { approvalPolicy: dispatcher.codex.approval_policy }
      : {}),
    ...(dispatcher.codex.sandbox_mode !== null
      ? { sandboxMode: dispatcher.codex.sandbox_mode }
      : {}),
    ...(dispatcher.codex.extra_args.length > 0
      ? { extraArgs: dispatcher.codex.extra_args }
      : {}),
  });
}

async function getServiceStatus(options: DoctorOptions): Promise<ServiceStatus> {
  const runner = options.runner ?? new ExecaCommandRunner();
  const unit = serviceUnitPath(options.platform, options.homeDir ?? homedir());
  if (unit.platform === 'launchd') {
    return launchdStatus(unit.path, runner, options.uid);
  }
  return systemdStatus(unit.path, runner);
}

async function launchdStatus(
  unitPath: string,
  runner: CommandRunner,
  uid?: number,
): Promise<ServiceStatus> {
  const target = launchdTarget(uid);
  let raw = '';
  let loaded = false;
  try {
    raw = await runner.capture('launchctl', ['print', target]);
    loaded = true;
  } catch {
    loaded = false;
  }
  const pid = parseLaunchdPid(raw);
  return {
    platform: 'launchd',
    unitPath,
    installed: existsSync(unitPath),
    enabled: existsSync(unitPath),
    loaded,
    running: pid !== null || /\bstate = running\b/.test(raw),
    pid,
    detail: parseLaunchdDetail(raw),
  };
}

async function systemdStatus(
  unitPath: string,
  runner: CommandRunner,
): Promise<ServiceStatus> {
  const enabled = await runner.check('systemctl', [
    '--user',
    'is-enabled',
    SYSTEMD_UNIT,
  ]);
  const active = await runner.check('systemctl', [
    '--user',
    'is-active',
    SYSTEMD_UNIT,
  ]);
  let raw = '';
  try {
    raw = await runner.capture('systemctl', [
      '--user',
      'show',
      SYSTEMD_UNIT,
      '--property=LoadState,ActiveState,SubState,MainPID,Result',
    ]);
  } catch {
    raw = '';
  }
  const props = parseSystemdProperties(raw);
  return {
    platform: 'systemd',
    unitPath,
    installed: existsSync(unitPath),
    enabled,
    loaded: props['LoadState'] === 'loaded',
    running: active || props['ActiveState'] === 'active',
    pid: parsePositiveInt(props['MainPID']),
    detail: systemdDetail(props),
  };
}

function launchdTarget(uid?: number): string {
  const actualUid = uid ?? process.getuid?.();
  if (actualUid === undefined) {
    throw new Error('launchd user service diagnostics require a numeric uid');
  }
  return `gui/${actualUid}/${LAUNCHD_LABEL}`;
}

function parseLaunchdPid(raw: string): number | null {
  const match = raw.match(/\bpid = (\d+)/);
  if (match === null) return null;
  return parsePositiveInt(match[1]);
}

function parseLaunchdDetail(raw: string): string | null {
  const state = raw.match(/\bstate = ([^\n]+)/)?.[1]?.trim();
  const reason = raw.match(/\breason = ([^\n]+)/)?.[1]?.trim();
  return [state, reason]
    .filter((value) => value !== undefined && value !== '')
    .join(', ') || null;
}

function parseSystemdProperties(raw: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of raw.split(/\r?\n/)) {
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    result[line.slice(0, eq)] = line.slice(eq + 1);
  }
  return result;
}

function systemdDetail(props: Record<string, string>): string | null {
  const parts = [
    props['LoadState'],
    props['ActiveState'],
    props['SubState'],
    props['Result'] !== undefined && props['Result'] !== 'success'
      ? `result=${props['Result']}`
      : undefined,
  ].filter((part) => part !== undefined && part !== '');
  return parts.join(', ') || null;
}

function parsePositiveInt(value: string | undefined): number | null {
  if (value === undefined) return null;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) return null;
  return parsed;
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
