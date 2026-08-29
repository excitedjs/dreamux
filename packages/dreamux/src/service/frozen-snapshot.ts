/**
 * Freeze a fact Core has published, in place.
 *
 * A sealed event and a frozen tool catalog are values their holders keep
 * across turns. Freezing them keeps a later mutation — by Core or by whoever
 * received them — from rewriting something already broadcast.
 */
export function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) {
    return value;
  }
  for (const nested of Object.values(value)) deepFreeze(nested);
  return Object.freeze(value);
}
