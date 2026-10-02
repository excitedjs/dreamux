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
