import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

import {
  cancel,
  confirm,
  intro,
  isCancel,
  outro,
  password,
  text,
} from '@clack/prompts';
import type {
  AgentRuntimeProvider,
  ChannelProvider,
  ProviderKind,
  ProviderOnboardContext,
  ProviderOnboardConfirmPrompt,
  ProviderOnboardPromptHost,
  ProviderOnboardSecretPrompt,
  ProviderOnboardTextPrompt,
} from '@excitedjs/dreamux-types';

import { AgentRuntimeProviderCatalog } from '../agent-runtime/catalog.js';
import { loadAgentRuntimeProviders } from '../agent-runtime/external-provider.js';
import { ChannelProviderCatalog } from '../channel/catalog.js';
import { loadChannelProviders } from '../channel/external-channel-provider.js';
import { expandHome } from '../config/config.js';
import { prepareProviderPlugins } from '../config/provider-plugin-loading.js';
import {
  BUILTIN_CODEX_PROVIDER_REF,
  BUILTIN_FEISHU_PROVIDER_REF,
  createBuiltinProviderRegistry,
  formatProviderRef,
  type ProviderRegistry,
} from '../registry/index.js';
import { validateDispatcherId } from '../state/dispatcher-id.js';
import type {
  OnboardAgentRuntimeConfig,
  OnboardAnswers,
  OnboardChannelConfig,
} from '../onboard/types.js';

export interface OnboardCliOptions {
  yes?: boolean;
  dryRun?: boolean;
  configDir?: string;
  dispatcherId?: string;
  dispatcherCwd?: string;
  agent?: string | string[];
  agentConfigJson?: string | string[];
  channel?: string | string[];
  channelConfigJson?: string | string[];
  registerService?: boolean;
  startService?: boolean;
  dreamuxBin?: string;
}

interface ProviderSelection {
  id: string;
  provider: string;
}

const DEFAULT_DISPATCHER_ID = 'dispatcher';
const DEFAULT_CHANNEL_ID = 'primary';

export async function collectOnboardAnswers(
  options: OnboardCliOptions,
): Promise<OnboardAnswers> {
  const interactive = process.stdin.isTTY === true && options.yes !== true;
  if (!interactive) return await answersFromOptions(options, false);

  intro('dreamux onboard');
  const configDir = await promptText(
    'dreamux config directory',
    defaultConfigDir(options),
  );
  const dispatcherId = validateDispatcherId(
    await promptText(
      'dispatcher id',
      options.dispatcherId ?? DEFAULT_DISPATCHER_ID,
    ),
  );
  const dispatcherCwd = await promptText(
    'dispatcher cwd',
    options.dispatcherCwd ?? process.cwd(),
  );
  const registry = createBuiltinProviderRegistry();
  const agentProvider = await promptProviderRef(
    registry,
    'agentRuntime',
    singleOption(options.agent, 'agent') ?? BUILTIN_CODEX_PROVIDER_REF,
  );
  const channelProvider = await promptProviderRef(
    registry,
    'channel',
    firstOption(options.channel) ?? BUILTIN_FEISHU_PROVIDER_REF,
  );
  const registerService = await promptConfirm(
    'register the user-level service now?',
    options.registerService ?? true,
  );
  const startService = registerService
    ? await promptConfirm(
        'start the service after registration?',
        options.startService ?? true,
      )
    : false;

  const answers = await answersFromOptions(
    {
      ...options,
      configDir,
      dispatcherId,
      dispatcherCwd,
      agent: agentProvider,
      channel: channelProvider,
      registerService,
      startService,
    },
    true,
  );
  outro('Collected onboarding inputs.');
  return answers;
}

export async function answersFromOptions(
  options: OnboardCliOptions,
  fromInteractive: boolean,
): Promise<OnboardAnswers> {
  const dispatcherId = validateDispatcherId(
    options.dispatcherId ?? DEFAULT_DISPATCHER_ID,
  );
  const dispatcherCwd = options.dispatcherCwd ?? process.cwd();
  const agentOption = singleOption(options.agent, 'agent');
  const agentSelection = parseProviderSelection(
    agentOption ?? BUILTIN_CODEX_PROVIDER_REF,
    dispatcherId,
    'agent',
  );
  const channelSelections = parseChannelSelections(options.channel);
  const registry = createBuiltinProviderRegistry();
  await loadSelectedProviders(registry, agentSelection, channelSelections);
  const agentCatalog = new AgentRuntimeProviderCatalog({ registry });
  const channelCatalog = new ChannelProviderCatalog({ registry });
  const promptHost = promptHostForMode(fromInteractive);

  const agentConfigJson = parseConfigJsonMap(
    options.agentConfigJson,
    agentSelection.id,
    'agent-config-json',
  );
  const channelConfigJson = parseConfigJsonMap(
    options.channelConfigJson,
    defaultChannelConfigId(channelSelections),
    'channel-config-json',
  );

  return {
    configDir: normalizePath(options.configDir ?? defaultConfigDir(options)),
    dispatcherId,
    dispatcherCwd: normalizePath(dispatcherCwd),
    agentRuntime: await onboardAgentRuntime(
      agentCatalog.resolve(agentSelection.provider),
      agentSelection,
      agentConfigJson.get(agentSelection.id),
      promptHost,
      fromInteractive,
    ),
    channels: await Promise.all(
      channelSelections.map((selection) =>
        onboardChannel(
          channelCatalog.resolve(selection.provider),
          selection,
          channelConfigJson.get(selection.id),
          promptHost,
          fromInteractive,
        ),
      ),
    ),
    registerService: options.registerService ?? true,
    startService: options.startService ?? true,
    dreamuxBin: normalizePath(
      options.dreamuxBin ?? process.env['DREAMUX_BIN'] ?? process.argv[1],
    ),
    dryRun: options.dryRun ?? false,
  };
}

function parseChannelSelections(
  input: string | string[] | undefined,
): ProviderSelection[] {
  const raw = optionValues(input);
  if (raw.length === 0) {
    return [{ id: DEFAULT_CHANNEL_ID, provider: BUILTIN_FEISHU_PROVIDER_REF }];
  }
  const out = raw.map((value, index) =>
    parseProviderSelection(
      value,
      index === 0 ? DEFAULT_CHANNEL_ID : `channel-${index + 1}`,
      'channel',
    ),
  );
  const ids = new Set<string>();
  const providers = new Set<string>();
  for (const entry of out) {
    if (ids.has(entry.id)) {
      throw new Error(`onboard channel id '${entry.id}' is declared more than once`);
    }
    ids.add(entry.id);
    if (providers.has(entry.provider)) {
      throw new Error(
        `onboard channel provider '${entry.provider}' is declared more than once`,
      );
    }
    providers.add(entry.provider);
  }
  return out;
}

function parseProviderSelection(
  raw: string,
  defaultId: string,
  optionName: string,
): ProviderSelection {
  const trimmed = raw.trim();
  if (trimmed === '') throw new Error(`--${optionName} must not be empty`);
  const eq = trimmed.indexOf('=');
  const id = eq >= 0 ? trimmed.slice(0, eq).trim() : defaultId;
  const provider = eq >= 0 ? trimmed.slice(eq + 1).trim() : trimmed;
  if (id === '') throw new Error(`--${optionName} id must not be empty`);
  if (provider === '') throw new Error(`--${optionName} provider must not be empty`);
  return { id, provider };
}

async function loadSelectedProviders(
  registry: ProviderRegistry,
  agent: ProviderSelection,
  channels: ProviderSelection[],
): Promise<void> {
  const agentRefs = [agent.provider];
  const channelRefs = channels.map((channel) => channel.provider);
  const pluginPlan = await prepareProviderPlugins({
    agentRefs,
    channelRefs,
    overrides: {},
  });
  await loadAgentRuntimeProviders({
    registry,
    refs: pluginPlan.agentRefsToLoad,
    importNpmModule: pluginPlan.agentImporter,
  });
  await loadChannelProviders({
    registry,
    refs: pluginPlan.channelRefsToLoad,
    importNpmModule: pluginPlan.channelImporter,
  });
}

async function onboardAgentRuntime(
  provider: AgentRuntimeProvider,
  selection: ProviderSelection,
  explicitConfig: Record<string, unknown> | undefined,
  prompts: ProviderOnboardPromptHost,
  interactive: boolean,
): Promise<OnboardAgentRuntimeConfig> {
  return {
    id: selection.id,
    provider: selection.provider,
    config: await collectProviderConfig(
      provider.onboard,
      {
        providerRef: selection.provider,
        providerId: provider.descriptor.id,
        env: process.env,
        interactive,
      },
      explicitConfig,
      prompts,
    ),
  };
}

async function onboardChannel(
  provider: ChannelProvider,
  selection: ProviderSelection,
  explicitConfig: Record<string, unknown> | undefined,
  prompts: ProviderOnboardPromptHost,
  interactive: boolean,
): Promise<OnboardChannelConfig> {
  return {
    id: selection.id,
    provider: selection.provider,
    config: await collectProviderConfig(
      provider.onboard,
      {
        providerRef: selection.provider,
        providerId: provider.descriptor.id,
        env: process.env,
        interactive,
      },
      explicitConfig,
      prompts,
    ),
  };
}

async function collectProviderConfig(
  onboard: AgentRuntimeProvider['onboard'] | ChannelProvider['onboard'],
  context: ProviderOnboardContext,
  explicitConfig: Record<string, unknown> | undefined,
  prompts: ProviderOnboardPromptHost,
): Promise<Record<string, unknown>> {
  if (explicitConfig !== undefined) return explicitConfig;
  if (onboard === undefined) return {};
  const config = await onboard.collect(context, prompts);
  if (!isRecord(config)) {
    throw new Error(
      `provider ${context.providerRef} onboard returned ${describeValue(config)}; expected an object config block`,
    );
  }
  return config;
}

function parseConfigJsonMap(
  input: string | string[] | undefined,
  defaultId: string,
  optionName: string,
): Map<string, Record<string, unknown>> {
  const out = new Map<string, Record<string, unknown>>();
  for (const raw of optionValues(input)) {
    const { id, json } = splitConfigJson(raw, defaultId, optionName);
    if (out.has(id)) {
      throw new Error(`--${optionName} for id '${id}' is declared more than once`);
    }
    const parsed = parseJsonObject(json, optionName);
    out.set(id, parsed);
  }
  return out;
}

function splitConfigJson(
  raw: string,
  defaultId: string,
  optionName: string,
): { id: string; json: string } {
  const trimmed = raw.trim();
  if (trimmed === '') throw new Error(`--${optionName} must not be empty`);
  const eq = trimmed.indexOf('=');
  if (eq < 0) return { id: defaultId, json: trimmed };
  const id = trimmed.slice(0, eq).trim();
  const json = trimmed.slice(eq + 1).trim();
  if (id === '') throw new Error(`--${optionName} id must not be empty`);
  if (json === '') throw new Error(`--${optionName} JSON must not be empty`);
  return { id, json };
}

function parseJsonObject(raw: string, optionName: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`--${optionName} must be valid JSON: ${message}`);
  }
  if (!isRecord(parsed)) {
    throw new Error(`--${optionName} must decode to an object config block`);
  }
  return parsed;
}

async function promptProviderRef(
  registry: ProviderRegistry,
  kind: ProviderKind,
  initialValue: string,
): Promise<string> {
  const builtins = registry
    .listByKind(kind)
    .map((descriptor) => formatProviderRef(descriptor.ref));
  return promptText(
    `${kind} provider (${builtins.join(', ') || 'no builtins'})`,
    initialValue,
  );
}

function promptHostForMode(interactive: boolean): ProviderOnboardPromptHost {
  if (!interactive) {
    return {
      text: nonInteractiveTextPrompt,
      secret: nonInteractiveSecretPrompt,
      confirm: nonInteractiveConfirmPrompt,
    };
  }
  return {
    text: (input) =>
      promptText(input.message, input.initialValue, input.required ?? true),
    secret: (input) => promptSecret(input.message, input.required ?? true),
    confirm: (input) => promptConfirm(input.message, input.initialValue),
  };
}

async function nonInteractiveTextPrompt(
  input: ProviderOnboardTextPrompt,
): Promise<string> {
  return nonInteractivePromptValue(input);
}

async function nonInteractiveSecretPrompt(
  input: ProviderOnboardSecretPrompt,
): Promise<string> {
  return nonInteractivePromptValue(input);
}

async function nonInteractiveConfirmPrompt(
  input: ProviderOnboardConfirmPrompt,
): Promise<boolean> {
  return input.initialValue;
}

function nonInteractivePromptValue(
  input: ProviderOnboardTextPrompt | ProviderOnboardSecretPrompt,
): string {
  if (
    input.initialValue !== undefined &&
    (input.initialValue.trim() !== '' || input.required === false)
  ) {
    return input.initialValue;
  }
  if (input.required === false) return '';
  throw new Error(
    `provider onboard prompt '${input.message}' requires interactive input; pass --agent-config-json or --channel-config-json`,
  );
}

function defaultConfigDir(options: OnboardCliOptions): string {
  return options.configDir ?? join(homedir(), '.dreamux');
}

async function promptText(
  label: string,
  initialValue?: string,
  required = true,
): Promise<string> {
  const value = await text({
    message: label,
    initialValue,
    validate: (input) =>
      required && (input === undefined || input.trim() === '')
        ? 'required'
        : undefined,
  });
  return unwrapPrompt(value);
}

async function promptConfirm(
  label: string,
  initialValue: boolean,
): Promise<boolean> {
  const value = await confirm({
    message: label,
    initialValue,
  });
  return unwrapPrompt(value);
}

async function promptSecret(
  label: string,
  required = true,
): Promise<string> {
  const value = await password({
    message: label,
    validate: (input) =>
      required && (input === undefined || input.trim() === '')
        ? 'required'
        : undefined,
  });
  return unwrapPrompt(value);
}

function unwrapPrompt<T>(value: T | symbol): T {
  if (isCancel(value)) {
    cancel('onboard cancelled');
    throw new Error('onboard cancelled');
  }
  return value;
}

function optionValues(value: string | string[] | undefined): string[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

function firstOption(value: string | string[] | undefined): string | undefined {
  return optionValues(value)[0];
}

function singleOption(
  value: string | string[] | undefined,
  optionName: string,
): string | undefined {
  const values = optionValues(value);
  if (values.length > 1) {
    throw new Error(`--${optionName} may be provided at most once`);
  }
  return values[0];
}

function defaultChannelConfigId(selections: ProviderSelection[]): string {
  return selections[0]?.id ?? DEFAULT_CHANNEL_ID;
}

function normalizePath(path: string): string {
  return resolve(expandHome(path));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function describeValue(value: unknown): string {
  if (Array.isArray(value)) return 'an array';
  if (value === null) return 'null';
  return typeof value;
}
