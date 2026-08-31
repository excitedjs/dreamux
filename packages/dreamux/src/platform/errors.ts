/**
 * Dreamux's error base and its small set of generic failures.
 *
 * Every failure a caller may see is an ordinary `Error` subclass carrying a
 * stable `code`. That code — not the class — is the wire vocabulary: the admin
 * socket writes `{code, message}` into its NDJSON envelope, the in-process
 * Channel invoker rejects with the same object shape (structurally the
 * published `ChannelCommandError`), and MCP adapters render it into one concise
 * sentence. The inheritance tree is an implementation detail that
 * never crosses a process boundary, so there is no layer, category, or
 * retryability taxonomy on it.
 *
 * Only three generic subclasses exist, because only three failure origins are
 * generic:
 *
 * - {@link ValidationError} — the request itself is wrong;
 * - {@link TransportError} — a cross-process framing, connection, or delivery
 *   failure, before any Command could run;
 * - {@link InternalError} — an implementation failure nobody classified.
 *
 * Everything else is a business failure and extends {@link StatedFailure} in the
 * domain that owns it, so a known failure keeps its own type and code instead of
 * collapsing into `INTERNAL`.
 *
 * Every failure is answered to whoever asked, including an unclassified one:
 * what {@link StatedFailure} decides is not *whether* a caller is told, but
 * whether a next step comes with the answer. A stated failure is rendered with
 * the step its own author wrote; anything else is rendered under the code it
 * has — or `INTERNAL` when it has none — carrying the message it already had,
 * because Core does not own those words and inventing a replacement would
 * delete the only concrete fact anyone has. The stack stays out of the answer
 * and goes to the log.
 */

/**
 * Abstract on purpose: a failure with no class is a failure nobody named, and
 * the one thing this tree exists to prevent is a code invented at a throw site.
 */
export abstract class DreamuxError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

/**
 * A failure whose own author wrote what to say about it.
 *
 * Two halves, both required: a `reason` that states the fact in this domain's
 * own words, and an `action` that says what to do next. Requiring them at
 * construction is the whole mechanism — there is no flag to set, no table to
 * keep, and no way to declare a failure public after the fact. A subclass that
 * cannot write an action for itself is a subclass that does not know what
 * happened, and it belongs on the other branch.
 *
 * The reason must be self-authored. Never pass another error's message through
 * it: a stated failure promises that its reason and its next step were written
 * by the same domain, and a caught message makes that promise false — the step
 * would be advice about a failure this class never diagnosed. Such a failure is
 * reported under its own code and its own message instead, with no next step.
 *
 * `message` is the reason, so the wire shape every adapter already writes —
 * `{code, message}` — is unchanged, and `action` rides beside it for the
 * adapters that carry it.
 */
export abstract class StatedFailure extends DreamuxError {
  protected constructor(
    code: string,
    reason: string,
    readonly action: string,
  ) {
    super(code, reason);
  }
}

/**
 * The caller sent something this request cannot accept: a malformed payload, an
 * out-of-range field, or a scope the caller may not address. `BAD_REQUEST` is
 * the single code because the distinction that matters to a caller is "fix your
 * request", and the message names the exact field.
 */
export class ValidationError extends StatedFailure {
  constructor(message: string) {
    super(
      'BAD_REQUEST',
      message,
      'Correct the named argument and call this tool again.',
    );
  }
}

/**
 * A cross-process framing, connection, or delivery failure — the request never
 * reached a Command.
 *
 * It carries its own `TRANSPORT_ERROR` code rather than borrowing
 * `BAD_REQUEST`: a socket that was not there, a response that never arrived,
 * and a reply that could not be framed are not defects in the caller's request,
 * and reporting them as one sends the caller to fix the wrong thing. Server-side
 * invalid params remain {@link ValidationError}.
 */
export class TransportError extends DreamuxError {
  constructor(message: string) {
    super('TRANSPORT_ERROR', message);
  }
}

/**
 * An implementation failure nobody classified. Reported as `INTERNAL` so no
 * adapter presents it as something the caller can fix; only genuinely unknown
 * failures belong here, never an ordinary known one.
 */
export class InternalError extends DreamuxError {
  constructor(message: string) {
    super('INTERNAL', message);
  }
}

/**
 * A domain rule said no.
 *
 * Deliberately *not* a {@link DreamuxError}: a rule is checked on more than one
 * kind of path, and only the caller's own request makes breaking it the
 * caller's fault. The reader that knows a value came from a caller re-types
 * exactly this class as {@link ValidationError}; the same rule broken by
 * persisted state stays unclassified and loud, because nothing the caller can
 * send would fix it.
 *
 * It exists so a request reader can narrow to one named type instead of
 * catching everything a validator might throw. A `TypeError` raised inside a
 * validation path is not a rule violation, and reporting it as the caller's
 * mistake both misleads the caller and states, in a failure's own words, a next
 * step that would not help. Such a failure keeps its own message and is
 * reported under `INTERNAL` instead.
 */
export class RuleViolation extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/** The process refused the request because shutdown already closed admission. */
export class ServerShuttingDownError extends StatedFailure {
  constructor() {
    super(
      'SERVER_SHUTTING_DOWN',
      'dreamux server is shutting down',
      'Nothing was started by this call. Wait for the operator to bring the ' +
        'server back, then call again.',
    );
  }
}

/** The message of an arbitrary thrown value, for wrapping into a typed error. */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
