import type { AgentActivityRecord } from '@excitedjs/dreamux-types';

/** One parsed native line, positioned inside its own rollout segment. */
export interface CodexActivityLine {
  start: number;
  boundaryBytes: Buffer;
  value: Record<string, unknown>;
}

/** One neutral record, anchored to the native line that produced it. */
export interface CodexPositionedRecord {
  start: number;
  boundaryBytes: Buffer;
  record: AgentActivityRecord;
}

/**
 * Project chronological native lines into chronological neutral records.
 *
 * The projection is deliberately flat: it does not require a completed turn, so
 * an actively growing session yields records as soon as its lines are written.
 * Only assistant text and tool name/status cross the seam — never tool
 * arguments, tool results, or any native line shape.
 *
 * Codex writes an assistant message twice: a live `event_msg`/`agent_message`
 * first, then a finalized `response_item` message. They are two representations
 * of one fact, so exactly one is emitted — the live one, which is what makes an
 * in-progress turn visible before its response item exists.
 *
 * Pairing is therefore *directional*, matching the order Codex writes in: a
 * finalized record is dropped only when an earlier live record in this window
 * already stands for it. A live record is never suppressed, so an older
 * finalized message can never hide the active turn that happens to repeat its
 * text; the cost is that such a repeat is shown twice, once per real message.
 */
export function projectCodexActivity(
  lines: readonly CodexActivityLine[],
  includeTools: boolean,
): CodexPositionedRecord[] {
  const records: CodexPositionedRecord[] = [];
  const calls = new Map<string, CodexPositionedRecord>();
  const live = new LiveAssistantMessages();

  for (const line of lines) {
    const occurredAt = timestampIso(line.value['timestamp']);
    const type = stringValue(line.value['type']);
    const payload = recordValue(line.value['payload']);
    if (type === 'event_msg') {
      const eventType = stringValue(payload?.['type']);
      if (eventType === 'agent_message') {
        const text =
          stringValue(payload?.['message']) ?? stringValue(payload?.['text']);
        if (text !== null && text !== '') {
          live.observe(text);
          records.push(
            positioned(line, {
              kind: 'assistant_message',
              text,
              ...(occurredAt !== null ? { occurredAt } : {}),
            }),
          );
        }
      }
      continue;
    }
    if (type !== 'response_item' || payload === null) continue;
    const itemType = stringValue(payload['type']);
    if (itemType === 'message') {
      if (payload['role'] !== 'assistant') continue;
      const text = contentText(payload['content']);
      if (text === '') continue;
      if (!live.acceptFinalized(text)) continue;
      records.push(
        positioned(line, {
          kind: 'assistant_message',
          text,
          ...(occurredAt !== null ? { occurredAt } : {}),
        }),
      );
      continue;
    }
    if (itemType === 'function_call' || itemType === 'custom_tool_call') {
      if (!includeTools) continue;
      const callId = stringValue(payload['call_id']);
      const name = stringValue(payload['name']);
      if (callId === null || name === null) continue;
      const entry = positioned(line, {
        kind: 'tool',
        name,
        status: 'started',
        ...(occurredAt !== null ? { occurredAt } : {}),
      });
      calls.set(callId, entry);
      records.push(entry);
      continue;
    }
    if (
      itemType === 'function_call_output' ||
      itemType === 'custom_tool_call_output'
    ) {
      if (!includeTools) continue;
      const callId = stringValue(payload['call_id']);
      if (callId === null) continue;
      const entry = calls.get(callId);
      // An output whose call fell outside this window has no record to settle;
      // the call keeps its own 'started' record on the page that holds it.
      if (entry === undefined || entry.record.kind !== 'tool') continue;
      entry.record = {
        kind: 'tool',
        name: entry.record.name,
        status: nativeOutputHasError(payload) ? 'failed' : 'completed',
        ...(entry.record.occurredAt !== undefined
          ? { occurredAt: entry.record.occurredAt }
          : {}),
      };
    }
  }

  // Emission followed line order, so the result is already ascending by offset,
  // which is what the reader's newest-first walk assumes.
  return records;
}

/**
 * The live assistant messages seen so far that no finalized record has claimed.
 *
 * Chronology is directional: Codex always writes the live representation before
 * the finalized one, so only a *later* finalized record may be dropped, and only
 * when an *earlier* live record with the same text is still unclaimed. Nothing
 * a finalized record does can suppress a live record that comes after it.
 *
 * Text is the only identity the two native shapes share, so claims are counted
 * per text and consumed first-come. A window boundary can split a pair, leaving
 * the finalized half unclaimed on its own page — the same window-local artifact
 * the reader already tolerates, and the safe direction to err in.
 */
class LiveAssistantMessages {
  private readonly unclaimed = new Map<string, number>();

  /** Record a live representation. Live records are always emitted. */
  observe(text: string): void {
    this.unclaimed.set(text, (this.unclaimed.get(text) ?? 0) + 1);
  }

  /** True when no earlier live record already stands for this message. */
  acceptFinalized(text: string): boolean {
    const outstanding = this.unclaimed.get(text) ?? 0;
    if (outstanding === 0) return true;
    if (outstanding === 1) this.unclaimed.delete(text);
    else this.unclaimed.set(text, outstanding - 1);
    return false;
  }
}

function positioned(
  line: CodexActivityLine,
  record: AgentActivityRecord,
): CodexPositionedRecord {
  return { start: line.start, boundaryBytes: line.boundaryBytes, record };
}

function contentText(value: unknown): string {
  if (!Array.isArray(value)) return '';
  return value
    .flatMap((entry) => {
      const item = recordValue(entry);
      const type = stringValue(item?.['type']);
      const text = stringValue(item?.['text']);
      return (type === 'input_text' ||
        type === 'output_text' ||
        type === 'text') &&
        text !== null
        ? [text]
        : [];
    })
    .join('');
}

function nativeOutputHasError(value: Record<string, unknown>): boolean {
  if (value['is_error'] === true) return true;
  const status = stringValue(value['status']);
  if (status === 'error' || status === 'failed') return true;
  const output = value['output'];
  return (
    Array.isArray(output) &&
    output.some((entry) => recordValue(entry)?.['is_error'] === true)
  );
}

function timestampIso(value: unknown): string | null {
  const millis = timestampMs(value);
  if (millis === null) return null;
  const date = new Date(millis);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function timestampMs(value: unknown): number | null {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return null;
    return value < 10_000_000_000 ? value * 1000 : value;
  }
  if (typeof value !== 'string') return null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}
