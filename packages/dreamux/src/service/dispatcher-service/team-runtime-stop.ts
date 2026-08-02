import type { DreamuxLogger } from '@excitedjs/dreamux-types';

import { errorInfo } from '../../platform/error-info.js';
import type { TeamCollection } from '../team-collection/index.js';

/** Sweep all materialized Team runtimes while allowing dispatcher stop to continue. */
export async function stopTeamRuntimes(input: {
  dispatcherId: string;
  teams: TeamCollection;
  log: DreamuxLogger;
}): Promise<unknown | null> {
  try {
    await input.teams.stopAll();
    return null;
  } catch (err) {
    input.log.error(
      { dispatcher_id: input.dispatcherId, err: errorInfo(err) },
      'error stopping Team runtimes',
    );
    return err;
  }
}
