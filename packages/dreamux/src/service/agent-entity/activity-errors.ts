import type { AgentActivityError } from '@excitedjs/dreamux-types';

import { StatedFailure } from '../../command/errors.js';
import { AgentActivityReadError } from './activity-reader.js';

/**
 * One Activity read failure, as the agent-entity layer states it.
 *
 * Named rather than assembled at the throw site: the reader's internal reason
 * vocabulary stops here, and what leaves is a fact with its own stable code and
 * its own next step.
 */
export class AgentActivityFailure extends StatedFailure {
  constructor(code: string, reason: string, action: string) {
    super(code, reason, action);
  }
}

/**
 * The public face of an Activity read failure the provider seam named. Each
 * message describes a neutral state only: never a filesystem path, a native
 * history layout, or a scan mode. Each action is what a caller can actually do
 * about that state.
 *
 * This table covers exactly the four recognized reasons and nothing else. A
 * failure Core never diagnosed is not listed here and is not given a sentence
 * here; it keeps its own.
 */
export const ACTIVITY_PUBLIC_ERRORS = [
  {
    reason: 'session_unavailable',
    code: 'ACTIVITY_SESSION_UNAVAILABLE',
    message: 'No runtime activity is available for this session.',
    action:
      'This agent has not produced runtime activity yet; send it a turn, or ' +
      'read its status to see whether it is running.',
  },
  {
    reason: 'cursor_invalid',
    code: 'ACTIVITY_CURSOR_INVALID',
    message: 'The activity cursor is invalid or no longer usable.',
    action: 'Read again without a cursor to start from the latest records.',
  },
  {
    reason: 'activity_corrupt',
    code: 'ACTIVITY_CORRUPT',
    message: 'The runtime activity could not be interpreted.',
    action:
      'Read again without a cursor; if it keeps failing, report it to the ' +
      'operator.',
  },
  {
    reason: 'provider_failure',
    code: 'ACTIVITY_PROVIDER_FAILURE',
    message: 'The agent runtime could not serve the activity read.',
    action:
      'Retry once; if it repeats, read the agent status to see whether its ' +
      'runtime is still running.',
  },
] as const satisfies readonly {
  reason: AgentActivityError['reason'];
  code: string;
  message: string;
  action: string;
}[];

/**
 * Re-throw one recognized Activity read failure as its public Command error.
 *
 * Only a read failure the provider seam named reaches here at all; anything
 * else was already left alone by the reader and passes straight through this
 * function with its own type and message intact.
 */
export function mapAgentActivityCommandError(error: unknown): never {
  if (!(error instanceof AgentActivityReadError)) throw error;
  const mapped = ACTIVITY_PUBLIC_ERRORS.find(
    (entry) => entry.reason === error.reason,
  );
  if (mapped === undefined) throw error;
  // A known Activity failure keeps its own public code; the reader's internal
  // reasons are what stay private, not the fact that the read failed.
  throw new AgentActivityFailure(mapped.code, mapped.message, mapped.action);
}
