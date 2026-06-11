import { access, readFile } from 'node:fs/promises';
import { homedir, userInfo } from 'node:os';

import { parse as parsePlist, type PlistValue } from 'plist';

/** Async existence probe — the fs/promises replacement for `existsSync`. */
async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

import { resolveCodexBinPath } from '../agent-runtime/builtin/codex/provider.js';
import {
  BUILT_IN_DEFAULTS,
  DEFAULT_CODEX_BIN,
  type DispatcherConfig,
  globalConfigDir,
  globalConfigFile,
  type DreamuxConfig,
} from '../config/config.js';
import { loadConfigWithBuiltins } from '../agent-runtime/load-config.js';
import {
  AgentRuntimeProviderCatalog,
  registerBuiltinAgentRuntimeProviders,
} from '../agent-runtime/catalog.js';
import { createBuiltinProviderRegistry } from '../registry/index.js';
import type {
  AgentRuntimeBinCheck,
  AgentRuntimeDiagnosticContext,
  AgentRuntimeDoctorResult,
} from '../agent-runtime/types.js';
import {
  setRuntimeConfig,
  stateRoot,
} from '../platform/paths.js';
import { diagnoseDispatcherWorkspace } from '../dispatcher-service/dispatcher-workspace.js';
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
  /** Override the user checked for systemd lingering (tests). */
  userName?: string;
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
  runtimeProvider: string;
  foreground: AgentRuntimeDoctorResult;
  managedService: AgentRuntimeDoctorResult | null;
}

export interface DreamuxDoctorResult {
  ok: boolean;
  configFile: string;
  stateDir: string;
  service: ServiceStatus;
  checks: DoctorCheck[];
  dispatchers: DispatcherDoctorReport[];
}

type RuntimeBinaryCheck = AgentRuntimeBinCheck;

export async function runDreamuxDoctor(
  options: DoctorOptions = {},
): Promise<DreamuxDoctorResult> {
  const runner = options.runner ?? new ExecaCommandRunner();
  const checks: DoctorCheck[] = [];
  const configDir = globalConfigDir();
  const { config, configFile, catalog } = await readConfigForDoctor(
    configDir,
    checks,
  );
  setRuntimeConfig(config);

  checks.push({
    name: 'state directory',
    ok: await pathExists(stateRoot()),
    detail: stateRoot(),
  });

  // Runtime binaries are provider-owned: each provider self-declares its bin
  // checks via its diagnostic capability; doctor dedups + executes them.
  const doctorEnv = options.env ?? process.env;
  for (const check of runtimeBinaryChecks(catalog, config.dispatchers, doctorEnv)) {
    checks.push({
      name: check.name,
      ok: await runner.check(check.bin, check.args),
      detail: check.bin,
    });
  }

  // Dispatcher workspace cwd contract (issue #182 PR-4): each ENABLED dispatcher
  // must declare an explicit, usable `cwd` — no state-dir fallback. This mirrors
  // `Server.assertDispatcherWorkspaces`, which enforces the contract only for
  // enabled dispatchers (PR #186 review P3): a disabled dispatcher is never
  // started, so its cwd is reported as a non-blocking diagnostic instead of a
  // failure, keeping doctor and `dreamux serve` on the same contract.
  for (const dispatcher of config.dispatchers) {
    if (dispatcher.enabled === false) {
      checks.push({
        name: `dispatcher ${dispatcher.id} workspace`,
        ok: true,
        detail: 'disabled; workspace cwd contract not enforced',
      });
      continue;
    }
    const diagnosis = await diagnoseDispatcherWorkspace(config, dispatcher.id);
    checks.push({
      name: `dispatcher ${dispatcher.id} workspace`,
      ok: diagnosis.ok,
      detail: diagnosis.detail,
    });
  }

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
  if (service.platform === 'systemd' && service.installed) {
    checks.push(
      await systemdLingerCheck(runner, options.userName ?? userInfo().username),
    );
  }
  await addManagedServiceLaunchChecks(
    checks,
    service,
    runner,
    options.nodeProbe ?? defaultServiceNodeProbe,
    catalog,
    config.dispatchers,
  );

  const dispatchers = await readDispatchers(
    catalog,
    config,
    runner,
    options.env ?? process.env,
    service,
  );
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

async function readConfigForDoctor(
  configDir: string,
  checks: DoctorCheck[],
): Promise<{
  config: DreamuxConfig;
  configFile: string;
  catalog: AgentRuntimeProviderCatalog;
}> {
  try {
    const loaded = await loadConfigWithBuiltins({ configDir });
    checks.push({
      name: 'config',
      ok: true,
      detail: loaded.configFile,
    });
    return {
      config: loaded.config,
      configFile: loaded.configFile,
      catalog: new AgentRuntimeProviderCatalog({
        registry: loaded.providerRegistry,
      }),
    };
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
      catalog: builtinDoctorCatalog(),
    };
  }
}

/**
 * A catalog over a fresh builtin registry, used when config failed to load (so
 * the empty-dispatchers default-codex bin check still resolves its provider).
 */
function builtinDoctorCatalog(): AgentRuntimeProviderCatalog {
  const registry = createBuiltinProviderRegistry();
  registerBuiltinAgentRuntimeProviders({ registry });
  return new AgentRuntimeProviderCatalog({ registry });
}

async function readDispatchers(
  catalog: AgentRuntimeProviderCatalog,
  config: DreamuxConfig,
  runner: CommandRunner,
  env: NodeJS.ProcessEnv,
  service: ServiceStatus,
): Promise<DispatcherDoctorReport[]> {
  return Promise.all(
    config.dispatchers.map(async (dispatcher) => {
      const provider = catalog.resolve(dispatcher.runtime.provider);
      const diagnostic = provider.diagnostic;
      const foreground = diagnostic
        ? await diagnostic.runDiagnostic(
            { dispatcher, env, scope: 'foreground' },
            runner,
          )
        : neutralRuntimeDoctor(dispatcher.runtime.provider);
      const managedService = !service.installed
        ? null
        : diagnostic
          ? await diagnostic.runDiagnostic(
              {
                dispatcher,
                env: service.environment ?? {},
                scope: 'managedService',
              },
              runner,
            )
          : neutralRuntimeDoctor(dispatcher.runtime.provider);
      return {
        id: dispatcher.id,
        runtimeProvider: dispatcher.runtime.provider,
        foreground,
        managedService,
      };
    }),
  );
}

/** Neutral result for a provider that declares no diagnostic surface. */
function neutralRuntimeDoctor(provider: string): AgentRuntimeDoctorResult {
  return {
    ok: true,
    detail: `runtime provider ${provider} reports no host-managed diagnostics`,
    errors: [],
  };
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
  const installed = await pathExists(unitPath);
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
    ? parseLaunchdPlist(await readFile(unitPath, 'utf8'))
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
  const installed = await pathExists(unitPath);
  const unitFile = installed
    ? parseSystemdUnit(await readFile(unitPath, 'utf8'))
    : { environment: null, execStart: null };
  const props = parseSystemdProperties(raw);
  return {
    platform: 'systemd',
    unitPath,
    installed,
    enabled,
    loaded: props['LoadState'] === 'loaded',
    running: active || props['ActiveState'] === 'active',
    pid: parsePositiveInt(props['MainPID']),
    detail: systemdDetail(props),
    environment: unitFile.environment,
    execStart: unitFile.execStart,
  };
}

async function systemdLingerCheck(
  runner: CommandRunner,
  userName: string,
): Promise<DoctorCheck> {
  const fix =
    'enable it with `loginctl enable-linger` (or rerun `dreamux daemon install`)';
  try {
    const raw = await runner.capture('loginctl', [
      'show-user',
      userName,
      '--property=Linger',
    ]);
    const ok = /Linger=yes/.test(raw);
    return {
      name: 'systemd linger',
      ok,
      detail: ok
        ? `enabled for ${userName}; the service starts at boot`
        : `disabled for ${userName}; the service will not start at boot without an interactive login — ${fix}`,
    };
  } catch (err) {
    return {
      name: 'systemd linger',
      ok: false,
      detail: `could not determine lingering for ${userName} (${err instanceof Error ? err.message : String(err)}) — ${fix}`,
    };
  }
}

async function addManagedServiceLaunchChecks(
  checks: DoctorCheck[],
  service: ServiceStatus,
  runner: CommandRunner,
  probe: ServiceNodeProbe,
  catalog: AgentRuntimeProviderCatalog,
  dispatchers: DispatcherConfig[],
): Promise<void> {
  if (!service.installed) return;
  const env = service.environment;
  const missing: string[] = [];
  if (env === null) {
    missing.push('managed service environment');
  } else {
    // CODEX_HOST_CODEX_BIN is no longer required in the unit — the codex binary
    // is dispatcher-local and resolved off the unit PATH at runtime.
    for (const key of ['PATH', 'DREAMUX_NODE_BIN']) {
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

  // Each dispatcher's provider-owned runtime binary must launch under the
  // unit's PATH. CODEX_HOST_CODEX_BIN, when present, still overrides every
  // Codex bin to preserve older units that pinned it.
  for (const check of runtimeBinaryChecks(catalog, dispatchers, serviceEnv, true)) {
    checks.push(
      await checkHelpLaunch(
        check.name,
        check.bin,
        check.args,
        serviceEnv,
        runner,
        'runtime binary is not set; check the agents[] entry the dispatcher references',
      ),
    );
  }
}

function runtimeBinaryChecks(
  catalog: AgentRuntimeProviderCatalog,
  dispatchers: DispatcherConfig[],
  env: NodeJS.ProcessEnv,
  managedService = false,
): RuntimeBinaryCheck[] {
  const checks = new Map<string, RuntimeBinaryCheck>();
  const add = (check: RuntimeBinaryCheck): void => {
    checks.set(`${check.name}\0${check.bin}\0${check.args.join('\0')}`, check);
  };

  if (dispatchers.length === 0) {
    // Residual: with no dispatcher there is no agents[] entry to drive a provider
    // diagnostic, so the default codex bin check is constructed directly here.
    // This is the one codex-specific edge in core doctor (near-zero, not zero):
    // de-leaking it would require a "default provider for empty config" concept.
    add({
      name: managedService ? 'managed service Codex binary' : 'codex binary',
      bin: resolveCodexBinPath(DEFAULT_CODEX_BIN, env),
      args: ['--help'],
    });
    return [...checks.values()];
  }

  const scope: AgentRuntimeDiagnosticContext['scope'] = managedService
    ? 'managedService'
    : 'foreground';
  for (const dispatcher of dispatchers) {
    const diagnostic = catalog.resolve(dispatcher.runtime.provider).diagnostic;
    if (diagnostic === undefined) continue;
    for (const check of diagnostic.binChecks({ dispatcher, env, scope })) {
      add(check);
    }
  }
  return [...checks.values()];
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
  printRuntimeDoctor(`dispatcher ${dispatcher.id} foreground`, dispatcher.foreground);
  if (dispatcher.managedService !== null) {
    printRuntimeDoctor(
      `dispatcher ${dispatcher.id} managed-service`,
      dispatcher.managedService,
    );
  }
}

function printRuntimeDoctor(
  name: string,
  result: AgentRuntimeDoctorResult,
): void {
  console.log(`${result.ok ? 'ok' : 'fail'}\t${name}\t${result.detail}`);
  for (const error of result.errors) {
    console.log(`fail\t${name}\t${error}`);
  }
}
