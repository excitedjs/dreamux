import type { DreamuxLogger } from '@excitedjs/dreamux-types';
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
/**
 * Behavioral coverage for `readRecentActivity` (the `builtin:codex` provider's
 * mandatory recent-Activity-Records read), against REAL rollout files under a
 * temp `CODEX_HOME` — the reader discovers sessions purely from the
 * filesystem, so this is the right fidelity level, not a mocked filesystem.
 *
 * Scope (Stage 9 coverage cell B): actively-growing session reads, chronology,
 * stable cursor pagination without skip/duplicate, includeTools default +
 * group-only hiding, optional native turn IDs and canonical transcript paths,
 * and the typed neutral error taxonomy. Native lines and tool payloads stay private.
 */
import {
  appendFile,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { zstdCompress } from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';

import { createCodexAgentRuntimeProvider } from '../src/provider.js';
import { defaultDispatcherCodexConfig } from '../src/config.js';
import {
  appendAssistantMessage,
  appendCorruptLine,
  appendToolCall,
  createBoundsExceedingLineageSession,
  createDeepLineageSession,
  createFixtureSession,
  fixtureSessionId,
  type FixtureSession,
} from './helpers/codex-activity-fixtures.js';
import type { AgentActivityReadContext } from '@excitedjs/dreamux-types';

const provider = createCodexAgentRuntimeProvider();
const cleanupDirs: string[] = [];

afterEach(async () => {
  while (cleanupDirs.length > 0) {
    const dir = cleanupDirs.pop()!;
    await rm(dir, { recursive: true, force: true });
  }
});

async function makeSession(
  options?: Parameters<typeof createFixtureSession>[1],
): Promise<FixtureSession> {
  const session = await createFixtureSession(fixtureSessionId(), options);
  cleanupDirs.push(session.codexHome);
  return session;
}

function readContext(
  session: FixtureSession,
): AgentActivityReadContext<ReturnType<typeof defaultDispatcherCodexConfig>> {
  return {
    config: { ...defaultDispatcherCodexConfig(), extra_env: session.env },
    cwd: '/fake/cwd',
    logger: silentLog,
  };
}

describe('readRecentActivity: actively growing session', () => {
  it('returns useful records for a session with no completion marker at all', async () => {
    const session = await makeSession();
    await appendAssistantMessage(session, 'first assistant message');
    await appendAssistantMessage(session, 'second assistant message');

    const page = await provider.readRecentActivity(
      { sessionId: session.sessionId },
      readContext(session),
    );

    expect(page.records).toEqual([
      { kind: 'assistant_message', text: 'first assistant message' },
      { kind: 'assistant_message', text: 'second assistant message' },
    ]);
    expect(page.truncated).toBe(false);
  });

  it('sees newly appended records on a later read of the same still-open file', async () => {
    const session = await makeSession();
    await appendAssistantMessage(session, 'before growth');

    const firstPage = await provider.readRecentActivity(
      { sessionId: session.sessionId },
      readContext(session),
    );
    expect(
      firstPage.records.map((r) =>
        r.kind === 'assistant_message' ? r.text : null,
      ),
    ).toEqual(['before growth']);

    await appendAssistantMessage(session, 'after growth');
    const secondPage = await provider.readRecentActivity(
      { sessionId: session.sessionId },
      readContext(session),
    );
    expect(
      secondPage.records.map((r) =>
        r.kind === 'assistant_message' ? r.text : null,
      ),
    ).toEqual(['before growth', 'after growth']);
  });

  it('reads identically once nothing is appending anymore (the "runtime closed" case)', async () => {
    // The reader is purely filesystem-driven — it never asks whether a live
    // process still owns the file (see activity/reader.ts doc comment) — so a
    // session with no process attached at all reads exactly like the still-
    // growing case above; this is the same code path, not a special one.
    const session = await makeSession();
    await appendAssistantMessage(session, 'only message');

    const page = await provider.readRecentActivity(
      { sessionId: session.sessionId },
      readContext(session),
    );
    expect(page.records).toEqual([
      { kind: 'assistant_message', text: 'only message' },
    ]);
  });

  it('reports truncated: true once the tail segment alone exhausts the native-record scan budget', async () => {
    const sessionId = fixtureSessionId();
    const session = await createBoundsExceedingLineageSession(sessionId);
    cleanupDirs.push(session.codexHome);

    const page = await provider.readRecentActivity(
      { sessionId },
      readContext(session),
    );
    expect(page.truncated).toBe(true);
  });

  it('returns records in chronological order regardless of kind mix', async () => {
    const session = await makeSession();
    await appendAssistantMessage(session, 'thinking out loud');
    await appendToolCall(session, {
      callId: 'c1',
      name: 'search_files',
      output: 'ok',
    });
    await appendAssistantMessage(session, 'final answer');

    const page = await provider.readRecentActivity(
      { sessionId: session.sessionId },
      readContext(session),
    );
    expect(page.records.map((r) => r.kind)).toEqual([
      'assistant_message',
      'tool',
      'assistant_message',
    ]);
  });
});

describe('readRecentActivity: cursor pagination', () => {
  it('pages backward through history without skipping or duplicating as the file keeps growing', async () => {
    const session = await makeSession();
    for (let i = 0; i < 5; i += 1) {
      await appendAssistantMessage(session, `message-${i}`);
    }

    const firstPage = await provider.readRecentActivity(
      { sessionId: session.sessionId, limit: 2 },
      readContext(session),
    );
    expect(
      firstPage.records.map((r) =>
        r.kind === 'assistant_message' ? r.text : null,
      ),
    ).toEqual(['message-3', 'message-4']);
    expect(firstPage.nextCursor).toBeDefined();

    // Grow the session BETWEEN page reads — the cursor is anchored to a byte
    // position, not a record count, so new growth must not shift what the
    // already-issued cursor points at.
    await appendAssistantMessage(session, 'message-5');

    const secondPage = await provider.readRecentActivity(
      { sessionId: session.sessionId, limit: 2, cursor: firstPage.nextCursor! },
      readContext(session),
    );
    const firstTexts = firstPage.records.map((r) =>
      r.kind === 'assistant_message' ? r.text : null,
    );
    const secondTexts = secondPage.records.map((r) =>
      r.kind === 'assistant_message' ? r.text : null,
    );
    // No overlap (no duplicate) and strictly older (no skip past unseen history):
    // the next older page picks up exactly where the first page's oldest
    // record left off, unaffected by the growth that happened in between.
    for (const text of secondTexts) expect(firstTexts).not.toContain(text);
    expect(secondTexts).toEqual(['message-1', 'message-2']);
  });

  it('rejects a syntactically invalid cursor as cursor_invalid, never crashing the read', async () => {
    const session = await makeSession();
    await appendAssistantMessage(session, 'hello');

    await expect(
      provider.readRecentActivity(
        { sessionId: session.sessionId, cursor: 'not-a-real-cursor' },
        readContext(session),
      ),
    ).rejects.toMatchObject({
      name: 'AgentActivityError',
      reason: 'cursor_invalid',
    });
  });

  it('rejects a cursor from a different query fingerprint (includeTools flip) as cursor_invalid', async () => {
    const session = await makeSession();
    await appendAssistantMessage(session, 'hello');
    await appendToolCall(session, {
      callId: 'c1',
      name: 'search',
      output: 'x',
    });

    const page = await provider.readRecentActivity(
      { sessionId: session.sessionId, limit: 1, includeTools: true },
      readContext(session),
    );
    expect(page.nextCursor).toBeDefined();

    await expect(
      provider.readRecentActivity(
        {
          sessionId: session.sessionId,
          cursor: page.nextCursor!,
          includeTools: false,
        },
        readContext(session),
      ),
    ).rejects.toMatchObject({
      name: 'AgentActivityError',
      reason: 'cursor_invalid',
    });
  });
});

describe('readRecentActivity: includeTools', () => {
  it('includes tool records by default', async () => {
    const session = await makeSession();
    await appendToolCall(session, {
      callId: 'c1',
      name: 'search_files',
      output: 'result text',
    });

    const page = await provider.readRecentActivity(
      { sessionId: session.sessionId },
      readContext(session),
    );
    // A call and its output settle the SAME positioned record (started ->
    // completed in place) — one native call produces one neutral record.
    expect(page.records).toHaveLength(1);
    expect(page.records[0]).toMatchObject({
      kind: 'tool',
      name: 'search_files',
      status: 'completed',
    });
  });

  it('hides ALL tool records as one group when includeTools is false, never partially', async () => {
    const session = await makeSession();
    await appendAssistantMessage(session, 'before tools');
    await appendToolCall(session, {
      callId: 'c1',
      name: 'search_files',
      output: 'x',
    });
    await appendToolCall(session, {
      callId: 'c2',
      name: 'apply_patch',
      failed: true,
    });
    await appendAssistantMessage(session, 'after tools');

    const page = await provider.readRecentActivity(
      { sessionId: session.sessionId, includeTools: false },
      readContext(session),
    );
    expect(page.records.every((r) => r.kind !== 'tool')).toBe(true);
    expect(
      page.records.map((r) => (r.kind === 'assistant_message' ? r.text : null)),
    ).toEqual(['before tools', 'after tools']);
  });

  it('reports a failed tool call status distinctly from a completed one', async () => {
    const session = await makeSession();
    await appendToolCall(session, {
      callId: 'c1',
      name: 'apply_patch',
      failed: true,
    });
    await appendToolCall(session, {
      callId: 'c2',
      name: 'search_files',
      output: 'ok',
    });

    const page = await provider.readRecentActivity(
      { sessionId: session.sessionId },
      readContext(session),
    );
    const statuses = page.records
      .filter(
        (r): r is Extract<typeof r, { kind: 'tool' }> => r.kind === 'tool',
      )
      .map((r) => `${r.name}:${r.status}`);
    expect(statuses).toContain('apply_patch:failed');
    expect(statuses).toContain('search_files:completed');
  });
});

describe('readRecentActivity: neutral error taxonomy and non-leakage', () => {
  it('reports session_unavailable for a session with no rollout at all', async () => {
    const session = await makeSession();
    await expect(
      provider.readRecentActivity(
        { sessionId: 'never-existed-session-id' },
        readContext(session),
      ),
    ).rejects.toMatchObject({
      name: 'AgentActivityError',
      reason: 'session_unavailable',
    });
  });

  it('reports activity_corrupt for an unreadable (non-JSON) record line', async () => {
    const session = await makeSession();
    await appendAssistantMessage(session, 'ok before corruption');
    await appendCorruptLine(session);

    await expect(
      provider.readRecentActivity(
        { sessionId: session.sessionId },
        readContext(session),
      ),
    ).rejects.toMatchObject({
      name: 'AgentActivityError',
      reason: 'activity_corrupt',
    });
  });

  it('exposes the canonical transcript path without tool payloads or native lines in records or errors', async () => {
    const session = await makeSession();
    await appendToolCall(session, {
      callId: 'c1',
      name: 'exec_command',
      output: { secret: 'super-secret-tool-output' },
    });

    const page = await provider.readRecentActivity(
      { sessionId: session.sessionId },
      readContext(session),
    );
    expect(page.transcriptPath).toBe(await realpath(session.rolloutPath));
    const serialized = JSON.stringify(page.records);
    expect(serialized).not.toContain('super-secret-tool-output');
    expect(serialized).not.toContain(session.codexHome);
    expect(serialized).not.toContain('.jsonl');
    for (const record of page.records) {
      if (record.kind === 'tool') {
        expect(record).not.toHaveProperty('arguments');
        expect(record).not.toHaveProperty('result');
      }
    }

    let caught: unknown;
    try {
      await provider.readRecentActivity(
        { sessionId: 'definitely-not-a-real-session' },
        readContext(session),
      );
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).not.toContain(session.codexHome);
  });

  it('reports provider_failure when the history_base lineage exceeds the bounded depth', async () => {
    // buildLineage (reader.ts) throws scan_unsupported once the lineage grows
    // past 64 entries (tail + 64 parents); the neutral taxonomy maps
    // scan_unsupported to provider_failure — never a native/protocol detail.
    const sessionId = fixtureSessionId();
    const session = await createDeepLineageSession(sessionId, 64);
    cleanupDirs.push(session.codexHome);

    await expect(
      provider.readRecentActivity({ sessionId }, readContext(session)),
    ).rejects.toMatchObject({
      name: 'AgentActivityError',
      reason: 'provider_failure',
    });
  });
});

async function appendNative(
  session: FixtureSession,
  ...lines: readonly Record<string, unknown>[]
): Promise<void> {
  await appendFile(
    session.rolloutPath,
    lines.map((line) => JSON.stringify(line)).join('\n') + '\n',
  );
}

function turnEvent(type: string, turnId?: string): Record<string, unknown> {
  return {
    type: 'event_msg',
    payload: { type, ...(turnId !== undefined ? { turn_id: turnId } : {}) },
  };
}

function finalizedMessage(text: string): Record<string, unknown> {
  return {
    type: 'response_item',
    payload: {
      type: 'message',
      role: 'assistant',
      content: [{ type: 'output_text', text }],
    },
  };
}

describe('readRecentActivity: authoritative native turn IDs', () => {
  it('keeps tools and compaction continuations in their evidenced turn, across multiple turns', async () => {
    const session = await makeSession();
    await appendNative(session, turnEvent('task_started', 'native-one'));
    await appendAssistantMessage(session, 'working');
    await appendToolCall(session, {
      callId: 'call-one',
      name: 'search',
      output: 'ok',
    });
    await appendNative(session, turnEvent('context_compacted'), {
      type: 'turn_context',
      payload: { turn_id: 'native-one' },
    });
    await appendAssistantMessage(session, 'after compaction');
    await appendNative(session, turnEvent('task_complete', 'native-one'));
    await appendAssistantMessage(session, 'outside any known turn');
    await appendNative(
      session,
      turnEvent('task_started', 'native-two'),
      {
        type: 'response_item',
        payload: {
          type: 'custom_tool_call',
          call_id: 'custom',
          name: 'apply_patch',
        },
      },
      turnEvent('task_complete', 'native-two'),
      {
        type: 'response_item',
        payload: {
          type: 'custom_tool_call_output',
          call_id: 'custom',
          status: 'error',
        },
      },
    );

    const page = await provider.readRecentActivity(
      { sessionId: session.sessionId },
      readContext(session),
    );
    expect(page.records).toEqual([
      { kind: 'assistant_message', text: 'working', turnId: 'native-one' },
      {
        kind: 'tool',
        name: 'search',
        status: 'completed',
        turnId: 'native-one',
      },
      {
        kind: 'assistant_message',
        text: 'after compaction',
        turnId: 'native-one',
      },
      { kind: 'assistant_message', text: 'outside any known turn' },
      {
        kind: 'tool',
        name: 'apply_patch',
        status: 'failed',
        turnId: 'native-two',
      },
    ]);
    const withoutTools = await provider.readRecentActivity(
      { sessionId: session.sessionId, includeTools: false },
      readContext(session),
    );
    expect(withoutTools.records).toEqual(
      page.records.filter((record) => record.kind !== 'tool'),
    );
  });

  it('uses only native IDs and ends context only on the matching terminal or an unattributed abort', async () => {
    const session = await makeSession();
    await appendNative(session, {
      type: 'turn_context',
      payload: { turn_id: 'native-context' },
    });
    await appendAssistantMessage(session, 'known');
    await appendNative(
      session,
      turnEvent('task_complete', 'unrelated'),
      turnEvent('turn_aborted', 'unrelated'),
    );
    await appendAssistantMessage(session, 'still known');
    await appendNative(session, turnEvent('turn_aborted'));
    await appendAssistantMessage(session, 'after abort');
    await appendNative(session, turnEvent('task_started', 'native-next'));
    await appendAssistantMessage(session, 'next');
    await appendNative(session, { type: 'turn_context', payload: {} });
    await appendAssistantMessage(session, 'legacy context');
    await appendNative(session, turnEvent('task_started', ''));
    await appendAssistantMessage(session, 'empty native ID');

    const page = await provider.readRecentActivity(
      { sessionId: session.sessionId },
      readContext(session),
    );
    expect(page.records).toEqual([
      { kind: 'assistant_message', text: 'known', turnId: 'native-context' },
      {
        kind: 'assistant_message',
        text: 'still known',
        turnId: 'native-context',
      },
      { kind: 'assistant_message', text: 'after abort' },
      { kind: 'assistant_message', text: 'next', turnId: 'native-next' },
      { kind: 'assistant_message', text: 'legacy context' },
      { kind: 'assistant_message', text: 'empty native ID' },
    ]);
  });

  it('does not let an earlier turn claim a later finalized message with identical text', async () => {
    const session = await makeSession();
    await appendNative(session, turnEvent('task_started', 'first'));
    await appendAssistantMessage(session, 'same text');
    await appendNative(
      session,
      turnEvent('task_complete', 'first'),
      turnEvent('task_started', 'second'),
      finalizedMessage('same text'),
    );
    await appendAssistantMessage(session, 'live second');
    await appendNative(
      session,
      { type: 'turn_context', payload: { turn_id: 'second' } },
      finalizedMessage('live second'),
    );

    const page = await provider.readRecentActivity(
      { sessionId: session.sessionId },
      readContext(session),
    );
    expect(page.records).toEqual([
      { kind: 'assistant_message', text: 'same text', turnId: 'first' },
      { kind: 'assistant_message', text: 'same text', turnId: 'second' },
      { kind: 'assistant_message', text: 'live second', turnId: 'second' },
    ]);
  });

  it('retains IDs on cursor pages as new turns append, leaving legacy records unassigned', async () => {
    const session = await makeSession();
    await appendAssistantMessage(session, 'legacy');
    await appendNative(session, turnEvent('task_started', 'first'));
    await appendAssistantMessage(session, 'first-a');
    await appendAssistantMessage(session, 'first-b');
    await appendNative(
      session,
      turnEvent('task_complete', 'first'),
      turnEvent('task_started', 'second'),
    );
    await appendToolCall(session, {
      callId: 'second-tool',
      name: 'search',
      output: 'ok',
    });
    await appendAssistantMessage(session, 'second answer');
    const newest = await provider.readRecentActivity(
      { sessionId: session.sessionId, limit: 2 },
      readContext(session),
    );
    await appendNative(
      session,
      turnEvent('task_complete', 'second'),
      turnEvent('task_started', 'third'),
    );
    await appendAssistantMessage(session, 'third answer');
    const older = await provider.readRecentActivity(
      { sessionId: session.sessionId, limit: 2, cursor: newest.nextCursor! },
      readContext(session),
    );
    const oldest = await provider.readRecentActivity(
      { sessionId: session.sessionId, limit: 2, cursor: older.nextCursor! },
      readContext(session),
    );
    expect(newest.records.map((record) => record.turnId)).toEqual([
      'second',
      'second',
    ]);
    expect(older.records).toEqual([
      { kind: 'assistant_message', text: 'first-a', turnId: 'first' },
      { kind: 'assistant_message', text: 'first-b', turnId: 'first' },
    ]);
    expect(oldest.records).toEqual([
      { kind: 'assistant_message', text: 'legacy' },
    ]);
    expect(oldest.nextCursor).toBeUndefined();
    expect([newest, older, oldest].map((page) => page.transcriptPath)).toEqual(
      Array(3).fill(await realpath(session.rolloutPath)),
    );
  });

  it('does not invent an ID when the native start lies outside the bounded window', async () => {
    const session = await makeSession();
    await appendNative(session, turnEvent('task_started', 'outside-window'), {
      type: 'noise',
      padding: 'x'.repeat(8_388_608),
    });
    await appendAssistantMessage(session, 'visible with no boundary');
    const page = await provider.readRecentActivity(
      { sessionId: session.sessionId },
      readContext(session),
    );
    expect(page.records).toEqual([
      { kind: 'assistant_message', text: 'visible with no boundary' },
    ]);
    expect(page.truncated).toBe(true);
    expect(page.nextCursor).toBeDefined();
  });

  it('honors lineage cutoffs and does not transfer parent turn IDs into an unassigned child', async () => {
    const parent = await makeSession();
    await appendNative(parent, turnEvent('task_started', 'parent-turn'));
    await appendAssistantMessage(parent, 'parent-a');
    await appendAssistantMessage(parent, 'parent-b');
    const cutoff = (await stat(parent.rolloutPath)).size;
    await appendNative(
      parent,
      turnEvent('task_started', 'excluded-parent-turn'),
    );
    await appendAssistantMessage(parent, 'excluded parent branch');
    const tailId = fixtureSessionId();
    const tail: FixtureSession = {
      ...parent,
      sessionId: tailId,
      rolloutPath: join(
        parent.sessionsDir,
        `rollout-2024-01-02T00-00-00-${tailId}.jsonl`,
      ),
    };
    await appendNative(tail, {
      type: 'session_meta',
      payload: {
        id: tailId,
        history_base: { thread_id: parent.sessionId, end_byte_offset: cutoff },
      },
    });
    await appendAssistantMessage(tail, 'unassigned child');
    await appendNative(tail, {
      type: 'turn_context',
      payload: { turn_id: 'child-turn' },
    });
    await appendAssistantMessage(tail, 'child answer');

    const newest = await provider.readRecentActivity(
      { sessionId: tailId, limit: 2 },
      readContext(tail),
    );
    const older = await provider.readRecentActivity(
      { sessionId: tailId, limit: 2, cursor: newest.nextCursor! },
      readContext(tail),
    );
    expect(newest.records).toEqual([
      { kind: 'assistant_message', text: 'unassigned child' },
      { kind: 'assistant_message', text: 'child answer', turnId: 'child-turn' },
    ]);
    expect(older.records).toEqual([
      { kind: 'assistant_message', text: 'parent-a', turnId: 'parent-turn' },
      { kind: 'assistant_message', text: 'parent-b', turnId: 'parent-turn' },
    ]);
    expect([newest.transcriptPath, older.transcriptPath]).toEqual(
      Array(2).fill(await realpath(tail.rolloutPath)),
    );
    expect(older.nextCursor).toBeUndefined();
  });
});

describe('readRecentActivity: canonical transcript read paths', () => {
  it('reports the opened canonical path through a config-home directory symlink', async () => {
    const session = await makeSession();
    await appendAssistantMessage(session, 'canonical');
    const homeAlias = `${session.codexHome}-alias`;
    cleanupDirs.push(homeAlias);
    await symlink(session.codexHome, homeAlias);
    const aliased = {
      ...session,
      env: { ...session.env, CODEX_HOME: homeAlias },
    };
    const page = await provider.readRecentActivity(
      { sessionId: session.sessionId },
      readContext(aliased),
    );
    expect(page.transcriptPath).toBe(await realpath(session.rolloutPath));
    expect(page.transcriptPath).not.toContain(homeAlias);
    expect(page.records).toEqual([
      { kind: 'assistant_message', text: 'canonical' },
    ]);
  });

  it('reports the actual compressed representation on cursor pages', async () => {
    const session = await makeSession();
    await appendNative(session, turnEvent('task_started', 'compressed-turn'));
    await appendAssistantMessage(session, 'older');
    await appendAssistantMessage(session, 'newer');
    const compressedPath = `${session.rolloutPath}.zst`;
    await writeFile(
      compressedPath,
      await promisify(zstdCompress)(await readFile(session.rolloutPath)),
    );
    await rm(session.rolloutPath);
    const newest = await provider.readRecentActivity(
      { sessionId: session.sessionId, limit: 1 },
      readContext(session),
    );
    const older = await provider.readRecentActivity(
      { sessionId: session.sessionId, limit: 1, cursor: newest.nextCursor! },
      readContext(session),
    );
    expect(newest.records).toEqual([
      { kind: 'assistant_message', text: 'newer', turnId: 'compressed-turn' },
    ]);
    expect(older.records).toEqual([
      { kind: 'assistant_message', text: 'older', turnId: 'compressed-turn' },
    ]);
    expect([newest.transcriptPath, older.transcriptPath]).toEqual(
      Array(2).fill(await realpath(compressedPath)),
    );
  });
});
