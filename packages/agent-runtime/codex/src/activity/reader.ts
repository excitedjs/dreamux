import type {
  AgentActivityPage,
  AgentActivityQuery,
  AgentActivityReadContext,
  AgentRuntimeSessionRef,
} from '@excitedjs/dreamux-types';
import { readBytesAt } from '@excitedjs/dreamux-utils';

import type { DispatcherCodexConfig } from '../config.js';
import { createCodexScanBudget } from './budget.js';
import {
  codexQueryFingerprint,
  decodeCodexCursor,
  digest,
  encodeCodexCursor,
  type CodexCursorPosition,
} from './cursor.js';
import { CodexActivityError } from './error.js';
import { openCodexRollout, type CodexOpenedRollout } from './opened-file.js';
import {
  findCodexRolloutById,
  locateCodexRollout,
  readCodexRolloutText,
  resolveCodexRolloutRoots,
  type CodexRolloutRoots,
  type CodexValidatedRollout,
} from './path.js';
import {
  projectCodexActivity,
  type CodexActivityLine,
  type CodexPositionedRecord,
} from './projection.js';

/** Native read bounds. The provider enforces these and reports truncation. */
const MAX_DECODED_BYTES = 8_388_608;
const MAX_NATIVE_RECORDS = 20_000;
const MAX_ELAPSED_MS = 2_000;

/** Page-size bounds. Core validates the returned page independently. */
const DEFAULT_RECORD_LIMIT = 50;
const MAX_RECORD_LIMIT = 200;

interface LineageSegment {
  transcript: CodexValidatedRollout;
  endOffset: number | null;
}

interface PositionedInLineage {
  segment: number;
  entry: CodexPositionedRecord;
}

interface ScanResult {
  /** Newest first; the caller reverses into chronological page order. */
  collected: PositionedInLineage[];
  hasOlder: boolean;
  truncated: boolean;
  fallbackAnchor: PositionedInLineage | null;
}

/**
 * Read the recent tail of one Codex session's activity.
 *
 * The read works against an actively growing session and against the same
 * session after its live runtime has closed: it discovers the rollout lineage
 * from the session id alone, and never depends on a persisted native path.
 */
export async function readCodexRecentActivity(
  query: AgentActivityQuery<AgentRuntimeSessionRef>,
  context: AgentActivityReadContext<DispatcherCodexConfig>,
  testHooks: {
    afterLocate?: () => void | Promise<void>;
    maxReadChunkBytes?: number;
  } = {},
): Promise<AgentActivityPage> {
  const limit = resolveLimit(query.limit);
  const includeTools = query.includeTools ?? true;
  const roots = await resolveCodexRolloutRoots(effectiveEnvironment(context));
  const discoveryBudget = createCodexScanBudget();
  const tail = await locateCodexRollout(
    null,
    query.session.id,
    roots,
    discoveryBudget,
  );
  const lineage = await buildLineage(tail, roots, discoveryBudget);
  await testHooks.afterLocate?.();
  const generation = lineageGeneration(lineage);
  const fingerprint = codexQueryFingerprint(includeTools);
  const cursor =
    query.cursor === undefined
      ? null
      : decodeCodexCursor(query.cursor, fingerprint);
  if (cursor !== null && cursor.gen !== generation) {
    throw new CodexActivityError(
      'cursor_stale',
      'Codex activity cursor is no longer valid',
    );
  }
  if (cursor !== null) {
    await verifyBoundaryDigest(
      lineage,
      cursor.pos,
      cursor.bd,
      testHooks.maxReadChunkBytes,
    );
  }

  const scan = await scanRecords({
    lineage,
    startPosition: cursor?.pos ?? null,
    limit,
    includeTools,
    ...(testHooks.maxReadChunkBytes !== undefined
      ? { maxReadChunkBytes: testHooks.maxReadChunkBytes }
      : {}),
  });

  const anchor = scan.hasOlder
    ? (scan.collected.at(-1) ?? scan.fallbackAnchor)
    : null;
  let nextCursor: string | undefined;
  if (anchor !== null && anchor !== undefined) {
    const position: CodexCursorPosition = {
      segment: anchor.segment,
      offset: anchor.entry.start,
    };
    if (cursor !== null && !isStrictlyOlder(position, cursor.pos)) {
      throw new CodexActivityError(
        'scan_unsupported',
        'Codex activity pagination cannot make safe progress',
      );
    }
    nextCursor = encodeCodexCursor({
      fingerprint,
      generation,
      position,
      boundaryDigest: digest(anchor.entry.boundaryBytes),
    });
  }

  return {
    records: scan.collected
      .map((entry) => entry.entry.record)
      .reverse(),
    ...(nextCursor !== undefined ? { nextCursor } : {}),
    truncated: scan.truncated,
  };
}

function resolveLimit(limit: number | undefined): number {
  if (limit === undefined) return DEFAULT_RECORD_LIMIT;
  if (
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > MAX_RECORD_LIMIT
  ) {
    throw new CodexActivityError(
      'invalid',
      `Codex activity limit must be an integer in 1..${MAX_RECORD_LIMIT}`,
    );
  }
  return limit;
}

async function buildLineage(
  tail: CodexValidatedRollout,
  roots: CodexRolloutRoots,
  budget: ReturnType<typeof createCodexScanBudget>,
): Promise<LineageSegment[]> {
  const lineage: LineageSegment[] = [{ transcript: tail, endOffset: null }];
  const visited = new Set([tail.rolloutId]);
  let current = tail;
  while (current.historyBase !== null) {
    if (visited.has(current.historyBase.rolloutId)) {
      throw new CodexActivityError(
        'invalid',
        'Codex activity history contains a cycle',
      );
    }
    const parent = await findCodexRolloutById(
      roots,
      current.historyBase.rolloutId,
      budget,
    );
    visited.add(parent.rolloutId);
    lineage.push({
      transcript: parent,
      endOffset: current.historyBase.endByteOffset,
    });
    current = parent;
    if (lineage.length > 64) {
      throw new CodexActivityError(
        'scan_unsupported',
        'Codex activity history exceeds the bounded depth',
      );
    }
  }
  return lineage;
}

function lineageGeneration(lineage: readonly LineageSegment[]): string {
  return digest(
    JSON.stringify({
      lineage: lineage.map((segment) => ({
        rollout: digest(segment.transcript.rolloutId),
        end: segment.endOffset,
      })),
    }),
  );
}

async function scanRecords(input: {
  lineage: readonly LineageSegment[];
  startPosition: CodexCursorPosition | null;
  limit: number;
  includeTools: boolean;
  maxReadChunkBytes?: number;
}): Promise<ScanResult> {
  if (
    input.startPosition !== null &&
    input.startPosition.segment >= input.lineage.length
  ) {
    throw new CodexActivityError(
      'cursor_stale',
      'Codex activity cursor is no longer valid',
    );
  }
  const deadline = Date.now() + MAX_ELAPSED_MS;
  let bytesRemaining = MAX_DECODED_BYTES;
  let recordsRemaining = MAX_NATIVE_RECORDS;
  const collected: PositionedInLineage[] = [];
  let hasOlder = false;
  let boundsHit = false;
  let fallbackAnchor: PositionedInLineage | null = null;
  const firstSegment = input.startPosition?.segment ?? 0;

  for (
    let segmentIndex = firstSegment;
    segmentIndex < input.lineage.length;
    segmentIndex += 1
  ) {
    if (
      Date.now() > deadline ||
      bytesRemaining <= 0 ||
      recordsRemaining <= 0
    ) {
      boundsHit = true;
      break;
    }
    const segment = input.lineage[segmentIndex]!;
    const endOffset =
      segmentIndex === firstSegment && input.startPosition !== null
        ? input.startPosition.offset
        : segment.endOffset;
    const window = await loadLineWindow(
      segment.transcript,
      endOffset,
      bytesRemaining,
      input.maxReadChunkBytes,
    );
    bytesRemaining -= window.bytesRead;
    recordsRemaining -= window.lines.length;
    const projected = projectCodexActivity(window.lines, input.includeTools);
    const oldestLine = window.lines[0];
    if (oldestLine !== undefined) {
      fallbackAnchor = {
        segment: segmentIndex,
        entry: {
          start: oldestLine.start,
          boundaryBytes: oldestLine.boundaryBytes,
          record: { kind: 'assistant_message', text: '' },
        },
      };
    }
    for (let index = projected.length - 1; index >= 0; index -= 1) {
      if (collected.length >= input.limit) {
        hasOlder = true;
        break;
      }
      collected.push({ segment: segmentIndex, entry: projected[index]! });
    }
    if (collected.length >= input.limit) {
      hasOlder ||=
        window.startOffset > 0 || segmentIndex + 1 < input.lineage.length;
      break;
    }
    if (window.startOffset > 0) {
      boundsHit = true;
      break;
    }
  }

  return {
    collected,
    hasOlder: hasOlder || boundsHit,
    truncated: boundsHit,
    fallbackAnchor,
  };
}

async function loadLineWindow(
  transcript: CodexValidatedRollout,
  requestedEndOffset: number | null,
  maxBytes: number,
  maxReadChunkBytes?: number,
): Promise<{
  lines: CodexActivityLine[];
  startOffset: number;
  endOffset: number;
  bytesRead: number;
}> {
  if (maxBytes <= 0) {
    return { lines: [], startOffset: 0, endOffset: 0, bytesRead: 0 };
  }
  const opened = await openValidatedSegment(transcript);
  try {
    if (opened.path.endsWith('.zst')) {
      const text = await readCodexRolloutText(opened, maxBytes);
      const bytes = Buffer.from(text, 'utf8');
      const end = Math.min(requestedEndOffset ?? bytes.length, bytes.length);
      const limited = bytes.subarray(0, end);
      return {
        lines: parseLines(limited, 0, true),
        startOffset: 0,
        endOffset: end,
        bytesRead: limited.length,
      };
    }
    const end = Math.min(requestedEndOffset ?? opened.size, opened.size);
    const start = Math.max(0, end - maxBytes);
    const length = end - start;
    const data = await readBytesAt(opened.handle, start, length, {
      ...(maxReadChunkBytes !== undefined
        ? { maxChunkBytes: maxReadChunkBytes }
        : {}),
    });
    return {
      lines: parseLines(data, start, start === 0),
      startOffset: start,
      endOffset: start + data.length,
      bytesRead: data.length,
    };
  } finally {
    await opened.handle.close();
  }
}

function parseLines(
  bytes: Buffer,
  baseOffset: number,
  startsAtBoundary: boolean,
): CodexActivityLine[] {
  let localStart = 0;
  if (!startsAtBoundary) {
    const firstNewline = bytes.indexOf(0x0a);
    if (firstNewline < 0) return [];
    localStart = firstNewline + 1;
  }
  const lines: CodexActivityLine[] = [];
  let cursor = localStart;
  while (cursor < bytes.length) {
    const newline = bytes.indexOf(0x0a, cursor);
    if (newline < 0) break;
    const raw = bytes.subarray(cursor, newline).toString('utf8');
    if (raw.trim() !== '') {
      let value: unknown;
      try {
        value = JSON.parse(raw);
      } catch (error) {
        throw new CodexActivityError(
          'invalid',
          'Codex activity contains an unreadable record',
          { cause: error },
        );
      }
      if (isRecord(value)) {
        lines.push({
          start: baseOffset + cursor,
          boundaryBytes: bytes.subarray(cursor, newline + 1),
          value,
        });
      }
    }
    cursor = newline + 1;
  }
  return lines;
}

async function verifyBoundaryDigest(
  lineage: readonly LineageSegment[],
  position: CodexCursorPosition,
  expectedDigest: string,
  maxReadChunkBytes?: number,
): Promise<void> {
  const segment = lineage[position.segment];
  if (segment === undefined) {
    throw new CodexActivityError(
      'cursor_stale',
      'Codex activity cursor is no longer valid',
    );
  }
  const boundaryBytes = await readBoundaryRecordBytes(
    segment.transcript,
    position.offset,
    maxReadChunkBytes,
  );
  if (digest(boundaryBytes) !== expectedDigest) {
    throw new CodexActivityError(
      'cursor_stale',
      'Codex activity cursor is no longer valid',
    );
  }
}

async function readBoundaryRecordBytes(
  transcript: CodexValidatedRollout,
  offset: number,
  maxReadChunkBytes?: number,
): Promise<Buffer> {
  const opened = await openValidatedSegment(transcript);
  try {
    if (opened.path.endsWith('.zst')) {
      const text = await readCodexRolloutText(opened, MAX_DECODED_BYTES);
      return boundaryRecordFromBuffer(Buffer.from(text, 'utf8'), offset);
    }
    if (offset >= opened.size) {
      throw new CodexActivityError(
        'cursor_stale',
        'Codex activity cursor is no longer valid',
      );
    }
    const length = Math.min(MAX_DECODED_BYTES, opened.size - offset);
    const bytes = await readBytesAt(opened.handle, offset, length, {
      ...(maxReadChunkBytes !== undefined
        ? { maxChunkBytes: maxReadChunkBytes }
        : {}),
    });
    return boundaryRecordFromBuffer(bytes, 0);
  } finally {
    await opened.handle.close();
  }
}

async function openValidatedSegment(
  transcript: CodexValidatedRollout,
): Promise<CodexOpenedRollout> {
  const opened = await openCodexRollout(transcript.path, [transcript.root]);
  if (
    transcript.dev !== -1 &&
    (opened.dev !== transcript.dev || opened.ino !== transcript.ino)
  ) {
    await opened.handle.close();
    throw new CodexActivityError(
      'unreadable',
      'Codex activity source changed after validation',
    );
  }
  return opened;
}

function boundaryRecordFromBuffer(bytes: Buffer, offset: number): Buffer {
  const newline = bytes.indexOf(0x0a, offset);
  if (newline < 0) {
    throw new CodexActivityError(
      'scan_unsupported',
      'Codex activity cursor boundary exceeds the bounded limit',
    );
  }
  return bytes.subarray(offset, newline + 1);
}

function effectiveEnvironment(
  context: AgentActivityReadContext<DispatcherCodexConfig>,
): Record<string, string | undefined> {
  return {
    ...process.env,
    ...(context.injectEnv ?? {}),
    ...context.config.extra_env,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isStrictlyOlder(
  candidate: CodexCursorPosition,
  previous: CodexCursorPosition,
): boolean {
  return (
    candidate.segment > previous.segment ||
    (candidate.segment === previous.segment &&
      candidate.offset < previous.offset)
  );
}
