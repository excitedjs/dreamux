import type { AgentActivityError } from '@excitedjs/dreamux-types';

import { DreamuxError, InternalError } from '../../command/errors.js';
import { AgentActivityReadError } from './activity-reader.js';

/**
 * The public face of an Activity read failure. Each message describes a neutral
 * state only: never a filesystem path, a native history layout, or a scan mode.
 */
export const ACTIVITY_PUBLIC_ERRORS = [
  {
    reason: 'session_unavailable',
    code: 'ACTIVITY_SESSION_UNAVAILABLE',
    message: 'No runtime activity is available for this session.',
  },
  {
    reason: 'cursor_invalid',
    code: 'ACTIVITY_CURSOR_INVALID',
    message: 'The activity cursor is invalid or no longer usable.',
  },
  {
    reason: 'activity_corrupt',
    code: 'ACTIVITY_CORRUPT',
    message: 'The runtime activity could not be interpreted.',
  },
  {
    reason: 'provider_failure',
    code: 'ACTIVITY_PROVIDER_FAILURE',
    message: 'The agent runtime could not serve the activity read.',
  },
] as const satisfies readonly {
  reason: AgentActivityError['reason'];
  code: string;
  message: string;
}[];

export const ACTIVITY_INTERNAL_ERROR_MESSAGE =
  'The runtime activity could not be read because of an internal error.';

/**
 * Re-throw one Activity read failure as its public Command error. The reader's
 * internal reason vocabulary never leaves this module.
 */
export function mapAgentActivityCommandError(error: unknown): never {
  if (!(error instanceof AgentActivityReadError)) throw error;
  if (error.reason === null) {
    throw new InternalError(ACTIVITY_INTERNAL_ERROR_MESSAGE);
  }
  const mapped = ACTIVITY_PUBLIC_ERRORS.find(
    (entry) => entry.reason === error.reason,
  );
  if (mapped === undefined) {
    throw new InternalError(ACTIVITY_INTERNAL_ERROR_MESSAGE);
  }
  // A known Activity failure keeps its own public code; the reader's internal
  // reasons are what stay private, not the fact that the read failed.
  throw new DreamuxError(mapped.code, mapped.message);
}
