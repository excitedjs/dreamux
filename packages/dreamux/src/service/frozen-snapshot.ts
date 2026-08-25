/**
 * Deep, immutable snapshots of provider-supplied JSON facts.
 *
 * Core publishes binding endpoints and channel origins to channel providers as
 * long-lived values a provider may hold across turns. Snapshotting them here
 * keeps a later mutation of the source row — or a provider mutating what it
 * received — from rewriting an already-broadcast fact.
 */
export function immutableJsonSnapshot<T>(value: T): T {
  const encoded = JSON.stringify(value);
  // `undefined` (and any other value JSON drops) has no snapshot to take; it is
  // already immutable, so return it rather than throwing into a caller whose
  // real work — routing a turn — must not depend on this projection.
  return encoded === undefined ? value : (deepFreeze(JSON.parse(encoded)) as T);
}

export function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) {
    return value;
  }
  for (const nested of Object.values(value)) deepFreeze(nested);
  return Object.freeze(value);
}
