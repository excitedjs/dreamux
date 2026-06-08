import type { DreamuxConfig } from '../config/config.js';
import {
  BUILTIN_CODEX_PROVIDER_REF,
  BUILTIN_FEISHU_PROVIDER_REF,
  DEFAULT_APPROVAL_POLICY,
  DEFAULT_CODEX_TURN_TIMEOUT_MS,
  DEFAULT_INITIALIZE_TIMEOUT_MS,
  DEFAULT_SANDBOX_MODE,
  dispatcherFeishuConfig,
  type DispatcherConfig,
  type DispatcherProviderConfig,
  stringifyConfig,
} from '../config/config.js';
import { validateDispatcherId } from '../state/dispatcher-id.js';
import type { OnboardAnswers } from './types.js';

export function buildDreamuxConfigJson(answers: OnboardAnswers): string {
  return stringifyConfig(dreamuxConfigFromAnswers(answers));
}

export function dreamuxConfigFromAnswers(
  answers: OnboardAnswers,
  existing?: DreamuxConfig,
): DreamuxConfig {
  validateDispatcherId(answers.dispatcherId);
  const base: DreamuxConfig = existing ?? { dispatchers: [] };
  const dispatchers = base.dispatchers
    .filter((dispatcher) => dispatcher.id !== answers.dispatcherId)
    .map(cloneDispatcherConfig);
  dispatchers.push(dispatcherConfigFromAnswers(answers));
  const next: DreamuxConfig = { dispatchers };
  assertUniqueFeishuAppIds(next);
  return next;
}

export function dispatcherBotSecretRef(dispatcherId: string): string {
  return `config:${dispatcherId}`;
}

export function dispatcherCodexArgsJson(): string {
  return JSON.stringify({
    approvalPolicy: DEFAULT_APPROVAL_POLICY,
    sandboxMode: DEFAULT_SANDBOX_MODE,
    extraArgs: [],
  });
}

function assertUniqueFeishuAppIds(config: DreamuxConfig): void {
  const seen = new Map<string, string>();
  for (const dispatcher of config.dispatchers) {
    const feishu = dispatcherFeishuConfig(dispatcher);
    const existing = seen.get(feishu.app_id);
    if (existing !== undefined && existing !== dispatcher.id) {
      throw new Error(
        `Feishu app_id for dispatcher '${dispatcher.id}' duplicates dispatcher '${existing}'`,
      );
    }
    seen.set(feishu.app_id, dispatcher.id);
  }
}

function dispatcherConfigFromAnswers(answers: OnboardAnswers): DispatcherConfig {
  return {
    id: answers.dispatcherId,
    cwd: answers.dispatcherCwd,
    enabled: true,
    channels: [
      {
        id: 'primary',
        provider: BUILTIN_FEISHU_PROVIDER_REF,
        config: {
          app_id: answers.botAppId,
          app_secret: answers.botAppSecret,
        },
      },
    ],
    runtime: {
      provider: BUILTIN_CODEX_PROVIDER_REF,
      config: {
        bin: answers.codexBin,
        approval_policy: DEFAULT_APPROVAL_POLICY,
        sandbox_mode: DEFAULT_SANDBOX_MODE,
        extra_args: [],
        extra_env: {},
        initialize_timeout_ms: DEFAULT_INITIALIZE_TIMEOUT_MS,
        turn_timeout_ms: DEFAULT_CODEX_TURN_TIMEOUT_MS,
      },
    },
  };
}

function cloneDispatcherConfig(dispatcher: DispatcherConfig): DispatcherConfig {
  return {
    id: dispatcher.id,
    cwd: dispatcher.cwd,
    enabled: dispatcher.enabled,
    channels: dispatcher.channels.map((channel) => ({
      id: channel.id,
      provider: channel.provider,
      config: cloneProviderConfig(channel.config),
    })),
    runtime: {
      provider: dispatcher.runtime.provider,
      config: cloneProviderConfig(dispatcher.runtime.config),
    },
  };
}

function cloneProviderConfig(config: unknown): DispatcherProviderConfig {
  return structuredClone(config) as DispatcherProviderConfig;
}
