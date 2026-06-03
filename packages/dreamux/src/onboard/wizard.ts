import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

import {
  cancel,
  confirm,
  intro,
  isCancel,
  outro,
  text,
} from '@clack/prompts';

import { expandHome } from '../runtime/config.js';
import type { OnboardAnswers } from './types.js';

export interface OnboardCliOptions {
  yes?: boolean;
  dryRun?: boolean;
  configDir?: string;
  runtimeDir?: string;
  dispatcherId?: string;
  dispatcherCwd?: string;
  codexBin?: string;
  codexMarketplaceSource?: string;
  codexMarketplaceSparse?: string | string[];
  codexMarketplaceName?: string;
  codexPluginRef?: string;
  claudeBin?: string;
  claudeConfigDir?: string;
  claudeMarketplaceSource?: string;
  claudeMarketplaceSparse?: string | string[];
  claudeMarketplaceName?: string;
  claudePluginRef?: string;
  botAppId?: string;
  botAppSecret?: string;
  registerService?: boolean;
  startService?: boolean;
  dreamuxBin?: string;
}

const DEFAULT_DISPATCHER_ID = 'dispatcher';
const DEFAULT_CODEX_MARKETPLACE_SOURCE = 'excitedjs/dreamux';
const DEFAULT_CODEX_MARKETPLACE_SPARSE = [
  '.agents/plugins',
  'codex-marketplace/plugins/codexmux',
];
const DEFAULT_CODEX_MARKETPLACE_NAME = 'dreamux';
const DEFAULT_CODEX_PLUGIN_REF = 'codexmux@dreamux';
const DEFAULT_CLAUDE_MARKETPLACE_SOURCE = 'excitedjs/claudemux';
const DEFAULT_CLAUDE_MARKETPLACE_NAME = 'claudemux';
const DEFAULT_CLAUDE_PLUGIN_REF = 'claudemux@claudemux';

export async function collectOnboardAnswers(
  options: OnboardCliOptions,
): Promise<OnboardAnswers> {
  const interactive = process.stdin.isTTY === true && options.yes !== true;
  if (!interactive) return answersFromOptions(options, false);

  intro('dreamux onboard');
  const configDir = await promptText(
    'dreamux config directory',
    defaultConfigDir(options),
  );
  const runtimeDir = await promptText(
    'dreamux runtime directory',
    defaultRuntimeDir(options),
  );
  const dispatcherId = await promptText(
    'dispatcher id',
    options.dispatcherId ?? DEFAULT_DISPATCHER_ID,
  );
  const dispatcherCwd = await promptText(
    'dispatcher cwd',
    options.dispatcherCwd ?? process.cwd(),
  );
  const codexBin = await promptText('codex binary', options.codexBin ?? 'codex');
  const botAppId = await promptText('channel bot app id', options.botAppId);
  const botAppSecret = await promptText(
    'channel bot app secret',
    options.botAppSecret,
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

  outro('Collected onboarding inputs.');
  return answersFromOptions(
    {
      ...options,
      configDir,
      runtimeDir,
      dispatcherId,
      dispatcherCwd,
      codexBin,
      botAppId,
      botAppSecret,
      registerService,
      startService,
    },
    true,
  );
}

export function answersFromOptions(
  options: OnboardCliOptions,
  fromInteractive: boolean,
): OnboardAnswers {
  const botAppId = requiredOption(options.botAppId, 'bot-app-id', fromInteractive);
  const botAppSecret = requiredOption(
    options.botAppSecret,
    'bot-app-secret',
    fromInteractive,
  );
  const dispatcherCwd = options.dispatcherCwd ?? process.cwd();
  return {
    configDir: normalizePath(options.configDir ?? defaultConfigDir(options)),
    runtimeDir: normalizePath(options.runtimeDir ?? defaultRuntimeDir(options)),
    dispatcherId: options.dispatcherId ?? DEFAULT_DISPATCHER_ID,
    dispatcherCwd: normalizePath(dispatcherCwd),
    codexBin: options.codexBin ?? 'codex',
    codexMarketplaceSource:
      options.codexMarketplaceSource ?? DEFAULT_CODEX_MARKETPLACE_SOURCE,
    codexMarketplaceSparse: normalizeStringArray(
      options.codexMarketplaceSparse,
      DEFAULT_CODEX_MARKETPLACE_SPARSE,
    ),
    codexMarketplaceName:
      options.codexMarketplaceName ?? DEFAULT_CODEX_MARKETPLACE_NAME,
    codexPluginRef: options.codexPluginRef ?? DEFAULT_CODEX_PLUGIN_REF,
    claudeBin: options.claudeBin ?? 'claude',
    claudeConfigDir: normalizePath(
      options.claudeConfigDir ?? join(homedir(), '.claude'),
    ),
    claudeMarketplaceSource:
      options.claudeMarketplaceSource ?? DEFAULT_CLAUDE_MARKETPLACE_SOURCE,
    claudeMarketplaceSparse: normalizeStringArray(
      options.claudeMarketplaceSparse,
      [],
    ),
    claudeMarketplaceName:
      options.claudeMarketplaceName ?? DEFAULT_CLAUDE_MARKETPLACE_NAME,
    claudePluginRef: options.claudePluginRef ?? DEFAULT_CLAUDE_PLUGIN_REF,
    botAppId,
    botAppSecret,
    registerService: options.registerService ?? true,
    startService: options.startService ?? true,
    dreamuxBin: normalizePath(
      options.dreamuxBin ?? process.env['DREAMUX_BIN'] ?? process.argv[1],
    ),
    dryRun: options.dryRun ?? false,
  };
}

function defaultConfigDir(options: OnboardCliOptions): string {
  return options.configDir ?? join(homedir(), '.dreamux');
}

function defaultRuntimeDir(options: OnboardCliOptions): string {
  return options.runtimeDir ?? join(homedir(), '.codex-host');
}

async function promptText(label: string, initialValue?: string): Promise<string> {
  const value = await text({
    message: label,
    initialValue,
    validate: (input) =>
      input === undefined || input.trim() === '' ? 'required' : undefined,
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

function unwrapPrompt<T>(value: T | symbol): T {
  if (isCancel(value)) {
    cancel('onboard cancelled');
    throw new Error('onboard cancelled');
  }
  return value;
}

function requiredOption(
  value: string | undefined,
  name: string,
  fromInteractive: boolean,
): string {
  if (value !== undefined && value.trim() !== '') return value;
  const mode = fromInteractive ? 'wizard' : 'non-interactive onboard';
  throw new Error(`${mode} requires --${name}`);
}

function normalizePath(path: string): string {
  return resolve(expandHome(path));
}

function normalizeStringArray(
  value: string | string[] | undefined,
  fallback: string[],
): string[] {
  if (value === undefined) return fallback;
  return (Array.isArray(value) ? value : [value]).filter((item) => item !== '');
}
