/**
 * Generic JSON-shape primitives for reading untyped input — no config
 * vocabulary, no error-message formatting, just shape checks any caller
 * (config, plugin manifests, MCP payloads) can build its own messages on top
 * of.
 */

/** True when `v` is a non-null object and not an array, and therefore safe to index. */
export function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/** `v` when it is a string, otherwise `undefined`. */
export function asString(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

/** `v` when it is a non-empty string, otherwise `undefined`. */
export function nonEmptyString(v: unknown): string | undefined {
  const s = asString(v);
  return s !== undefined && s !== '' ? s : undefined;
}
