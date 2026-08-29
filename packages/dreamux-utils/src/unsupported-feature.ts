/**
 * Structural shape of the `Error` a runtime returns when a caller asked for a
 * neutral feature it cannot serve. Callers branch on `name` and `feature`
 * rather than `instanceof`, so the shape crosses a package edge without a
 * shared class, and it is declared beside the constructor and the predicate
 * that are its only producer and reader.
 */
export interface UnsupportedAgentRuntimeFeatureError extends Error {
  name: 'UnsupportedAgentRuntimeFeatureError';
  feature: string;
}

export function unsupportedFeatureError(
  feature: string,
  message: string,
): UnsupportedAgentRuntimeFeatureError {
  return Object.assign(new Error(message), {
    name: 'UnsupportedAgentRuntimeFeatureError' as const,
    feature,
  });
}

export function isUnsupportedFeatureError(
  error: unknown,
  feature?: string,
): error is UnsupportedAgentRuntimeFeatureError {
  if (typeof error !== 'object' || error === null) return false;
  const candidate = error as { name?: unknown; feature?: unknown };
  return candidate.name === 'UnsupportedAgentRuntimeFeatureError' &&
    typeof candidate.feature === 'string' &&
    (feature === undefined || candidate.feature === feature);
}
