import type { DreamuxConfig } from '../config/config.js';
import {
  type DispatcherConfig,
  type DispatcherProviderConfig,
  stringifyConfig,
} from '../config/config.js';
import { validateDispatcherId } from '../state/dispatcher-id.js';
import type { OnboardAnswers } from '../onboard/types.js';

export function buildDreamuxConfigJson(answers: OnboardAnswers): string {
  return stringifyConfig(dreamuxConfigFromAnswers(answers));
}

export function dreamuxConfigFromAnswers(
  answers: OnboardAnswers,
  existing?: DreamuxConfig,
): DreamuxConfig {
  validateDispatcherId(answers.dispatcherId);
  const base: DreamuxConfig = existing ?? {
    agents: {},
    dispatchers: [],
  };
  const existingDispatcher = base.dispatchers.find(
    (dispatcher) => dispatcher.id === answers.dispatcherId,
  );
  const dispatchers = base.dispatchers
    .filter((dispatcher) => dispatcher.id !== answers.dispatcherId)
    .map(cloneDispatcherConfig);
  dispatchers.push(
    dispatcherConfigFromAnswers(
      answers,
      existingDispatcher?.workspace ?? { enabled: true },
    ),
  );
  // Runtime config lands only in agents[]. Onboard creates or updates the
  // selected agent id, preserving provider-owned raw config so the file
  // round-trips after provider parsers normalize defaults.
  //
  // Seed from the existing agents map FIRST, then overwrite/add the
  // dispatcher-owned entries. agents[] is the global runtime-config map, so an
  // entry referenced only by a TeamMate is valid even though no dispatcher names
  // it; re-running onboard must not silently delete it.
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
  const next: DreamuxConfig = {
    agents,
    dispatchers,
  };
  return next;
}

function dispatcherConfigFromAnswers(
  answers: OnboardAnswers,
  workspace: DispatcherConfig['workspace'],
): DispatcherConfig {
  return {
    id: answers.dispatcherId,
    cwd: answers.dispatcherCwd,
    enabled: true,
    workspace,
    channels: answers.channels.map((channel) => ({
      id: channel.id,
      provider: channel.provider,
      config: cloneProviderConfig(channel.config),
      rawConfig: cloneProviderConfig(channel.config),
    })),
    agentRuntime: answers.agentRuntime.id,
    runtime: {
      provider: answers.agentRuntime.provider,
      config: cloneProviderConfig(answers.agentRuntime.config),
      rawConfig: cloneProviderConfig(answers.agentRuntime.config),
    },
  };
}

function cloneDispatcherConfig(dispatcher: DispatcherConfig): DispatcherConfig {
  return {
    id: dispatcher.id,
    cwd: dispatcher.cwd,
    enabled: dispatcher.enabled,
    workspace: { enabled: dispatcher.workspace.enabled },
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
