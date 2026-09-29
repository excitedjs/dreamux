/**
 * The one TeamMate fact a caller can act on.
 *
 * It was a plain `Error`, which made it `INTERNAL` to every adapter: a caller
 * that named a TeamMate this dispatcher does not have was told that something
 * went wrong on the server, and had nothing to fix. It is an ordinary business
 * failure — the collection knows exactly what is true — so it carries its own
 * stable code like every other one, and only genuinely unclassified failures
 * stay `INTERNAL`.
 *
 * "Already closed" is deliberately not here: closing a closed TeamMate is the
 * operation succeeding, not failing, so the collection answers it from the
 * record instead of raising anything.
 */
import { StatedFailure } from '../../platform/errors.js';

/**
 * There is no such TeamMate in this collection.
 *
 * A record that exists under another owner is the same fact: visibility is
 * physical scoping plus the roster predicate, so a wrong-scope name resolves as
 * a name that does not exist rather than as one the caller may not have.
 */
export class TeamMateNotFoundError extends StatedFailure {
  constructor(message: string) {
    super(
      'TEAMMATE_NOT_FOUND',
      message,
      'Re-read the TeamMate roster this surface offers and use an exact name ' +
        'from it; a guessed or misspelled name never resolves, and a closed ' +
        'TeamMate is found through history rather than the live roster.',
    );
  }
}

/**
 * The one sentence for a TeamMate that is not here.
 *
 * Three lookups reach it — a missing record, a record found under another
 * owner, and a name resolved out of scope — and a caller must not be able to
 * tell them apart, so they say it in the same words rather than each in its
 * own.
 */
export function teamMateNotFound(name: string): TeamMateNotFoundError {
  return new TeamMateNotFoundError(
    `TeamMate ${JSON.stringify(name)} does not exist`,
  );
}
