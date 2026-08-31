/**
 * How a caller asks an Agent entity collection about its history.
 *
 * The query is an agent-entity fact — its fields and its status vocabulary are
 * this layer's — so the payload is read here rather than in the generic Command
 * readers. The Dispatcher and Team TeamMate surfaces both ask the same
 * question, so they both ask it through this one reader.
 */
import { throwCallerMistake, ValidationError } from '../../command/errors.js';
import {
  optionalInteger,
  optionalString,
  type CommandPayload,
} from '../../command/payload.js';
import {
  clampHistoryLimit,
  decodeCursor,
  optionalAgentEntityNameParam,
} from './read-helpers.js';
import type {
  AgentEntityHistoryQuery,
  AgentEntityIdentityStatus,
} from './types.js';

export function historyQuery(params: CommandPayload): AgentEntityHistoryQuery {
  // Validated here rather than deep in the record scan: a filter naming an
  // impossible entity is the caller's mistake, not an unclassified failure.
  const name = optionalAgentEntityNameParam(params, 'name');
  const status = optionalTeammateStatus(params, 'status');
  const agentRuntime = optionalString(params, 'agent_runtime');
  const repo = optionalString(params, 'repo');
  const grep = optionalString(params, 'grep');
  const since = optionalInteger(params, 'since');
  const until = optionalInteger(params, 'until');
  const cursor = optionalString(params, 'cursor');
  const limit = optionalInteger(params, 'limit');
  // The paging rules belong to the reader that applies them and are stated in
  // its own words; asked here so a caller that sends an unusable page reads
  // which rule it broke, instead of a failure the scan raises later.
  try {
    clampHistoryLimit(limit ?? undefined);
    if (cursor !== null) decodeCursor(cursor);
  } catch (error) {
    throwCallerMistake(error);
  }
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
