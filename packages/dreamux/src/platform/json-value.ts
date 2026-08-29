/**
 * Core's JSON-compatibility boundary for provider-supplied data.
 *
 * Two seams hand Core opaque values it must persist or republish verbatim: a
 * provider's own session identity and its public capability config. Both are
 * documented as JSON, but nothing in the type system enforces it, and a plain
 * `JSON.stringify` reshapes silently — it erases functions and `undefined`,
 * turns array holes into `null`, drops extra array properties, skips symbol and
 * non-enumerable own keys, folds `-0` to `0`, calls `toJSON`, unwraps boxed
 * primitives, and throws on cycles and BigInt.
 *
 * So the canonical value is produced in three steps: validate the provider's
 * value and reject everything a round trip would reshape, serialize once, and
 * return the *parsed* result. What Core keeps is therefore literally the value
 * a reader gets back from the persisted bytes, by construction rather than by
 * argument. The frozen copy also means a provider stays free to mutate the
 * object it returned without changing what Core validated.
 */
import { Buffer } from 'node:buffer';

import type { JsonValue } from '@excitedjs/dreamux-types';

/** Raised by {@link canonicalJsonValue}; callers wrap it in their own error. */
export class JsonValueError extends Error {
  override readonly name = 'JsonValueError';
}

export interface JsonValueBounds {
  /** Maximum container nesting, counting the root as level 0. */
  maxDepth: number;
  /** Maximum entries in any one array or object. */
  maxEntries: number;
  /** Maximum serialized size of the whole value. */
  maxBytes: number;
}

/**
 * Bounds that impose no size policy at all.
 *
 * Structural safety still applies — cycles, non-JSON types, foreign prototypes,
 * holes, and hidden keys are still rejected, and the value is still
 * canonicalized and frozen. Only the depth/entry/byte ceilings are lifted.
 *
 * Use it for a value Core itself produced, where a generic ceiling would be an
 * arbitrary cutoff rather than a real policy. Some producers do bound their own
 * result (activity pages, `*.history` cursors) and some do not — a roster
 * listing grows with the persisted entities — but no product path produces an
 * arbitrarily large one, and the answer for a result that does grow is
 * pagination owned by its domain. Never use it for untrusted input: that is what
 * an explicit {@link JsonValueBounds} is for.
 */
export const JSON_VALUE_UNBOUNDED: JsonValueBounds = {
  maxDepth: Number.POSITIVE_INFINITY,
  maxEntries: Number.POSITIVE_INFINITY,
  maxBytes: Number.POSITIVE_INFINITY,
};

/**
 * Validate `value` as JSON and return the frozen value a persist/read round
 * trip yields.
 */
export function canonicalJsonValue(
  value: unknown,
  bounds: JsonValueBounds,
): JsonValue {
  const validated = validateJsonValue(value, bounds, 0, new Set());
  // Validation rejected every value `JSON.stringify` would drop or reshape, so
  // the result is always a JSON document rather than `undefined`.
  const text = JSON.stringify(validated) as string;
  if (Buffer.byteLength(text, 'utf8') > bounds.maxBytes) {
    throw new JsonValueError(`value exceeds the ${bounds.maxBytes}-byte budget`);
  }
  // Parsing back is what makes the canonical value the persisted value: it also
  // restores an own `"__proto__"` key as plain data, which building an object
  // by assignment cannot do.
  return deepFreeze(JSON.parse(text) as JsonValue);
}

/**
 * Copy `value` into a null-prototype JSON skeleton, rejecting anything that
 * would not survive a round trip unchanged.
 *
 * Containers are built with `Object.create(null)` so an own `"__proto__"` key
 * is stored as data instead of invoking `Object.prototype`'s setter, which
 * would silently drop it or repoint the copy's prototype.
 */
function validateJsonValue(
  value: unknown,
  bounds: JsonValueBounds,
  depth: number,
  seen: Set<object>,
): JsonValue {
  if (value === null) return null;
  const type = typeof value;
  if (type === 'string' || type === 'boolean') return value as JsonValue;
  if (type === 'number') {
    if (!Number.isFinite(value)) {
      throw new JsonValueError('numbers must be finite');
    }
    // `JSON.stringify(-0)` is `"0"`, so `-0` cannot survive a round trip.
    // Canonicalize it to the value the persisted bytes parse back as.
    return Object.is(value, -0) ? 0 : (value as number);
  }
  if (type !== 'object') {
    // `undefined`, functions, and symbols vanish or turn into `null` in a JSON
    // round trip; BigInt throws. None of them survive as the same value.
    throw new JsonValueError(`values of type ${type} are not JSON-serializable`);
  }
  if (depth >= bounds.maxDepth) {
    throw new JsonValueError(`value nests deeper than ${bounds.maxDepth} levels`);
  }
  const container = value as object;
  if (seen.has(container)) throw new JsonValueError('value contains a cycle');
  seen.add(container);
  try {
    if (Array.isArray(value)) {
      return validateArray(value, bounds, depth, seen);
    }
    if (!isPlainObject(value)) {
      // Boxed primitives, `Date`, class instances, and anything else carrying a
      // foreign prototype are serialized as some *other* value (a string, a
      // number, a `toJSON` result), never as themselves.
      throw new JsonValueError('only plain objects and arrays are persistable');
    }
    const entries = Object.entries(value);
    assertEntryCount(entries.length, bounds, 'objects');
    // JSON carries enumerable own string keys and nothing else. A symbol key or
    // a hidden (non-enumerable) own key would be dropped, so the persisted
    // object would silently be missing state this value still holds.
    if (Object.getOwnPropertySymbols(value).length > 0) {
      throw new JsonValueError('objects must not carry own symbol keys');
    }
    if (Object.getOwnPropertyNames(value).length !== entries.length) {
      throw new JsonValueError('objects must not carry non-enumerable own keys');
    }
    const out = Object.create(null) as Record<string, JsonValue>;
    for (const [key, entry] of entries) {
      out[key] = validateJsonValue(entry, bounds, depth + 1, seen);
    }
    return out as JsonValue;
  } finally {
    seen.delete(container);
  }
}

function validateArray(
  value: readonly unknown[],
  bounds: JsonValueBounds,
  depth: number,
  seen: Set<object>,
): JsonValue {
  assertEntryCount(value.length, bounds, 'arrays');
  // JSON represents exactly the dense element slots: a hole serializes as
  // `null`, and every other own key — extra, hidden, or symbol — is dropped.
  // So the canonical own-key set is `length` plus the enumerable indices
  // `0..length-1`, and anything else is rejected rather than quietly lost.
  if (Object.getOwnPropertySymbols(value).length > 0) {
    throw new JsonValueError('arrays must not carry own symbol keys');
  }
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.hasOwn(value, index)) {
      throw new JsonValueError('arrays must not contain holes');
    }
  }
  // Every index is present, and `length` always is, so an own-name count above
  // `length + 1` is an extra key of either visibility.
  if (Object.getOwnPropertyNames(value).length !== value.length + 1) {
    throw new JsonValueError(
      'arrays must not carry own keys beyond their elements',
    );
  }
  if (Object.keys(value).length !== value.length) {
    throw new JsonValueError('array elements must be enumerable');
  }
  const out: JsonValue[] = [];
  for (const entry of value) {
    out.push(validateJsonValue(entry, bounds, depth + 1, seen));
  }
  return out;
}

function assertEntryCount(
  count: number,
  bounds: JsonValueBounds,
  kind: string,
): void {
  if (count > bounds.maxEntries) {
    throw new JsonValueError(
      `${kind} may hold at most ${bounds.maxEntries} entries`,
    );
  }
}

function deepFreeze(value: JsonValue): JsonValue {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) {
    for (const entry of value) deepFreeze(entry);
    return Object.freeze(value);
  }
  for (const entry of Object.values(value)) deepFreeze(entry);
  return Object.freeze(value);
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const proto = Object.getPrototypeOf(value) as object | null;
  return proto === Object.prototype || proto === null;
}
