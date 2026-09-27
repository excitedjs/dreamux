/**
 * How a caller asks for one Agent entity, or asks an Agent entity collection
 * about its history.
 *
 * These are Agent entity facts — their fields and their status vocabulary are
 * this layer's — so the payload is read here rather than in the generic Command
 * readers. The Dispatcher and Team TeamMate surfaces both ask the same
 * questions, so they both ask them through this one reader.
 */
import type { JsonSchema } from '@excitedjs/dreamux-types';

import {
  throwCallerMistake,
  RuleViolation,
  ValidationError,
} from '../../command/errors.js';
import {
  mustNonBlankString,
  mustNonEmptyString,
  mustString,
  optionalBooleanField,
  optionalInteger,
  optionalNonBlankString,
  optionalString,
  type CommandPayload,
} from '../../command/payload.js';
import { OBJECT, STRING, enumOf, objectSchema } from '../../command/schema.js';
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

/** One spawn request's scalar fields, as both Command and MCP ask them. */
export interface AgentSpawnRequest {
  readonly name: string;
  readonly prompt: string;
  readonly intent: string;
  readonly agentRuntime: string | null;
  readonly identity: string | null;
}

/**
 * Read a spawn request's scalar fields.
 *
 * `repo` and `skill_sources` are not read here: MCP's `spawn` resolves `repo`
 * into a caller-kind-scoped workspace decision the Command surface does not
 * make, so those two fields stay with the caller that reads them. `prompt`
 * and `agent_runtime` reject blank the same way on both surfaces: a
 * caller-supplied but empty first turn, or a caller-supplied but blank
 * runtime id, is the caller's mistake on either surface, not a value Core
 * silently treats as absent.
 */
export function agentSpawnRequest(params: CommandPayload): AgentSpawnRequest {
  return {
    name: mustNonBlankString(params, 'name_prefix'),
    prompt: mustNonEmptyString(params, 'prompt'),
    intent: mustNonBlankString(params, 'intent'),
    agentRuntime: optionalNonBlankString(params, 'agent_runtime'),
    identity: optionalNonBlankString(params, 'identity'),
  };
}

/** One send request, as both Command and MCP ask it. */
export interface AgentSendRequest {
  readonly name: string;
  readonly prompt: string;
  readonly intent: string | null;
}

/** Read a send request. `prompt`/`intent` reject blank on both surfaces. */
export function agentSendRequest(params: CommandPayload): AgentSendRequest {
  return {
    name: agentEntityNameParam(params, 'name'),
    prompt: mustNonEmptyString(params, 'prompt'),
    intent: optionalNonBlankString(params, 'intent'),
  };
}

/** One close request, as both Command and MCP ask it. */
export interface AgentCloseRequest {
  readonly name: string;
  readonly note: string;
}

export function agentCloseRequest(params: CommandPayload): AgentCloseRequest {
  return {
    name: agentEntityNameParam(params, 'name'),
    note: mustNonBlankString(params, 'note'),
  };
}

/**
 * The external status vocabulary a submission receipt reports.
 *
 * Deliberately not the runtime admission ledger's own status union: its
 * internal `skipped` outcome is normalized to `stopped` at every
 * caller-facing boundary, so a receipt schema built from the raw union would
 * advertise a status no caller ever receives. One array instead of the three
 * independent spellings `teammate.spawn`/`teammate.submit`'s Command schema,
 * the TeamMate MCP tools' schema, and `team.submit`'s schema each carried.
 */
export const SUBMISSION_STATUS_VALUES = [
  'submitted',
  'duplicate',
  'stopped',
  'failed',
  'ambiguous',
] as const;

/**
 * The declared output of a TeamMate submission receipt: `teammate.spawn`,
 * `teammate.submit`, and their MCP `spawn`/`send` equivalents all return this
 * one shape instead of each declaring their own copy.
 */
export const teammateReceiptSchema: JsonSchema = objectSchema(
  {
    teammate: OBJECT,
    status: enumOf(SUBMISSION_STATUS_VALUES),
    error: STRING,
  },
  ['teammate', 'status'],
);
