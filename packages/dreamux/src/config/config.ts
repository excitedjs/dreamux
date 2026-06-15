import { pathExists } from '../platform/fs-errors.js';
/**
 * Global dreamux configuration loaded from `~/.dreamux/config.json`.
 *
 * Layout:
 *   ~/.dreamux/config.json  dreamux configuration and local channel secrets
 *
 * Format: JSON. dreamux does not write TOML files.
 */

import { homedir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { mkdir, open, readFile, stat } from 'node:fs/promises';
import {
  loadExternalAgentRuntimeProviders,
  type ExternalAgentRuntimeModuleImporter,
} from '../agent-runtime/external-provider.js';
import type { AgentRuntimeProvider } from '@excitedjs/dreamux-types';
import type { ChannelProvider } from '@excitedjs/dreamux-types';
import {
  InvalidProviderRefError,
  ReservedExternalProviderError,
  UnknownBuiltinProviderError,
  createBuiltinProviderRegistry,
  formatProviderRef,
  parseProviderRef,
  type ProviderDescriptor,
  type ProviderRegistry,
} from '../registry/index.js';
import {
  describeType,
  isPlainObject,
  readOptionalString,
  readProviderConfigObject,
  rejectUnknownKeys,
  requireNonEmptyString,
} from '@excitedjs/dreamux-utils';
import type { DispatcherCodexConfig } from '@excitedjs/agent-runtime-codex';
import type { DispatcherClaudeCodeConfig } from '@excitedjs/agent-runtime-claude-code';
import { validateDispatcherId } from '../state/dispatcher-id.js';

// Re-export the relocated builtin runtime config + provider-ref symbols so the
// non-builtin callers (doctor, daemon, dispatcher-service, onboard,
// feishu-channel, tests) keep their existing `config/config.js` import paths.
// The builtins themselves import these from `registry/` / their own
// `config.ts` directly, never via this re-export, so the cycle stays severed.
export {
  BUILTIN_CLAUDE_CODE_PROVIDER_REF,
  BUILTIN_CODEX_PROVIDER_REF,
  BUILTIN_FEISHU_PROVIDER_REF,
} from '../registry/index.js';
export {
  ALLOWED_APPROVAL_POLICIES,
  ALLOWED_SANDBOX_MODES,
  DEFAULT_APPROVAL_POLICY,
  DEFAULT_CODEX_BIN,
  DEFAULT_CODEX_TURN_TIMEOUT_MS,
  DEFAULT_INITIALIZE_TIMEOUT_MS,
  DEFAULT_SANDBOX_MODE,
  defaultDispatcherCodexConfig,
  dispatcherCodexConfig,
} from '@excitedjs/agent-runtime-codex';
export type { DispatcherCodexConfig } from '@excitedjs/agent-runtime-codex';
export {
  ALLOWED_CLAUDE_CODE_PERMISSION_MODES,
  DEFAULT_CLAUDE_CODE_BIN,
  DEFAULT_CLAUDE_CODE_TURN_TIMEOUT_MS,
  defaultDispatcherClaudeCodeConfig,
  dispatcherClaudeCodeConfig,
} from '@excitedjs/agent-runtime-claude-code';
export type { DispatcherClaudeCodeConfig } from '@excitedjs/agent-runtime-claude-code';

export interface DreamuxConfig {
  /**
   * Named agent runtime declarations. The sole config landing place for runtime
   * settings: a dispatcher (and a teammate) references one of these by id rather
   * than carrying its own inline `runtime` block. Keyed by `agents[].id`, the
   * config-internal alias (unique, not a path/IPC key). Each entry carries the
   * canonical provider ref plus the config already parsed by that provider's
   * `readConfig`. Empty when no agents are declared.
   */
  agents: Record<string, ResolvedAgentConfig>;
  /** Dispatcher declarations and local channel credentials. */
  dispatchers: DispatcherConfig[];
}

/**
 * An `agents[]` entry resolved at load: the canonical provider ref and the typed
 * config that provider's `readConfig` produced from the raw `config` block.
 */
export interface ResolvedAgentConfig {
  provider: string;
  config: DispatcherProviderConfig | DispatcherCodexConfig | DispatcherClaudeCodeConfig;
}

export interface DispatcherConfig {
  id: string;
  cwd: string | null;
  enabled: boolean;
  channels: DispatcherChannelConfig[];
  /**
   * The `agents[].id` this dispatcher references on disk. Kept so the in-memory
   * config round-trips back to the `dispatchers[].agentRuntime` file shape
   * (`stringifyConfig`). The resolved provider + config live in `runtime`.
   */
  agentRuntime: string;
  /**
   * The resolved runtime provider + config for this dispatcher, populated at load
   * by resolving `agentRuntime` against `DreamuxConfig.agents`. In-memory only —
   * the file no longer carries `dispatchers[].runtime`; downstream readers
   * (services, doctor) keep using this shape unchanged.
   */
  runtime: DispatcherRuntimeConfig;
}

export interface DispatcherChannelConfig {
  id: string;
  provider: string;
  /**
   * The raw provider-specific channel config, validated by the channel
   * provider's `readConfig` at load (issue #209 multi-channel). Kept raw and
   * opaque: core never interprets a channel provider's config fields — the
   * provider re-parses this block when core opens its session.
   */
  config: DispatcherProviderConfig;
  /**
   * The channel's neutral, provider-reported identity (the channel provider's
   * `getIdentity`), derived at config-load and in-memory only — never written
   * back to the config file. Core surfaces a dispatcher's primary-channel
   * identity (`channels[0].identity`) as `DispatcherRow.channel_identity` for
   * status display without naming any provider config field. Empty string when
   * the provider does not implement `getIdentity` (issue #209 de-leak).
   */
  identity?: string;
}

export interface DispatcherRuntimeConfig {
  provider: string;
  config: DispatcherProviderConfig | DispatcherCodexConfig | DispatcherClaudeCodeConfig;
}

export type DispatcherProviderConfig = Record<string, unknown>;

export const BUILT_IN_DEFAULTS: DreamuxConfig = {
  agents: {},
  dispatchers: [],
};

// Route the default through the in-memory -> file translator so first boot
// writes the on-disk shape (agents[] + dispatchers[].agentRuntime) that the
// parser accepts on the next boot — never the in-memory map shape.
export const DEFAULT_CONFIG_JSON = stringifyConfig(BUILT_IN_DEFAULTS);

export interface ConfigPathOverrides {
  /** Override the global config dir. Default: ~/.dreamux. */
  configDir?: string;
  /** Provider registry used to validate config provider refs. */
  providerRegistry?: ProviderRegistry;
  /** Test seam for external `npm:` agentRuntime provider loading. */
  externalAgentRuntimeModuleImporter?: ExternalAgentRuntimeModuleImporter;
}

export interface LoadConfigResult {
  config: DreamuxConfig;
  configFile: string;
  providerRegistry: ProviderRegistry;
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
): Promise<{
  config: DreamuxConfig;
  configFile: string;
  createdOnThisBoot: boolean;
  providerRegistry: ProviderRegistry;
}> {
  const file = globalConfigFile(overrides);
  const providerRegistry = providerRegistryFor(overrides);
  await assertNoLegacyTomlOnly(overrides);
  await mkdir(dirname(file), { recursive: true });

  const createdOnThisBoot = await atomicWriteIfAbsent(file, DEFAULT_CONFIG_JSON);
  const config = await readConfigFile(file, providerRegistry, overrides);
  return { config, configFile: file, createdOnThisBoot, providerRegistry };
}

export async function loadConfig(
  overrides: ConfigPathOverrides = {},
): Promise<LoadConfigResult> {
  const file = globalConfigFile(overrides);
  const providerRegistry = providerRegistryFor(overrides);
  await assertNoLegacyTomlOnly(overrides);
  return {
    config: await readConfigFile(file, providerRegistry, overrides),
    configFile: file,
    providerRegistry,
  };
}

/**
 * Serialize the in-memory {@link DreamuxConfig} to the on-disk file shape:
 * the `agents` map becomes a top-level `agents[]` array, and each dispatcher's
 * resolved `runtime` block is dropped in favor of the `agentRuntime` id
 * reference it was resolved from. The result round-trips through
 * {@link readConfigFile}.
 */
export function stringifyConfig(config: DreamuxConfig): string {
  const fileShape = {
    agents: Object.entries(config.agents).map(([id, agent]) => ({
      id,
      provider: agent.provider,
      config: agent.config,
    })),
    dispatchers: config.dispatchers.map((dispatcher) => ({
      id: dispatcher.id,
      cwd: dispatcher.cwd,
      enabled: dispatcher.enabled,
      // Emit only the on-disk channel fields; `identity` is derived at load
      // (in-memory only) and must not round-trip into the config file, where it
      // would be rejected as an unknown channel key on the next read.
      channels: dispatcher.channels.map((channel) => ({
        id: channel.id,
        provider: channel.provider,
        config: channel.config,
      })),
      agentRuntime: dispatcher.agentRuntime,
    })),
  };
  return `${JSON.stringify(fileShape, null, 2)}\n`;
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
  redactFeishuSecrets(parsed);
  return `${JSON.stringify(parsed, null, 2)}\n`;
}

async function readConfigFile(
  file: string,
  providerRegistry: ProviderRegistry,
  overrides: ConfigPathOverrides,
): Promise<DreamuxConfig> {
  if (!(await pathExists(file))) {
    throw new Error(
      `dreamux config is missing at ${file}.\n` +
        'Run `dreamux onboard` to create it before starting the server.',
    );
  }
  await assertConfigFileMode(file);
  const raw = await readFile(file, 'utf8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(
      `dreamux config parse error in ${file}: ${msg}\n` +
        `Fix the JSON syntax in ${file}, then restart. Run \`dreamux onboard\` if you need to recreate the config.`,
    );
  }
  // Each agent's config is parsed through its provider's `readConfig`, so the
  // provider implementations must already be registered in `providerRegistry`.
  // config does not register the builtins itself — that would invert the layering
  // (a schema/parse leaf reaching up into the runtime catalog and dragging the
  // whole builtin stack into its module-init, which is the cycle that crashed
  // #148). The caller composes: `cli/server.ts` hands in a factory-bearing
  // registry, and the leaf entry points (doctor/daemon/onboard) go through
  // `loadConfigWithBuiltins`. A builtin agent parsed against a registry with no
  // implementation fails loud in `readAgents`. External `npm:` providers still
  // load here because that is a config-file-driven, dynamic-import concern.
  await loadExternalAgentRuntimeProviders({
    registry: providerRegistry,
    refs: agentProviderRefs(parsed),
    importModule: overrides.externalAgentRuntimeModuleImporter,
  });
  return await mergeWithDefaults(parsed, file, providerRegistry);
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

function providerRegistryFor(overrides: ConfigPathOverrides): ProviderRegistry {
  return overrides.providerRegistry ?? createBuiltinProviderRegistry();
}

async function mergeWithDefaults(
  raw: unknown,
  file: string,
  providerRegistry: ProviderRegistry,
): Promise<DreamuxConfig> {
  if (!isPlainObject(raw)) {
    throw new Error(`dreamux config error in ${file}: top-level must be an object`);
  }
  rejectTopLevelCodex(raw, file);
  rejectUnknownKeys(raw, new Set(['agents', 'dispatchers']), file, '');

  const agents = await readAgents(raw['agents'], file, providerRegistry);
  return {
    agents,
    dispatchers: readDispatchers(raw['dispatchers'], file, agents, providerRegistry),
  };
}

/**
 * The top-level `codex` block was removed: runtime settings live in a named
 * `agents[]` entry (`agents[].config`), referenced by each dispatcher via
 * `dispatchers[].agentRuntime`. The binary path comes from
 * `CODEX_HOST_CODEX_BIN`.
 * A leftover top-level block is rejected loudly with migration guidance rather
 * than silently ignored, so an operator's intent is never dropped.
 */
function rejectTopLevelCodex(raw: Record<string, unknown>, file: string): void {
  if (!('codex' in raw)) return;
  throw new Error(
    `dreamux config error in ${file}: a top-level "codex" block is no longer ` +
      'supported. Declare a named agent under agents[] with provider ' +
      '"builtin:codex" and a config block (bin, approval_policy, sandbox_mode, ' +
      'extra_args, extra_env, initialize_timeout_ms), then reference it from each ' +
      'dispatcher via dispatchers[].agentRuntime. For a host-level binary ' +
      'override across all dispatchers, set the CODEX_HOST_CODEX_BIN ' +
      'environment variable.',
  );
}

/**
 * Parse the top-level `agents[]` array into a `id -> resolved agent` map. Each
 * entry's `config` block is parsed through its provider's `readConfig` (the
 * core no longer branches on runtime identity). #98 fail-loud: a non-array
 * `agents`, a non-object entry, a missing/empty `id`, a duplicate `id`, or a
 * provider that is registered but not runnable each throws with the file named.
 */
async function readAgents(
  rawAgents: unknown,
  file: string,
  providerRegistry: ProviderRegistry,
): Promise<Record<string, ResolvedAgentConfig>> {
  if (rawAgents === undefined) return {};
  if (!Array.isArray(rawAgents)) {
    throw new Error(
      `dreamux config error in ${file}: agents must be an array (got ${describeType(rawAgents)}).\n` +
        'Declare named runtimes as agents[] entries, each with an id, a provider ' +
        '(e.g. "builtin:codex"), and a config block.',
    );
  }
  const out: Record<string, ResolvedAgentConfig> = {};
  for (let index = 0; index < rawAgents.length; index++) {
    const raw = rawAgents[index];
    const prefix = `agents[${index}].`;
    if (!isPlainObject(raw)) {
      throw new Error(
        `dreamux config error in ${file}: agents[${index}] must be an object (got ${describeType(raw)})`,
      );
    }
    rejectUnknownKeys(raw, new Set(['id', 'provider', 'config']), file, prefix);
    const id = requireNonEmptyString(raw, 'id', file, prefix);
    if (Object.prototype.hasOwnProperty.call(out, id)) {
      throw new Error(
        `dreamux config error in ${file}: agents[${index}].id duplicates agent '${id}'`,
      );
    }
    const provider = resolveConfigProvider(
      requireNonEmptyString(raw, 'provider', file, prefix),
      'agentRuntime',
      file,
      prefix,
      providerRegistry,
    );
    const rawConfig = readProviderConfigObject(raw['config'], file, `${prefix}config`, {
      allowMissing: true,
    });
    const runtimeProvider = asAgentRuntimeProvider(
      providerRegistry.getImplementation(provider.descriptor.id),
    );
    if (runtimeProvider === null) {
      throw new Error(
        `dreamux config error in ${file}: ${prefix}provider='${provider.ref}' is registered but not runnable.\n` +
          'Builtin runtimes are wired by the caller: load config through ' +
          '`loadConfigWithBuiltins` (or pass a providerRegistry that already has the ' +
          'builtin implementations). External runtimes must load and register an ' +
          'agentRuntime provider before config validation.',
      );
    }
    // A provider's `readConfig` may be sync or async (parity with
    // `ChannelProvider.readConfig`); await covers both and preserves fail-loud —
    // a thrown or rejected parse aborts config load.
    // A provider parses its own config to a provider-specific shape, which core
    // holds opaquely (`DispatcherProviderConfig` = `Record<string, unknown>`);
    // the owning runtime re-narrows it via its typed accessor. `readConfig`
    // returns the neutral `unknown`, so the parsed value is stored as the opaque
    // member of the resolved-config union.
    const parsedConfig =
      ((await runtimeProvider.readConfig?.(rawConfig, {
        providerRef: provider.ref,
        agentId: id,
        file,
        prefix: `${prefix}config.`,
      })) as DispatcherProviderConfig | undefined) ?? rawConfig;
    out[id] = {
      provider: provider.ref,
      config: parsedConfig,
    };
  }
  return out;
}

function readDispatchers(
  rawDispatchers: unknown,
  file: string,
  agents: Record<string, ResolvedAgentConfig>,
  providerRegistry: ProviderRegistry,
): DispatcherConfig[] {
  if (rawDispatchers === undefined) return [];
  if (!Array.isArray(rawDispatchers)) {
    throw new Error(
      `dreamux config error in ${file}: dispatchers must be an array (got ${describeType(rawDispatchers)})`,
    );
  }
  const out: DispatcherConfig[] = [];
  const ids = new Set<string>();
  for (let index = 0; index < rawDispatchers.length; index++) {
    const raw = rawDispatchers[index];
    const prefix = `dispatchers[${index}].`;
    if (!isPlainObject(raw)) {
      throw new Error(
        `dreamux config error in ${file}: dispatchers[${index}] must be an object (got ${describeType(raw)})`,
      );
    }
    // #98 fail-loud: an inline runtime block is the old schema. Reject it
    // before rejectUnknownKeys so the operator gets migration guidance naming
    // the new agents[] + agentRuntime shape, not a bare unknown-key error.
    if ('runtime' in raw) {
      throw new Error(
        `dreamux config error in ${file}: ${prefix}runtime is no longer supported.\n` +
          'Runtime config moved to a named agents[] entry. Declare the runtime ' +
          'under top-level agents[] (id, provider, config) and reference it here ' +
          `with ${prefix}agentRuntime = "<agent id>", then rebuild ${file}.`,
      );
    }
    rejectUnknownKeys(
      raw,
      new Set(['id', 'cwd', 'enabled', 'channels', 'agentRuntime']),
      file,
      prefix,
    );
    const id = validateDispatcherId(
      requireNonEmptyString(raw, 'id', file, prefix),
      `${prefix}id`,
    );
    if (ids.has(id)) {
      throw new Error(
        `dreamux config error in ${file}: dispatchers[${index}].id duplicates dispatcher '${id}'`,
      );
    }
    ids.add(id);

    const channels = readDispatcherChannels(
      raw['channels'],
      file,
      prefix,
      id,
      providerRegistry,
    );

    const cwd = readOptionalString(raw, 'cwd', file, prefix);
    const agentRuntimeId = resolveAgentRuntime(raw, prefix, file, agents);
    out.push({
      id,
      cwd: cwd === null ? null : expandHome(cwd),
      enabled: readOptionalBoolean(raw, 'enabled', true, file, prefix),
      channels,
      agentRuntime: agentRuntimeId,
      runtime: {
        provider: agents[agentRuntimeId]!.provider,
        config: agents[agentRuntimeId]!.config,
      },
    });
  }
  return out;
}

/**
 * Resolve a dispatcher's `agentRuntime` id against the parsed agents map. #98
 * fail-loud: a missing `agentRuntime` and a dangling reference (no matching
 * `agents[].id`) each throw with the file named and the required shape.
 */
function resolveAgentRuntime(
  raw: Record<string, unknown>,
  prefix: string,
  file: string,
  agents: Record<string, ResolvedAgentConfig>,
): string {
  if (!('agentRuntime' in raw)) {
    throw new Error(
      `dreamux config error in ${file}: ${prefix}agentRuntime is required.\n` +
        'Declare a named runtime under top-level agents[] (id, provider, config) ' +
        `and set ${prefix}agentRuntime to that agent's id, then rebuild ${file}.`,
    );
  }
  const agentRuntimeId = requireNonEmptyString(raw, 'agentRuntime', file, prefix);
  if (!Object.prototype.hasOwnProperty.call(agents, agentRuntimeId)) {
    const known = Object.keys(agents);
    const knownHint =
      known.length > 0
        ? `Known agents: ${known.map((id) => `'${id}'`).join(', ')}.`
        : 'No agents[] are declared.';
    throw new Error(
      `dreamux config error in ${file}: ${prefix}agentRuntime='${agentRuntimeId}' ` +
        `does not match any agents[].id. ${knownHint}\n` +
        `Add an agents[] entry with id '${agentRuntimeId}' (or fix the reference), then rebuild ${file}.`,
    );
  }
  return agentRuntimeId;
}

/**
 * Parse `dispatchers[].channels[]` (issue #209 multi-channel config). The
 * envelope accepts one or more channels with unique dispatcher-local ids and at
 * most one channel per provider ref (Decision #4: a dispatcher may not declare
 * two channels backed by the same provider, e.g. two `builtin:feishu` channels).
 * Each channel's provider-specific config is validated by the selected channel
 * provider's own `readConfig`. Core no longer validates Feishu-specific channel
 * fields (app id/secret, unknown keys) — the channel provider owns them.
 */
function readDispatcherChannels(
  rawChannels: unknown,
  file: string,
  dispatcherPrefix: string,
  dispatcherId: string,
  providerRegistry: ProviderRegistry,
): DispatcherChannelConfig[] {
  const prefix = `${dispatcherPrefix}channels`;
  if (!Array.isArray(rawChannels)) {
    throw new Error(
      `dreamux config error in ${file}: ${prefix} must be an array (got ${describeType(rawChannels)}).\n` +
        'Use providerized config v2: dispatchers[].channels[] with provider "builtin:feishu".',
    );
  }
  if (rawChannels.length === 0) {
    throw new Error(
      `dreamux config error in ${file}: ${prefix} must contain at least one channel.`,
    );
  }
  const out: DispatcherChannelConfig[] = [];
  const channelIds = new Set<string>();
  const providerRefs = new Set<string>();
  for (let index = 0; index < rawChannels.length; index++) {
    const raw = rawChannels[index];
    const channelPrefix = `${prefix}[${index}].`;
    if (!isPlainObject(raw)) {
      throw new Error(
        `dreamux config error in ${file}: ${channelPrefix.slice(0, -1)} must be an object (got ${describeType(raw)})`,
      );
    }
    rejectUnknownKeys(raw, new Set(['id', 'provider', 'config']), file, channelPrefix);
    const id = requireNonEmptyString(raw, 'id', file, channelPrefix);
    if (channelIds.has(id)) {
      throw new Error(
        `dreamux config error in ${file}: ${channelPrefix}id='${id}' duplicates another channel in this dispatcher; channel ids must be unique per dispatcher.`,
      );
    }
    channelIds.add(id);
    const provider = resolveConfigProvider(
      requireNonEmptyString(raw, 'provider', file, channelPrefix),
      'channel',
      file,
      channelPrefix,
      providerRegistry,
    );
    if (providerRefs.has(provider.ref)) {
      throw new Error(
        `dreamux config error in ${file}: ${channelPrefix}provider='${provider.ref}' duplicates another channel in this dispatcher; each provider may appear at most once per dispatcher.`,
      );
    }
    providerRefs.add(provider.ref);
    const rawConfig = readProviderConfigObject(
      raw['config'],
      file,
      `${channelPrefix}config`,
      { allowMissing: true },
    );
    const channelProvider = asChannelProvider(
      providerRegistry.getImplementation(provider.descriptor.id),
    );
    if (channelProvider === null) {
      throw new Error(
        `dreamux config error in ${file}: ${channelPrefix}provider='${provider.ref}' is registered but has no channel implementation.\n` +
          'Builtin channels are wired by the caller: load config through ' +
          '`loadConfigWithBuiltins` (or pass a providerRegistry that already has ' +
          'the builtin implementations). External channels must load and register ' +
          'a channel provider before config validation.',
      );
    }
    // Provider-owned validation, fail-loud at config-load. The parsed result is
    // consumed below to derive the neutral channel `identity` (via `getIdentity`);
    // the live session re-parses the raw config when core opens it. A channel
    // provider whose `readConfig` is async is not supported at config-load time
    // in this phase.
    const parsed = channelProvider.readConfig?.(rawConfig, {
      dispatcher_id: dispatcherId,
      channel_id: id,
      provider: provider.ref,
    });
    if (parsed !== undefined && typeof (parsed as { then?: unknown }).then === 'function') {
      throw new Error(
        `dreamux config error in ${file}: ${channelPrefix}provider='${provider.ref}' readConfig returned a Promise; channel config validation must be synchronous in this phase.`,
      );
    }
    // Neutral, provider-reported identity for status display (issue #209
    // de-leak): the dispatcher's bot identity comes from the channel provider's
    // own `getIdentity`, so core never names a provider config field. Fail-soft —
    // an unrunnable shape fails loud at the dispatcher launch guard, not here.
    let identity = '';
    try {
      identity = channelProvider.getIdentity?.(parsed) ?? '';
    } catch {
      identity = '';
    }
    out.push({ id, provider: provider.ref, config: rawConfig, identity });
  }
  return out;
}

function resolveConfigProvider(
  rawProvider: string,
  expectedKind: ProviderDescriptor['kind'],
  file: string,
  prefix: string,
  providerRegistry: ProviderRegistry,
): { ref: string; descriptor: ProviderDescriptor } {
  try {
    const descriptor = providerRegistry.resolve(rawProvider);
    if (descriptor.kind !== expectedKind) {
      throw new Error(
        `dreamux config error in ${file}: ${prefix}provider='${rawProvider}' is a ${descriptor.kind} provider, expected ${expectedKind}`,
      );
    }
    return { ref: formatProviderRef(descriptor.ref), descriptor };
  } catch (err) {
    if (err instanceof InvalidProviderRefError) {
      throw new Error(
        `dreamux config error in ${file}: ${prefix}provider is invalid: ${err.message}`,
      );
    }
    if (err instanceof ReservedExternalProviderError) {
      throw new Error(
        `dreamux config error in ${file}: ${prefix}provider='${rawProvider}' was not loaded as an external ${expectedKind} provider.\n` +
          err.message,
      );
    }
    if (err instanceof UnknownBuiltinProviderError) {
      throw new Error(
        `dreamux config error in ${file}: ${prefix}provider references unknown builtin provider '${err.id}'`,
      );
    }
    throw err;
  }
}

function agentProviderRefs(raw: unknown): string[] {
  if (!isPlainObject(raw)) return [];
  const agents = raw['agents'];
  if (!Array.isArray(agents)) return [];
  const out: string[] = [];
  for (const agent of agents) {
    if (!isPlainObject(agent)) continue;
    const provider = agent['provider'];
    if (typeof provider !== 'string') continue;
    try {
      const parsed = parseProviderRef(provider);
      if (parsed.source === 'npm') out.push(parsed.raw);
    } catch {
      // The normal config validation path reports malformed refs with context.
    }
  }
  return out;
}

function asAgentRuntimeProvider(value: unknown): AgentRuntimeProvider | null {
  if (typeof value !== 'object' || value === null) return null;
  const candidate = value as Partial<AgentRuntimeProvider>;
  if (
    typeof candidate.ref !== 'string' ||
    candidate.descriptor === undefined ||
    typeof candidate.getCapabilities !== 'function' ||
    typeof candidate.createRuntime !== 'function'
  ) {
    return null;
  }
  return value as AgentRuntimeProvider;
}

function asChannelProvider(value: unknown): ChannelProvider | null {
  if (typeof value !== 'object' || value === null) return null;
  const candidate = value as Partial<ChannelProvider>;
  if (
    typeof candidate.ref !== 'string' ||
    candidate.descriptor === undefined ||
    typeof candidate.createSession !== 'function'
  ) {
    return null;
  }
  return value as ChannelProvider;
}

function readOptionalBoolean(
  obj: Record<string, unknown>,
  key: string,
  fallback: boolean,
  file: string,
  prefix = '',
): boolean {
  const v = obj[key];
  if (v === undefined) return fallback;
  if (typeof v === 'boolean') return v;
  throw new Error(
    `dreamux config error in ${file}: ${prefix}${key} must be a boolean (got ${describeType(v)})`,
  );
}

function redactFeishuSecrets(value: unknown): void {
  if (Array.isArray(value)) {
    for (const item of value) redactFeishuSecrets(item);
    return;
  }
  if (!isPlainObject(value)) return;
  for (const [key, child] of Object.entries(value)) {
    if (key === 'app_secret' && typeof child === 'string') {
      value[key] = '<redacted>';
      continue;
    }
    redactFeishuSecrets(child);
  }
}

export function expandHome(path: string): string {
  if (path === '~') return homedir();
  if (path.startsWith('~/')) return join(homedir(), path.slice(2));
  if (!isAbsolute(path)) return path;
  return path;
}
