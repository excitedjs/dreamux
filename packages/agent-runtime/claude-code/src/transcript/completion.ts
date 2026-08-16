export interface ClaudeCompletionEntry {
  value: Record<string, unknown>;
}

export function hasAssistantWithoutHumanBoundary(
  entries: readonly ClaudeCompletionEntry[],
): boolean {
  return (
    entries.some(
      (entry) =>
        entry.value['type'] === 'assistant' &&
        entry.value['isSidechain'] !== true &&
        entry.value['isMeta'] !== true,
    ) &&
    !entries.some((entry) => isHumanPrompt(entry.value))
  );
}

export function hasCompletionEvidence(
  entries: readonly ClaudeCompletionEntry[],
): boolean {
  return entries.some((entry) => isCompletionMarker(entry.value));
}

export function hasOpenTail(
  entries: readonly ClaudeCompletionEntry[],
): boolean {
  let open = false;
  for (const entry of entries) {
    if (isHumanPrompt(entry.value)) open = true;
    if (isCompletionMarker(entry.value)) open = false;
  }
  return open;
}

export function isHumanPrompt(value: Record<string, unknown>): boolean {
  if (
    value['type'] !== 'user' ||
    value['isSidechain'] === true ||
    value['isMeta'] === true
  ) {
    return false;
  }
  const content = recordValue(value['message'])?.['content'];
  if (typeof content === 'string') return content !== '';
  if (!Array.isArray(content)) return false;
  return content.some((entry) => recordValue(entry)?.['type'] === 'text');
}

function isCompletionMarker(value: Record<string, unknown>): boolean {
  return (
    value['type'] === 'system' &&
    value['subtype'] === 'turn_duration' &&
    value['isSidechain'] !== true &&
    value['isMeta'] !== true
  );
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
