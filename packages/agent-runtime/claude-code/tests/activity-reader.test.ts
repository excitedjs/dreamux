/**
 * `readClaudeRecentActivity` (`src/activity/reader.ts`) — the MANDATORY
 * `AgentRuntimeProvider.readRecentActivity` implementation for Claude Code.
 *
 * These write REAL native-shaped `.jsonl` session files under a temp
 * `CLAUDE_CONFIG_DIR` (so `deriveClaudeHistoryPath` finds them exactly the way
 * the real CLI's own history layout would place them) and read them back
 * through the real reader — no live `claude` binary needed, since this module
 * only ever reads Claude's on-disk transcript, never talks to the process.
 *
 * Covered: an actively growing session paginates with a stable cursor; the
 * same session reads identically after its writer has "closed" (this reader
 * has no live-process dependency at all — the file is the only input); tools
 * are hidden as a GROUP by `includeTools`; neutral typed errors surface with
 * no native path/session-layout detail; and no tool argument/result content or
 * native filesystem path ever crosses into a returned `AgentActivityRecord`.
 */
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { readClaudeRecentActivity } from '../src/activity/reader.js';
import { deriveClaudeHistoryPath } from '../src/activity/path.js';
import { defaultDispatcherClaudeCodeConfig } from '../src/config.js';
import type {
  AgentActivityReadContext,
  AgentActivityQuery,
  AgentRuntimeSessionRef,
} from '@excitedjs/dreamux-types';

// ─── Native record builders ─────────────────────────────────────────────────

interface NativeRecordInput {
  sessionId: string;
  uuid: string;
  parentUuid: string | null;
  timestamp: string;
}

function userText(input: NativeRecordInput, text: string): Record<string, unknown> {
  return {
    type: 'user',
    sessionId: input.sessionId,
    uuid: input.uuid,
    parentUuid: input.parentUuid,
    timestamp: input.timestamp,
    message: { role: 'user', content: [{ type: 'text', text }] },
  };
}

function assistantText(input: NativeRecordInput, text: string): Record<string, unknown> {
  return {
    type: 'assistant',
    sessionId: input.sessionId,
    uuid: input.uuid,
    parentUuid: input.parentUuid,
    timestamp: input.timestamp,
    message: { role: 'assistant', content: [{ type: 'text', text }] },
  };
}

function assistantToolUse(
  input: NativeRecordInput,
  callId: string,
  name: string,
  toolInput: Record<string, unknown>,
): Record<string, unknown> {
  return {
    type: 'assistant',
    sessionId: input.sessionId,
    uuid: input.uuid,
    parentUuid: input.parentUuid,
    timestamp: input.timestamp,
    message: {
      role: 'assistant',
      content: [{ type: 'tool_use', id: callId, name, input: toolInput }],
    },
  };
}

function userToolResult(
  input: NativeRecordInput,
  callId: string,
  content: string,
  isError: boolean,
): Record<string, unknown> {
  return {
    type: 'user',
    sessionId: input.sessionId,
    uuid: input.uuid,
    parentUuid: input.parentUuid,
    timestamp: input.timestamp,
    message: {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: callId, content, is_error: isError }],
    },
  };
}

// ─── Fixture harness ─────────────────────────────────────────────────────────

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

interface Fixture {
  cwd: string;
  configDir: string;
  sessionId: string;
  path: string;
  context: AgentActivityReadContext<ReturnType<typeof defaultDispatcherClaudeCodeConfig>>;
  /** Append native JSONL lines to the session file (models a growing session). */
  append(lines: readonly Record<string, unknown>[]): Promise<void>;
  /** Overwrite the whole session file (used for malformed/mismatched fixtures). */
  write(lines: readonly Record<string, unknown>[]): Promise<void>;
}

async function makeFixture(sessionId = randomUUID()): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), 'dreamux-claude-activity-'));
  tempDirs.push(root);
  const cwd = join(root, 'workspace');
  const configDir = join(root, 'claude-config');
  await mkdir(cwd, { recursive: true });
  await mkdir(configDir, { recursive: true });
  const path = await deriveClaudeHistoryPath(sessionId, cwd, {
    CLAUDE_CONFIG_DIR: configDir,
  });
  const context: AgentActivityReadContext<ReturnType<typeof defaultDispatcherClaudeCodeConfig>> = {
    config: defaultDispatcherClaudeCodeConfig(),
    cwd,
    injectEnv: { CLAUDE_CONFIG_DIR: configDir },
  };
  return {
    cwd,
    configDir,
    sessionId,
    path,
    context,
    async append(lines) {
      await mkdir(join(path, '..'), { recursive: true });
      const text = lines.map((line) => JSON.stringify(line)).join('\n') + '\n';
      const { appendFile } = await import('node:fs/promises');
      await appendFile(path, text, 'utf8');
    },
    async write(lines) {
      await mkdir(join(path, '..'), { recursive: true });
      const text = lines.map((line) => JSON.stringify(line)).join('\n') + '\n';
      await writeFile(path, text, 'utf8');
    },
  };
}

function query(
  fixture: Fixture,
  overrides: Partial<AgentActivityQuery<AgentRuntimeSessionRef>> = {},
): AgentActivityQuery<AgentRuntimeSessionRef> {
  return { session: { id: fixture.sessionId }, ...overrides };
}

/** A full four-record conversation: text turn, then a tool-using turn. */
function conversation(sessionId: string): Record<string, unknown>[] {
  const t = (offsetSeconds: number) =>
    new Date(Date.UTC(2026, 0, 1, 0, 0, offsetSeconds)).toISOString();
  return [
    userText({ sessionId, uuid: 'u1', parentUuid: null, timestamp: t(0) }, 'hello'),
    assistantText({ sessionId, uuid: 'a1', parentUuid: 'u1', timestamp: t(1) }, 'hi there'),
    userText({ sessionId, uuid: 'u2', parentUuid: 'a1', timestamp: t(2) }, 'read the file'),
    assistantToolUse(
      { sessionId, uuid: 'a2', parentUuid: 'u2', timestamp: t(3) },
      'call-1',
      'Read',
      { file_path: '/etc/native/secret-path.txt' },
    ),
    userToolResult(
      { sessionId, uuid: 'u3', parentUuid: 'a2', timestamp: t(4) },
      'call-1',
      'super secret file contents',
      false,
    ),
    assistantText({ sessionId, uuid: 'a3', parentUuid: 'u3', timestamp: t(5) }, 'done reading'),
  ];
}

// ─── Tests ────────────────────────────────────────────────────────────────

describe('readClaudeRecentActivity: active growing session', () => {
  it('projects a flat chronological page and paginates with a stable cursor as the file keeps growing', async () => {
    const fixture = await makeFixture();
    await fixture.write(conversation(fixture.sessionId));

    const firstPage = await readClaudeRecentActivity(query(fixture, { limit: 1 }), fixture.context);
    expect(firstPage.records).toEqual([
      { kind: 'assistant_message', text: 'done reading', occurredAt: expect.any(String) },
    ]);
    expect(firstPage.nextCursor).toBeDefined();

    // The session keeps growing (a live turn appending more native lines)
    // AFTER the cursor was minted.
    await fixture.append([
      userText(
        { sessionId: fixture.sessionId, uuid: 'u4', parentUuid: 'a3', timestamp: '2026-01-01T00:00:06.000Z' },
        'one more thing',
      ),
      assistantText(
        { sessionId: fixture.sessionId, uuid: 'a4', parentUuid: 'u4', timestamp: '2026-01-01T00:00:07.000Z' },
        'sure',
      ),
    ]);

    const secondPage = await readClaudeRecentActivity(
      query(fixture, { limit: 2, cursor: firstPage.nextCursor }),
      fixture.context,
    );
    expect(secondPage.records).toEqual([
      { kind: 'assistant_message', text: 'hi there', occurredAt: expect.any(String) },
      { kind: 'tool', name: 'Read', status: 'completed', occurredAt: expect.any(String) },
    ]);
  });

  it('reads the newest tail directly (no cursor) reflecting whatever was appended most recently', async () => {
    const fixture = await makeFixture();
    await fixture.write(conversation(fixture.sessionId));
    const page = await readClaudeRecentActivity(query(fixture), fixture.context);
    expect(page.records).toEqual([
      { kind: 'assistant_message', text: 'hi there', occurredAt: expect.any(String) },
      { kind: 'tool', name: 'Read', status: 'completed', occurredAt: expect.any(String) },
      { kind: 'assistant_message', text: 'done reading', occurredAt: expect.any(String) },
    ]);
    expect(page.truncated).toBe(false);
    // No further page beyond the file start.
    expect(page.nextCursor).toBeUndefined();
  });
});

describe('readClaudeRecentActivity: closed session', () => {
  it('reads identically once the session is no longer live — the reader has no live-process dependency', async () => {
    const fixture = await makeFixture();
    await fixture.write(conversation(fixture.sessionId));
    // No live child, no supervisor, nothing but the on-disk file: the read
    // path never needed one, so a "closed" session reads the same way.
    const page = await readClaudeRecentActivity(query(fixture), fixture.context);
    expect(page.records).toHaveLength(3);
  });
});

describe('readClaudeRecentActivity: tool filtering as a group', () => {
  it('includeTools=false hides every tool record, keeping only assistant text, with no partial tool leakage', async () => {
    const fixture = await makeFixture();
    await fixture.write(conversation(fixture.sessionId));
    const page = await readClaudeRecentActivity(
      query(fixture, { includeTools: false }),
      fixture.context,
    );
    expect(page.records).toEqual([
      { kind: 'assistant_message', text: 'hi there', occurredAt: expect.any(String) },
      { kind: 'assistant_message', text: 'done reading', occurredAt: expect.any(String) },
    ]);
    expect(page.records.some((record) => record.kind === 'tool')).toBe(false);
  });

  it('a cursor minted with includeTools=true cannot be replayed against an includeTools=false query', async () => {
    const fixture = await makeFixture();
    await fixture.write(conversation(fixture.sessionId));
    const withTools = await readClaudeRecentActivity(
      query(fixture, { limit: 1, includeTools: true }),
      fixture.context,
    );
    await expect(
      readClaudeRecentActivity(
        query(fixture, { cursor: withTools.nextCursor, includeTools: false }),
        fixture.context,
      ),
    ).rejects.toMatchObject({ name: 'AgentActivityError', reason: 'cursor_invalid' });
  });
});

describe('readClaudeRecentActivity: bounds', () => {
  it('rejects a limit outside 1..200 as a neutral invalid-input error', async () => {
    const fixture = await makeFixture();
    await fixture.write(conversation(fixture.sessionId));
    await expect(
      readClaudeRecentActivity(query(fixture, { limit: 0 }), fixture.context),
    ).rejects.toMatchObject({ name: 'AgentActivityError', reason: 'activity_corrupt' });
    await expect(
      readClaudeRecentActivity(query(fixture, { limit: 201 }), fixture.context),
    ).rejects.toMatchObject({ name: 'AgentActivityError', reason: 'activity_corrupt' });
  });
});

describe('readClaudeRecentActivity: neutral typed errors', () => {
  it('surfaces session_unavailable when the session file does not exist at all', async () => {
    const fixture = await makeFixture();
    // Never written: the derived path is valid but nothing lives there.
    await expect(
      readClaudeRecentActivity(query(fixture), fixture.context),
    ).rejects.toMatchObject({ name: 'AgentActivityError', reason: 'session_unavailable' });
  });

  it('surfaces session_unavailable when the file belongs to a different native session id', async () => {
    const fixture = await makeFixture();
    const otherSessionId = randomUUID();
    // Write a file at THIS fixture's derived path, but stamp every record with
    // a different session id — the on-disk evidence contradicts the query.
    await fixture.write(conversation(otherSessionId));
    await expect(
      readClaudeRecentActivity(query(fixture), fixture.context),
    ).rejects.toMatchObject({ name: 'AgentActivityError', reason: 'session_unavailable' });
  });

  it('surfaces cursor_invalid for a garbage cursor string', async () => {
    const fixture = await makeFixture();
    await fixture.write(conversation(fixture.sessionId));
    await expect(
      readClaudeRecentActivity(query(fixture, { cursor: 'not-a-real-cursor' }), fixture.context),
    ).rejects.toMatchObject({ name: 'AgentActivityError', reason: 'cursor_invalid' });
  });

  it('every rejection is a plain neutral AgentActivityError, never a raw Node fs error', async () => {
    const fixture = await makeFixture();
    try {
      await readClaudeRecentActivity(query(fixture), fixture.context);
      throw new Error('expected the missing-session read to reject');
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).name).toBe('AgentActivityError');
      expect((error as NodeJS.ErrnoException).code).toBeUndefined();
    }
  });
});

describe('readClaudeRecentActivity: no native leakage into records', () => {
  it('never carries tool arguments or tool results, and never carries a filesystem path, in a returned record', async () => {
    const fixture = await makeFixture();
    await fixture.write(conversation(fixture.sessionId));
    const page = await readClaudeRecentActivity(query(fixture), fixture.context);

    const toolRecord = page.records.find((record) => record.kind === 'tool');
    expect(toolRecord).toBeDefined();
    // Structural proof, not just type-level: the actual returned object has
    // no 'arguments' or 'result' key at all, even though the native transcript
    // carried a tool call argument and a tool result payload.
    expect(Object.keys(toolRecord!)).toEqual(['kind', 'name', 'status', 'occurredAt']);

    const serialized = JSON.stringify(page);
    expect(serialized).not.toContain('/etc/native/secret-path.txt');
    expect(serialized).not.toContain('super secret file contents');
    expect(serialized).not.toContain(fixture.cwd);
    expect(serialized).not.toContain(fixture.configDir);
  });
});
