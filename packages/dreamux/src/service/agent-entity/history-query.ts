/**
 * How a caller asks an Agent entity collection about its history.
 *
 * The query is an agent-entity fact — its fields and its status vocabulary are
 * this layer's — so the payload is read here rather than in the generic Command
 * readers. The Dispatcher and Team TeamMate surfaces both ask the same
 * question, so they both ask it through this one reader.
 */
import { ValidationError } from '../../command/errors.js';
import {
  optionalInteger,
  optionalString,
  type CommandPayload,
} from '../../command/payload.js';
import type {
  AgentEntityHistoryQuery,
  AgentEntityIdentityStatus,
} from './types.js';

export function historyQuery(params: CommandPayload): AgentEntityHistoryQuery {
  const name = optionalString(params, 'name');
  const status = optionalTeammateStatus(params, 'status');
  const agentRuntime = optionalString(params, 'agent_runtime');
  const repo = optionalString(params, 'repo');
  const grep = optionalString(params, 'grep');
  const since = optionalInteger(params, 'since');
  const until = optionalInteger(params, 'until');
  const cursor = optionalString(params, 'cursor');
  const limit = optionalInteger(params, 'limit');
  return {
    ...(name !== null ? { name } : {}),
    ...(status !== null ? { status } : {}),
    ...(agentRuntime !== null ? { agentRuntime } : {}),
    ...(repo !== null ? { repo } : {}),
    ...(grep !== null ? { grep } : {}),
    ...(since !== null ? { since } : {}),
    ...(until !== null ? { until } : {}),
    ...(cursor !== null ? { cursor } : {}),
    ...(limit !== null ? { limit } : {}),
  };
}

function optionalTeammateStatus(
  params: CommandPayload,
  key: string,
): AgentEntityIdentityStatus | null {
  const value = optionalString(params, key);
  if (value === null) return null;
  if (
    value === 'starting' ||
    value === 'running' ||
    value === 'degraded' ||
    value === 'closed' ||
    value === 'stopped'
  ) {
    return value;
  }
  throw new ValidationError(
    `param '${key}' must be starting, running, degraded, closed, or stopped`,
  );
}
