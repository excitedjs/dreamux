/**
 * The Command layer's failure vocabulary.
 *
 * There is no Command-specific error type: a Command fails with the same
 * {@link DreamuxError} tree every other layer uses, and every adapter reports
 * the same fields — the admin socket writes them into its NDJSON error
 * envelope, and the in-process Channel invoker rejects with the error itself so
 * a Channel can read `error.code` directly (it is structurally the published
 * `ChannelCommandError`). A {@link StatedFailure} additionally carries the next
 * step it authored, which travels beside its code and reason. Re-exported here
 * so a domain Command module has one import for the base, the generic failures,
 * and the one failure the registry owns.
 */
import { errorMessage, RuleViolation } from '@excitedjs/dreamux-utils';

import {
  DreamuxError,
  StatedFailure,
  ValidationError,
} from '../platform/errors.js';

// eslint-disable-next-line no-restricted-syntax -- callers import the Command failure vocabulary from this module today (see file-level comment above), not from platform/errors.js or dreamux-utils directly
export {
  DreamuxError,
  InternalError,
  ServerShuttingDownError,
  StatedFailure,
  TransportError,
  ValidationError,
} from '../platform/errors.js';
// eslint-disable-next-line no-restricted-syntax -- same one-import convenience re-export as above, for the canonical helper's new home and the one shared rule-violation class
export { errorMessage, RuleViolation } from '@excitedjs/dreamux-utils';

/**
 * One Command failure, in the shape every adapter puts on its wire.
 *
 * The class the failure already is decides the shape, and nothing else does: a
 * {@link StatedFailure} carries the next step its own domain wrote, another
 * Dreamux failure carries the code it was given, and a value Core never
 * classified is reported as `INTERNAL` carrying the message it already had.
 * Core does not own that last message and does not rewrite it — a Node,
 * filesystem, provider, or library sentence is the most specific fact anyone
 * has about that failure.
 *
 * It exists so the admin socket and the in-process Channel port answer the
 * same way without either one keeping its own table.
 */
export interface CommandFailure {
  readonly code: string;
  readonly message: string;
  readonly action?: string;
}

export function commandFailure(error: unknown): CommandFailure {
  if (error instanceof StatedFailure) {
    return { code: error.code, message: error.message, action: error.action };
  }
  if (error instanceof DreamuxError) {
    return { code: error.code, message: error.message };
  }
  return { code: 'INTERNAL', message: errorMessage(error) };
}

/**
 * The sentence for one already-classified Command failure.
 *
 * `commandFailure` sets `action` for exactly the failures a domain stated for
 * itself, so `action === undefined` here means exactly "not one of those" —
 * the code and message travel as given, with no next step invented for a
 * failure that never authored one. When it is set, the reason is turned into
 * a full sentence and the action follows it, so a caller reads the same three
 * parts a stated failure's own author wrote.
 *
 * Takes a {@link CommandFailure} directly rather than only `unknown`, because
 * a value that already carries that exact shape — a Command failure that
 * crossed a wire and was reconstructed on the other side, for instance —
 * needs the same rendering without being re-classified as if it were a fresh
 * thrown value.
 */
export function commandFailureText(failure: CommandFailure): string {
  return failure.action === undefined
    ? `${failure.code}: ${failure.message}`
    : `${failure.code}: ${sentence(failure.message)} ${failure.action}`;
}

/**
 * The sentence for any thrown value, by the class it already is.
 *
 * Built on {@link commandFailure}'s own classification, so every caller gets
 * the same answer `commandFailure(err)` would already commit to, in one call.
 */
export function failureText(error: unknown): string {
  return commandFailureText(commandFailure(error));
}

/** A reason always ends as a sentence, whether or not its author ended it. */
function sentence(reason: string): string {
  const stated = reason.trim();
  if (stated === '') return 'No further detail is available.';
  return /[.!?]$/.test(stated) ? stated : `${stated}.`;
}

/**
 * Re-type one broken domain rule as the caller's mistake.
 *
 * The single narrowing a request reader performs: exactly a {@link
 * RuleViolation} becomes `BAD_REQUEST`, keeping the rule's own wording so the
 * caller reads which rule it broke. Anything else is rethrown untouched — an
 * unforeseen failure raised on a validation path is not a caller mistake, and
 * presenting it as one would tell the caller to fix an argument that is not
 * wrong. It keeps its own code and message instead.
 */
export function throwCallerMistake(error: unknown): never {
  if (error instanceof RuleViolation) throw new ValidationError(error.message);
  throw error;
}

/** No Command is registered under the requested name. */
export class UnknownCommandError extends StatedFailure {
  constructor(name: string) {
    super(
      'UNKNOWN_METHOD',
      `unknown method '${name}'`,
      'Call one of the methods this server publishes; the name is a Command ' +
        'name, not a tool name.',
    );
  }
}
