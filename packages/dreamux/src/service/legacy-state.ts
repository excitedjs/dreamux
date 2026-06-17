import { access } from 'node:fs/promises';
import { join } from 'node:path';

import { isNotFound } from '../platform/fs-errors.js';
import { dispatcherTeamDir, dispatcherTeamMateDir } from '../platform/paths.js';

/**
 * Fail-loud detection of pre-#233 local state (issue #199 Slice 5, extended by
 * issue #233). Dreamux 0.x does not migrate state automatically (issue #98): a
 * leftover from a server that ran an earlier layout is a hard upgrade blocker the
 * operator resolves by deleting the named path and letting the current symmetric
 * directory-per-entity layout rebuild. Like `assertNoLegacyAdminServer`, this is
 * detection only — the legacy paths are probed, never read for migration,
 * rewritten, or removed.
 *
 * #233 replaced the flat per-name files with a directory per entity:
 *   teammate/records/<name>.json + teammate/turns/<name>.jsonl
 *     → teammate/<name>/{identity.json, turn.jsonl}
 *   team/records/<team>.json
 *     → team/<team>/record.json (+ leader identity.json/turn.jsonl + members)
 *   team/channel-bindings.json
 *     → channel-bindings.json at the dispatcher root
 * The `teammate/` and `team/` directories themselves stay valid (they now hold
 * the per-entity dirs), so detection probes the specific removed leaves, not the
 * parents. The reserved-name guard (`assertNotReservedAgentName`) keeps a real
 * entity dir from recreating one of these leaf names.
 */

export interface LegacyStateFinding {
  /** The leftover path that this version no longer reads. */
  path: string;
  /** What it was and what replaced it, for the rebuild message. */
  what: string;
}

/**
 * Marks a deliberate pre-#199 old-state rejection (a removed field in a present
 * record, or a record still keyed the old way) as distinct from a genuinely
 * corrupt/unreadable file. The list chokepoint re-throws this so old state fails
 * loud on `list`/`history` instead of being silently skipped, while a
 * malformed/partial record may still be tolerated.
 */
export class LegacyStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LegacyStateError';
  }
}

/**
 * State paths the #199 Epic and the #233 refactor removed or renamed, anchored on
 * the canonical per-dispatcher state-dir builders so the leaf names are the only
 * historical constants here (the live builders for these were deleted with each
 * change). Probes the specific removed leaves — `teammate/` and `team/` stay
 * valid as the new per-entity collection roots.
 */
function removedStatePaths(dispatcherId: string): LegacyStateFinding[] {
  const teammate = dispatcherTeamMateDir(dispatcherId);
  const team = dispatcherTeamDir(dispatcherId);
  return [
    {
      path: join(teammate, 'identities'),
      what: 'pre-#199 TeamMate identities directory, replaced by teammate/<name>/identity.json',
    },
    {
      path: join(teammate, 'records'),
      what: 'pre-#233 flat TeamMate records directory, replaced by teammate/<name>/identity.json',
    },
    {
      path: join(teammate, 'turns'),
      what: 'pre-#233 flat TeamMate turns directory, replaced by teammate/<name>/turn.jsonl',
    },
    {
      path: join(teammate, 'sessions.jsonl'),
      what: 'pre-#199 TeamMate/Team session ledger, replaced by per-entity teammate/<name>/turn.jsonl',
    },
    {
      path: join(teammate, 'history'),
      what: 'pre-#182 per-name TeamMate history index, folded into the identity plus the turn archive',
    },
    {
      path: join(team, 'records'),
      what: 'pre-#233 flat Team records directory, replaced by team/<team>/record.json',
    },
    {
      path: join(team, 'channel-bindings.json'),
      what: 'pre-#233 Team-scoped channel bindings, moved to channel-bindings.json at the dispatcher root',
    },
    {
      path: join(team, 'ledger'),
      what: 'pre-#199 Team audit ledger, removed (Team history now reads team/<team>/record.json)',
    },
  ];
}

/** Return the removed-state paths that still exist for a dispatcher. */
export async function detectLegacyDispatcherState(
  dispatcherId: string,
): Promise<LegacyStateFinding[]> {
  const findings: LegacyStateFinding[] = [];
  for (const candidate of removedStatePaths(dispatcherId)) {
    if (await pathExists(candidate.path)) findings.push(candidate);
  }
  return findings;
}

/** Render the rebuild guidance for one dispatcher's legacy-state findings. */
export function legacyDispatcherStateMessage(
  dispatcherId: string,
  findings: LegacyStateFinding[],
): string {
  const lines = findings.map((finding) => `  - ${finding.path} (${finding.what})`);
  return (
    `dispatcher ${dispatcherId} has pre-#199 local state this version no longer reads:\n` +
    `${lines.join('\n')}\n` +
    'Dreamux 0.x does not migrate old state. Delete the listed path(s); the current ' +
    'records + per-name turns layout rebuilds on the next run. The files are left untouched.'
  );
}

/**
 * Reject a persisted JSON record that still carries a field the #199 Epic
 * removed. The single chokepoint shared by the record/identity readers so a
 * stale field is a loud, named rebuild signal rather than a silently-ignored
 * key. `rebuild` names the concrete remedy (which file to delete / what to
 * recreate).
 */
export function assertNoRemovedRecordFields(
  label: string,
  value: Record<string, unknown>,
  removed: readonly string[],
  rebuild: string,
): void {
  const present = removed.filter((key) =>
    Object.prototype.hasOwnProperty.call(value, key),
  );
  if (present.length > 0) {
    throw new LegacyStateError(
      `${label} carries fields removed in issue #199 (${present.join(', ')}). ` +
        `Dreamux 0.x does not migrate old state — ${rebuild}`,
    );
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch (err) {
    // Only a missing entry counts as "not present". A different access error
    // (e.g. EACCES) is a real problem the operator must see, not silent absence.
    if (isNotFound(err)) return false;
    throw err;
  }
}
