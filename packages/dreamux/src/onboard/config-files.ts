import type { DreamuxConfig } from '../runtime/config.js';
import {
  BUILT_IN_DEFAULTS,
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
  const next: DreamuxConfig = {
    runtime_dir: base.runtime_dir,
    admin_socket: base.admin_socket,
    codex: {
      ...base.codex,
      extra_args: [...base.codex.extra_args],
    },
    outbound: { ...base.outbound },
    feishu: {
      bots: {
        ...base.feishu.bots,
        [answers.dispatcherId]: {
          app_id: answers.botAppId,
          app_secret: answers.botAppSecret,
        },
      },
    },
  };
  assertUniqueFeishuAppIds(next);
  return next;
}

function dreamuxConfigDefaultsFromAnswers(
  answers: OnboardAnswers,
): DreamuxConfig {
  return {
    runtime_dir: answers.runtimeDir,
    admin_socket: null,
    codex: {
      bin: answers.codexBin,
      approval_policy: 'never',
      sandbox_mode: 'workspace-write',
      extra_args: [],
      initialize_timeout_ms: BUILT_IN_DEFAULTS.codex.initialize_timeout_ms,
    },
    outbound: {
      retries: BUILT_IN_DEFAULTS.outbound.retries,
      retry_delay_ms: BUILT_IN_DEFAULTS.outbound.retry_delay_ms,
    },
    feishu: {
      bots: {},
    },
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
  for (const [dispatcherId, bot] of Object.entries(config.feishu.bots)) {
    const existing = seen.get(bot.app_id);
    if (existing !== undefined && existing !== dispatcherId) {
      throw new Error(
        `Feishu app_id for dispatcher '${dispatcherId}' duplicates dispatcher '${existing}'`,
      );
    }
    seen.set(bot.app_id, dispatcherId);
  }
}
