import { pathExists } from '../platform/fs-errors.js';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { mkdir, open, readFile, stat } from 'node:fs/promises';
import {
  ExternalAgentRuntimeProviderContractError,
  ExternalAgentRuntimeProviderLoadError,
  type ExternalAgentRuntimeModuleImporter,
} from '../agent-runtime/external-provider.js';
import {
  ExternalChannelProviderContractError,
  ExternalChannelProviderLoadError,
  type ExternalChannelModuleImporter,
} from '../channel/external-channel-provider.js';
import {
  createBuiltinProviderRegistry,
  parseProviderRef,
  type ProviderRegistry,
} from '../registry/index.js';
import { errMessage } from '../registry/provider-loader.js';
import {
  expandHome,
  redactConfigSecrets,
} from './config-helpers.js';
import {
  defaultChannelCollaborationSpaceConfig,
  stringifyChannelCollaborationSpace,
  type DispatcherChannelCollaborationSpaceConfig,
} from './collaboration-space-config.js';
import {
  loadProviderPluginsForConfig,
  createProviderPluginSession,
  rejectProviderPluginCandidatesAfterFailure,
} from './provider-plugin-loading.js';
import {
  hostAgentRefs,
  hostChannelRefs,
  validateHostConfig,
  type HostAgentConfig,
  type HostConfig,
  type HostDispatcherConfig,
} from './host-config.js';
import {
  ProviderReadConfigError,
  readHostAgentConfig,
  readHostChannelConfig,
} from './provider-readers.js';
import type {
  ProviderPluginAccess,
  ProviderPluginLoadSession,
} from '../registry/provider-plugin-store.js';
export { expandHome } from './config-helpers.js';
export { createBuiltinProviderRegistry } from '../registry/index.js';
export {
  defaultChannelCollaborationSpaceConfig,
  type DispatcherChannelCollaborationSpaceConfig,
} from './collaboration-space-config.js';
export interface DreamuxConfig {
  agents: Record<string, ResolvedAgentConfig>;
  dispatchers: DispatcherConfig[];
}
export interface DreamuxWorkspaceConfig {
  enabled: boolean;
}
export interface ResolvedAgentConfig {
  provider: string;
  config: DispatcherProviderConfig;
  rawConfig?: DispatcherProviderConfig;
}
export interface DispatcherConfig {
  id: string;
  cwd: string | null;
  enabled: boolean;
  workspace: DreamuxWorkspaceConfig;
  channels: DispatcherChannelConfig[];
  agentRuntime: string;
  runtime: DispatcherRuntimeConfig;
}
export interface DispatcherChannelConfig {
  id: string;
  provider: string;
  collaborationSpace?: DispatcherChannelCollaborationSpaceConfig;
  config: DispatcherProviderConfig;
  rawConfig?: DispatcherProviderConfig;
  identity?: string;
}
export interface DispatcherRuntimeConfig {
  provider: string;
  config: DispatcherProviderConfig;
  rawConfig?: DispatcherProviderConfig;
}
export type DispatcherProviderConfig = Record<string, unknown>;
export const BUILT_IN_DEFAULTS: DreamuxConfig = {
  agents: {},
  dispatchers: [],
};
export const DEFAULT_CONFIG_JSON = stringifyConfig(BUILT_IN_DEFAULTS);
export interface ConfigPathOverrides {
  configDir?: string;
  providerRegistryFactory?: ProviderRegistryFactory;
  externalAgentRuntimeModuleImporter?: ExternalAgentRuntimeModuleImporter;
  externalChannelModuleImporter?: ExternalChannelModuleImporter;
  providerPluginStore?: ProviderPluginAccess;
}
export type ProviderRegistryFactory = () => ProviderRegistry;
export interface LoadConfigResult {
  config: DreamuxConfig;
  configFile: string;
  providerRegistry: ProviderRegistry;
  providerPluginPackages: string[];
  providerPluginWarnings: string[];
}
export function globalConfigDir(overrides: ConfigPathOverrides = {}): string {
  if (overrides.configDir !== undefined) return overrides.configDir;
  return process.env['DREAMUX_CONFIG_DIR'] || join(homedir(), '.dreamux');
}
export function globalConfigFile(overrides: ConfigPathOverrides = {}): string {
  return join(globalConfigDir(overrides), 'config.json');
}
export function legacyGlobalConfigFile(
  overrides: ConfigPathOverrides = {},
): string {
  return join(globalConfigDir(overrides), 'config.toml');
}
export async function loadOrInitConfig(
  overrides: ConfigPathOverrides = {},
): Promise<LoadConfigResult & { createdOnThisBoot: boolean }> {
  const file = globalConfigFile(overrides);
  await assertNoLegacyTomlOnly(overrides);
  await mkdir(dirname(file), { recursive: true });
  const createdOnThisBoot = await atomicWriteIfAbsent(file, DEFAULT_CONFIG_JSON);
  return {
    ...(await readConfigFileResult(file, overrides, materializingStrict())),
    createdOnThisBoot,
  };
}
export async function loadConfig(
  overrides: ConfigPathOverrides = {},
): Promise<LoadConfigResult> {
  const file = globalConfigFile(overrides);
  await assertNoLegacyTomlOnly(overrides);
  return await readConfigFileResult(file, overrides, materializingStrict());
}
export async function loadConfigInstalledOnly(
  overrides: ConfigPathOverrides = {},
): Promise<LoadConfigResult> {
  const file = globalConfigFile(overrides);
  await assertNoLegacyTomlOnly(overrides);
  return await readConfigFileResult(file, overrides, {
    operation: 'installed-only-strict',
    allowSelectedFallback: false,
    commit: false,
  });
}
export async function loadConfigJsonWithSession(input: {
  raw: unknown;
  file: string;
  overrides?: ConfigPathOverrides;
  session: ProviderPluginLoadSession | null;
  commit: boolean;
}): Promise<Omit<LoadConfigResult, 'configFile'>> {
  const overrides = input.overrides ?? {};
  const host = validateHostConfig(input.raw, input.file);
  const attempt = await strictConfigAttempt({
    parsed: input.raw,
    file: input.file,
    host,
    overrides,
    session: input.session,
  });
  if (attempt.ok === false) {
    await rejectProviderPluginCandidatesAfterFailure(input.session, attempt.error);
    throw attempt.error;
  }
  if (input.commit) await attempt.result.session?.commit();
  return {
    config: attempt.result.config,
    providerRegistry: attempt.result.providerRegistry,
    providerPluginPackages: attempt.result.providerPluginPackages,
    providerPluginWarnings: attempt.result.providerPluginWarnings,
  };
}
export function stringifyConfig(config: DreamuxConfig): string {
  return `${JSON.stringify(configFileShape(config), null, 2)}\n`;
}
export function configFileShape(config: DreamuxConfig): Record<string, unknown> {
  return {
    agents: Object.entries(config.agents).map(([id, agent]) => ({
      id,
      provider: agent.provider,
      config: agent.rawConfig ?? agent.config,
    })),
    dispatchers: config.dispatchers.map((dispatcher) => ({
      id: dispatcher.id,
      cwd: dispatcher.cwd,
      enabled: dispatcher.enabled,
      workspace: {
        enabled: dispatcher.workspace.enabled,
      },
      channels: dispatcher.channels.map((channel) => ({
        id: channel.id,
        provider: channel.provider,
        ...((channel.collaborationSpace ?? defaultChannelCollaborationSpaceConfig())
          .defaultBinding.enabled
          ? {
              collaborationSpace: stringifyChannelCollaborationSpace(
                channel.collaborationSpace ?? defaultChannelCollaborationSpaceConfig(),
              ),
            }
          : {}),
        config: channel.rawConfig ?? channel.config,
      })),
      agentRuntime: dispatcher.agentRuntime,
    })),
  };
}
export function redactConfigForDisplay(raw: string, file: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(
      `dreamux config parse error in ${file}: ${msg}\n` +
        'Fix the JSON syntax before running `dreamux config show`.',
    );
  }
  redactConfigSecrets(parsed);
  return `${JSON.stringify(parsed, null, 2)}\n`;
}
async function readConfigFile(
  file: string,
  overrides: ConfigPathOverrides,
  options: StrictConfigLoadOptions,
): Promise<{
  config: DreamuxConfig;
  providerRegistry: ProviderRegistry;
  providerPluginPackages: string[];
  providerPluginWarnings: string[];
}> {
  if (!(await pathExists(file))) {
    throw new Error(
      `dreamux config is missing at ${file}.\n` +
        'Run `dreamux onboard` to create it before starting the server.',
    );
  }
  const parsed = await readConfigJson(file);
  return await readConfigValue(parsed, file, overrides, options);
}
async function readConfigFileResult(
  file: string,
  overrides: ConfigPathOverrides,
  options: StrictConfigLoadOptions,
): Promise<LoadConfigResult> {
  return { ...(await readConfigFile(file, overrides, options)), configFile: file };
}
async function readConfigValue(
  parsed: unknown,
  file: string,
  overrides: ConfigPathOverrides,
  options: StrictConfigLoadOptions,
): Promise<{
  config: DreamuxConfig;
  providerRegistry: ProviderRegistry;
  providerPluginPackages: string[];
  providerPluginWarnings: string[];
}> {
  const host = validateHostConfig(parsed, file);
  const session = await createProviderPluginSession({
    agentRefs: hostAgentRefs(host),
    channelRefs: hostChannelRefs(host),
    overrides,
    operation: options.operation,
  });
  const attempt = await strictConfigAttempt({
    parsed,
    file,
    host,
    overrides,
    session,
  });
  if (
    attempt.ok === false &&
    options.allowSelectedFallback &&
    isCandidateBackedProviderFailure(attempt.error, session)
  ) {
    await rejectProviderPluginCandidatesAfterFailure(session, attempt.error);
    if (await session.canUseSelectedOnly()) {
      const retrySession = session.selectedOnly();
      const retry = await strictConfigAttempt({
        parsed,
        file,
        host,
        overrides,
        session: retrySession,
      });
      if (retry.ok) {
        return {
          ...retry.result,
          providerPluginWarnings: [
            `rejected provider plugin candidate generation(s) for ${session.candidatePackages.join(', ')}: ${errMessage(attempt.error)}`,
          ],
        };
      }
      throw new AggregateError(
        [attempt.error, retry.error],
        `provider plugin candidate load failed, and selected-only fallback also failed: ${errMessage(attempt.error)}; fallback: ${errMessage(retry.error)}`,
      );
    }
    throw attempt.error;
  }
  if (attempt.ok === false) throw attempt.error;
  if (options.commit) await attempt.result.session?.commit();
  return {
    ...attempt.result,
    providerPluginWarnings: [],
  };
}
export async function readConfigJson(file: string): Promise<unknown> {
  await assertConfigFileMode(file);
  const raw = await readFile(file, 'utf8');
  try {
    return JSON.parse(raw) as unknown;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(
      `dreamux config parse error in ${file}: ${msg}\n` +
        `Fix the JSON syntax in ${file}, then restart. Run \`dreamux onboard\` if you need to recreate the config.`,
    );
  }
}
export async function assertNoLegacyTomlOnly(
  overrides: ConfigPathOverrides = {},
): Promise<void> {
  const jsonFile = globalConfigFile(overrides);
  const tomlFile = legacyGlobalConfigFile(overrides);
  if ((await pathExists(jsonFile)) || !(await pathExists(tomlFile))) return;
  throw new Error(
    `legacy dreamux config detected at ${tomlFile}, but ${jsonFile} does not exist.\n` +
      'dreamux 0.x does not migrate TOML config; it will not read it or write default ' +
      'JSON over an existing install.\n' +
      `Recreate the config as JSON (run \`dreamux onboard\`, or write ${jsonFile} with a ` +
      `dispatchers array), then move ${tomlFile} aside.`,
  );
}
async function atomicWriteIfAbsent(
  file: string,
  content: string,
): Promise<boolean> {
  let handle;
  try {
    handle = await open(file, 'wx', 0o600);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw err;
  }
  try {
    await handle.writeFile(content);
  } finally {
    await handle.close();
  }
  return true;
}
export async function assertConfigFileMode(file: string): Promise<void> {
  if (process.platform === 'win32') return;
  const mode = (await stat(file)).mode & 0o777;
  if (mode === 0o600) return;
  throw new Error(
    `dreamux config file must be mode 0600: ${file} has mode 0${mode.toString(8)}`,
  );
}
interface StrictConfigLoadOptions {
  operation: 'materializing-strict' | 'installed-only-strict';
  allowSelectedFallback: boolean;
  commit: boolean;
}
function materializingStrict(): StrictConfigLoadOptions {
  return {
    operation: 'materializing-strict',
    allowSelectedFallback: true,
    commit: true,
  };
}
type StrictConfigAttempt =
  | {
      ok: true;
      result: {
        config: DreamuxConfig;
        providerRegistry: ProviderRegistry;
        providerPluginPackages: string[];
        providerPluginWarnings: string[];
        session: ProviderPluginLoadSession | null;
      };
    }
  | { ok: false; error: unknown };
async function strictConfigAttempt(input: {
  parsed: unknown;
  file: string;
  host: HostConfig;
  overrides: ConfigPathOverrides;
  session: ProviderPluginLoadSession | null;
}): Promise<StrictConfigAttempt> {
  const providerRegistry = providerRegistryFor(input.overrides);
  try {
    const providerPlugins = await loadProviderPluginsForConfig({
      agentRefs: hostAgentRefs(input.host),
      channelRefs: hostChannelRefs(input.host),
      providerRegistry,
      overrides: input.overrides,
      session: input.session,
    });
    return {
      ok: true,
      result: {
        config: await mergeWithDefaults(
          structuredClone(input.host) as HostConfig,
          input.file,
          providerRegistry,
        ),
        providerRegistry,
        providerPluginPackages: providerPlugins.packages,
        providerPluginWarnings: [],
        session: providerPlugins.session,
      },
    };
  } catch (err) {
    return { ok: false, error: err };
  }
}
function providerRegistryFor(overrides: ConfigPathOverrides): ProviderRegistry {
  return (overrides.providerRegistryFactory ?? createBuiltinProviderRegistry)();
}
async function mergeWithDefaults(
  host: HostConfig,
  file: string,
  providerRegistry: ProviderRegistry,
): Promise<DreamuxConfig> {
  const agents = await readAgents(host.agents, file, providerRegistry);
  const dispatchers = await readDispatchers(host.dispatchers, file, agents, providerRegistry);
  return {
    agents,
    dispatchers,
  };
}
export function defaultWorkspaceEnabled(
  config: DreamuxConfig,
  dispatcherId: string,
): boolean {
  return (
    config.dispatchers.find((dispatcher) => dispatcher.id === dispatcherId)?.workspace
      .enabled ?? true
  );
}
async function readAgents(
  rawAgents: HostAgentConfig[],
  file: string,
  providerRegistry: ProviderRegistry,
): Promise<Record<string, ResolvedAgentConfig>> {
  const out: Record<string, ResolvedAgentConfig> = {};
  for (const [index, raw] of rawAgents.entries()) {
    out[raw.id] = await readHostAgentConfig(
      raw,
      file,
      providerRegistry,
      `agents[${index}].`,
    );
  }
  return out;
}
async function readDispatchers(
  rawDispatchers: HostDispatcherConfig[],
  file: string,
  agents: Record<string, ResolvedAgentConfig>,
  providerRegistry: ProviderRegistry,
): Promise<DispatcherConfig[]> {
  const out: DispatcherConfig[] = [];
  for (const [index, raw] of rawDispatchers.entries()) {
    const prefix = `dispatchers[${index}].`;
    const channels = await Promise.all(
      raw.channels.map((channel, channelIndex) =>
        readHostChannelConfig(channel, file, providerRegistry, {
          dispatcherId: raw.id,
          dispatcherPrefix: prefix,
          channelIndex,
        }),
      ),
    );
    const agent = agents[raw.agentRuntime]!;
    out.push({
      id: raw.id,
      cwd: raw.cwd === null ? null : expandHome(raw.cwd),
      enabled: raw.enabled,
      workspace: raw.workspace,
      channels,
      agentRuntime: raw.agentRuntime,
      runtime: {
        provider: agent.provider,
        config: agent.config,
        ...(agent.rawConfig === undefined ? {} : { rawConfig: agent.rawConfig }),
      },
    });
  }
  return out;
}
function isCandidateBackedProviderFailure(
  error: unknown,
  session: ProviderPluginLoadSession | null,
): session is ProviderPluginLoadSession {
  if (session === null) return false;
  const failure = providerFailure(error);
  if (failure === null) return false;
  const parsed = parseProviderRef(failure.providerRef);
  return parsed.source === 'npm' &&
    session.candidatePackages.includes(parsed.package);
}

function providerFailure(error: unknown): { providerRef: string } | null {
  if (
    error instanceof ExternalAgentRuntimeProviderLoadError ||
    error instanceof ExternalChannelProviderLoadError
  ) {
    return { providerRef: error.providerRef };
  }
  if (
    error instanceof ExternalAgentRuntimeProviderContractError ||
    error instanceof ExternalChannelProviderContractError
  ) {
    return { providerRef: error.providerRef };
  }
  if (error instanceof ProviderReadConfigError) {
    return { providerRef: error.providerRef };
  }
  return null;
}
