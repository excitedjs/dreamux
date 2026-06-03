import type { DreamuxConfig } from '../runtime/config.js';
import {
  BUILT_IN_DEFAULTS,
  stringifyConfig,
} from '../runtime/config.js';
import type { OnboardAnswers } from './types.js';

export function buildDreamuxConfigJson(answers: OnboardAnswers): string {
  return stringifyConfig(dreamuxConfigFromAnswers(answers));
}

export function dreamuxConfigFromAnswers(answers: OnboardAnswers): DreamuxConfig {
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
      bots: {
        [answers.dispatcherId]: {
          app_id: answers.botAppId,
          app_secret: answers.botAppSecret,
        },
      },
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
