import type {
  AgentRuntimeTranscriptContext,
  AgentRuntimeTranscriptPage,
  AgentRuntimeTranscriptQuery,
  AgentRuntimeTranscriptTurn,
} from '@excitedjs/dreamux-types';
import {
  budgetTranscriptTurns,
  isTranscriptTurnCount,
  readTranscriptBytesAt,
} from '@excitedjs/dreamux-utils';

import type { DispatcherCodexConfig } from '../config.js';
import { createCodexTranscriptBudget } from './budget.js';
import {
  codexQueryFingerprint,
  decodeCodexCursor,
  digest,
  encodeCodexCursor,
  type CodexCursorPosition,
} from './cursor.js';
import { CodexTranscriptError } from './error.js';
import {
  openCodexTranscript,
  type CodexOpenedTranscript,
} from './opened-file.js';
import {
  findCodexRolloutById,
  locateCodexTranscript,
  readCodexTranscriptText,
  resolveCodexTranscriptRoots,
  type CodexTranscriptRoots,
  type CodexValidatedTranscript,
} from './path.js';
import { projectCodexTurn } from './projection.js';

const MAX_DECODED_BYTES = 8_388_608;
const MAX_NATIVE_RECORDS = 20_000;
const MAX_ELAPSED_MS = 2_000;

interface LineRecord {
  start: number;
  end: number;
  raw: string;
  boundaryBytes: Buffer;
  value: Record<string, unknown>;
}

interface LineageSegment {
  transcript: CodexValidatedTranscript;
  endOffset: number | null;
}

interface NativeTurn {
  start: number;
  end: number;
  boundaryDigest: string;
  turn: AgentRuntimeTranscriptTurn;
}

interface PositionedTurn {
  segment: number;
  native: NativeTurn;
}

interface ScanResult {
  candidates: PositionedTurn[];
  hasOlder: boolean;
  resumePosition: CodexCursorPosition | null;
  resumeBoundaryDigest: string | null;
}

export async function readCodexTranscript(
  query: AgentRuntimeTranscriptQuery,
  context: AgentRuntimeTranscriptContext<DispatcherCodexConfig>,
  testHooks: {
    afterLocate?: () => void | Promise<void>;
    maxReadChunkBytes?: number;
  } = {},
): Promise<AgentRuntimeTranscriptPage> {
  if (!isTranscriptTurnCount(query.turns)) {
    throw new CodexTranscriptError(
      'invalid',
      'Codex transcript query turns must be an integer in 1..50',
    );
  }
  const checkpoint = context.checkpoint;
  if (checkpoint === null) {
    throw new CodexTranscriptError(
      'checkpoint_missing',
      'Codex transcript is unavailable before a session is established',
    );
  }
  const includeTools = query.includeTools ?? true;
  const roots = await resolveCodexTranscriptRoots(effectiveEnvironment(context));
  const discoveryBudget = createCodexTranscriptBudget();
  const tail = await locateCodexTranscript(
    checkpoint.transcript_locator,
    checkpoint.id,
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
    throw new CodexTranscriptError(
      'cursor_stale',
      'Codex transcript cursor is stale',
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

  const scan = await scanTurns({
    lineage,
    roots,
    startPosition: cursor?.pos ?? null,
    turns: query.turns,
    includeTools,
    maxReadChunkBytes: testHooks.maxReadChunkBytes,
  });
  const budgeted = budgetTranscriptTurns(
    scan.candidates.map((candidate) => candidate.native.turn),
    context.outputBudgetBytes,
  );
  const consumed = scan.candidates.slice(0, budgeted.consumed);
  const omittedForBudget = budgeted.consumed < scan.candidates.length;
  const cursorTarget =
    consumed.at(-1) ??
    (budgeted.consumed === 0 ? null : scan.candidates[0] ?? null);
  let nextPosition: CodexCursorPosition | null = null;
  let nextBoundaryDigest: string | null = null;
  if (cursorTarget !== null && (omittedForBudget || scan.hasOlder)) {
    nextPosition = {
      segment: cursorTarget.segment,
      offset: cursorTarget.native.start,
    };
    nextBoundaryDigest = cursorTarget.native.boundaryDigest;
  } else if (consumed.length === 0 && scan.resumePosition !== null) {
    nextPosition = scan.resumePosition;
    nextBoundaryDigest = scan.resumeBoundaryDigest;
  }
  if (
    nextPosition !== null &&
    cursor !== null &&
    !isStrictlyOlder(nextPosition, cursor.pos)
  ) {
    throw new CodexTranscriptError(
      'scan_unsupported',
      'Codex transcript pagination cannot make safe progress',
    );
  }
  const nextCursor =
    nextPosition !== null && nextBoundaryDigest !== null
      ? encodeCodexCursor({
          fingerprint,
          generation,
          position: nextPosition,
          boundaryDigest: nextBoundaryDigest,
        })
      : null;
  return {
    turns: [...budgeted.turnsNewestFirst].reverse(),
    nextCursor,
    truncated: budgeted.truncated,
  };
}

async function buildLineage(
  tail: CodexValidatedTranscript,
  roots: CodexTranscriptRoots,
  budget: ReturnType<typeof createCodexTranscriptBudget>,
): Promise<LineageSegment[]> {
  const lineage: LineageSegment[] = [{ transcript: tail, endOffset: null }];
  const visited = new Set([tail.rolloutId]);
  let current = tail;
  while (current.historyBase !== null) {
    if (visited.has(current.historyBase.rolloutId)) {
      throw new CodexTranscriptError(
        'invalid',
        'Codex transcript lineage contains a cycle',
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
      throw new CodexTranscriptError(
        'scan_unsupported',
        'Codex transcript lineage exceeds the bounded depth',
      );
    }
  }
  return lineage;
}

function lineageGeneration(
  lineage: readonly LineageSegment[],
): string {
  return digest(
    JSON.stringify({
      lineage: lineage.map((segment) => ({
        rollout: digest(segment.transcript.rolloutId),
        end: segment.endOffset,
      })),
    }),
  );
}

async function scanTurns(input: {
  lineage: readonly LineageSegment[];
  roots: CodexTranscriptRoots;
  startPosition: CodexCursorPosition | null;
  turns: number;
  includeTools: boolean;
  maxReadChunkBytes?: number;
}): Promise<ScanResult> {
  if (
    input.startPosition !== null &&
    input.startPosition.segment >= input.lineage.length
  ) {
    throw new CodexTranscriptError(
      'cursor_stale',
      'Codex transcript cursor is stale',
    );
  }
  const deadline = Date.now() + MAX_ELAPSED_MS;
  let bytesRemaining = MAX_DECODED_BYTES;
  let recordsRemaining = MAX_NATIVE_RECORDS;
  const candidates: PositionedTurn[] = [];
  let resumePosition: CodexCursorPosition | null = null;
  let resumeBoundaryDigest: string | null = null;
  const firstSegment = input.startPosition?.segment ?? 0;

  for (
    let segmentIndex = firstSegment;
    segmentIndex < input.lineage.length;
    segmentIndex += 1
  ) {
    if (Date.now() > deadline) break;
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
    const parsed = parseNativeTurns(
      window.lines,
      input.includeTools,
      recordsRemaining,
      deadline,
    );
    recordsRemaining -= parsed.records;
    for (const native of parsed.turns) {
      candidates.push({ segment: segmentIndex, native });
      if (candidates.length >= input.turns) {
        return {
          candidates,
          hasOlder:
            native.start > 0 ||
            window.startOffset > 0 ||
            segmentIndex + 1 < input.lineage.length,
          resumePosition: null,
          resumeBoundaryDigest: null,
        };
      }
    }
    if (parsed.incompleteBoundary !== null) {
      if (
        candidates.length === 0 &&
        input.startPosition === null &&
        segmentIndex === 0 &&
        parsed.sawOpenTail
      ) {
        break;
      }
      if (candidates.length === 0) {
        throw new CodexTranscriptError(
          'scan_unsupported',
          'Codex completed turn exceeds the bounded scan limit',
        );
      }
      break;
    }
    if (parsed.boundReached || window.startOffset > 0) {
      if (
        candidates.length === 0 &&
        input.startPosition === null &&
        segmentIndex === 0 &&
        !parsed.sawCompleteMarker
      ) {
        break;
      }
      if (candidates.length === 0) {
        const boundary = parsed.oldestProcessed;
        if (boundary === null) {
          throw new CodexTranscriptError(
            'scan_unsupported',
            'Codex transcript pagination cannot make safe progress',
          );
        }
        resumePosition = {
          segment: segmentIndex,
          offset: boundary.start,
        };
        resumeBoundaryDigest = digest(boundary.boundaryBytes);
      }
      break;
    }
    if (bytesRemaining <= 0 || recordsRemaining <= 0 || Date.now() > deadline) {
      if (candidates.length === 0) {
        throw new CodexTranscriptError(
          'scan_unsupported',
          'Codex transcript pagination cannot make safe progress',
        );
      }
      break;
    }
  }
  const hasOlder =
    resumePosition !== null ||
    (candidates.at(-1)?.native.start ?? 0) > 0 ||
    firstSegment + 1 < input.lineage.length;
  return {
    candidates,
    hasOlder,
    resumePosition,
    resumeBoundaryDigest,
  };
}

async function loadLineWindow(
  transcript: CodexValidatedTranscript,
  requestedEndOffset: number | null,
  maxBytes: number,
  maxReadChunkBytes?: number,
): Promise<{
  lines: LineRecord[];
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
    const text = await readCodexTranscriptText(opened, maxBytes);
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
    const data = await readTranscriptBytesAt(opened.handle, start, length, {
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
): LineRecord[] {
  let localStart = 0;
  if (!startsAtBoundary) {
    const firstNewline = bytes.indexOf(0x0a);
    if (firstNewline < 0) return [];
    localStart = firstNewline + 1;
  }
  const lines: LineRecord[] = [];
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
        throw new CodexTranscriptError(
          'invalid',
          'Codex transcript contains an invalid native record',
          { cause: error },
        );
      }
      if (isRecord(value)) {
        lines.push({
          start: baseOffset + cursor,
          end: baseOffset + newline + 1,
          raw,
          boundaryBytes: bytes.subarray(cursor, newline + 1),
          value,
        });
      }
    }
    cursor = newline + 1;
  }
  return lines;
}

function parseNativeTurns(
  lines: readonly LineRecord[],
  includeTools: boolean,
  recordBudget: number,
  deadline: number,
): {
  turns: NativeTurn[];
  records: number;
  incompleteBoundary: LineRecord | null;
  oldestProcessed: LineRecord | null;
  sawStartMarker: boolean;
  sawCompleteMarker: boolean;
  sawOpenTail: boolean;
  boundReached: boolean;
} {
  const turns: NativeTurn[] = [];
  let terminal: LineRecord | null = null;
  let collected: LineRecord[] = [];
  let records = 0;
  let oldestProcessed: LineRecord | null = null;
  let sawStartMarker = false;
  let sawCompleteMarker = false;
  let sawOpenTail = false;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (records >= recordBudget || Date.now() > deadline) break;
    const line = lines[index]!;
    records += 1;
    oldestProcessed = line;
    const marker = eventMarker(line.value);
    sawStartMarker ||= isStartMarker(marker);
    sawCompleteMarker ||= isCompleteMarker(marker);
    if (terminal === null) {
      if (isStartMarker(marker)) sawOpenTail = true;
      if (isCompleteMarker(marker)) {
        terminal = line;
        collected = [line];
      }
      continue;
    }
    collected.push(line);
    if (!isStartMarker(marker)) continue;
    const chronological = [...collected].reverse();
    turns.push({
      start: line.start,
      end: terminal.end,
      boundaryDigest: digest(line.boundaryBytes),
      turn: projectCodexTurn(chronological, includeTools),
    });
    terminal = null;
    collected = [];
  }
  return {
    turns,
    records,
    incompleteBoundary: terminal,
    oldestProcessed,
    sawStartMarker,
    sawCompleteMarker,
    sawOpenTail,
    boundReached:
      records < lines.length &&
      (records >= recordBudget || Date.now() > deadline),
  };
}

async function verifyBoundaryDigest(
  lineage: readonly LineageSegment[],
  position: CodexCursorPosition,
  expectedDigest: string,
  maxReadChunkBytes?: number,
): Promise<void> {
  const segment = lineage[position.segment];
  if (segment === undefined) {
    throw new CodexTranscriptError(
      'cursor_stale',
      'Codex transcript cursor is stale',
    );
  }
  const boundaryBytes = await readBoundaryRecordBytes(
    segment.transcript,
    position.offset,
    maxReadChunkBytes,
  );
  if (digest(boundaryBytes) !== expectedDigest) {
    throw new CodexTranscriptError(
      'cursor_stale',
      'Codex transcript cursor is stale',
    );
  }
}

async function readBoundaryRecordBytes(
  transcript: CodexValidatedTranscript,
  offset: number,
  maxReadChunkBytes?: number,
): Promise<Buffer> {
  const opened = await openValidatedSegment(transcript);
  try {
  if (opened.path.endsWith('.zst')) {
    const text = await readCodexTranscriptText(opened, MAX_DECODED_BYTES);
    return boundaryRecordFromBuffer(Buffer.from(text, 'utf8'), offset);
  }
  if (offset >= opened.size) {
    throw new CodexTranscriptError(
      'cursor_stale',
      'Codex transcript cursor is stale',
    );
  }
  const length = Math.min(MAX_DECODED_BYTES, opened.size - offset);
    const bytes = await readTranscriptBytesAt(opened.handle, offset, length, {
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
  transcript: CodexValidatedTranscript,
): Promise<CodexOpenedTranscript> {
  const opened = await openCodexTranscript(
    transcript.path,
    [transcript.root],
  );
  if (
    transcript.dev !== -1 &&
    (opened.dev !== transcript.dev || opened.ino !== transcript.ino)
  ) {
    await opened.handle.close();
    throw new CodexTranscriptError(
      'unreadable',
      'Codex transcript changed after validation',
    );
  }
  return opened;
}

function boundaryRecordFromBuffer(bytes: Buffer, offset: number): Buffer {
  const newline = bytes.indexOf(0x0a, offset);
  if (newline < 0) {
    throw new CodexTranscriptError(
      'scan_unsupported',
      'Codex cursor boundary record exceeds the bounded scan limit',
    );
  }
  return bytes.subarray(offset, newline + 1);
}

function eventMarker(value: Record<string, unknown>): string | null {
  if (value['type'] !== 'event_msg') return null;
  return stringValue(recordValue(value['payload'])?.['type']);
}

function isStartMarker(value: string | null): boolean {
  return value === 'task_started' || value === 'turn_started';
}

function isCompleteMarker(value: string | null): boolean {
  return value === 'task_complete' || value === 'turn_complete';
}

function effectiveEnvironment(
  context: AgentRuntimeTranscriptContext<DispatcherCodexConfig>,
): Record<string, string | undefined> {
  return {
    ...process.env,
    ...(context.injectEnv ?? {}),
    ...context.config.extra_env,
  };
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return isRecord(value) ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
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
