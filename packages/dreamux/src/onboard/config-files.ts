import { hostConfigFileShape, type HostConfig } from '../config/host-config.js';
import { validateDispatcherId } from '../state/dispatcher-id.js';
import type { OnboardAnswers } from '../onboard/types.js';

export function configFileShapeFromAnswers(
  answers: OnboardAnswers,
  existing?: HostConfig,
): Record<string, unknown> {
  validateDispatcherId(answers.dispatcherId);
  const base = existing ?? {
    agents: [],
    dispatchers: [],
  };
  const shape = hostConfigFileShape(base);
  const existingDispatcher = base.dispatchers.find(
    (dispatcher) => dispatcher.id === answers.dispatcherId,
  );
  const dispatchers = (shape['dispatchers'] as Record<string, unknown>[])
    .filter((dispatcher) => dispatcher['id'] !== answers.dispatcherId);
  dispatchers.push(dispatcherFileShapeFromAnswers(
    answers,
    existingDispatcher?.workspace ?? { enabled: true },
  ));
  const agentsById = new Map<string, Record<string, unknown>>();
  for (const agent of shape['agents'] as Record<string, unknown>[]) {
    agentsById.set(String(agent['id']), agent);
  }
  agentsById.set(answers.agentRuntime.id, {
    id: answers.agentRuntime.id,
    provider: answers.agentRuntime.provider,
    config: structuredClone(answers.agentRuntime.config),
  });
  return {
    agents: [...agentsById.values()],
    dispatchers,
  };
}

function dispatcherFileShapeFromAnswers(
  answers: OnboardAnswers,
  workspace: { enabled: boolean },
): Record<string, unknown> {
  return {
    id: answers.dispatcherId,
    cwd: answers.dispatcherCwd,
    enabled: true,
    workspace,
    channels: answers.channels.map((channel) => ({
      id: channel.id,
      provider: channel.provider,
      config: structuredClone(channel.config),
    })),
    agentRuntime: answers.agentRuntime.id,
  };
}
