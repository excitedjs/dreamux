import { userInfo } from 'node:os';

import {
  BUILT_IN_DEFAULTS,
  globalConfigFile,
  type DreamuxConfig,
} from '../config/config.js';
import { loadConfig } from '../config/load.js';
import { AgentRuntimeProviderCatalog } from '../agent-runtime/catalog.js';
import { ChannelProviderCatalog } from '../channel/catalog.js';
import { ProviderRegistry } from '../registry/index.js';
import type { ProviderBinCheck } from '@excitedjs/dreamux-types';
import { createLogger } from '../platform/logger.js';
import { type LoadedPlugin, PluginLoadError } from '../plugin/loader.js';
import {
  pluginDoctorChecks,
  pluginLoadFailureCheck,
} from './doctor-plugins.js';
import type { DoctorCheck } from './doctor-types.js';
import {
  providerBinChecksForConfig,
  runDispatcherProviderDiagnostics,
  type ProviderDiagnosticCatalogs,
  type ProviderDiagnosticReport,
} from '../provider-diagnostics.js';
import { pathExists } from '../platform/fs-errors.js';
import {
  dispatcherCronJobsPath,
  dispatcherTeamCronJobsPath,
  dispatcherTeamDir,
  stateRoot,
} from '../platform/paths.js';
import { diagnoseDispatcherWorkspace } from '../service/dispatcher-workspace.js';
import { detectLegacyCronJobStore } from '../service/scheduler/store.js';
import { readTeamRecords } from '../service/team/store.js';
import {
  defaultServiceNodeProbe,
  detectServiceNodeVersionManager,
  MIN_SERVICE_NODE_VERSION,
  nodeVersionSatisfies,
  type ServiceNodeProbe,
} from '../daemon/environment.js';
import { createServiceHost } from '../daemon/host.js';
import { getServiceStatus, type ServiceStatus } from '../daemon/status.js';
import type { CommandRunner } from '../platform/command-runner.js';

export interface DoctorOptions {
  env?: NodeJS.ProcessEnv;
  runner?: CommandRunner;
  platform?: NodeJS.Platform;
  homeDir?: string;
  uid?: number | undefined;
  nodeProbe?: ServiceNodeProbe;
  userName?: string;
}

export interface DispatcherDoctorReport {
  id: string;
  providers: ProviderDiagnosticReport[];
}

export interface DreamuxDoctorResult {
  ok: boolean;
  configFile: string;
  stateDir: string;
  service: ServiceStatus;
  checks: DoctorCheck[];
  dispatchers: DispatcherDoctorReport[];
}

type ProviderBinaryCheck = ProviderBinCheck;

export async function runDreamuxDoctor(
  options: DoctorOptions = {},
): Promise<DreamuxDoctorResult> {
  const host = createServiceHost(options);
  const checks: DoctorCheck[] = [];
  const { config, configFile, catalogs, plugins } =
    await readConfigForDoctor(checks);
  // Before the channel diagnostics below: api publication is where extensions
  // register into their channel provider.
  checks.push(...pluginDoctorChecks(plugins, createLogger({ name: 'doctor' })));

  checks.push({
    name: 'state directory',
    ok: await pathExists(stateRoot()),
    detail: stateRoot(),
  });
  const doctorEnv = options.env ?? process.env;
  for (const check of providerBinaryChecks(
    catalogs,
    config,
    doctorEnv,
    false,
  )) {
    checks.push({
      name: check.name,
      ok: await host.runner.check(check.bin, check.args, { env: doctorEnv }),
      detail: check.bin,
    });
  }
  for (const dispatcher of config.dispatchers) {
    if (dispatcher.enabled === false) {
      checks.push({
        name: `dispatcher ${dispatcher.id} workspace`,
        ok: true,
        detail: 'disabled; workspace cwd contract not enforced',
      });
    } else {
      const diagnosis = await diagnoseDispatcherWorkspace(
        config,
        dispatcher.id,
      );
      checks.push({
        name: `dispatcher ${dispatcher.id} workspace`,
        ok: diagnosis.ok,
        detail: diagnosis.detail,
      });
    }
    const cronLegacy = await detectLegacyCronJobStore(
      dispatcherCronJobsPath(dispatcher.id),
    );
    checks.push({
      name: `dispatcher ${dispatcher.id} cron jobs`,
      ok: cronLegacy === null,
      detail: cronLegacy ?? 'cron job store is current (v1) or absent',
    });
    const teams = await readTeamRecords({
      root: dispatcherTeamDir(dispatcher.id),
      dispatcherId: dispatcher.id,
    });
    for (const team of teams) {
      if (team.status === 'closed') continue;
      const teamCronLegacy = await detectLegacyCronJobStore(
        dispatcherTeamCronJobsPath(dispatcher.id, team.team_id),
      );
      checks.push({
        name: `dispatcher ${dispatcher.id} team ${team.team_id} cron jobs`,
        ok: teamCronLegacy === null,
        detail: teamCronLegacy ?? 'cron job store is current (v1) or absent',
      });
    }
  }

  const service = await getServiceStatus(host);
  checks.push({
    name: 'user service',
    ok: true,
    detail: service.installed
      ? `installed at ${service.unitPath}`
      : `not installed at ${service.unitPath}`,
  });
  if (service.platform === 'systemd' && service.installed) {
    checks.push(
      await systemdLingerCheck(
        host.runner,
        options.userName ?? userInfo().username,
      ),
    );
  }
  await addManagedServiceLaunchChecks(
    checks,
    service,
    host.runner,
    options.nodeProbe ?? defaultServiceNodeProbe,
    catalogs,
    config,
  );

  const dispatchers = await readDispatchers(
    catalogs,
    config,
    host.runner,
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
      dispatcher.providers.every((report) => report.result.ok),
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

async function readConfigForDoctor(checks: DoctorCheck[]): Promise<{
  config: DreamuxConfig;
  configFile: string;
  catalogs: ProviderDiagnosticCatalogs;
  plugins: LoadedPlugin[];
}> {
  try {
    const loaded = await loadConfig();
    checks.push({
      name: 'config',
      ok: true,
      detail: loaded.configFile,
    });
    return {
      config: loaded.config,
      configFile: loaded.configFile,
      catalogs: catalogsFromRegistry(loaded.providerRegistry),
      plugins: loaded.plugins,
    };
  } catch (err) {
    if (err instanceof PluginLoadError) {
      checks.push(
        {
          name: 'config',
          ok: false,
          detail: `not loaded: plugin "${err.plugin}" failed`,
        },
        pluginLoadFailureCheck(err),
      );
    } else {
      const detail = err instanceof Error ? err.message : String(err);
      checks.push({ name: 'config', ok: false, detail });
    }
    return {
      config: BUILT_IN_DEFAULTS,
      configFile: globalConfigFile(),
      catalogs: catalogsFromRegistry(new ProviderRegistry()),
      plugins: [],
    };
  }
}

function catalogsFromRegistry(
  registry: ProviderRegistry,
): ProviderDiagnosticCatalogs {
  return {
    agentRuntime: new AgentRuntimeProviderCatalog({ registry }),
    channel: new ChannelProviderCatalog({ registry }),
  };
}

async function readDispatchers(
  catalogs: ProviderDiagnosticCatalogs,
  config: DreamuxConfig,
  runner: CommandRunner,
  env: NodeJS.ProcessEnv,
  service: ServiceStatus,
): Promise<DispatcherDoctorReport[]> {
  return Promise.all(
    config.dispatchers.map(async (dispatcher) => {
      const foreground = await runDispatcherProviderDiagnostics({
        config,
        dispatcher,
        catalogs,
        runner,
        env,
        scope: 'foreground',
      });
      const managedService = service.installed
        ? await runDispatcherProviderDiagnostics({
            config,
            dispatcher,
            catalogs,
            runner,
            env: service.environment ?? {},
            scope: 'managedService',
          })
        : [];
      return {
        id: dispatcher.id,
        providers: [...foreground, ...managedService],
      };
    }),
  );
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
  catalogs: ProviderDiagnosticCatalogs,
  config: DreamuxConfig,
): Promise<void> {
  if (!service.installed) return;
  const env = service.environment;
  const missing: string[] = [];
  if (env === null) {
    missing.push('managed service environment');
  } else {
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
  for (const check of providerBinaryChecks(
    catalogs,
    config,
    serviceEnv,
    true,
  )) {
    checks.push(
      await checkHelpLaunch(
        check.name,
        check.bin,
        check.args,
        serviceEnv,
        runner,
        'provider binary is not set; check the provider config entry',
      ),
    );
  }
}

function providerBinaryChecks(
  catalogs: ProviderDiagnosticCatalogs,
  config: DreamuxConfig,
  env: NodeJS.ProcessEnv,
  managedService = false,
): ProviderBinaryCheck[] {
  return providerBinChecksForConfig({
    config,
    catalogs,
    env,
    scope: managedService ? 'managedService' : 'foreground',
  });
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
    detail: ok
      ? command
      : `${command} failed under installed service environment; rerun dreamux onboard`,
  };
}

function printDispatcherDoctor(dispatcher: DispatcherDoctorReport): void {
  for (const report of dispatcher.providers) {
    printProviderDoctor(dispatcher.id, report);
  }
}

function printProviderDoctor(
  dispatcherId: string,
  report: ProviderDiagnosticReport,
): void {
  const result = report.result;
  const name =
    `dispatcher ${dispatcherId} ${report.scope} ` +
    `${report.kind} ${report.id} (${report.provider})`;
  console.log(`${result.ok ? 'ok' : 'fail'}\t${name}\t${result.detail}`);
  for (const error of result.errors) {
    console.log(`fail\t${name}\t${error}`);
  }
}
