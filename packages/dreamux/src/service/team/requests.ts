import type { TeamStatus, TeamSubmitResult } from '@excitedjs/dreamux-types';

import { ValidationError, throwCallerMistake } from '../../command/errors.js';
import {
  mustString,
  optionalInteger,
  optionalNonBlankString,
  optionalString,
  type CommandPayload,
} from '../../command/payload.js';
import { STRING, enumOf, objectSchema } from '../../command/schema.js';
import {
  clampHistoryLimit,
  decodeCursor,
} from '../../platform/history-page.js';
import type { TurnAdmission } from '../agent/admission.js';
import { SUBMISSION_STATUS_VALUES } from '../agent/requests.js';
import { validateTeamId, type TeamHistoryQuery } from './types.js';

/** Read an optional Team status filter, in this domain's own vocabulary. */
export function optionalTeamStatus(
  params: CommandPayload,
  key: string,
): TeamStatus | null {
  const value = optionalString(params, key);
  if (value === null) return null;
  if (value === 'starting' || value === 'running' || value === 'closed')
    return value;
  throw new ValidationError(
    `param '${key}' must be starting, running, or closed`,
  );
}

/**
 * Read a required `team_name`, in the Team's own word for it.
 *
 * The Team's own name rule decides it, on every surface that takes a name, and
 * a name that breaks it is the caller's mistake rather than an unclassified
 * failure raised deep in a lookup. {@link validateTeamId} speaks in its own
 * words, so its sentence is kept and only its type is made the caller's.
 */
export function teamNameParam(params: CommandPayload, key: string): string {
  return assertTeamName(mustString(params, key));
}

/** The same read where the field is optional; absent stays absent. */
export function optionalTeamNameParam(
  params: CommandPayload,
  key: string,
): string | null {
  const value = optionalNonBlankString(params, key);
  return value === null ? null : assertTeamName(value);
}

function assertTeamName(value: string): string {
  try {
    return validateTeamId(value);
  } catch (error) {
    throwCallerMistake(error);
  }
}

/** The Team recovery search, as every surface asks it. */
export function teamHistoryQuery(params: CommandPayload): TeamHistoryQuery {
  // Validated here rather than deep in the record scan: a filter naming an
  // impossible Team is the caller's mistake, not an unclassified failure.
  const name = optionalTeamNameParam(params, 'team_name');
  const status = optionalTeamStatus(params, 'status');
  const repo = optionalString(params, 'repo');
  const grep = optionalString(params, 'grep');
  const since = optionalInteger(params, 'since');
  const until = optionalInteger(params, 'until');
  const limit = optionalInteger(params, 'limit');
  const cursor = optionalString(params, 'cursor');
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
    ...(repo !== null ? { repo } : {}),
    ...(grep !== null ? { grep } : {}),
    ...(since !== null ? { since } : {}),
    ...(until !== null ? { until } : {}),
    ...(limit !== null ? { limit } : {}),
    ...(cursor !== null ? { cursor } : {}),
  };
}

/**
 * The declared output schema of the submit receipt {@link teamSubmitResult}
 * projects. Both `team.submit` and `dispatcher.submit` return that one receipt,
 * so they share this one declaration beside the projection.
 */
export const teamSubmitResultOutput = objectSchema(
  {
    status: enumOf(SUBMISSION_STATUS_VALUES),
    turn_id: STRING,
    error: objectSchema({ code: STRING, message: STRING }, ['code', 'message']),
  },
  ['status'],
);

/**
 * The canonical public receipt of one TeamLeader submission.
 *
 * The one submission projection that is not a copy: the provider seam's
 * internal `skipped` is normalized to `stopped` here, and a duplicate is
 * reported without a turn identity it never got. Both caller-facing surfaces
 * read this, so the receipt cannot mean two things.
 */
export function teamSubmitResult(admission: TurnAdmission): TeamSubmitResult {
  switch (admission.status) {
    case 'submitted':
      return { status: 'submitted', turn_id: admission.turn.id };
    case 'duplicate':
      // Core returned before runtime admission, so there is no second turn
      // identity to report.
      return { status: 'duplicate' };
    case 'stopped':
      return { status: 'stopped' };
    // The provider seam's internal `skipped` is normalized at this boundary.
    case 'skipped':
      return {
        status: 'stopped',
        error: { code: 'TURN_SKIPPED', message: 'turn skipped' },
      };
    case 'failed':
      return {
        status: 'failed',
        error: { code: 'SUBMIT_FAILED', message: admission.error.message },
      };
    case 'ambiguous':
      return {
        status: 'ambiguous',
        error: {
          code: 'SUBMIT_AMBIGUOUS',
          message: admission.error.message,
        },
      };
  }
}
