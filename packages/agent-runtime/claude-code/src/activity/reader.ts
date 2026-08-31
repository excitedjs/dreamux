import type {
  AgentActivityPage,
  AgentActivityQuery,
  AgentActivityReadContext,
  AgentActivityRecord,
} from '@excitedjs/dreamux-types';
import { readBytesAt } from '@excitedjs/dreamux-utils';

import type { DispatcherClaudeCodeConfig } from '../config.js';
import {
  claudeQueryFingerprint,
  decodeClaudeCursor,
  digest,
  encodeClaudeCursor,
} from './cursor.js';
import { ClaudeActivityError } from './error.js';
import {
  openClaudeRollout,
  type ClaudeOpenedRollout,
  validateClaudeSessionEvidence,
} from './opened-file.js';
import { recoverParallelToolBranches } from './parallel-tools.js';
import { locateClaudeHistory } from './path.js';
import { applyNativeRewrites } from './rewrites.js';

/** Native read bounds. The provider enforces these and reports truncation. */
const MAX_DECODED_BYTES = 8_388_608;
const MAX_NATIVE_RECORDS = 20_000;
const MAX_ELAPSED_MS = 2_000;

/** Page-size bounds. Core validates the returned page independently. */
const DEFAULT_RECORD_LIMIT = 50;
const MAX_RECORD_LIMIT = 200;

interface NativeEntry {
  start: number;
  end: number;
  raw: string;
  boundaryBytes: Buffer;
  value: Record<string, unknown>;
}

/** One neutral record, anchored to the native entry that produced it. */
interface PositionedRecord {
  start: number;
  boundaryDigest: string;
  record: AgentActivityRecord;
}

interface ParsedEntries {
  entries: NativeEntry[];
  oldestProcessed: NativeEntry | null;
  boundReached: boolean;
}

interface RewriteEvidence {
  watermark: number;
  position: number | null;
  digest: string | null;
}

/**
 * Read the recent tail of one Claude Code session's activity.
 *
 * The read works against an actively growing session and against the same
 * session after its live runtime has closed: it discovers the native history
 * from the session id and cwd alone, and never depends on a persisted native
 * path. Projection is flat, so records appear without waiting for a turn to
 * complete.
 */
export async function readClaudeRecentActivity(
  query: AgentActivityQuery,
  context: AgentActivityReadContext<DispatcherClaudeCodeConfig>,
  testHooks: {
    afterLocate?: () => void | Promise<void>;
    maxReadChunkBytes?: number;
  } = {},
): Promise<AgentActivityPage> {
  const limit = resolveLimit(query.limit);
  const sessionId = query.sessionId;
  const includeTools = query.includeTools ?? true;
  const env = effectiveEnvironment(context);
  const located = await locateClaudeHistory({
    sessionId,
    cwd: context.cwd,
    locator: null,
    env,
  });
  await testHooks.afterLocate?.();
  const opened = await openClaudeRollout(located.path, located.root);
  if (opened.dev !== located.dev || opened.ino !== located.ino) {
    await opened.handle.close();
    throw new ClaudeActivityError(
      'unreadable',
      'Claude Code activity source changed after validation',
    );
  }
  try {
    await validateClaudeSessionEvidence(opened, sessionId, {
      ...(testHooks.maxReadChunkBytes !== undefined
        ? { maxReadChunkBytes: testHooks.maxReadChunkBytes }
        : {}),
    });
    const fingerprint = claudeQueryFingerprint(includeTools);
    const cursor =
      query.cursor === undefined
        ? null
        : decodeClaudeCursor(query.cursor, fingerprint);
    const endOffset = Math.min(cursor?.pos ?? opened.size, opened.size);
    const rewriteEvidence = await verifyRewriteEvidence(
      opened,
      cursor,
      testHooks.maxReadChunkBytes,
    );
    if (cursor !== null) {
      await verifyCursorBoundaryDigest(
        opened,
        cursor.pos,
        cursor.bd,
        testHooks.maxReadChunkBytes,
      );
    }
    const window = await readWindow(
      opened,
      endOffset,
      testHooks.maxReadChunkBytes,
    );
    const parsed = parseEntries(window.bytes, window.startOffset, sessionId);
    const logical = applyNativeRewrites(parsed.entries);
    const chain = recoverParallelToolBranches(
      logical,
      buildSelectedChain(logical),
    );
    const projected = projectActivity(chain, includeTools);
    const consumed = projected.slice(-limit);
    const anchor: PositionedRecord | null = consumed.at(0) ?? null;
    const hasOlder =
      (anchor?.start ?? endOffset) > 0 &&
      (projected.length > consumed.length || parsed.boundReached);
    const boundary =
      anchor ?? (hasOlder ? parsed.oldestProcessed : null);
    if (boundary !== null && cursor !== null && boundary.start >= cursor.pos) {
      throw new ClaudeActivityError(
        'scan_unsupported',
        'Claude Code activity pagination cannot make safe progress',
      );
    }
    const nextCursor =
      boundary !== null && hasOlder
        ? encodeClaudeCursor({
            fingerprint,
            generation: rewriteGeneration(rewriteEvidence),
            position: boundary.start,
            boundaryDigest:
              'boundaryDigest' in boundary
                ? boundary.boundaryDigest
                : digest(boundary.boundaryBytes),
            rewriteWatermark: rewriteEvidence.watermark,
            rewritePosition: rewriteEvidence.position,
            rewriteDigest: rewriteEvidence.digest,
          })
        : undefined;
    return {
      records: consumed.map((entry) => entry.record),
      ...(nextCursor !== undefined ? { nextCursor } : {}),
      truncated: parsed.boundReached && projected.length < limit,
    };
  } finally {
    await opened.handle.close();
  }
}

function resolveLimit(limit: number | undefined): number {
  if (limit === undefined) return DEFAULT_RECORD_LIMIT;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_RECORD_LIMIT) {
    throw new ClaudeActivityError(
      'invalid',
      `Claude Code activity limit must be an integer in 1..${MAX_RECORD_LIMIT}`,
    );
  }
  return limit;
}

async function readWindow(
  opened: ClaudeOpenedRollout,
  endOffset: number,
  maxReadChunkBytes?: number,
): Promise<{ bytes: Buffer; startOffset: number }> {
  const startOffset = Math.max(0, endOffset - MAX_DECODED_BYTES);
  const length = endOffset - startOffset;
  const bytes = await readBytesAt(opened.handle, startOffset, length, {
    ...(maxReadChunkBytes !== undefined
      ? { maxChunkBytes: maxReadChunkBytes }
      : {}),
  });
  return { bytes, startOffset };
}

function parseEntries(
  bytes: Buffer,
  baseOffset: number,
  sessionId: string | null,
): ParsedEntries {
  const deadline = Date.now() + MAX_ELAPSED_MS;
  const entriesNewestFirst: NativeEntry[] = [];
  const firstBoundary =
    baseOffset === 0 ? 0 : Math.max(0, bytes.indexOf(0x0a) + 1);
  let lineEnd = bytes.length;
  if (lineEnd > 0 && bytes[lineEnd - 1] !== 0x0a) {
    lineEnd = bytes.lastIndexOf(0x0a, lineEnd - 1) + 1;
  }
  let cursor = lineEnd;
  while (
    cursor > firstBoundary &&
    entriesNewestFirst.length < MAX_NATIVE_RECORDS &&
    Date.now() <= deadline
  ) {
    const previousNewline = bytes.lastIndexOf(0x0a, cursor - 2);
    const lineStart = Math.max(firstBoundary, previousNewline + 1);
    const rawEnd = cursor - 1;
    const raw = bytes.subarray(lineStart, rawEnd).toString('utf8');
    const value = parseRecord(raw);
    if (value === null && raw.trim() !== '') {
      throw new ClaudeActivityError(
        'invalid',
        'Claude Code activity contains an unreadable record',
      );
    }
    if (value !== null) {
      const nativeSessionId = stringValue(value['sessionId']);
      if (nativeSessionId !== null) {
        if (sessionId !== null && nativeSessionId !== sessionId) {
          throw new ClaudeActivityError(
            'session_mismatch',
            'Claude Code activity does not belong to the selected session',
          );
        }
      }
      if (isProjectableRecord(value) && nativeSessionId === null) {
        throw new ClaudeActivityError(
          'invalid',
          'Claude Code activity record has no native session id',
        );
      }
      entriesNewestFirst.push({
        start: baseOffset + lineStart,
        end: baseOffset + cursor,
        raw,
        boundaryBytes: bytes.subarray(lineStart, cursor),
        value,
      });
    }
    cursor = lineStart;
  }
  const entries = entriesNewestFirst.reverse();
  return {
    entries,
    oldestProcessed: entries[0] ?? null,
    boundReached:
      baseOffset > 0 ||
      cursor > firstBoundary ||
      entriesNewestFirst.length >= MAX_NATIVE_RECORDS ||
      Date.now() > deadline,
  };
}

function buildSelectedChain(entries: readonly NativeEntry[]): NativeEntry[] {
  const byId = new Map<string, NativeEntry>();
  const parents = new Set<string>();
  for (const entry of entries) {
    const uuid = stringValue(entry.value['uuid']);
    if (uuid === null) continue;
    byId.set(uuid, entry);
    const parent = stringValue(entry.value['parentUuid']);
    if (parent !== null) parents.add(parent);
  }
  const leaf =
    [...entries]
      .reverse()
      .find((entry) => {
        const uuid = stringValue(entry.value['uuid']);
        return (
          uuid !== null &&
          !parents.has(uuid) &&
          isConversationParticipant(entry.value)
        );
      }) ?? null;
  if (leaf === null) return [];
  const chain: NativeEntry[] = [];
  const seen = new Set<string>();
  let current: NativeEntry | undefined = leaf;
  while (current !== undefined && chain.length < MAX_NATIVE_RECORDS) {
    const uuid = stringValue(current.value['uuid']);
    if (uuid === null || seen.has(uuid)) break;
    seen.add(uuid);
    chain.push(current);
    const parent: string | null =
      stringValue(current.value['parentUuid']) ??
      stringValue(current.value['logicalParentUuid']);
    current = parent === null ? undefined : byId.get(parent);
  }
  return chain.reverse();
}

/**
 * Project the selected native chain into chronological neutral records.
 *
 * Deliberately flat: no turn grouping and no completion-marker gate, so an
 * in-progress turn yields records immediately. Only assistant text and tool
 * name/status cross the seam — never tool inputs, tool results, or human
 * prompts.
 */
function projectActivity(
  chain: readonly NativeEntry[],
  includeTools: boolean,
): PositionedRecord[] {
  const records: PositionedRecord[] = [];
  const tools = new Map<string, PositionedRecord>();

  for (const entry of chain) {
    const occurredAt = timestampIso(entry.value['timestamp']);
    const type = entry.value['type'];
    const message = recordValue(entry.value['message']);
    const content = message?.['content'];
    if (type === 'assistant') {
      if (!Array.isArray(content)) continue;
      const text = visibleText(content, 'text');
      if (text !== '') {
        records.push(
          positioned(entry, {
            kind: 'assistant_message',
            text,
            ...(occurredAt !== null ? { occurredAt } : {}),
          }),
        );
      }
      if (!includeTools) continue;
      for (const nativeBlock of content) {
        const block = recordValue(nativeBlock);
        if (block?.['type'] !== 'tool_use') continue;
        const id = stringValue(block['id']);
        const name = stringValue(block['name']);
        if (id === null || name === null) continue;
        const record = positioned(entry, {
          kind: 'tool',
          name,
          status: 'started',
          ...(occurredAt !== null ? { occurredAt } : {}),
        });
        tools.set(id, record);
        records.push(record);
      }
      continue;
    }
    if (type !== 'user' || !Array.isArray(content) || !includeTools) continue;
    for (const nativeBlock of content) {
      const block = recordValue(nativeBlock);
      if (block?.['type'] !== 'tool_result') continue;
      const toolUseId = stringValue(block['tool_use_id']);
      if (toolUseId === null) continue;
      const tool = tools.get(toolUseId);
      // A result whose call fell outside this window has no record to settle;
      // the call keeps its own 'started' record on the page that holds it.
      if (tool === undefined || tool.record.kind !== 'tool') continue;
      tool.record = {
        kind: 'tool',
        name: tool.record.name,
        status: block['is_error'] === true ? 'failed' : 'completed',
        ...(tool.record.occurredAt !== undefined
          ? { occurredAt: tool.record.occurredAt }
          : {}),
      };
    }
  }

  return records;
}

function positioned(
  entry: NativeEntry,
  record: AgentActivityRecord,
): PositionedRecord {
  return {
    start: entry.start,
    boundaryDigest: digest(entry.boundaryBytes),
    record,
  };
}

async function verifyCursorBoundaryDigest(
  opened: ClaudeOpenedRollout,
  position: number,
  expected: string,
  maxReadChunkBytes?: number,
): Promise<void> {
    const length = Math.min(
      MAX_DECODED_BYTES,
      Math.max(0, opened.size - position),
    );
    const bytes = await readBytesAt(opened.handle, position, length, {
      ...(maxReadChunkBytes !== undefined
        ? { maxChunkBytes: maxReadChunkBytes }
        : {}),
    });
    const newline = bytes.indexOf(0x0a, 0);
    if (bytes.length === 0) {
      throw new ClaudeActivityError(
        'cursor_stale',
        'Claude Code activity cursor is no longer valid',
      );
    }
    if (newline < 0) {
      throw new ClaudeActivityError(
        'scan_unsupported',
        'Claude Code activity cursor boundary exceeds the bounded limit',
      );
    }
    const boundaryBytes = bytes.subarray(0, newline + 1);
    if (digest(boundaryBytes) !== expected) {
      throw new ClaudeActivityError(
        'cursor_stale',
        'Claude Code activity cursor is no longer valid',
      );
    }
}

function isConversationParticipant(value: Record<string, unknown>): boolean {
  if (value['isSidechain'] === true || value['isMeta'] === true) return false;
  return (
    value['type'] === 'user' ||
    value['type'] === 'assistant' ||
    (value['type'] === 'system' &&
      (value['subtype'] === 'compact_boundary' ||
        value['subtype'] === 'turn_duration'))
  );
}

function isProjectableRecord(value: Record<string, unknown>): boolean {
  return (
    value['type'] === 'user' ||
    value['type'] === 'assistant' ||
    (value['type'] === 'system' && value['subtype'] === 'turn_duration')
  );
}

async function verifyRewriteEvidence(
  opened: ClaudeOpenedRollout,
  cursor: ReturnType<typeof decodeClaudeCursor> | null,
  maxReadChunkBytes?: number,
): Promise<RewriteEvidence> {
  if (cursor === null) {
    const start = Math.max(0, opened.size - MAX_DECODED_BYTES);
    return scanRewriteEvidence(
      opened,
      start,
      opened.size,
      start === 0,
      maxReadChunkBytes,
    );
  }
  if (
    cursor.gen !==
    rewriteGeneration({
      watermark: cursor.rw,
      position: cursor.rp,
      digest: cursor.rd,
    })
  ) {
    throw new ClaudeActivityError(
      'cursor_stale',
      'Claude Code activity cursor is no longer valid',
    );
  }
  if (cursor.rw > opened.size) {
    throw new ClaudeActivityError(
      'cursor_stale',
      'Claude Code activity cursor is no longer valid',
    );
  }
  if (cursor.rp !== null && cursor.rd !== null) {
    await verifyCursorBoundaryDigest(
      opened,
      cursor.rp,
      cursor.rd,
      maxReadChunkBytes,
    );
  }
  const appended = await scanRewriteEvidence(
    opened,
    cursor.rw,
    opened.size,
    true,
    maxReadChunkBytes,
  );
  if (appended.position !== null) {
    throw new ClaudeActivityError(
      'cursor_stale',
      'Claude Code activity cursor is no longer valid',
    );
  }
  return {
    watermark: appended.watermark,
    position: cursor.rp,
    digest: cursor.rd,
  };
}

async function scanRewriteEvidence(
  opened: ClaudeOpenedRollout,
  start: number,
  end: number,
  startsAtBoundary: boolean,
  maxReadChunkBytes?: number,
): Promise<RewriteEvidence> {
  const length = end - start;
  if (length > MAX_DECODED_BYTES) {
    throw new ClaudeActivityError(
      'scan_unsupported',
      'Claude Code activity interval exceeds the bounded limit',
    );
  }
  const data = await readBytesAt(opened.handle, start, length, {
    ...(maxReadChunkBytes !== undefined
      ? { maxChunkBytes: maxReadChunkBytes }
      : {}),
  });
  let position: number | null = null;
  let evidenceDigest: string | null = null;
  let cursor = startsAtBoundary
    ? 0
    : data.indexOf(0x0a) + 1;
  if (cursor === 0 && !startsAtBoundary && data.length > 0) {
    throw new ClaudeActivityError(
      'scan_unsupported',
      'Claude Code activity cannot find a bounded record boundary',
    );
  }
  while (cursor < data.length) {
    const newline = data.indexOf(0x0a, cursor);
    if (newline < 0) break;
    const raw = data.subarray(cursor, newline).toString('utf8');
    const value = parseRecord(raw);
    if (value === null && raw.trim() !== '') {
      throw new ClaudeActivityError(
        'invalid',
        'Claude Code activity contains an unreadable record',
      );
    }
    if (value !== null && isRewriteRecord(value)) {
      position = start + cursor;
      evidenceDigest = digest(data.subarray(cursor, newline + 1));
    }
    cursor = newline + 1;
  }
  return {
    watermark: start + cursor,
    position,
    digest: evidenceDigest,
  };
}

function rewriteGeneration(evidence: RewriteEvidence): string {
  return digest(
    JSON.stringify({
      watermark: evidence.watermark,
      position: evidence.position,
      digest: evidence.digest,
    }),
  );
}

function isRewriteRecord(value: Record<string, unknown>): boolean {
  return (
    value['type'] === 'summary' ||
    (value['type'] === 'system' &&
      value['subtype'] === 'compact_boundary') ||
    value['snipMetadata'] !== undefined
  );
}


function visibleText(value: unknown, type: string): string {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) return '';
  return value
    .flatMap((entry) => {
      const block = recordValue(entry);
      return block?.['type'] === type && typeof block['text'] === 'string'
        ? [block['text']]
        : [];
    })
    .join('');
}

function parseRecord(raw: string): Record<string, unknown> | null {
  try {
    return recordValue(JSON.parse(raw));
  } catch {
    return null;
  }
}

function effectiveEnvironment(
  context: AgentActivityReadContext<DispatcherClaudeCodeConfig>,
): Record<string, string | undefined> {
  return {
    ...process.env,
    ...(context.injectEnv ?? {}),
    ...context.config.extra_env,
  };
}

function timestampIso(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : new Date(parsed).toISOString();
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}
