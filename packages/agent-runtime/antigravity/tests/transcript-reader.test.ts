import type {
  AgentActivityPage,
  AgentActivityQuery,
  AgentActivityReadContext,
  AgentActivityRecord,
  DreamuxLogger,
} from '@excitedjs/dreamux-types';
import { activityQueryFingerprint, scanDigest } from '@excitedjs/dreamux-utils';
import {
  appendFile,
  mkdir,
  mkdtemp,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  defaultAntigravityConfig,
  type AntigravityConfig,
} from '../src/config.js';
import {
  antigravityTranscriptPath,
  resolveAntigravityNativeRoots,
} from '../src/paths.js';
import { encodeAntigravityCursor } from '../src/transcript/cursor.js';
import { readAntigravityRecentActivity } from '../src/transcript/reader.js';

/**
 * Behavioral coverage for the bounded cold `readAntigravityRecentActivity`
 * read, against deterministic synthetic `transcript_full.jsonl` fixtures laid
 * out under a temp native home. No real transcripts, native ids, credentials,
 * or user content are used.
 */

const SESSION_ID = 'synthetic-session-0001';
const TS = '2026-11-23T03:00:00Z';
const ISO = '2026-11-23T03:00:00.000Z';

const silentLog: DreamuxLogger = {
  error() {},
  warn() {},
  info() {},
  debug() {},
  trace() {},
  child() {
    return silentLog;
  },
};

const homes: string[] = [];
afterEach(async () => {
  while (homes.length > 0) {
    await rm(homes.pop()!, { recursive: true, force: true });
  }
});

async function newHome(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), 'agy-reader-'));
  homes.push(home);
  return home;
}

function jsonl(records: readonly Record<string, unknown>[]): string {
  return records.map((record) => `${JSON.stringify(record)}\n`).join('');
}

function userInput(step: number, text = `synthetic prompt ${step}`) {
  return {
    step_index: step,
    source: 'USER_EXPLICIT',
    type: 'USER_INPUT',
    status: 'DONE',
    created_at: TS,
    content: `<USER_REQUEST>\n${text}\n</USER_REQUEST>\n<ADDITIONAL_METADATA>\nsynthetic metadata\n</ADDITIONAL_METADATA>`,
  };
}

function planner(
  step: number,
  fields: {
    content?: string;
    thinking?: string;
    toolCalls?: string[];
    secretArgs?: boolean;
  } = {},
): Record<string, unknown> {
  return {
    step_index: step,
    source: 'MODEL',
    type: 'PLANNER_RESPONSE',
    status: 'DONE',
    created_at: TS,
    ...(fields.content !== undefined ? { content: fields.content } : {}),
    ...(fields.thinking !== undefined ? { thinking: fields.thinking } : {}),
    ...(fields.toolCalls !== undefined
      ? {
          tool_calls: fields.toolCalls.map((name, index) => ({
            name,
            args: fields.secretArgs
              ? { secret: 'super-secret-synthetic-arg' }
              : { synthetic: index },
          })),
        }
      : {}),
  };
}

function generic(
  step: number,
  status: 'DONE' | 'RUNNING' | 'ERROR' = 'DONE',
  content = 'synthetic tool result',
): Record<string, unknown> {
  return {
    step_index: step,
    source: 'MODEL',
    type: 'GENERIC',
    status,
    created_at: TS,
    content,
  };
}

describe('readAntigravityRecentActivity: projection and complete text', () => {
  it('returns complete assistant text with its native timestamp, never thinking or user input', async () => {
    const home = await newHome();
    const longText = `synthetic heading\n${'complete body line\n'.repeat(2000)}`;
    await writeRecords(home, [
      userInput(0),
      planner(1, { thinking: 'synthetic hidden reasoning', content: longText }),
      planner(2, { content: '' }),
    ]);

    const page = await read(home);

    expect(page.truncated).toBe(false);
    expect(page.nextCursor).toBeUndefined();
    expect(page.records).toEqual([
      {
        kind: 'assistant_message',
        text: longText,
        occurredAt: ISO,
      },
    ]);
  });

  it('reports session_unavailable when the bound transcript does not exist', async () => {
    const home = await newHome();
    await expect(read(home)).rejects.toMatchObject({
      name: 'AgentActivityError',
      reason: 'session_unavailable',
    });
  });

  it('exposes the canonical transcript path but never tool arguments or results', async () => {
    const home = await newHome();
    await writeRecords(home, [
      planner(1, { toolCalls: ['run_command'], secretArgs: true }),
      generic(2, 'DONE', 'super-secret-synthetic-result'),
    ]);

    const page = await read(home);
    expect(page.transcriptPath).toBe(await realpath(transcriptFile(home)));
    const serialized = JSON.stringify(page.records);
    expect(serialized).not.toContain('super-secret-synthetic-result');
    expect(serialized).not.toContain('super-secret-synthetic-arg');
    for (const record of page.records) {
      expect(record).not.toHaveProperty('arguments');
      expect(record).not.toHaveProperty('result');
    }
  });

  it('tolerates blank lines between native records', async () => {
    const home = await newHome();
    const path = transcriptFile(home);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(
      path,
      `\n${jsonl([planner(1, { content: 'synthetic one' })])}\n\n${jsonl([
        planner(3, { content: 'synthetic two' }),
      ])}`,
    );

    const page = await read(home);
    expect(texts(page.records)).toEqual(['synthetic one', 'synthetic two']);
  });
});

describe('readAntigravityRecentActivity: tools and includeTools', () => {
  it('pairs GENERIC results with planner tool calls FIFO as started/completed', async () => {
    const home = await newHome();
    await writeRecords(home, [
      planner(1, { toolCalls: ['run_command', 'read_file'] }),
      generic(2, 'DONE'),
      generic(3, 'DONE'),
    ]);

    const page = await read(home);
    expect(page.records).toEqual([
      { kind: 'tool', name: 'run_command', status: 'started', occurredAt: ISO },
      { kind: 'tool', name: 'read_file', status: 'started', occurredAt: ISO },
      {
        kind: 'tool',
        name: 'run_command',
        status: 'completed',
        occurredAt: ISO,
      },
      {
        kind: 'tool',
        name: 'read_file',
        status: 'completed',
        occurredAt: ISO,
      },
    ]);
  });

  it('maps ERROR results to failed and treats RUNNING as a progress notice', async () => {
    const home = await newHome();
    await writeRecords(home, [
      planner(1, { toolCalls: ['run_command'] }),
      generic(2, 'RUNNING'),
      generic(3, 'ERROR'),
    ]);

    const page = await read(home);
    expect(page.records).toEqual([
      { kind: 'tool', name: 'run_command', status: 'started', occurredAt: ISO },
      { kind: 'tool', name: 'run_command', status: 'failed', occurredAt: ISO },
    ]);
  });

  it('drops a result whose call fell outside the parsed window', async () => {
    const home = await newHome();
    await writeRecords(home, [
      generic(1, 'DONE'),
      planner(2, { content: 'synthetic answer' }),
    ]);

    const page = await read(home);
    expect(texts(page.records)).toEqual(['synthetic answer']);
    expect(page.records.every((record) => record.kind !== 'tool')).toBe(true);
  });

  it('hides every tool record as one group when includeTools is false', async () => {
    const home = await newHome();
    await writeRecords(home, [
      planner(1, { content: 'synthetic before', toolCalls: ['run_command'] }),
      generic(2, 'DONE'),
      planner(3, { content: 'synthetic after' }),
    ]);

    const page = await read(home, { includeTools: false });
    expect(page.records.every((record) => record.kind !== 'tool')).toBe(true);
    expect(texts(page.records)).toEqual([
      'synthetic before',
      'synthetic after',
    ]);
  });
});

describe('readAntigravityRecentActivity: growing and closed files', () => {
  it('sees appended records on a later read and reads identically once closed', async () => {
    const home = await newHome();
    await writeRecords(home, [
      planner(1, { content: 'synthetic before growth' }),
    ]);

    const firstPage = await read(home);
    expect(texts(firstPage.records)).toEqual(['synthetic before growth']);

    await appendRecords(home, [
      planner(2, { content: 'synthetic after growth' }),
    ]);
    const secondPage = await read(home);
    expect(texts(secondPage.records)).toEqual([
      'synthetic before growth',
      'synthetic after growth',
    ]);

    // A closed file is the same code path: no live process is ever consulted.
    const closedPage = await read(home);
    expect(closedPage.records).toEqual(secondPage.records);
  });

  it('keeps a cursor walk stable without skip or duplicate as the file grows', async () => {
    const home = await newHome();
    await writeRecords(
      home,
      [0, 1, 2].map((index) =>
        planner(index + 1, { content: `synthetic message-${index}` }),
      ),
    );

    const firstPage = await read(home, { limit: 2 });
    expect(texts(firstPage.records)).toEqual([
      'synthetic message-1',
      'synthetic message-2',
    ]);
    expect(firstPage.nextCursor).toBeDefined();

    await appendRecords(
      home,
      [3, 4].map((index) =>
        planner(index + 1, { content: `synthetic message-${index}` }),
      ),
    );

    const olderPage = await read(home, {
      cursor: firstPage.nextCursor!,
      limit: 2,
    });
    expect(texts(olderPage.records)).toEqual(['synthetic message-0']);
    expect(olderPage.nextCursor).toBeUndefined();

    const freshPage = await read(home);
    expect(texts(freshPage.records)).toEqual([
      'synthetic message-0',
      'synthetic message-1',
      'synthetic message-2',
      'synthetic message-3',
      'synthetic message-4',
    ]);
  });
});

describe('readAntigravityRecentActivity: chronological pagination', () => {
  it('walks the full tail in bounded ascending pages with no overlap', async () => {
    const home = await newHome();
    await writeRecords(
      home,
      [0, 1, 2, 3, 4, 5].map((index) =>
        planner(index + 1, { content: `synthetic page-${index}` }),
      ),
    );

    const seen: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    for (;;) {
      const page = await read(home, {
        limit: 2,
        ...(cursor !== undefined ? { cursor } : {}),
      });
      pages += 1;
      seen.push(...texts(page.records));
      if (page.nextCursor === undefined) break;
      cursor = page.nextCursor;
      expect(pages).toBeLessThan(10);
    }

    expect(pages).toBe(3);
    expect(seen).toEqual([
      'synthetic page-4',
      'synthetic page-5',
      'synthetic page-2',
      'synthetic page-3',
      'synthetic page-0',
      'synthetic page-1',
    ]);
  });

  it('paginates one multi-activity native record by projection ordinal at limit 1', async () => {
    const home = await newHome();
    await writeRecords(home, [
      planner(1, {
        content: 'synthetic answer',
        toolCalls: ['run_command', 'read_file', 'edit_file'],
      }),
    ]);

    const collected: AgentActivityRecord[] = [];
    const anchorOffsets = new Set<number>();
    const anchorOrdinals: number[] = [];
    let cursor: string | undefined;
    for (let guard = 0; guard < 6; guard += 1) {
      const page = await read(home, {
        limit: 1,
        ...(cursor !== undefined ? { cursor } : {}),
      });
      if (page.records.length === 0) {
        expect(page.nextCursor).toBeUndefined();
        break;
      }
      expect(page.records).toHaveLength(1);
      collected.push(page.records[0]!);
      if (page.nextCursor === undefined) break;
      const decoded = decodeAnchor(page.nextCursor!);
      anchorOffsets.add(decoded.offset);
      anchorOrdinals.push(decoded.ordinal);
      cursor = page.nextCursor;
    }

    // Newest-first walk: three tool siblings then the assistant text, all from
    // the same native line; nothing duplicated or skipped.
    expect(collected).toEqual([
      { kind: 'tool', name: 'edit_file', status: 'started', occurredAt: ISO },
      { kind: 'tool', name: 'read_file', status: 'started', occurredAt: ISO },
      {
        kind: 'tool',
        name: 'run_command',
        status: 'started',
        occurredAt: ISO,
      },
      {
        kind: 'assistant_message',
        text: 'synthetic answer',
        occurredAt: ISO,
      },
    ]);
    expect(anchorOffsets.size).toBe(1);
    expect(anchorOrdinals).toEqual([3, 2, 1]);
  });
});

describe('readAntigravityRecentActivity: cursor and malformed records', () => {
  it('rejects a syntactically invalid cursor as cursor_invalid', async () => {
    const home = await newHome();
    await writeRecords(home, [planner(1, { content: 'synthetic' })]);

    await expect(
      read(home, { cursor: 'not-a-real-cursor' }),
    ).rejects.toMatchObject({
      name: 'AgentActivityError',
      reason: 'cursor_invalid',
    });
  });

  it('rejects a cursor minted for a different includeTools query', async () => {
    const home = await newHome();
    await writeRecords(home, [
      planner(1, { toolCalls: ['run_command'] }),
      generic(2, 'DONE'),
    ]);
    const page = await read(home, { limit: 1, includeTools: true });
    expect(page.nextCursor).toBeDefined();

    await expect(
      read(home, { cursor: page.nextCursor!, includeTools: false }),
    ).rejects.toMatchObject({
      name: 'AgentActivityError',
      reason: 'cursor_invalid',
    });
  });

  it('rejects a cursor whose boundary digest no longer matches', async () => {
    const home = await newHome();
    await writeRecords(home, [planner(1, { content: 'synthetic' })]);
    const cursor = encodeAntigravityCursor({
      fingerprint: activityQueryFingerprint(true),
      position: { offset: 0, ordinal: 0 },
      boundaryDigest: scanDigest('synthetic-bogus-boundary'),
    });

    await expect(read(home, { cursor })).rejects.toMatchObject({
      name: 'AgentActivityError',
      reason: 'cursor_invalid',
    });
  });

  it('rejects a cursor pointing past the current file size', async () => {
    const home = await newHome();
    await writeRecords(home, [planner(1, { content: 'synthetic' })]);
    const cursor = encodeAntigravityCursor({
      fingerprint: activityQueryFingerprint(true),
      position: { offset: 9_999_999, ordinal: 0 },
      boundaryDigest: scanDigest('synthetic-bogus-boundary'),
    });

    await expect(read(home, { cursor })).rejects.toMatchObject({
      name: 'AgentActivityError',
      reason: 'cursor_invalid',
    });
  });

  it('rejects an out-of-range limit through the corrupt-activity contract', async () => {
    const home = await newHome();
    await writeRecords(home, [planner(1, { content: 'synthetic' })]);

    await expect(read(home, { limit: 0 })).rejects.toMatchObject({
      name: 'AgentActivityError',
      reason: 'activity_corrupt',
    });
    await expect(read(home, { limit: 201 })).rejects.toMatchObject({
      name: 'AgentActivityError',
      reason: 'activity_corrupt',
    });
  });

  it('reports activity_corrupt for an unreadable non-JSON native line', async () => {
    const home = await newHome();
    const path = transcriptFile(home);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(
      path,
      jsonl([planner(1, { content: 'synthetic before corruption' })]) +
        '{broken synthetic json\n' +
        jsonl([planner(3, { content: 'synthetic after corruption' })]),
    );

    await expect(read(home)).rejects.toMatchObject({
      name: 'AgentActivityError',
      reason: 'activity_corrupt',
    });
  });
});

describe('readAntigravityRecentActivity: decode bounds', () => {
  it('fails with provider_failure on a single record over the bounded record size', async () => {
    const home = await newHome();
    await writeRecords(home, [
      planner(1, { content: 'synthetic-bytes'.repeat(120_000) }),
    ]);

    await expect(read(home)).rejects.toMatchObject({
      name: 'AgentActivityError',
      reason: 'provider_failure',
    });
  });

  it('marks the page truncated once the native-record scan cap is reached', async () => {
    const home = await newHome();
    const records = Array.from({ length: 20_005 }, (_unused, index) =>
      planner(index + 1, { content: `synthetic-capped-${index}` }),
    );
    await writeRecords(home, records);

    const page = await read(home);
    expect(page.truncated).toBe(true);
    // A recent-tail read keeps the NEWEST cap-sized records; the oldest lines
    // are what truncation drops, never the other way around.
    expect(texts(page.records)).toContain('synthetic-capped-20004');
    expect(texts(page.records)).not.toContain('synthetic-capped-0');
  });

  it('marks the page truncated when older bytes fall outside the decode window', async () => {
    const home = await newHome();
    const records = Array.from({ length: 9_000 }, (_unused, index) =>
      planner(index + 1, {
        content:
          index === 0
            ? `synthetic-oldest-marker ${'x'.repeat(900)}`
            : index === 8_999
              ? `synthetic-newest-marker ${'x'.repeat(900)}`
              : 'x'.repeat(950),
      }),
    );
    await writeRecords(home, records);

    const page = await read(home);
    expect(page.truncated).toBe(true);
    const serialized = JSON.stringify(page.records);
    expect(serialized).toContain('synthetic-newest-marker');
    expect(serialized).not.toContain('synthetic-oldest-marker');
  });
});

function transcriptFile(home: string, sessionId = SESSION_ID): string {
  const roots = resolveAntigravityNativeRoots({ HOME: home });
  return antigravityTranscriptPath(roots, sessionId);
}

async function writeRecords(
  home: string,
  records: readonly Record<string, unknown>[],
): Promise<void> {
  const path = transcriptFile(home);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, jsonl(records));
}

async function appendRecords(
  home: string,
  records: readonly Record<string, unknown>[],
): Promise<void> {
  await appendFile(transcriptFile(home), jsonl(records));
}

function readContext(
  home: string,
): AgentActivityReadContext<AntigravityConfig> {
  return {
    config: { ...defaultAntigravityConfig(), extra_env: { HOME: home } },
    cwd: '/synthetic/cwd',
    logger: silentLog,
  };
}

function read(
  home: string,
  query: Partial<AgentActivityQuery> = {},
): Promise<AgentActivityPage> {
  return readAntigravityRecentActivity(
    { sessionId: SESSION_ID, ...query },
    readContext(home),
  );
}

function texts(records: readonly AgentActivityRecord[]): string[] {
  return records.flatMap((record) =>
    record.kind === 'assistant_message' ? [record.text] : [],
  );
}

function decodeAnchor(cursor: string): { offset: number; ordinal: number } {
  const envelope = JSON.parse(
    Buffer.from(cursor, 'base64url').toString('utf8'),
  ) as Record<string, unknown>;
  return {
    offset: envelope['pos'] as number,
    ordinal: envelope['ord'] as number,
  };
}
