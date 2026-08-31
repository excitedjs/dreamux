/**
 * One request, one result, in JSON.
 *
 * This is the smallest shape a caller and a callee can agree on without
 * agreeing on anything else: a named operation, a JSON payload, and a single
 * JSON answer that settles it. There is no subscription, no correlation id, no
 * push, and no partial delivery — a call that has not answered yet is simply a
 * promise that has not settled.
 *
 * It names no transport and no domain. Core binds it to its in-process Command
 * port and to the admin socket; nothing about either is visible here, which is
 * what lets a package that must not know Core still be handed one.
 */
import type { JsonValue } from './json.js';

export interface JsonInvoker {
  invoke(method: string, params: JsonValue): Promise<JsonValue>;
}

/**
 * A settled outcome an implementation chose to state, rather than throw.
 *
 * The distinction is the whole failure boundary. `ok: false` is a decision: the
 * implementation understood the request, refused it, and wrote a message it
 * accepts being read by whoever asked. Everything it did *not* decide — a bug,
 * a broken invariant, an unexpected exception — is never this. It stays an
 * exception, so the boundary that owns diagnostics logs it in full and answers
 * with its own sanitized wording.
 *
 * Because a refusal is data, it crosses a process or package edge as JSON. No
 * error class, error code, or thrown domain value has to be shared for one side
 * to tell the other exactly what was wrong.
 */
export type JsonInvokeResult<TValue = JsonValue> =
  | { readonly ok: true; readonly value: TValue }
  | { readonly ok: false; readonly message: string };
