import type { DreamuxLogger } from '@excitedjs/dreamux-types';

import { errorInfo } from '@excitedjs/dreamux-utils';
import type { TeamCollection } from '../team/index.js';

/** Release the runtime authority this process took over its Teams. */
export async function stopTeamRuntimes(input: {
  dispatcherId: string;
  teams: TeamCollection;
  log: DreamuxLogger;
}): Promise<unknown | null> {
  try {
    await input.teams.stopForHost();
    return null;
  } catch (err) {
    input.log.error(
      { dispatcher_id: input.dispatcherId, err: errorInfo(err) },
      'error stopping Team runtimes',
    );
    return err;
  }
}
