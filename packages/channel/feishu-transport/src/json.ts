/**
 * Tiny structural helpers for reading untyped JSON — the shape every raw
 * Feishu event payload arrives in. Used across the event parsers, which
 * decode their payloads defensively. `isRecord`/`asString` are ported
 * verbatim from claudemux.
 */

/** True when `v` is a non-null object, and therefore safe to index. */
export function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object';
}

/** `v` when it is a string, otherwise the empty string. */
export function asString(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

/**
 * `v` narrowed to a plain object, excluding arrays — every event field this
 * package reads by key expects an object, not a list.
 */
export function asRecord(v: unknown): Record<string, unknown> | undefined {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : undefined;
}

/** The first string among `values`, or the empty string when none is one. */
export function firstString(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value === 'string') return value;
  }
  return '';
}
