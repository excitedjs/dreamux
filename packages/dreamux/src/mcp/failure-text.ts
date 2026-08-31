/**
 * How one failure becomes the sentence a caller reads.
 *
 * Two shapes, decided by who owns the fact:
 *
 * - a {@link StatedFailure} was written by the domain that raised it — a stable
 *   code, a reason in that domain's own words, and the next step it knows — so
 *   all three are rendered;
 * - anything else keeps its own code, or `INTERNAL` when it never had one, and
 *   its own message. Core does not own that failure, so Core does not re-author
 *   it: a Node, filesystem, provider, or library message is the most specific
 *   thing anybody has, and replacing it with a Core sentence would delete the
 *   only fact in the room. The stack stays out of the result; the message does
 *   not.
 *
 * There is no code list, no allowlist, and no policy table: the class the
 * failure already is decides which of the two shapes it takes.
 */
import { DreamuxError, StatedFailure, errorMessage } from '../platform/errors.js';

/** One failure exactly as its own domain stated it. */
export function statedFailureText(error: {
  code: string;
  message: string;
  action: string;
}): string {
  return `${error.code}: ${sentence(error.message)} ${error.action}`;
}

/** One failure under a code that is already on the wire. */
export function codedFailureText(code: string, message: string): string {
  return `${code}: ${message}`;
}

/** One failure Core does not own, under the code it has or `INTERNAL`. */
export function unclassifiedFailureText(error: unknown): string {
  const code = error instanceof DreamuxError ? error.code : 'INTERNAL';
  return codedFailureText(code, errorMessage(error));
}

/** The sentence for any thrown value, by the class it already is. */
export function failureText(error: unknown): string {
  return error instanceof StatedFailure
    ? statedFailureText(error)
    : unclassifiedFailureText(error);
}

/** A reason always ends as a sentence, whether or not its author ended it. */
function sentence(reason: string): string {
  const stated = reason.trim();
  if (stated === '') return 'No further detail is available.';
  return /[.!?]$/.test(stated) ? stated : `${stated}.`;
}
