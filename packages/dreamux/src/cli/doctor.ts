import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';

import { parse as parsePlist, type PlistValue } from 'plist';

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
  defaultServiceNodeProbe,
  detectServiceNodeVersionManager,
  LAUNCHD_LABEL,
  MIN_SERVICE_NODE_VERSION,
  nodeVersionSatisfies,
  type ServiceNodeProbe,
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
  nodeProbe?: ServiceNodeProbe;
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
  environment: Record<string, string> | null;
  execStart: string[] | null;
}

export interface DoctorCheck {
  name: string;
  ok: boolean;
  detail: string;
  // Advisory severity for an `ok: true` check that still warrants attention
  // (e.g. a version-manager-bound Node that runs today but is fragile). A
  // `warn` never flips `result.ok` or the CLI exit code; it stays visible.
  severity?: 'warn';
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
  await addManagedServiceLaunchChecks(
    checks,
    service,
    runner,
    options.nodeProbe ?? defaultServiceNodeProbe,
  );

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
    const label = check.ok
      ? check.severity === 'warn'
        ? 'warn'
        : 'ok'
      : 'fail';
    console.log(`${label}\t${check.name}\t${check.detail}`);
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
    const managedServiceEnv = service.environment ?? {};
    const managedService = service.installed
      ? validateDispatcherCodexHome(context, {
          env: managedServiceEnv,
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
  const installed = existsSync(unitPath);
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
  const unitFile = installed
    ? parseLaunchdPlist(readFileSync(unitPath, 'utf8'))
    : { environment: null, execStart: null };
  return {
    platform: 'launchd',
    unitPath,
    installed,
    enabled: installed,
    loaded,
    running: pid !== null || /\bstate = running\b/.test(raw),
    pid,
    detail: parseLaunchdDetail(raw),
    environment: unitFile.environment,
    execStart: unitFile.execStart,
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
  const unitFile = existsSync(unitPath)
    ? parseSystemdUnit(readFileSync(unitPath, 'utf8'))
    : { environment: null, execStart: null };
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
    environment: unitFile.environment,
    execStart: unitFile.execStart,
  };
}

async function addManagedServiceLaunchChecks(
  checks: DoctorCheck[],
  service: ServiceStatus,
  runner: CommandRunner,
  probe: ServiceNodeProbe,
): Promise<void> {
  if (!service.installed) return;
  const env = service.environment;
  const missing: string[] = [];
  if (env === null) {
    missing.push('managed service environment');
  } else {
    for (const key of ['PATH', 'DREAMUX_NODE_BIN', 'CODEX_HOST_CODEX_BIN']) {
      if (env[key] === undefined || env[key]?.trim() === '') missing.push(key);
    }
  }
  if (missing.length > 0) {
    checks.push({
      name: 'managed service environment',
      ok: false,
      detail: `${missing.join(', ')} missing in ${service.unitPath}; rerun dreamux onboard`,
    });
    return;
  }

  const serviceEnv = env as Record<string, string>;
  const nodeBin = serviceEnv['DREAMUX_NODE_BIN'];
  checks.push(await checkNodeLaunch(nodeBin, serviceEnv, runner));

  // Drift advisory: the service Node runs today but is bound to a version
  // manager, so a version switch/cleanup will break it. Surface it visibly
  // without failing — reuses the same predicate selection uses.
  const manager = await detectServiceNodeVersionManager(nodeBin, probe);
  if (manager !== null) {
    checks.push({
      name: 'managed service Node stability',
      ok: true,
      severity: 'warn',
      detail: `${nodeBin} resolves into ${manager}-managed Node; a version switch or cleanup will break the managed service. Rerun dreamux onboard to repin to a stable Node.`,
    });
  }

  const dreamuxBin = service.execStart?.[0];
  checks.push(
    await checkHelpLaunch(
      'managed service dreamux launcher',
      dreamuxBin,
      ['--help'],
      serviceEnv,
      runner,
      'ExecStart is missing in the installed service; rerun dreamux onboard',
    ),
  );

  checks.push(
    await checkHelpLaunch(
      'managed service Codex binary',
      serviceEnv['CODEX_HOST_CODEX_BIN'],
      ['--help'],
      serviceEnv,
      runner,
      'CODEX_HOST_CODEX_BIN is missing in the installed service; rerun dreamux onboard',
    ),
  );
}

async function checkNodeLaunch(
  nodeBin: string,
  env: NodeJS.ProcessEnv,
  runner: CommandRunner,
): Promise<DoctorCheck> {
  try {
    const version = await runner.capture(nodeBin, ['--version'], { env });
    const ok = nodeVersionSatisfies(version);
    return {
      name: 'managed service Node binary',
      ok,
      detail: ok
        ? `${nodeBin} (${version.trim()})`
        : `${nodeBin} reported ${version.trim() || '<empty>'}; expected >=${MIN_SERVICE_NODE_VERSION}`,
    };
  } catch (err) {
    return {
      name: 'managed service Node binary',
      ok: false,
      detail: `${nodeBin} failed: ${err instanceof Error ? err.message : String(err)}; rerun dreamux onboard`,
    };
  }
}

async function checkHelpLaunch(
  name: string,
  command: string | undefined,
  args: string[],
  env: NodeJS.ProcessEnv,
  runner: CommandRunner,
  missingDetail: string,
): Promise<DoctorCheck> {
  if (command === undefined || command.trim() === '') {
    return { name, ok: false, detail: missingDetail };
  }
  const ok = await runner.check(command, args, { env });
  return {
    name,
    ok,
    detail: ok ? command : `${command} failed under installed service environment; rerun dreamux onboard`,
  };
}

function parseSystemdUnit(content: string): {
  environment: Record<string, string> | null;
  execStart: string[] | null;
} {
  const environment: Record<string, string> = {};
  let execStart: string[] | null = null;
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.startsWith('Environment=')) {
      const assignment = line.slice('Environment='.length);
      const eq = assignment.indexOf('=');
      if (eq > 0) {
        environment[assignment.slice(0, eq)] = systemdUnescapeEnv(
          assignment.slice(eq + 1),
        );
      }
    } else if (line.startsWith('ExecStart=')) {
      execStart = splitSystemdCommand(line.slice('ExecStart='.length));
    }
  }
  return {
    environment: Object.keys(environment).length > 0 ? environment : null,
    execStart,
  };
}

function systemdUnescapeEnv(value: string): string {
  let out = '';
  for (let index = 0; index < value.length; index += 1) {
    const ch = value[index];
    if (ch !== '\\') {
      out += ch;
      continue;
    }
    if (value.slice(index, index + 4) === '\\x20') {
      out += ' ';
      index += 3;
      continue;
    }
    const next = value[index + 1];
    if (next === '\\') {
      out += '\\';
      index += 1;
      continue;
    }
    if (next === '"') {
      out += '"';
      index += 1;
      continue;
    }
    out += ch;
  }
  return out;
}

function splitSystemdCommand(value: string): string[] {
  const args: string[] = [];
  let current = '';
  let quoted = false;
  let escaped = false;
  for (const ch of value) {
    if (escaped) {
      current += ch;
      escaped = false;
      continue;
    }
    if (ch === '\\') {
      escaped = true;
      continue;
    }
    if (ch === '"') {
      quoted = !quoted;
      continue;
    }
    if (!quoted && /\s/.test(ch)) {
      if (current !== '') {
        args.push(current);
        current = '';
      }
      continue;
    }
    current += ch;
  }
  if (current !== '') args.push(current);
  return args;
}

function parseLaunchdPlist(content: string): {
  environment: Record<string, string> | null;
  execStart: string[] | null;
} {
  let parsed: PlistValue;
  try {
    parsed = parsePlist(content);
  } catch {
    return { environment: null, execStart: null };
  }
  if (!isPlistRecord(parsed)) {
    return { environment: null, execStart: null };
  }
  return {
    environment: parseLaunchdEnvironment(parsed['EnvironmentVariables']),
    execStart: parseLaunchdProgramArguments(parsed['ProgramArguments']),
  };
}

function parseLaunchdEnvironment(
  value: PlistValue | undefined,
): Record<string, string> | null {
  if (!isPlistRecord(value)) return null;
  const environment: Record<string, string> = {};
  for (const [key, raw] of Object.entries(value)) {
    if (typeof raw === 'string') environment[key] = raw;
  }
  return Object.keys(environment).length > 0 ? environment : null;
}

function parseLaunchdProgramArguments(
  value: PlistValue | undefined,
): string[] | null {
  if (!Array.isArray(value)) return null;
  if (!value.every((item): item is string => typeof item === 'string')) {
    return null;
  }
  return value.length > 0 ? value : null;
}

function isPlistRecord(
  value: PlistValue | undefined,
): value is Record<string, PlistValue> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
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
