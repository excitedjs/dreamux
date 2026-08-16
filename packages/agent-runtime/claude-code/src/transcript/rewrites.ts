export interface ClaudeRewriteEntry {
  value: Record<string, unknown>;
}

export function applyNativeRewrites<TEntry extends ClaudeRewriteEntry>(
  entries: readonly TEntry[],
): TEntry[] {
  const removed = new Set<string>();
  for (const entry of entries) {
    const metadata = recordValue(entry.value['snipMetadata']);
    const uuids = metadata?.['removedUuids'];
    if (Array.isArray(uuids)) {
      for (const uuid of uuids) {
        if (typeof uuid === 'string') removed.add(uuid);
      }
    }
  }
  const byId = new Map<string, TEntry>();
  const parentById = new Map<string, string | null>();
  for (const entry of entries) {
    const uuid = stringValue(entry.value['uuid']);
    if (uuid === null) continue;
    parentById.set(uuid, stringValue(entry.value['parentUuid']));
    if (!removed.has(uuid)) byId.set(uuid, entry);
  }
  if (removed.size === 0) return [...byId.values()];

  const resolvedParents = new Map<string, string | null>();
  const resolveParent = (uuid: string): string | null => {
    if (resolvedParents.has(uuid)) return resolvedParents.get(uuid) ?? null;
    const path: string[] = [];
    const seen = new Set<string>();
    let current: string | null = uuid;
    while (
      current !== null &&
      removed.has(current) &&
      !seen.has(current)
    ) {
      seen.add(current);
      path.push(current);
      if (resolvedParents.has(current)) {
        current = resolvedParents.get(current) ?? null;
        break;
      }
      current = parentById.get(current) ?? null;
    }
    const resolved = current !== null && seen.has(current) ? null : current;
    for (const removedUuid of path) {
      resolvedParents.set(removedUuid, resolved);
    }
    return resolved;
  };

  for (const entry of byId.values()) {
    let parent = stringValue(entry.value['parentUuid']);
    if (parent !== null && removed.has(parent)) parent = resolveParent(parent);
    entry.value['parentUuid'] = parent;
  }
  return [...byId.values()];
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}
