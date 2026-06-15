import type { DreamuxConfig } from '../config/config.js';
import {
  type DispatcherConfig,
  type DispatcherProviderConfig,
  stringifyConfig,
} from '../config/config.js';
import {
  BUILTIN_CODEX_PROVIDER_REF,
  BUILTIN_FEISHU_PROVIDER_REF,
} from '../registry/index.js';
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
  const base: DreamuxConfig = existing ?? { agents: {}, dispatchers: [] };
  const dispatchers = base.dispatchers
    .filter((dispatcher) => dispatcher.id !== answers.dispatcherId)
    .map(cloneDispatcherConfig);
  dispatchers.push(dispatcherConfigFromAnswers(answers));
  // Config lands only in agents[]. Onboard uses one agent per dispatcher with
  // agent id == dispatcher id (dispatcher ids are unique and an agent id has no
  // path-safety constraint), so a per-dispatcher codex bin is preserved and the
  // shape round-trips with no dedup logic.
  //
  // Seed from the existing agents map FIRST, then overwrite/add the
  // dispatcher-owned entries. agents[] is the global runtime-config map, so an
  // entry referenced only by a TeamMate (e.g. a `claude` agent used via
  // teammate.spawn under a Codex dispatcher) is valid even though no dispatcher
  // names it; re-running onboard must not silently delete it.
  const agents: DreamuxConfig['agents'] = {};
  for (const [id, agent] of Object.entries(base.agents)) {
    const rawConfig = cloneOptionalProviderConfig(agent.rawConfig);
    agents[id] = {
      provider: agent.provider,
      config: cloneProviderConfig(agent.config),
      ...(rawConfig === undefined ? {} : { rawConfig }),
    };
  }
  for (const dispatcher of dispatchers) {
    const rawConfig = cloneOptionalProviderConfig(dispatcher.runtime.rawConfig);
    agents[dispatcher.agentRuntime] = {
      provider: dispatcher.runtime.provider,
      config: cloneProviderConfig(dispatcher.runtime.config),
      ...(rawConfig === undefined ? {} : { rawConfig }),
    };
  }
  const next: DreamuxConfig = { agents, dispatchers };
  return next;
}

export function dispatcherBotSecretRef(dispatcherId: string): string {
  return `config:${dispatcherId}`;
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
    // One agent per dispatcher; agent id == dispatcher id.
    agentRuntime: answers.dispatcherId,
    runtime: {
      provider: BUILTIN_CODEX_PROVIDER_REF,
      config: {
        bin: answers.codexBin,
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
      ...(channel.rawConfig === undefined
        ? {}
        : { rawConfig: cloneProviderConfig(channel.rawConfig) }),
    })),
    agentRuntime: dispatcher.agentRuntime,
    runtime: {
      provider: dispatcher.runtime.provider,
      config: cloneProviderConfig(dispatcher.runtime.config),
      ...(dispatcher.runtime.rawConfig === undefined
        ? {}
        : { rawConfig: cloneProviderConfig(dispatcher.runtime.rawConfig) }),
    },
  };
}

function cloneProviderConfig(config: unknown): DispatcherProviderConfig {
  return structuredClone(config) as DispatcherProviderConfig;
}

function cloneOptionalProviderConfig(
  config: DispatcherProviderConfig | undefined,
): DispatcherProviderConfig | undefined {
  if (config === undefined) return undefined;
  return cloneProviderConfig(config);
}
