import type { AgentEntityCollectionStore } from '../agent-entity/identity-store.js';
import type { AgentEntityIdentity } from '../agent-entity/types.js';
import {
  collectShutdownFailure,
  throwShutdownFailures,
} from '../shutdown-errors.js';
import type { TeammateService } from '../teammate-service/index.js';

/**
 * Close every member of a dissolving Team.
 *
 * A Team's members are of two kinds, and each is closed as what it is. One this
 * process holds is closed through its own entity, so its runtime stops, its
 * turn settles, and its terminal is published exactly as in any other close —
 * that is what keeps a dissolve from leaving a child process burning tokens
 * behind a Team that no longer exists. One that exists only as a record has no
 * runtime to stop: this process is the only place a TeamMate runs, so a record
 * it never materialized is not running anywhere. Its record is stated closed
 * where it lives, because building an entity for it would start an Agent in
 * order to stop it.
 *
 * A record is normalized, never reclaimed. The Team lent these members its
 * directory and the checkout under it stays the Team's own to clean.
 *
 * Held members are excluded from the record pass by identity rather than by the
 * status they ended up with, so a member whose close failed surfaces as that
 * failure instead of being declared closed with a runtime still live.
 */
export async function closeMembersForDissolve(input: {
  teamId: string;
  note: string;
  held: readonly TeammateService[];
  roster: readonly AgentEntityIdentity[];
  store: AgentEntityCollectionStore;
}): Promise<void> {
  const failures: unknown[] = [];
  for (const member of input.held) {
    await collectShutdownFailure(failures, async () => {
      await member.close({ note: input.note });
    });
  }
  const held = new Set(input.held.map((member) => member.name));
  const closedAt = Date.now();
  for (const identity of input.roster) {
    if (identity.status === 'closed' || held.has(identity.name)) continue;
    await collectShutdownFailure(failures, async () => {
      await input.store.entity(identity.name).update(identity, {
        status: 'closed',
        closedAt,
        closeNote: input.note,
      });
    });
  }
  throwShutdownFailures(
    failures,
    `Team ${JSON.stringify(input.teamId)} members did not close for dissolve`,
  );
}
