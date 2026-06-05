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
import { validateDispatcherId } from '../runtime/dispatcher-id.js';
import type { OnboardAnswers } from './types.js';

export interface OnboardCliOptions {
  yes?: boolean;
  dryRun?: boolean;
  configDir?: string;
  dispatcherId?: string;
  dispatcherCwd?: string;
  codexBin?: string;
  botAppId?: string;
  botAppSecret?: string;
  registerService?: boolean;
  startService?: boolean;
  dreamuxBin?: string;
}

const DEFAULT_DISPATCHER_ID = 'dispatcher';

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
    dispatcherId: validateDispatcherId(
      options.dispatcherId ?? DEFAULT_DISPATCHER_ID,
    ),
    dispatcherCwd: normalizePath(dispatcherCwd),
    codexBin: options.codexBin ?? 'codex',
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
