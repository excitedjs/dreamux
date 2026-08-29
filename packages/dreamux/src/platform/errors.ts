/**
 * Dreamux's error base and its small set of generic failures.
 *
 * Every failure a caller may see is an ordinary `Error` subclass carrying a
 * stable `code`. That code — not the class — is the wire vocabulary: the admin
 * socket writes `{code, message}` into its NDJSON envelope, the in-process
 * Channel invoker rejects with the same object shape (structurally the
 * published `ChannelCommandError`), and MCP adapters project it into one
 * concise public failure. The inheritance tree is an implementation detail that
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
 * Everything else is a business failure and extends {@link DreamuxError}
 * directly in the domain that owns it, so a known failure keeps its own type and
 * code instead of collapsing into `INTERNAL`.
 */

export class DreamuxError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

/**
 * The caller sent something this request cannot accept: a malformed payload, an
 * out-of-range field, or a scope the caller may not address. `BAD_REQUEST` is
 * the single code because the distinction that matters to a caller is "fix your
 * request", and the message names the exact field.
 */
export class ValidationError extends DreamuxError {
  constructor(message: string) {
    super('BAD_REQUEST', message);
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

/** The process refused the request because shutdown already closed admission. */
export class ServerShuttingDownError extends DreamuxError {
  constructor() {
    super('SERVER_SHUTTING_DOWN', 'dreamux server is shutting down');
  }
}

/**
 * The Command failure for an arbitrary thrown value.
 *
 * A failure that already carries a Dreamux code keeps its own type and code —
 * that is the whole point of business failures being real classes. Only a value
 * nobody classified becomes `INTERNAL`, so this must never be used to flatten a
 * known failure into a generic one.
 */
export function toDreamuxError(error: unknown): DreamuxError {
  return error instanceof DreamuxError
    ? error
    : new InternalError(errorMessage(error));
}

/** The message of an arbitrary thrown value, for wrapping into a typed error. */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
