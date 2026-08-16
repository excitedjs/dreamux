import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { isAbsolute, relative, sep } from 'node:path';

import type {
  AgentRuntimeTranscriptBlock,
  AgentRuntimeTranscriptTurn,
} from '@excitedjs/dreamux-types';

export const TRANSCRIPT_MESSAGE_MAX_CHARS = 16_384;
export const TRANSCRIPT_TOOL_VALUE_MAX_CHARS = 4_096;
export const TRANSCRIPT_BLOCKS_PER_TURN_MAX = 64;
export const TRANSCRIPT_TURNS_MAX = 50;
export const TRANSCRIPT_DISCOVERY_MAX_ENTRIES = 20_000;
export const TRANSCRIPT_DISCOVERY_MAX_ELAPSED_MS = 2_000;

const REDACTED = '[REDACTED]';
const SECRET_FIELD =
  /(?:^|_)(?:api[_-]?key|authorization|cookie|credential|password|private[_-]?key|secret|session[_-]?token|token)(?:$|_)/i;

export interface TranscriptBudgetResult {
  turnsNewestFirst: AgentRuntimeTranscriptTurn[];
  consumed: number;
  truncated: boolean;
}

export interface TranscriptScanBudget {
  inspect(entries?: number): void;
}

export interface TranscriptPositionalReader {
  read(
    buffer: Buffer,
    offset: number,
    length: number,
    position: number,
  ): Promise<{ bytesRead: number }>;
}

export function transcriptDigest(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('base64url');
}

export function isTranscriptDigest(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value);
}

export function isTranscriptTurnCount(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= 1 &&
    value <= TRANSCRIPT_TURNS_MAX
  );
}

export function createTranscriptScanBudget(input: {
  maxEntries?: number;
  maxElapsedMs?: number;
  now?: () => number;
  limitError: () => Error;
}): TranscriptScanBudget {
  const maxEntries =
    input.maxEntries ?? TRANSCRIPT_DISCOVERY_MAX_ENTRIES;
  const now = input.now ?? Date.now;
  const deadline =
    now() +
    (input.maxElapsedMs ?? TRANSCRIPT_DISCOVERY_MAX_ELAPSED_MS);
  let inspected = 0;
  return {
    inspect(entries = 1): void {
      inspected += entries;
      if (inspected > maxEntries || now() > deadline) {
        throw input.limitError();
      }
    },
  };
}

export async function readTranscriptBytesAt(
  reader: TranscriptPositionalReader,
  position: number,
  length: number,
  options: { maxChunkBytes?: number } = {},
): Promise<Buffer> {
  if (
    !Number.isSafeInteger(position) ||
    position < 0 ||
    !Number.isSafeInteger(length) ||
    length < 0
  ) {
    throw new RangeError('transcript positional read requires non-negative integers');
  }
  const maxChunkBytes = options.maxChunkBytes ?? length;
  if (!Number.isSafeInteger(maxChunkBytes) || maxChunkBytes <= 0) {
    if (length === 0) return Buffer.alloc(0);
    throw new RangeError('transcript positional read chunk size must be positive');
  }
  const bytes = Buffer.alloc(length);
  let offset = 0;
  while (offset < length) {
    const requested = Math.min(length - offset, maxChunkBytes);
    const read = await reader.read(
      bytes,
      offset,
      requested,
      position + offset,
    );
    if (
      !Number.isSafeInteger(read.bytesRead) ||
      read.bytesRead < 0 ||
      read.bytesRead > requested
    ) {
      throw new Error('transcript positional reader returned an invalid byte count');
    }
    if (read.bytesRead === 0) break;
    offset += read.bytesRead;
  }
  return bytes.subarray(0, offset);
}

export function isPathWithin(root: string, candidate: string): boolean {
  const child = relative(root, candidate);
  return (
    child === '' ||
    (!child.startsWith(`..${sep}`) && child !== '..' && !isAbsolute(child))
  );
}

export function renderTranscriptValue(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return value;
  return JSON.stringify(sortAndRedact(value));
}

export function boundTranscriptTurn(
  turn: AgentRuntimeTranscriptTurn,
): { turn: AgentRuntimeTranscriptTurn; truncated: boolean } {
  let truncated = turn.blocks.length > TRANSCRIPT_BLOCKS_PER_TURN_MAX;
  const blocks = turn.blocks
    .slice(0, TRANSCRIPT_BLOCKS_PER_TURN_MAX)
    .map((block): AgentRuntimeTranscriptBlock => {
      if (block.kind === 'message') {
        const text = clipCharacters(block.text, TRANSCRIPT_MESSAGE_MAX_CHARS);
        truncated ||= text.truncated || block.truncated;
        return {
          kind: 'message',
          role: block.role,
          text: text.value,
          truncated: block.truncated || text.truncated,
        };
      }
      const input =
        block.input === null
          ? null
          : clipCharacters(block.input, TRANSCRIPT_TOOL_VALUE_MAX_CHARS);
      const output =
        block.output === null
          ? null
          : clipCharacters(block.output, TRANSCRIPT_TOOL_VALUE_MAX_CHARS);
      truncated ||=
        block.inputTruncated ||
        block.outputTruncated ||
        input?.truncated === true ||
        output?.truncated === true;
      return {
        kind: 'tool',
        name: block.name,
        input: input?.value ?? null,
        output: output?.value ?? null,
        status: block.status,
        inputTruncated: block.inputTruncated || input?.truncated === true,
        outputTruncated: block.outputTruncated || output?.truncated === true,
      };
    });
  return {
    turn: {
      startedAt: turn.startedAt,
      endedAt: turn.endedAt,
      blocks,
    },
    truncated,
  };
}

/**
 * Apply the fixed serialized `turns` budget to candidates ordered newest first.
 * The newest candidate is always consumed and deterministically clipped when
 * necessary; subsequent older candidates are consumed only whole.
 */
export function budgetTranscriptTurns(
  candidatesNewestFirst: readonly AgentRuntimeTranscriptTurn[],
  budgetBytes: number,
): TranscriptBudgetResult {
  if (!Number.isInteger(budgetBytes) || budgetBytes < 2) {
    throw new Error('transcript output budget must be an integer of at least 2 bytes');
  }
  const turnsNewestFirst: AgentRuntimeTranscriptTurn[] = [];
  let truncated = false;
  let consumed = 0;

  for (const candidate of candidatesNewestFirst) {
    const bounded = boundTranscriptTurn(candidate);
    truncated ||= bounded.truncated;
    const next = [...turnsNewestFirst, bounded.turn];
    if (serializedTurnsBytes(next) <= budgetBytes) {
      turnsNewestFirst.push(bounded.turn);
      consumed += 1;
      continue;
    }
    if (turnsNewestFirst.length > 0) break;
    turnsNewestFirst.push(clipTurnToBudget(bounded.turn, budgetBytes));
    consumed += 1;
    truncated = true;
    break;
  }

  return { turnsNewestFirst, consumed, truncated };
}

function clipTurnToBudget(
  turn: AgentRuntimeTranscriptTurn,
  budgetBytes: number,
): AgentRuntimeTranscriptTurn {
  const mutable: AgentRuntimeTranscriptBlock[] = turn.blocks.map((block) => ({
    ...block,
  }));
  const result = (): AgentRuntimeTranscriptTurn => ({
    startedAt: turn.startedAt,
    endedAt: turn.endedAt,
    blocks: mutable,
  });

  while (mutable.length > 1 && serializedTurnsBytes([result()]) > budgetBytes) {
    mutable.pop();
  }
  if (serializedTurnsBytes([result()]) <= budgetBytes) return result();

  const block = mutable[0];
  if (block === undefined) return result();
  if (block.kind === 'message') {
    block.text = clipStringToSerializedBudget(
      block.text,
      budgetBytes,
      (value) => {
        block.text = value;
        block.truncated = true;
        return serializedTurnsBytes([result()]);
      },
    );
    block.truncated = true;
    return result();
  }

  for (const field of ['output', 'input', 'name'] as const) {
    const value = block[field];
    if (value === null || value === '') continue;
    const clipped = clipStringToSerializedBudget(
      value,
      budgetBytes,
      (nextValue) => {
        block[field] = nextValue;
        if (field === 'input') block.inputTruncated = true;
        if (field === 'output') block.outputTruncated = true;
        return serializedTurnsBytes([result()]);
      },
    );
    block[field] = clipped;
    if (field === 'input') block.inputTruncated = true;
    if (field === 'output') block.outputTruncated = true;
    if (serializedTurnsBytes([result()]) <= budgetBytes) return result();
  }
  return result();
}

function clipStringToSerializedBudget(
  input: string,
  budgetBytes: number,
  serializedBytes: (value: string) => number,
): string {
  let low = 0;
  let high = [...input].length;
  let best = '';
  const characters = [...input];
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const candidate = characters.slice(0, middle).join('');
    if (serializedBytes(candidate) <= budgetBytes) {
      best = candidate;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return best;
}

function clipCharacters(
  input: string,
  limit: number,
): { value: string; truncated: boolean } {
  const characters = [...input];
  return characters.length <= limit
    ? { value: input, truncated: false }
    : { value: characters.slice(0, limit).join(''), truncated: true };
}

function serializedTurnsBytes(turns: readonly AgentRuntimeTranscriptTurn[]): number {
  return Buffer.byteLength(JSON.stringify(turns), 'utf8');
}

function sortAndRedact(value: unknown, key?: string): unknown {
  if (key !== undefined && SECRET_FIELD.test(key)) return REDACTED;
  if (Array.isArray(value)) {
    return value.map((entry) => sortAndRedact(entry));
  }
  if (value === null || typeof value !== 'object') return value;
  const record = value as Record<string, unknown>;
  return Object.fromEntries(
    Object.keys(record)
      .sort()
      .map((entry) => [entry, sortAndRedact(record[entry], entry)]),
  );
}
