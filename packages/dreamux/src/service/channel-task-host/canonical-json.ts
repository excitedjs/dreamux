export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

export function assertJsonDomain(value: unknown, seen = new Set<object>()): void {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new Error('task host WAL transaction contains a non-finite number');
    }
    return;
  }
  if (typeof value !== 'object') {
    throw new Error('task host WAL transaction contains a non-JSON value');
  }
  if (seen.has(value)) {
    throw new Error('task host WAL transaction contains a cycle');
  }
  seen.add(value);
  if (Array.isArray(value)) {
    for (const entry of value) assertJsonDomain(entry, seen);
  } else {
    for (const entry of Object.values(value as Record<string, unknown>)) {
      if (entry === undefined) {
        throw new Error('task host WAL transaction contains undefined');
      }
      assertJsonDomain(entry, seen);
    }
  }
  seen.delete(value);
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, sortValue(entry)]),
  );
}
