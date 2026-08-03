import type { DreamuxLogger } from '@excitedjs/dreamux-types';

import {
  boundedLogText,
  LOG_ERROR_MAX_LENGTH,
} from '../../platform/log-fields.js';

export function teamDissolveLogFields(
  dispatcherId: string,
  teamName: string,
): Record<string, string> {
  return {
    dispatcher_id: boundedLogText(dispatcherId),
    team_name: boundedLogText(teamName),
  };
}

export function logTeamWorktreeCleanupResult(
  log: DreamuxLogger,
  fields: Record<string, string>,
  cleanup: { cleanup_state: string; cleanup_error: string | null },
): void {
  log.info(
    {
      ...fields,
      cleanup_state: cleanup.cleanup_state,
      cleanup_error: cleanup.cleanup_error === null
        ? null
        : boundedLogText(cleanup.cleanup_error, LOG_ERROR_MAX_LENGTH),
    },
    'Team worktree cleanup finished',
  );
}
