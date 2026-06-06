import type { DreamuxConfig } from '../runtime/config.js';
import {
  DEFAULT_APPROVAL_POLICY,
  DEFAULT_INITIALIZE_TIMEOUT_MS,
  DEFAULT_SANDBOX_MODE,
  type DispatcherConfig,
  stringifyConfig,
} from '../runtime/config.js';
import { validateDispatcherId } from '../runtime/dispatcher-id.js';
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
    const existing = seen.get(dispatcher.feishu.app_id);
    if (existing !== undefined && existing !== dispatcher.id) {
      throw new Error(
        `Feishu app_id for dispatcher '${dispatcher.id}' duplicates dispatcher '${existing}'`,
      );
    }
    seen.set(dispatcher.feishu.app_id, dispatcher.id);
  }
}

function dispatcherConfigFromAnswers(answers: OnboardAnswers): DispatcherConfig {
  return {
    id: answers.dispatcherId,
    cwd: answers.dispatcherCwd,
    enabled: true,
    feishu: {
      app_id: answers.botAppId,
      app_secret: answers.botAppSecret,
    },
    codex: {
      bin: answers.codexBin,
      approval_policy: DEFAULT_APPROVAL_POLICY,
      sandbox_mode: DEFAULT_SANDBOX_MODE,
      extra_args: [],
      extra_env: {},
      initialize_timeout_ms: DEFAULT_INITIALIZE_TIMEOUT_MS,
    },
  };
}

function cloneDispatcherConfig(dispatcher: DispatcherConfig): DispatcherConfig {
  return {
    id: dispatcher.id,
    cwd: dispatcher.cwd,
    enabled: dispatcher.enabled,
    feishu: { ...dispatcher.feishu },
    codex: {
      bin: dispatcher.codex.bin,
      approval_policy: dispatcher.codex.approval_policy,
      sandbox_mode: dispatcher.codex.sandbox_mode,
      extra_args: [...dispatcher.codex.extra_args],
      extra_env: { ...dispatcher.codex.extra_env },
      initialize_timeout_ms: dispatcher.codex.initialize_timeout_ms,
    },
  };
}
