import type {
  AgentRuntimeTranscriptBlock,
  AgentRuntimeTranscriptContext,
  AgentRuntimeTranscriptPage,
  AgentRuntimeTranscriptQuery,
  AgentRuntimeTranscriptTurn,
} from '@excitedjs/dreamux-types';
import {
  budgetTranscriptTurns,
  isTranscriptTurnCount,
  readTranscriptBytesAt,
  renderTranscriptValue,
} from '@excitedjs/dreamux-utils';

import type { DispatcherClaudeCodeConfig } from '../config.js';
import {
  hasAssistantWithoutHumanBoundary,
  hasCompletionEvidence,
  hasOpenTail,
  isHumanPrompt,
} from './completion.js';
import {
  claudeQueryFingerprint,
  decodeClaudeCursor,
  digest,
  encodeClaudeCursor,
} from './cursor.js';
import { ClaudeTranscriptError } from './error.js';
import {
  openClaudeTranscript,
  type ClaudeOpenedTranscript,
  validateClaudeSessionEvidence,
} from './opened-file.js';
import { recoverParallelToolBranches } from './parallel-tools.js';
import {
  locateClaudeTranscript,
} from './path.js';
import { applyNativeRewrites } from './rewrites.js';

const MAX_DECODED_BYTES = 8_388_608;
const MAX_NATIVE_RECORDS = 20_000;
const MAX_ELAPSED_MS = 2_000;

interface NativeEntry {
  start: number;
  end: number;
  raw: string;
  boundaryBytes: Buffer;
  value: Record<string, unknown>;
}

interface NativeTurn {
  start: number;
  boundaryDigest: string;
  turn: AgentRuntimeTranscriptTurn;
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

export async function readClaudeTranscript(
  query: AgentRuntimeTranscriptQuery,
  context: AgentRuntimeTranscriptContext<DispatcherClaudeCodeConfig>,
  testHooks: {
    afterLocate?: () => void | Promise<void>;
    maxReadChunkBytes?: number;
  } = {},
): Promise<AgentRuntimeTranscriptPage> {
  if (!isTranscriptTurnCount(query.turns)) {
    throw new ClaudeTranscriptError(
      'invalid',
      'Claude Code transcript query turns must be an integer in 1..50',
    );
  }
  const checkpoint = context.checkpoint;
  if (checkpoint === null) {
    throw new ClaudeTranscriptError(
      'checkpoint_missing',
      'Claude Code transcript is unavailable before a session is established',
    );
  }
  const includeTools = query.includeTools ?? true;
  const env = effectiveEnvironment(context);
  const located = await locateClaudeTranscript({
    sessionId: checkpoint.id,
    cwd: context.cwd,
    locator: checkpoint.transcript_locator,
    env,
  });
  await testHooks.afterLocate?.();
  const opened = await openClaudeTranscript(located.path, located.root);
  if (opened.dev !== located.dev || opened.ino !== located.ino) {
    await opened.handle.close();
    throw new ClaudeTranscriptError(
      'unreadable',
      'Claude Code transcript changed after validation',
    );
  }
  try {
  await validateClaudeSessionEvidence(opened, checkpoint.id, {
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
  const parsed = parseEntries(window.bytes, window.startOffset, checkpoint.id);
  const logical = applyNativeRewrites(parsed.entries);
  const chain = recoverParallelToolBranches(
    logical,
    buildSelectedChain(logical),
  );
  const nativeTurns = groupTurns(chain, includeTools);
  const candidates = nativeTurns.slice(-query.turns).reverse();
  const openTailOnly =
    cursor === null &&
    candidates.length === 0 &&
    (!hasCompletionEvidence(chain) || hasOpenTail(chain));
  if (
    candidates.length === 0 &&
    !openTailOnly &&
    parsed.boundReached &&
    hasCompletionEvidence(chain) &&
    hasAssistantWithoutHumanBoundary(chain)
  ) {
    throw new ClaudeTranscriptError(
      'scan_unsupported',
      'Claude Code completed turn exceeds the bounded scan limit',
    );
  }
  const budgeted = budgetTranscriptTurns(
    candidates.map((candidate) => candidate.turn),
    context.outputBudgetBytes,
  );
  const consumed = candidates.slice(0, budgeted.consumed);
  const hasOlder =
    !openTailOnly &&
    (consumed.at(-1)?.start ?? endOffset) > 0 &&
    (nativeTurns.length > consumed.length || parsed.boundReached);
  const boundary =
    consumed.at(-1) ??
    (hasOlder && candidates.length === 0 ? parsed.oldestProcessed : null);
  if (
    boundary !== null &&
    cursor !== null &&
    boundary.start >= cursor.pos
  ) {
    throw new ClaudeTranscriptError(
      'scan_unsupported',
      'Claude Code transcript pagination cannot make safe progress',
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
      : null;
  return {
    turns: [...budgeted.turnsNewestFirst].reverse(),
    nextCursor,
    truncated: budgeted.truncated,
  };
  } finally {
    await opened.handle.close();
  }
}

async function readWindow(
  opened: ClaudeOpenedTranscript,
  endOffset: number,
  maxReadChunkBytes?: number,
): Promise<{ bytes: Buffer; startOffset: number }> {
  const startOffset = Math.max(0, endOffset - MAX_DECODED_BYTES);
  const length = endOffset - startOffset;
  const bytes = await readTranscriptBytesAt(opened.handle, startOffset, length, {
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
      throw new ClaudeTranscriptError(
        'invalid',
        'Claude Code transcript contains an invalid native record',
      );
    }
    if (value !== null) {
      const nativeSessionId = stringValue(value['sessionId']);
      if (nativeSessionId !== null) {
        if (sessionId !== null && nativeSessionId !== sessionId) {
          throw new ClaudeTranscriptError(
            'session_mismatch',
            'Claude Code transcript does not belong to the selected session',
          );
        }
      }
      if (isProjectableRecord(value) && nativeSessionId === null) {
        throw new ClaudeTranscriptError(
          'invalid',
          'Claude Code conversation record has no native session id',
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

function groupTurns(
  chain: readonly NativeEntry[],
  includeTools: boolean,
): NativeTurn[] {
  const turns: NativeTurn[] = [];
  let current: NativeEntry[] = [];
  for (const entry of chain) {
    if (isHumanPrompt(entry.value)) {
      commitCurrentTurn(turns, current, includeTools);
      current = [entry];
    } else if (current.length > 0) {
      current.push(entry);
    }
  }
  commitCurrentTurn(turns, current, includeTools);
  return turns;
}

function commitCurrentTurn(
  turns: NativeTurn[],
  entries: readonly NativeEntry[],
  includeTools: boolean,
): void {
  if (
    entries.length === 0 ||
    !hasCompletionEvidence(entries)
  ) {
    return;
  }
  const blocks: AgentRuntimeTranscriptBlock[] = [];
  const tools = new Map<
    string,
    {
      index: number;
      name: string;
      input: string | null;
      output: string | null;
      status: 'ok' | 'error';
    }
  >();
  let startedAt: number | null = null;
  let endedAt: number | null = null;

  for (const entry of entries) {
    const timestamp = timestampMs(entry.value['timestamp']);
    startedAt ??= timestamp;
    endedAt = timestamp ?? endedAt;
    const type = entry.value['type'];
    const message = recordValue(entry.value['message']);
    const content = message?.['content'];
    if (type === 'user' && isHumanPrompt(entry.value)) {
      const text = visibleText(content, 'text');
      if (text !== '') {
        blocks.push({
          kind: 'message',
          role: 'user',
          text,
          truncated: false,
        });
      }
    } else if (type === 'assistant') {
      if (!Array.isArray(content)) continue;
      const text = visibleText(content, 'text');
      if (text !== '') {
        blocks.push({
          kind: 'message',
          role: 'assistant',
          text,
          truncated: false,
        });
      }
      for (const nativeBlock of content) {
        const block = recordValue(nativeBlock);
        if (block?.['type'] !== 'tool_use') continue;
        const id = stringValue(block['id']);
        const name = stringValue(block['name']);
        if (id === null || name === null) continue;
        const publicIndex = includeTools ? blocks.length : -1;
        tools.set(id, {
          index: publicIndex,
          name,
          input: renderTranscriptValue(block['input']),
          output: null,
          status: 'error',
        });
        if (includeTools) {
          blocks.push({
            kind: 'tool',
            name,
            input: renderTranscriptValue(block['input']),
            output: null,
            status: 'error',
            inputTruncated: false,
            outputTruncated: false,
          });
        }
      }
    } else if (type === 'user' && Array.isArray(content)) {
      for (const nativeBlock of content) {
        const block = recordValue(nativeBlock);
        if (block?.['type'] !== 'tool_result') continue;
        const toolUseId = stringValue(block['tool_use_id']);
        if (toolUseId === null) continue;
        const tool = tools.get(toolUseId);
        if (tool === undefined) continue;
        tool.output = renderToolResult(block['content']);
        tool.status = block['is_error'] === true ? 'error' : 'ok';
        if (includeTools) {
          const publicBlock = blocks[tool.index];
          if (publicBlock?.kind === 'tool') {
            publicBlock.output = tool.output;
            publicBlock.status = tool.status;
          }
        }
      }
    }
  }
  turns.push({
    start: entries[0]!.start,
    boundaryDigest: digest(entries[0]!.boundaryBytes),
    turn: { startedAt, endedAt, blocks },
  });
}

async function verifyCursorBoundaryDigest(
  opened: ClaudeOpenedTranscript,
  position: number,
  expected: string,
  maxReadChunkBytes?: number,
): Promise<void> {
    const length = Math.min(
      MAX_DECODED_BYTES,
      Math.max(0, opened.size - position),
    );
    const bytes = await readTranscriptBytesAt(opened.handle, position, length, {
      ...(maxReadChunkBytes !== undefined
        ? { maxChunkBytes: maxReadChunkBytes }
        : {}),
    });
    const newline = bytes.indexOf(0x0a, 0);
    if (bytes.length === 0) {
      throw new ClaudeTranscriptError(
        'cursor_stale',
        'Claude Code transcript cursor is stale',
      );
    }
    if (newline < 0) {
      throw new ClaudeTranscriptError(
        'scan_unsupported',
        'Claude Code cursor boundary record exceeds the bounded scan limit',
      );
    }
    const boundaryBytes = bytes.subarray(0, newline + 1);
    if (digest(boundaryBytes) !== expected) {
      throw new ClaudeTranscriptError(
        'cursor_stale',
        'Claude Code transcript cursor is stale',
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
  opened: ClaudeOpenedTranscript,
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
    throw new ClaudeTranscriptError(
      'cursor_stale',
      'Claude Code transcript cursor is stale',
    );
  }
  if (cursor.rw > opened.size) {
    throw new ClaudeTranscriptError(
      'cursor_stale',
      'Claude Code transcript cursor is stale',
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
    throw new ClaudeTranscriptError(
      'cursor_stale',
      'Claude Code transcript cursor is stale',
    );
  }
  return {
    watermark: appended.watermark,
    position: cursor.rp,
    digest: cursor.rd,
  };
}

async function scanRewriteEvidence(
  opened: ClaudeOpenedTranscript,
  start: number,
  end: number,
  startsAtBoundary: boolean,
  maxReadChunkBytes?: number,
): Promise<RewriteEvidence> {
  const length = end - start;
  if (length > MAX_DECODED_BYTES) {
    throw new ClaudeTranscriptError(
      'scan_unsupported',
      'Claude Code rewrite interval exceeds the bounded scan limit',
    );
  }
  const data = await readTranscriptBytesAt(opened.handle, start, length, {
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
    throw new ClaudeTranscriptError(
      'scan_unsupported',
      'Claude Code rewrite scan cannot find a bounded record boundary',
    );
  }
  while (cursor < data.length) {
    const newline = data.indexOf(0x0a, cursor);
    if (newline < 0) break;
    const raw = data.subarray(cursor, newline).toString('utf8');
    const value = parseRecord(raw);
    if (value === null && raw.trim() !== '') {
      throw new ClaudeTranscriptError(
        'invalid',
        'Claude Code transcript contains an invalid native record',
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

function renderToolResult(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    const text = visibleText(value, 'text');
    if (text !== '') return text;
  }
  return renderTranscriptValue(value);
}

function parseRecord(raw: string): Record<string, unknown> | null {
  try {
    return recordValue(JSON.parse(raw));
  } catch {
    return null;
  }
}

function effectiveEnvironment(
  context: AgentRuntimeTranscriptContext<DispatcherClaudeCodeConfig>,
): Record<string, string | undefined> {
  return {
    ...process.env,
    ...(context.injectEnv ?? {}),
    ...context.config.extra_env,
  };
}

function timestampMs(value: unknown): number | null {
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
