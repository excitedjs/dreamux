import type {
  AgentRuntimeCapabilities,
} from '@excitedjs/dreamux-types';

import type {
  DreamuxConfig,
  ResolvedAgentConfig,
} from '../../config/config.js';
import type { AgentRuntimeProviderCatalog } from '../../agent-runtime/index.js';
import type { AgentEntityRuntimeCapability } from '../agent-entity/types.js';

export function defaultAgentRuntime(
  config: DreamuxConfig,
  dispatcherId: string,
): string {
  const dispatcherCfg =
    config.dispatchers.find((entry) => entry.id === dispatcherId) ?? null;
  if (dispatcherCfg === null) {
    throw new Error(
      `cannot spawn a teammate for unknown dispatcher '${dispatcherId}': ` +
        'no dispatcher config to resolve a default agentRuntime from. Pass an ' +
        'explicit agentRuntime (an agents[].id).',
    );
  }
  return dispatcherCfg.agentRuntime;
}

export function resolveAgent(
  config: DreamuxConfig,
  dispatcherId: string,
  agentRuntimeId: string,
): ResolvedAgentConfig {
  const agent = config.agents[agentRuntimeId];
  if (agent === undefined) {
    const known = Object.keys(config.agents);
    const knownHint =
      known.length > 0
        ? `Known agents: ${known.map((id) => `'${id}'`).join(', ')}.`
        : 'No agents are declared.';
    throw new Error(
      `teammate for dispatcher '${dispatcherId}' references agentRuntime ` +
        `'${agentRuntimeId}', which matches no agents[].id. ${knownHint} ` +
        'Add the agent to config and rebuild, or respawn the teammate with a ' +
        'known agent id.',
    );
  }
  return agent;
}

export function agentRuntimeCapability(
  providers: AgentRuntimeProviderCatalog,
  agentRuntimeId: string,
  agent: ResolvedAgentConfig,
): AgentEntityRuntimeCapability {
  let capabilities: AgentRuntimeCapabilities | null = null;
  let unsupportedReason: string | null = null;
  try {
    capabilities = providers.resolve(agent.provider).getCapabilities();
  } catch (err) {
    unsupportedReason = err instanceof Error ? err.message : String(err);
  }
  return {
    id: agentRuntimeId,
    spawn: { agent_runtime: agentRuntimeId },
    runtime_available: capabilities !== null,
    resume: capabilities?.resume ?? { supported: false },
    unsupported_reason: unsupportedReason,
  };
}
