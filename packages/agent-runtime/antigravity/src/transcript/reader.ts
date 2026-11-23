import type {
  AgentActivityPage,
  AgentActivityQuery,
  AgentActivityReadContext,
  AgentActivityRecord,
} from '@excitedjs/dreamux-types';
import {
  activityQueryFingerprint,
  ActivityError,
  openActivityFile,
  type OpenedActivityFile,
  readBytesAt,
} from '@excitedjs/dreamux-utils';

import type { AntigravityConfig } from '../config.js';
import {
  antigravityTranscriptPath,
  resolveAntigravityNativeRoots,
} from '../paths.js';
import {
  decodeAntigravityCursor,
  digest,
  encodeAntigravityCursor,
  type AntigravityCursorPosition,
} from './cursor.js';
import { decodeNativeRecord } from './records.js';

/** Native read bounds. The provider enforces these and reports truncation. */
const MAX_DECODED_BYTES = 8_388_608;
const MAX_NATIVE_RECORDS = 20_000;
const MAX_NATIVE_RECORD_BYTES = 1_048_576;
const MAX_ELAPSED_MS = 2_000;

/** Provider-owned page-size bounds; Core checks record shape and count only. */
const DEFAULT_RECORD_LIMIT = 50;
const MAX_RECORD_LIMIT = 200;

const ANTIGRAVITY_ACTIVITY_FILE_MESSAGES = {
  notFound: 'Antigravity activity is unavailable for this session',
  outsideRoot: 'Antigravity activity is unavailable for this session',
  notRegularFile: 'Antigravity activity source is not a regular file',
  changedWhileOpening: 'Antigravity activity source changed while opening',
  unreadable: 'Antigravity activity is unreadable',
};

/** One parsed native JSONL line, positioned at its byte offset in the file. */
interface NativeLine {
  start: number;
  boundaryBytes: Buffer;
  value: Record<string, unknown>;
}

/** One neutral record anchored to both its native line and its ordinal in
 *  that line, so one native record can page out several activities. */
interface PositionedEntry {
  start: number;
  ordinal: number;
  boundaryBytes: Buffer;
  record: AgentActivityRecord;
}

/** Cursor anchor facts; a window that projects nothing still needs the
 *  position of its oldest native line so pagination can continue. */
interface Anchor {
  start: number;
  ordinal: number;
  boundaryBytes: Buffer;
}

interface ParsedWindow {
  lines: NativeLine[];
  /** Older bytes or records exist outside what this bounded window parsed. */
  boundReached: boolean;
}

/**
 * Read the recent tail of one Antigravity session's activity.
 *
 * The only source is the bound session's `transcript_full.jsonl`, located from
 * the native roots and session id alone. The read is a cold file read: it
 * works while the session is still growing and after the live runtime has
 * closed, never launches or mutates agy, and projects only neutral
 * assistant/tool facts — never live `RuntimeActivity`.
 */
export async function readAntigravityRecentActivity(
  query: AgentActivityQuery,
  context: AgentActivityReadContext<AntigravityConfig>,
): Promise<AgentActivityPage> {
  const limit = resolveLimit(query.limit);
  const includeTools = query.includeTools ?? true;
  const fingerprint = activityQueryFingerprint(includeTools);
  const cursor =
    query.cursor === undefined
      ? null
      : decodeAntigravityCursor(query.cursor, fingerprint);

  const roots = resolveAntigravityNativeRoots({
    ...globalThis.process.env,
    ...context.config.extra_env,
  });
  const path = antigravityTranscriptPath(roots, query.sessionId);
  const opened = await openActivityFile(
    path,
    [roots.appDataHome],
    ANTIGRAVITY_ACTIVITY_FILE_MESSAGES,
  );
  try {
    // A cursor marks the oldest entry already shown. The next window therefore
    // ends at the end of that boundary line (its lower ordinals may still be
    // unseen), and entries at or after the anchor ordinal are filtered out.
    let readEnd = opened.size;
    if (cursor !== null) {
      const boundaryLength = await verifyBoundaryDigest(
        opened,
        cursor.pos,
        cursor.bd,
      );
      readEnd = Math.min(opened.size, cursor.pos + boundaryLength);
    }

    const window = await readWindow(opened, readEnd);
    const parsed = parseLines(window.bytes, window.startOffset);
    const projected = projectLines(parsed.lines, includeTools);
    const resumed =
      cursor === null
        ? projected
        : projected.filter(
            (entry) =>
              entry.start < cursor.pos ||
              (entry.start === cursor.pos && entry.ordinal < cursor.ord),
          );

    const page = resumed.slice(-limit);
    const hasOlder = resumed.length > page.length || parsed.boundReached;
    // A cursor exists only while older entries remain: the oldest entry of a
    // full final page, or the oldest parsed line when bounds cut history off.
    const anchor = !hasOlder
      ? null
      : (page[0] ??
        (parsed.lines.length > 0 ? lineAnchor(parsed.lines[0]!) : null));
    if (
      cursor !== null &&
      anchor !== null &&
      !isStrictlyOlder(anchor, { offset: cursor.pos, ordinal: cursor.ord })
    ) {
      throw new ActivityError(
        'scan_unsupported',
        'Antigravity activity pagination cannot make safe progress',
      );
    }

    const nextCursor =
      anchor === null
        ? undefined
        : encodeAntigravityCursor({
            fingerprint,
            position: { offset: anchor.start, ordinal: anchor.ordinal },
            boundaryDigest: digest(anchor.boundaryBytes),
          });

    return {
      records: page.map((entry) => entry.record),
      transcriptPath: opened.path,
      ...(nextCursor !== undefined ? { nextCursor } : {}),
      truncated: parsed.boundReached,
    };
  } finally {
    await opened.handle.close();
  }
}

function resolveLimit(limit: number | undefined): number {
  if (limit === undefined) return DEFAULT_RECORD_LIMIT;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_RECORD_LIMIT) {
    throw new ActivityError(
      'invalid',
      `Antigravity activity limit must be an integer in 1..${MAX_RECORD_LIMIT}`,
    );
  }
  return limit;
}

async function readWindow(
  opened: OpenedActivityFile,
  endOffset: number,
): Promise<{ bytes: Buffer; startOffset: number }> {
  const startOffset = Math.max(0, endOffset - MAX_DECODED_BYTES);
  const bytes = await readBytesAt(
    opened.handle,
    startOffset,
    endOffset - startOffset,
  );
  return { bytes, startOffset };
}

/**
 * Split one bounded byte window into complete native lines. A window starting
 * mid-file drops its leading partial line; a trailing line without its newline
 * is still being written and is not yet a record, matching the live tailer.
 * The byte window is already bounded, so every complete line is parsed; the
 * native-record cap then keeps the NEWEST cap-sized tail, since this is a
 * recent-activity read and the older lines are what truncation drops.
 */
function parseLines(bytes: Buffer, baseOffset: number): ParsedWindow {
  const deadline = Date.now() + MAX_ELAPSED_MS;
  let cursor = 0;
  if (baseOffset !== 0) {
    const firstNewline = bytes.indexOf(0x0a);
    if (firstNewline < 0) {
      return { lines: [], boundReached: baseOffset > 0 };
    }
    cursor = firstNewline + 1;
  }

  const all: NativeLine[] = [];
  let deadlineHit = false;
  while (cursor < bytes.length) {
    const newline = bytes.indexOf(0x0a, cursor);
    if (newline < 0) break;
    if (newline - cursor > MAX_NATIVE_RECORD_BYTES) {
      throw new ActivityError(
        'scan_unsupported',
        'Antigravity activity record exceeds the bounded limit',
      );
    }
    const raw = bytes.subarray(cursor, newline).toString('utf8');
    if (raw.trim() !== '') {
      let value: unknown;
      try {
        value = JSON.parse(raw);
      } catch (error) {
        throw new ActivityError(
          'invalid',
          'Antigravity activity contains an unreadable record',
          { cause: error },
        );
      }
      if (!isRecord(value)) {
        throw new ActivityError(
          'invalid',
          'Antigravity activity contains an unreadable record',
        );
      }
      all.push({
        start: baseOffset + cursor,
        boundaryBytes: bytes.subarray(cursor, newline + 1),
        value,
      });
    }
    cursor = newline + 1;
    if (Date.now() > deadline) {
      deadlineHit = true;
      break;
    }
  }

  const capHit = all.length > MAX_NATIVE_RECORDS;
  return {
    lines: capHit ? all.slice(-MAX_NATIVE_RECORDS) : all,
    boundReached: baseOffset > 0 || capHit || deadlineHit,
  };
}

/**
 * Project chronological native lines into chronological neutral records.
 *
 * Deliberately flat: no turn grouping or completion gate, so an in-progress
 * turn yields records as soon as its lines are written. A PLANNER_RESPONSE
 * emits its complete `content` as one assistant message, then one `started`
 * tool record per native `tool_calls` entry in native order. GENERIC results
 * settle those calls FIFO in line order — the pairing agy itself writes — with
 * native RUNNING treated as a background-progress notice rather than a result.
 * A result whose call fell outside this window has no record to settle, the
 * same window-local artifact the other providers tolerate.
 */
function projectLines(
  lines: readonly NativeLine[],
  includeTools: boolean,
): PositionedEntry[] {
  const entries: PositionedEntry[] = [];
  const pendingCalls: string[] = [];

  for (const line of lines) {
    const native = decodeNativeRecord(line.value);
    const occurredAt = occurredAtIso(native.occurredAt);
    let ordinal = 0;
    const emit = (record: AgentActivityRecord): void => {
      entries.push({
        start: line.start,
        ordinal: ordinal++,
        boundaryBytes: line.boundaryBytes,
        record,
      });
    };

    if (native.type === 'PLANNER_RESPONSE') {
      if (native.content !== null && native.content !== '') {
        emit({
          kind: 'assistant_message',
          text: native.content,
          ...(occurredAt === null ? {} : { occurredAt }),
        });
      }
      if (includeTools) {
        for (const call of native.toolCalls) {
          pendingCalls.push(call.name);
          emit({
            kind: 'tool',
            name: call.name,
            status: 'started',
            ...(occurredAt === null ? {} : { occurredAt }),
          });
        }
      }
      continue;
    }

    if (
      includeTools &&
      native.type === 'GENERIC' &&
      native.status !== 'RUNNING'
    ) {
      const name = pendingCalls.shift();
      if (name !== undefined) {
        emit({
          kind: 'tool',
          name,
          status: native.status === 'ERROR' ? 'failed' : 'completed',
          ...(occurredAt === null ? {} : { occurredAt }),
        });
      }
    }
  }

  return entries;
}

function lineAnchor(line: NativeLine): Anchor {
  return {
    start: line.start,
    ordinal: 0,
    boundaryBytes: line.boundaryBytes,
  };
}

/** Verify the boundary record still has its recorded bytes; return its full
 *  line length (including the trailing newline) so the caller can window up to
 *  the line's end without re-reading for another newline. */
async function verifyBoundaryDigest(
  opened: OpenedActivityFile,
  offset: number,
  expectedDigest: string,
): Promise<number> {
  if (offset >= opened.size) {
    throw new ActivityError(
      'cursor_stale',
      'Antigravity activity cursor is no longer valid',
    );
  }
  const length = Math.min(MAX_DECODED_BYTES, opened.size - offset);
  const bytes = await readBytesAt(opened.handle, offset, length);
  if (bytes.length === 0) {
    throw new ActivityError(
      'cursor_stale',
      'Antigravity activity cursor is no longer valid',
    );
  }
  const newline = bytes.indexOf(0x0a);
  if (newline < 0) {
    throw new ActivityError(
      'scan_unsupported',
      'Antigravity activity cursor boundary exceeds the bounded limit',
    );
  }
  if (digest(bytes.subarray(0, newline + 1)) !== expectedDigest) {
    throw new ActivityError(
      'cursor_stale',
      'Antigravity activity cursor is no longer valid',
    );
  }
  return newline + 1;
}

function isStrictlyOlder(
  anchor: Anchor,
  cursor: AntigravityCursorPosition,
): boolean {
  return (
    anchor.start < cursor.offset ||
    (anchor.start === cursor.offset && anchor.ordinal < cursor.ordinal)
  );
}

function occurredAtIso(millis: number | null): string | null {
  return millis === null ? null : new Date(millis).toISOString();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
