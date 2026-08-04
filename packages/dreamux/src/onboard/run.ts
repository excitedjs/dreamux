import { pathExists } from '../platform/fs-errors.js';
import { homedir } from 'node:os';
import type { ProviderBinCheck } from '@excitedjs/dreamux-types';
import {
  assertNoLegacyTomlOnly,
  configFileShape,
  createBuiltinProviderRegistry,
  globalConfigFile,
  loadConfigJsonWithSession,
  readConfigJson,
  stringifyConfig,
  type DreamuxConfig,
  type LoadConfigResult,
} from '../config/config.js';
import {
  dispatcherDir,
  logsRoot,
  probeStandardExecDirs,
  setRuntimeConfig,
  stateRoot,
  type ExecDirProbe,
} from '../platform/paths.js';
import { AgentRuntimeProviderCatalog } from '../agent-runtime/catalog.js';
import { ChannelProviderCatalog } from '../channel/catalog.js';
import {
  providerBinChecksForConfig,
  runDispatcherProviderDiagnostics,
  type ProviderDiagnosticCatalogs,
  type ProviderDiagnosticReport,
} from '../provider-diagnostics.js';
import { createOnboardProviderContext } from './wizard.js';
import {
  freshHostSnapshot,
  hostAgentRefs,
  hostChannelRefs,
  validateHostConfig,
  type HostConfig,
} from '../config/host-config.js';
import { ExecaCommandRunner } from './commands.js';
import { dreamuxConfigFromAnswers } from './config-files.js';
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
  withUserLocalBinPath,
} from './service.js';
import type {
  CommandRunner,
  OnboardAnswers,
  OnboardDoctorResult,
  OnboardFileLedger,
  OnboardProviderContext,
  OnboardRunResult,
} from '../onboard/types.js';
type EffectiveOnboardAnswers = OnboardAnswers & {
  nodeBin: string;
  providerBinChecks: ProviderBinCheck[];
  fallbackDirs: string[];
};
export interface RunOnboardOptions {
  answers: OnboardAnswers;
  providerContext?: OnboardProviderContext;
  runner?: CommandRunner;
  ledger?: OnboardFileLedger;
  platform?: NodeJS.Platform;
  homeDir?: string;
  uid?: number;
  env?: NodeJS.ProcessEnv;
  nodeProbe?: ServiceNodeProbe;
  /** Optional Homebrew-directory presence probe (tests). */
  execDirProbe?: ExecDirProbe;
}
export async function runOnboard(
  options: RunOnboardOptions,
): Promise<OnboardRunResult> {
  const answers = options.answers;
  const ledger = options.ledger ?? new TransparentFileLedger();
  const runner = options.runner ?? new ExecaCommandRunner();
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const homeDir = options.homeDir ?? homedir();
  const configPath = globalConfigFile({ configDir: answers.configDir });
  const existingConfig = await readExistingDreamuxConfig(answers.configDir);
  const dreamuxConfig = dreamuxConfigFromAnswers(answers, existingConfig);
  const dreamuxConfigFileShape = configFileShape(dreamuxConfig);
  const providerContext =
    options.providerContext ??
    (await directRunProviderContext({
      raw: dreamuxConfigFileShape,
      file: configPath,
      configDir: answers.configDir,
      dryRun: answers.dryRun,
    }));
  const serviceNodeBin = answers.registerService && !answers.dryRun
    ? await selectServiceNodeBin({
        platform,
        currentNodeBin: process.execPath,
        runner,
        probe: options.nodeProbe,
      })
    : process.execPath;
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
  await ensureDirectory(
    dispatcherDir(answers.dispatcherId),
    ledger,
    'dispatcher state directory',
    { dryRun: answers.dryRun },
  );
  await ensureDirectory(
    answers.dispatcherCwd,
    ledger,
    'dispatcher cwd',
    { dryRun: answers.dryRun },
  );
  // Bundled Dreamux skills are no longer symlinked into the workspace
  // (`<cwd>/.codex/skills`) at onboard time (issue #209 slice 6). Core now
  // injects them at runtime by role via the create context's `skillSources`
  // capability, so onboarding creates no skill dir or symlinks. Pre-existing old
  // symlinks are outside Dreamux-owned state and are left untouched; operators
  // may delete them manually.
  let loaded: LoadConfigResult;
  if (answers.dryRun) {
    await providerContext.assertPluginsAvailable(
      dreamuxConfigFileShape,
      'dreamux onboard --dry-run cannot install npm provider plugins',
    );
  }
  loaded = {
    ...(await loadConfigJsonWithSession({
      raw: dreamuxConfigFileShape,
      file: configPath,
      overrides: {
        ...providerContext.overrides,
        configDir: answers.configDir,
        providerRegistryFactory: providerContext.registryFactory,
      },
      session: providerContext.session,
      commit: !answers.dryRun,
    })),
    configFile: configPath,
  };
  setRuntimeConfig(loaded.config);
  const catalogs = catalogsFromLoadedConfig(loaded);
  const fallbackDirs = answers.registerService
    ? await probeStandardExecDirs(
        { platform, homeDir, env },
        options.execDirProbe,
      )
    : [];
  const providerBinChecks =
    answers.registerService && !answers.dryRun
      ? await resolveProviderBinChecks(
          loaded.config,
          catalogs,
          env,
          fallbackDirs,
        )
      : [];
  // Persist the effective env/homeDir and captured fallback dirs (not the
  // optional raw option values) so managedServicePath renders the same PATH
  // used by provider resolution. In normal CLI use options.env is undefined, so
  // env falls back to process.env — that ambient PATH must be persisted into
  // the service unit.
  const effectiveAnswers = {
    ...answers,
    nodeBin: serviceNodeBin,
    providerBinChecks,
    homeDir,
    env,
    fallbackDirs,
  };
  const doctor = await runDispatcherDoctor(
    effectiveAnswers,
    loaded,
    catalogs,
    env,
    runner,
  );
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
        platform,
        homeDir,
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
    '- rerun dreamux onboard from the desired Node/runtime install, or pass explicit binary paths',
  ].join('\n');
}
async function readExistingDreamuxConfig(
  configDir: string,
): Promise<DreamuxConfig | undefined> {
  const configPath = globalConfigFile({ configDir });
  await assertNoLegacyTomlOnly({ configDir });
  if (!(await pathExists(configPath))) return undefined;
  const raw = await readConfigJson(configPath);
  const host = validateHostConfig(raw, configPath);
  return dreamuxConfigFromHost(freshHostSnapshot(host));
}
async function directRunProviderContext(input: {
  raw: unknown;
  file: string;
  configDir: string;
  dryRun: boolean;
}): Promise<OnboardProviderContext> {
  const host = validateHostConfig(input.raw, input.file);
  return await createOnboardProviderContext({
    agentRefs: hostAgentRefs(host),
    channelRefs: hostChannelRefs(host),
    registryFactory: createBuiltinProviderRegistry,
    overrides: { configDir: input.configDir },
    dryRun: input.dryRun,
  });
}
function dreamuxConfigFromHost(host: HostConfig): DreamuxConfig {
  const agents: DreamuxConfig['agents'] = {};
  for (const agent of host.agents) {
    agents[agent.id] = {
      provider: agent.provider,
      config: structuredClone(agent.rawConfig),
      rawConfig: structuredClone(agent.rawConfig),
    };
  }
  return {
    agents,
    dispatchers: host.dispatchers.map((dispatcher) => {
      const runtime = agents[dispatcher.agentRuntime]!;
      return {
        id: dispatcher.id,
        cwd: dispatcher.cwd,
        enabled: dispatcher.enabled,
        workspace: dispatcher.workspace,
        channels: dispatcher.channels.map((channel) => ({
          id: channel.id,
          provider: channel.provider,
          collaborationSpace: channel.collaborationSpace,
          config: structuredClone(channel.rawConfig),
          rawConfig: structuredClone(channel.rawConfig),
        })),
        agentRuntime: dispatcher.agentRuntime,
        runtime: {
          provider: runtime.provider,
          config: structuredClone(runtime.config),
          rawConfig: structuredClone(runtime.rawConfig ?? runtime.config),
        },
      };
    }),
  };
}
function catalogsFromLoadedConfig(
  loaded: LoadConfigResult,
): ProviderDiagnosticCatalogs {
  return {
    agentRuntime: new AgentRuntimeProviderCatalog({
      registry: loaded.providerRegistry,
    }),
    channel: new ChannelProviderCatalog({
      registry: loaded.providerRegistry,
    }),
  };
}
async function resolveProviderBinChecks(
  config: DreamuxConfig,
  catalogs: ProviderDiagnosticCatalogs,
  env: NodeJS.ProcessEnv,
  fallbackDirs: string[],
): Promise<ProviderBinCheck[]> {
  const checks = providerBinChecksForConfig({
    config,
    catalogs,
    env,
    scope: 'managedService',
  });
  // Bare provider binaries (e.g. a `local-agent` installed to
  // $HOME/.local/bin) resolve against the effective service PATH, which the
  // service unit also includes. Resolve against that augmented PATH so the
  // daemon-install preflight and the running service agree. process.env is
  // never mutated; platform/homeDir/env are passed explicitly by the caller.
  const resolveEnv = withUserLocalBinPath(env, fallbackDirs);
  return await Promise.all(
    checks.map(async (check) => ({
      ...check,
      bin: await resolveServiceExecutable(check.bin, resolveEnv),
    })),
  );
}
async function runDispatcherDoctor(
  answers: EffectiveOnboardAnswers,
  loaded: LoadConfigResult,
  catalogs: ProviderDiagnosticCatalogs,
  env: NodeJS.ProcessEnv,
  runner: CommandRunner,
): Promise<OnboardDoctorResult> {
  if (answers.dryRun) {
    return {
      ok: true,
      errors: [],
      detail: 'dry run',
      reports: [],
    };
  }
  const dispatcher = loaded.config.dispatchers.find(
    (entry) => entry.id === answers.dispatcherId,
  );
  if (dispatcher === undefined) {
    return {
      ok: false,
      detail: answers.dispatcherId,
      errors: [`onboarded dispatcher '${answers.dispatcherId}' was not found in config`],
      reports: [],
    };
  }
  const doctorEnv = answers.registerService
    ? managedServiceEnvironment(answers)
    : env;
  const reports = await runDispatcherProviderDiagnostics(
    {
      dispatcher,
      catalogs,
      runner,
      env: doctorEnv,
      scope: answers.registerService ? 'managedService' : 'foreground',
    },
  );
  const errors = providerDiagnosticErrors(reports);
  return {
    ok: errors.length === 0,
    detail: `${reports.length} provider diagnostic(s)`,
    errors,
    reports,
  };
}
function providerDiagnosticErrors(reports: ProviderDiagnosticReport[]): string[] {
  return reports.flatMap((report) => {
    const prefix = `${report.kind} ${report.id} (${report.provider})`;
    if (report.result.errors.length > 0) {
      return report.result.errors.map((error) => `${prefix}: ${error}`);
    }
    return report.result.ok ? [] : [`${prefix}: ${report.result.detail}`];
  });
}
function formatDoctorFailure(
  answers: EffectiveOnboardAnswers,
  doctor: OnboardDoctorResult,
): string {
  const lines = [
    `dispatcher '${answers.dispatcherId}' providers are not ready`,
    ...doctor.errors.map((error) => `- ${error}`),
  ];
  if (
    answers.registerService &&
    doctor.errors.some((error) => /auth/i.test(error))
  ) {
    lines.push(
      '- managed service environments do not inherit your interactive shell auth token',
      '- authenticate the selected runtime before registering the service',
    );
  }
  return lines.join('\n');
}
