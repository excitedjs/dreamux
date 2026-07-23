/** Share one in-flight promise per key; a concurrent same-key call joins it. */
export function dedupe<T>(
  inFlight: Map<string, Promise<T>>,
  key: string,
  start: () => Promise<T>,
): Promise<T> {
  const existing = inFlight.get(key);
  if (existing !== undefined) return existing;
  const promise = start().finally(() => inFlight.delete(key));
  inFlight.set(key, promise);
  return promise;
}
