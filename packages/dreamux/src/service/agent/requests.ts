/**
 * How a caller asks for one Agent entity, or asks an Agent entity collection
 * about its history.
 *
 * These are Agent entity facts — their fields and their status vocabulary are
 * this layer's — so the payload is read here rather than in the generic Command
 * readers. The Dispatcher and Team TeamMate surfaces both ask the same
 * questions, so they both ask them through this one reader.
 */
import {
  throwCallerMistake,
  RuleViolation,
  ValidationError,
} from '../../command/errors.js';
import {
  mustString,
  optionalBooleanField,
  optionalInteger,
  optionalNonBlankString,
  optionalString,
  type CommandPayload,
} from '../../command/payload.js';
import {
  clampHistoryLimit,
  decodeCursor,
} from '../../platform/history-page.js';
import {
  validateTeamMateName,
  type AgentEntityHistoryQuery,
  type AgentEntityIdentityStatus,
  type AgentEntityLastQuery,
} from './identity.js';

/**
 * Read an agent entity name parameter.
 *
 * The entity naming rule decides it, on every caller-facing surface, and a name
 * that breaks it is the caller's mistake rather than an unclassified failure
 * raised deep in a lookup or a record scan. The rule speaks in its own words, so
 * its sentence is kept and only its type is made the caller's.
 */
export function agentEntityNameParam(
  params: CommandPayload,
  key: string,
): string {
  return assertEntityName(mustString(params, key));
}

/** The same read where the field is an optional filter; absent stays absent. */
export function optionalAgentEntityNameParam(
  params: CommandPayload,
  key: string,
): string | null {
  const value = optionalNonBlankString(params, key);
  return value === null ? null : assertEntityName(value);
}

function assertEntityName(value: string): string {
  try {
    return validateTeamMateName(value);
  } catch (error) {
    throwCallerMistake(error);
  }
}

const LAST_LIMIT_DEFAULT = 20;
const LAST_LIMIT_MAX = 200;

export function validateLastLimit(input: number | undefined): number {
  if (input === undefined) return LAST_LIMIT_DEFAULT;
  if (!Number.isInteger(input) || input < 1 || input > LAST_LIMIT_MAX) {
    throw new RuleViolation(
      `last limit must be an integer in 1..${LAST_LIMIT_MAX}`,
    );
  }
  return input;
}

/**
 * One Activity read request, as every caller-facing surface asks it.
 *
 * The bound belongs to {@link validateLastLimit} and is stated in its own words;
 * only its type becomes the caller's, so the sentence a caller reads cannot
 * drift from the limit that produced it.
 */
export function agentEntityLastQuery(
  params: CommandPayload,
): AgentEntityLastQuery {
  const limit = optionalInteger(params, 'limit');
  try {
    validateLastLimit(limit ?? undefined);
  } catch (error) {
    throwCallerMistake(error);
  }
  const cursor = optionalString(params, 'cursor');
  const includeTools = optionalBooleanField(params, 'include_tools')[
    'include_tools'
  ];
  return {
    ...(limit !== null ? { limit } : {}),
    ...(cursor !== null ? { cursor } : {}),
    includeTools,
  };
}

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
