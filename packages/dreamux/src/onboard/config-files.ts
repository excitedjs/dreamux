import type { DreamuxConfig } from '../runtime/config.js';
import {
  BUILT_IN_DEFAULTS,
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
  const base = existing ?? dreamuxConfigDefaultsFromAnswers(answers);
  const dispatchers = base.dispatchers
    .filter((dispatcher) => dispatcher.id !== answers.dispatcherId)
    .map(cloneDispatcherConfig);
  dispatchers.push(dispatcherConfigFromAnswers(answers));
  const next: DreamuxConfig = {
    codex: {
      ...base.codex,
      extra_args: [...base.codex.extra_args],
    },
    dispatchers,
  };
  assertUniqueFeishuAppIds(next);
  return next;
}

function dreamuxConfigDefaultsFromAnswers(
  answers: OnboardAnswers,
): DreamuxConfig {
  return {
    codex: {
      bin: answers.codexBin,
      approval_policy: 'never',
      sandbox_mode: 'workspace-write',
      extra_args: [],
      initialize_timeout_ms: BUILT_IN_DEFAULTS.codex.initialize_timeout_ms,
    },
    dispatchers: [],
  };
}

export function dispatcherBotSecretRef(dispatcherId: string): string {
  return `config:${dispatcherId}`;
}

export function dispatcherCodexArgsJson(): string {
  return JSON.stringify({
    approvalPolicy: 'never',
    sandboxMode: 'workspace-write',
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
      approval_policy: 'never',
      sandbox_mode: 'workspace-write',
      extra_args: [],
      extra_env: {},
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
      approval_policy: dispatcher.codex.approval_policy,
      sandbox_mode: dispatcher.codex.sandbox_mode,
      extra_args: [...dispatcher.codex.extra_args],
      extra_env: { ...dispatcher.codex.extra_env },
    },
  };
}
