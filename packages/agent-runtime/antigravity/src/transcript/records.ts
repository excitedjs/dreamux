/**
 * Decoding for the native `transcript_full.jsonl` record shapes written by
 * Antigravity CLI (`agy`) 1.5.15.
 *
 * Every line is one self-contained JSON object. Observed native vocabulary:
 *   - `USER_INPUT` (`source: "USER_EXPLICIT"`): one submitted composer input,
 *     wrapped in agy's `<USER_REQUEST>` envelope;
 *   - `PLANNER_RESPONSE` (`source: "MODEL"`): `content` text, `thinking`, and
 *     `tool_calls`, in any combination;
 *   - `GENERIC` (`source: "MODEL"`): tool execution result with status
 *     `DONE` / `RUNNING` / `ERROR`;
 *   - `SYSTEM_MESSAGE`, `ERROR_MESSAGE`, `ERROR`, `CHECKPOINT`,
 *     `TASK_NOTIFICATION`: lifecycle and notice records.
 *
 * This module owns mechanism only: it preserves native facts verbatim and
 * never projects them. The live tailer needs tolerant parsing (a line can be
 * half-written), while the cold reader classifies malformed completed lines
 * through its own error contract, so both a tolerant string parser and a
 * strict structural decoder are exported. No botmux bridge type is imported.
 */

/** One native `tool_calls` entry as agy writes it. */
export interface NativeToolCall {
  /** Native call id when the record carries one; 1.5.15 logs often omit it. */
  readonly id: string | null;
  readonly name: string;
  /** Native arguments untouched: usually an object, sometimes a JSON string. */
  readonly args: unknown;
}

/** One decoded native transcript record, with native fields normalized but
 *  no native fact dropped or truncated. */
export interface NativeRecord {
  /** Native `type` string, preserved verbatim (including unknown future names). */
  readonly type: string;
  readonly source: string | null;
  /** Native status verbatim; observed values are DONE, RUNNING, and ERROR. */
  readonly status: string | null;
  /** Native `step_index`; absent unless it is a safe integer. */
  readonly stepIndex?: number;
  /** Epoch milliseconds parsed from `created_at`; null when absent/invalid. */
  readonly occurredAt: number | null;
  readonly content: string | null;
  readonly thinking: string | null;
  /** Top-level native id when one is present; null in observed 1.5.15 logs. */
  readonly id: string | null;
  /** Always a present array, possibly empty. */
  readonly toolCalls: readonly NativeToolCall[];
}

/**
 * Decode one already-parsed native JSON object. Strict structural entry point
 * for the cold reader, which has already classified JSON parse failures.
 */
export function decodeNativeRecord(
  value: Record<string, unknown>,
): NativeRecord {
  return {
    type: stringValue(value['type']) ?? '',
    source: stringValue(value['source']),
    status: stringValue(value['status']),
    ...safeInteger(value['stepIndex'] ?? value['step_index']),
    occurredAt: timestampMillis(value['created_at']),
    content: stringValue(value['content']),
    thinking: stringValue(value['thinking']),
    id: stringValue(value['id']),
    toolCalls: decodeToolCalls(value['tool_calls']),
  };
}

/**
 * Tolerantly decode one raw JSONL line. Returns null for blank lines,
 * unparseable JSON, or non-object values — never throws — so a live tailer
 * can wait for a half-written line to complete.
 */
export function parseNativeRecord(raw: string): NativeRecord | null {
  if (raw.trim() === '') return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(value)) return null;
  return decodeNativeRecord(value);
}

const USER_REQUEST_OPEN = '<USER_REQUEST>';
const USER_REQUEST_CLOSE = '\n</USER_REQUEST>';

/**
 * Extract the exact submitted payload from a native `USER_INPUT` record.
 *
 * agy wraps explicit input as
 * `<USER_REQUEST>\n<payload>\n</USER_REQUEST>\n<ADDITIONAL_METADATA>…`. The
 * payload itself may legitimately contain the literal `</USER_REQUEST>`, so
 * the LAST close marker is authoritative and the open marker's newline is
 * skipped only when actually present. A record without the envelope is
 * returned unchanged. Null means this is not a string-bearing USER_INPUT.
 *
 * Adapted from botmux's `unwrapAntigravityUserInput` (MIT licensed).
 */
export function userInputText(record: NativeRecord): string | null {
  if (record.type !== 'USER_INPUT' || record.content === null) return null;
  const content = record.content;
  if (!content.startsWith(USER_REQUEST_OPEN)) return content;
  const innerStart =
    content.charCodeAt(USER_REQUEST_OPEN.length) === 10
      ? USER_REQUEST_OPEN.length + 1
      : USER_REQUEST_OPEN.length;
  const closeAt = content.lastIndexOf(USER_REQUEST_CLOSE);
  if (closeAt < innerStart) return content;
  return content.slice(innerStart, closeAt);
}

function decodeToolCalls(value: unknown): readonly NativeToolCall[] {
  if (!Array.isArray(value)) return [];
  const calls: NativeToolCall[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) continue;
    calls.push({
      id: stringValue(entry['id']),
      name: stringValue(entry['name']) ?? '',
      args: entry['args'],
    });
  }
  return calls;
}

function timestampMillis(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

function safeInteger(value: unknown): { stepIndex?: number } {
  return typeof value === 'number' && Number.isSafeInteger(value)
    ? { stepIndex: value }
    : {};
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
