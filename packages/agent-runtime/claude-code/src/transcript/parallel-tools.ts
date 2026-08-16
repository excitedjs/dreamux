export interface ClaudeTranscriptEntry {
  start: number;
  value: Record<string, unknown>;
}

export function recoverParallelToolBranches<TEntry extends ClaudeTranscriptEntry>(
  entries: readonly TEntry[],
  chain: readonly TEntry[],
): TEntry[] {
  const seen = new Set(
    chain
      .map((entry) => stringValue(entry.value['uuid']))
      .filter((uuid): uuid is string => uuid !== null),
  );
  const chainAssistants = chain.filter(isEligibleAssistant);
  if (chainAssistants.length === 0) return [...chain];

  const anchorByMessageId = new Map<string, TEntry>();
  for (const assistant of chainAssistants) {
    const messageId = assistantMessageId(assistant);
    if (messageId !== null) anchorByMessageId.set(messageId, assistant);
  }

  const siblingsByMessageId = new Map<string, TEntry[]>();
  const toolResultsByAssistant = new Map<string, TEntry[]>();
  for (const entry of entries) {
    if (isEligibleAssistant(entry)) {
      const messageId = assistantMessageId(entry);
      if (messageId !== null) {
        pushMapValue(siblingsByMessageId, messageId, entry);
      }
      continue;
    }
    if (!isEligibleToolResult(entry)) continue;
    const parentUuid = stringValue(entry.value['parentUuid']);
    if (parentUuid !== null) {
      pushMapValue(toolResultsByAssistant, parentUuid, entry);
    }
  }

  const processedGroups = new Set<string>();
  const inserts = new Map<string, TEntry[]>();
  for (const assistant of chainAssistants) {
    const messageId = assistantMessageId(assistant);
    if (messageId === null || processedGroups.has(messageId)) continue;
    processedGroups.add(messageId);

    const group = siblingsByMessageId.get(messageId) ?? [assistant];
    const siblings = stableTimestampSort(
      group.filter((entry) => !isSeen(entry, seen)),
    );
    const toolResults: TEntry[] = [];
    for (const member of group) {
      const uuid = stringValue(member.value['uuid']);
      if (uuid === null) continue;
      for (const result of toolResultsByAssistant.get(uuid) ?? []) {
        if (!isSeen(result, seen)) toolResults.push(result);
      }
    }
    const recovered = [...siblings, ...stableTimestampSort(toolResults)];
    if (recovered.length === 0) continue;
    for (const entry of recovered) {
      const uuid = stringValue(entry.value['uuid']);
      if (uuid !== null) seen.add(uuid);
    }
    const anchor = anchorByMessageId.get(messageId);
    const anchorUuid =
      anchor === undefined ? null : stringValue(anchor.value['uuid']);
    if (anchorUuid !== null) inserts.set(anchorUuid, recovered);
  }

  if (inserts.size === 0) return [...chain];
  const result: TEntry[] = [];
  for (const entry of chain) {
    result.push(entry);
    const uuid = stringValue(entry.value['uuid']);
    if (uuid !== null) result.push(...(inserts.get(uuid) ?? []));
  }
  return result;
}

function assistantMessageId(
  entry: ClaudeTranscriptEntry,
): string | null {
  return stringValue(recordValue(entry.value['message'])?.['id']);
}

function isEligibleAssistant<TEntry extends ClaudeTranscriptEntry>(
  entry: TEntry,
): boolean {
  return (
    entry.value['type'] === 'assistant' &&
    entry.value['isSidechain'] !== true &&
    entry.value['isMeta'] !== true
  );
}

function isEligibleToolResult<TEntry extends ClaudeTranscriptEntry>(
  entry: TEntry,
): boolean {
  if (
    entry.value['type'] !== 'user' ||
    entry.value['isSidechain'] === true ||
    entry.value['isMeta'] === true
  ) {
    return false;
  }
  const content = recordValue(entry.value['message'])?.['content'];
  return (
    Array.isArray(content) &&
    content.some((block) => recordValue(block)?.['type'] === 'tool_result')
  );
}

function stableTimestampSort<TEntry extends ClaudeTranscriptEntry>(
  entries: readonly TEntry[],
): TEntry[] {
  return [...entries].sort((left, right) => {
    const timestampOrder = compareCodeUnits(timestamp(left), timestamp(right));
    return timestampOrder !== 0 ? timestampOrder : left.start - right.start;
  });
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function timestamp(entry: ClaudeTranscriptEntry): string {
  return stringValue(entry.value['timestamp']) ?? '';
}

function isSeen(
  entry: ClaudeTranscriptEntry,
  seen: ReadonlySet<string>,
): boolean {
  const uuid = stringValue(entry.value['uuid']);
  return uuid !== null && seen.has(uuid);
}

function pushMapValue<TKey, TValue>(
  map: Map<TKey, TValue[]>,
  key: TKey,
  value: TValue,
): void {
  const entries = map.get(key);
  if (entries === undefined) map.set(key, [value]);
  else entries.push(value);
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}
