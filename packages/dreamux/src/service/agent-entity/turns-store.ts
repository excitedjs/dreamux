import { createReadStream } from 'node:fs';
import { open, readdir } from 'node:fs/promises';
import { Buffer } from 'node:buffer';
import { join } from 'node:path';
import { TextDecoder } from 'node:util';

import { isNotFound } from '../../platform/fs-errors.js';
import { appendJsonLine } from '../../platform/jsonl.js';
import {
  dispatcherAgentTurnsPath,
  dispatcherDir,
} from '../../platform/paths.js';
import { LegacyStateError } from '../legacy-state.js';
import type {
  AgentEntityRole,
  AgentEntityTurnOrigin,
  AgentEntityTurnRecord,
} from './types.js';

export interface AgentTurnsScope {
  dispatcherId: string;
  name: string;
  teamId: string | null;
  role: AgentEntityRole;
}

function turnsPath(scope: AgentTurnsScope): string {
  return dispatcherAgentTurnsPath({
    dispatcherId: scope.dispatcherId,
    name: scope.name,
    teamId: scope.teamId,
    role: scope.role,
  });
}

const PREVIEW_MAX = 500;
const PREVIEW_HEAD = 497;
const MAX_TURN_ROW_BYTES = 2 * 1024 * 1024;
const TERMINAL_TURN_KEYS = [
  'version',
  'type',
  'submitted_at',
  'settled_at',
  'turn_origin',
  'prompt_preview',
  'intent',
  'settle_status',
  'assistant',
  'assistant_preview',
  'assistant_truncated',
] as const;
const SCHEDULED_TURN_ORIGIN_KEYS = ['kind', 'job_id'] as const;

export const ASSISTANT_TEXT_MAX = 160_000;

export const LEGACY_TURN_ARCHIVE_REBUILD =
  'Rebuild: stop Dreamux, back up the affected dispatcher state, then delete ' +
  'every legacy turn.jsonl below ~/.dreamux/state/<dispatcher-id>/ before ' +
  'restarting. TeamMate identities and runtime checkpoints remain; historical ' +
  'Turn detail in those deleted archives is discarded.';

export interface AgentTerminalTurnInput {
  submittedAt: number;
  settledAt: number;
  turnOrigin: AgentEntityTurnOrigin | null;
  prompt: string | null;
  intent: string | null;
  settleStatus: AgentEntityTurnRecord['settle_status'];
  assistant: string | null;
  assistantTruncated?: boolean;
}

/** Strict v2 terminal Turn archive. Every logical Turn contributes one row. */
export class AgentTurnsStore {
  async appendTerminal(
    scope: AgentTurnsScope,
    input: AgentTerminalTurnInput,
  ): Promise<AgentEntityTurnRecord> {
    const path = turnsPath(scope);
    await prepareArchiveForAppend(path);
    const raw = input.assistant;
    const assistantTruncated =
      input.assistantTruncated === true ||
      (raw !== null && raw.length > ASSISTANT_TEXT_MAX);
    const assistant =
      raw === null ? null : raw.slice(0, ASSISTANT_TEXT_MAX);
    const row: AgentEntityTurnRecord = {
      version: 2,
      type: 'terminal',
      submitted_at: input.submittedAt,
      settled_at: input.settledAt,
      turn_origin: input.turnOrigin,
      prompt_preview: input.prompt === null ? null : preview(input.prompt),
      intent: input.intent,
      settle_status: input.settleStatus,
      assistant,
      assistant_preview: raw === null ? null : preview(raw),
      assistant_truncated: assistantTruncated,
    };
    await appendJsonLine(path, row);
    return row;
  }

  async *stream(scope: AgentTurnsScope): AsyncGenerator<AgentEntityTurnRecord> {
    const path = turnsPath(scope);
    try {
      for await (const line of archiveLines(path)) {
        const result = validateArchiveLine(line, path);
        if (result.record !== null) yield result.record;
      }
    } catch (error) {
      if (!isNotFound(error)) throw error;
    }
  }
}

/** Boot preflight for every current-layout Turn archive in one dispatcher. */
export async function assertNoLegacyTurnArchives(
  dispatcherId: string,
): Promise<void> {
  for (const path of await listTurnArchives(dispatcherDir(dispatcherId))) {
    try {
      for await (const line of archiveLines(path)) {
        validateArchiveLine(line, path);
      }
    } catch (error) {
      if (!isNotFound(error)) throw error;
    }
  }
}

async function listTurnArchives(root: string): Promise<string[]> {
  const found: string[] = [];
  const pending = [root];
  while (pending.length > 0) {
    const dir = pending.pop()!;
    let entries: import('node:fs').Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (error) {
      if (isNotFound(error)) continue;
      throw error;
    }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) pending.push(path);
      else if (entry.isFile() && entry.name === 'turn.jsonl') found.push(path);
    }
  }
  return found.sort();
}

export function turnsScopeOf(identity: {
  dispatcher_id: string;
  name: string;
  team_id: string | null;
  role: AgentEntityRole;
}): AgentTurnsScope {
  return {
    dispatcherId: identity.dispatcher_id,
    name: identity.name,
    teamId: identity.team_id,
    role: identity.role,
  };
}

export function preview(text: string): string {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  return collapsed.length <= PREVIEW_MAX
    ? collapsed
    : `${collapsed.slice(0, PREVIEW_HEAD)}...`;
}

function parseRecord(line: string, path: string): AgentEntityTurnRecord {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch (error) {
    throw new Error(`invalid complete Turn archive row in ${path}`, {
      cause: error,
    });
  }
  return parseRecordValue(value, path);
}

function parseRecordValue(
  value: unknown,
  path: string,
): AgentEntityTurnRecord {
  if (isObject(value) && value['version'] === 1) {
    throw legacyTurnArchiveError(path);
  }
  if (!isTerminalTurnRecord(value)) {
    throw new Error(`invalid v2 terminal Turn archive row in ${path}`);
  }
  return value;
}

function isTerminalTurnRecord(value: unknown): value is AgentEntityTurnRecord {
  if (!isObject(value)) return false;
  return (
    hasExactKeys(value, TERMINAL_TURN_KEYS) &&
    value['version'] === 2 &&
    value['type'] === 'terminal' &&
    isFiniteNumber(value['submitted_at']) &&
    isFiniteNumber(value['settled_at']) &&
    isTurnOrigin(value['turn_origin']) &&
    isNullableString(value['prompt_preview']) &&
    isNullableString(value['intent']) &&
    (value['settle_status'] === 'completed' ||
      value['settle_status'] === 'failed' ||
      value['settle_status'] === 'stopped') &&
    isNullableString(value['assistant']) &&
    isNullableString(value['assistant_preview']) &&
    typeof value['assistant_truncated'] === 'boolean'
  );
}

function isTurnOrigin(value: unknown): value is AgentEntityTurnOrigin | null {
  if (
    value === null ||
    value === 'channel' ||
    value === 'dispatcher' ||
    value === 'team_leader'
  ) {
    return true;
  }
  return (
    isObject(value) &&
    hasExactKeys(value, SCHEDULED_TURN_ORIGIN_KEYS) &&
    value['kind'] === 'scheduled' &&
    typeof value['job_id'] === 'string'
  );
}

function hasExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const keys = Object.keys(value);
  return (
    keys.length === expected.length &&
    expected.every((key) => Object.hasOwn(value, key))
  );
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === 'string';
}

function legacyTurnArchiveError(path: string): LegacyStateError {
  return new LegacyStateError(
    `legacy v1 Turn archive found at ${path}. ${LEGACY_TURN_ARCHIVE_REBUILD}`,
  );
}

async function prepareArchiveForAppend(path: string): Promise<void> {
  let handle;
  try {
    let finalLine: ArchiveLine | null = null;
    for await (const line of archiveLines(path)) {
      validateArchiveLine(line, path);
      finalLine = line;
    }
    if (finalLine === null || finalLine.terminatedByNewline) return;

    handle = await open(path, 'r+');
    const info = await handle.stat();
    if (finalLine.torn) {
      await handle.truncate(finalLine.offset);
    } else {
      // A valid final row and whitespace-only final content are preserved.
      await handle.write('\n', info.size, 'utf8');
    }
  } catch (error) {
    if (!isNotFound(error)) throw error;
  } finally {
    await handle?.close();
  }
}

interface ArchiveLine {
  text: string;
  offset: number;
  terminatedByNewline: boolean;
  torn: boolean;
}

const UTF8_DECODER = new TextDecoder('utf-8', { fatal: true });

async function* archiveLines(path: string): AsyncGenerator<ArchiveLine> {
  const input = createReadStream(path);
  let pending = Buffer.alloc(0);
  let offset = 0;
  for await (const raw of input) {
    const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
    pending = pending.length === 0 ? chunk : Buffer.concat([pending, chunk]);
    let newline = pending.indexOf(0x0a);
    while (newline >= 0) {
      const row = pending.subarray(0, newline);
      yield decodeArchiveLine(row, offset, true, path);
      offset += newline + 1;
      pending = pending.subarray(newline + 1);
      newline = pending.indexOf(0x0a);
    }
    if (pending.length > MAX_TURN_ROW_BYTES) {
      throw new Error(
        `Turn archive row exceeds ${MAX_TURN_ROW_BYTES} bytes: ${path}`,
      );
    }
  }
  if (pending.length > 0) {
    yield decodeArchiveLine(pending, offset, false, path);
  }
}

function decodeArchiveLine(
  row: Buffer,
  offset: number,
  terminatedByNewline: boolean,
  path: string,
): ArchiveLine {
  if (row.length > MAX_TURN_ROW_BYTES) {
    throw new Error(
      `Turn archive row exceeds ${MAX_TURN_ROW_BYTES} bytes: ${path}`,
    );
  }
  try {
    return {
      text: UTF8_DECODER.decode(row),
      offset,
      terminatedByNewline,
      torn: false,
    };
  } catch (error) {
    throw new Error(`invalid UTF-8 Turn archive row in ${path}`, {
      cause: error,
    });
  }
}

function validateArchiveLine(
  line: ArchiveLine,
  path: string,
): { record: AgentEntityTurnRecord | null } {
  if (isJsonWhitespace(line.text)) return { record: null };
  if (line.terminatedByNewline) {
    return { record: parseRecord(line.text, path) };
  }
  let value: unknown;
  try {
    value = JSON.parse(line.text);
  } catch (error) {
    if (classifyJsonPrefix(line.text) === 'incomplete') {
      line.torn = true;
      return { record: null };
    }
    throw new Error(`invalid complete Turn archive row in ${path}`, {
      cause: error,
    });
  }
  return { record: parseRecordValue(value, path) };
}

function isJsonWhitespace(value: string): boolean {
  return /^[\x20\t\r]*$/.test(value);
}

type JsonPrefixResult = 'complete' | 'incomplete' | 'invalid';

/** Classifies only whether an EOF-truncated JSON value can still be completed. */
function classifyJsonPrefix(value: string): JsonPrefixResult {
  return new JsonPrefixParser(value).parse();
}

class JsonPrefixParser {
  private index = 0;

  constructor(private readonly input: string) {}

  parse(): JsonPrefixResult {
    this.skipWhitespace();
    const value = this.parseValue();
    if (value !== 'complete') return value;
    this.skipWhitespace();
    return this.index === this.input.length ? 'complete' : 'invalid';
  }

  private parseValue(): JsonPrefixResult {
    if (this.atEnd()) return 'incomplete';
    switch (this.input[this.index]) {
      case '{':
        return this.parseObject();
      case '[':
        return this.parseArray();
      case '"':
        return this.parseString();
      case 't':
        return this.parseLiteral('true');
      case 'f':
        return this.parseLiteral('false');
      case 'n':
        return this.parseLiteral('null');
      default:
        return this.parseNumber();
    }
  }

  private parseObject(): JsonPrefixResult {
    this.index += 1;
    this.skipWhitespace();
    if (this.atEnd()) return 'incomplete';
    if (this.take('}')) return 'complete';
    while (true) {
      if (this.input[this.index] !== '"') return 'invalid';
      const key = this.parseString();
      if (key !== 'complete') return key;
      this.skipWhitespace();
      if (this.atEnd()) return 'incomplete';
      if (!this.take(':')) return 'invalid';
      this.skipWhitespace();
      const value = this.parseValue();
      if (value !== 'complete') return value;
      this.skipWhitespace();
      if (this.atEnd()) return 'incomplete';
      if (this.take('}')) return 'complete';
      if (!this.take(',')) return 'invalid';
      this.skipWhitespace();
      if (this.atEnd()) return 'incomplete';
    }
  }

  private parseArray(): JsonPrefixResult {
    this.index += 1;
    this.skipWhitespace();
    if (this.atEnd()) return 'incomplete';
    if (this.take(']')) return 'complete';
    while (true) {
      const value = this.parseValue();
      if (value !== 'complete') return value;
      this.skipWhitespace();
      if (this.atEnd()) return 'incomplete';
      if (this.take(']')) return 'complete';
      if (!this.take(',')) return 'invalid';
      this.skipWhitespace();
      if (this.atEnd()) return 'incomplete';
      if (this.input[this.index] === ']') return 'invalid';
    }
  }

  private parseString(): JsonPrefixResult {
    this.index += 1;
    while (!this.atEnd()) {
      const char = this.input[this.index++]!;
      if (char === '"') return 'complete';
      if (char.charCodeAt(0) < 0x20) return 'invalid';
      if (char !== '\\') continue;
      if (this.atEnd()) return 'incomplete';
      const escape = this.input[this.index++]!;
      if ('"\\/bfnrt'.includes(escape)) continue;
      if (escape !== 'u') return 'invalid';
      for (let digit = 0; digit < 4; digit += 1) {
        if (this.atEnd()) return 'incomplete';
        if (!/[0-9a-fA-F]/.test(this.input[this.index++]!)) return 'invalid';
      }
    }
    return 'incomplete';
  }

  private parseLiteral(expected: string): JsonPrefixResult {
    for (const char of expected) {
      if (this.atEnd()) return 'incomplete';
      if (this.input[this.index++] !== char) return 'invalid';
    }
    return 'complete';
  }

  private parseNumber(): JsonPrefixResult {
    if (this.take('-') && this.atEnd()) return 'incomplete';
    if (this.take('0')) {
      if (this.isDigit(this.input[this.index])) return 'invalid';
    } else {
      if (!this.isNonZeroDigit(this.input[this.index])) return 'invalid';
      while (this.isDigit(this.input[this.index])) this.index += 1;
    }
    if (this.take('.')) {
      if (this.atEnd()) return 'incomplete';
      if (!this.isDigit(this.input[this.index])) return 'invalid';
      while (this.isDigit(this.input[this.index])) this.index += 1;
    }
    if (this.take('e') || this.take('E')) {
      if (this.atEnd()) return 'incomplete';
      if (this.take('+') || this.take('-')) {
        if (this.atEnd()) return 'incomplete';
      }
      if (!this.isDigit(this.input[this.index])) return 'invalid';
      while (this.isDigit(this.input[this.index])) this.index += 1;
    }
    return 'complete';
  }

  private skipWhitespace(): void {
    while (
      this.input[this.index] === ' ' ||
      this.input[this.index] === '\t' ||
      this.input[this.index] === '\r' ||
      this.input[this.index] === '\n'
    ) {
      this.index += 1;
    }
  }

  private take(char: string): boolean {
    if (this.input[this.index] !== char) return false;
    this.index += 1;
    return true;
  }

  private atEnd(): boolean {
    return this.index >= this.input.length;
  }

  private isDigit(char: string | undefined): boolean {
    return char !== undefined && char >= '0' && char <= '9';
  }

  private isNonZeroDigit(char: string | undefined): boolean {
    return char !== undefined && char >= '1' && char <= '9';
  }
}
