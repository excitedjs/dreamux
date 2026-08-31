/**
 * Behavioral coverage for `readRecentActivity` (the `builtin:codex` provider's
 * mandatory recent-Activity-Records read), against REAL rollout files under a
 * temp `CODEX_HOME` — the reader discovers sessions purely from the
 * filesystem, so this is the right fidelity level, not a mocked filesystem.
 *
 * Scope (Stage 9 coverage cell B): actively-growing session reads, chronology,
 * stable cursor pagination without skip/duplicate, includeTools default +
 * group-only hiding, and the typed neutral error taxonomy — never a leaked
 * filesystem path, native record shape, tool argument, or tool result.
 */
import { rm } from 'node:fs/promises';
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

function readContext(session: FixtureSession): AgentActivityReadContext<ReturnType<typeof defaultDispatcherCodexConfig>> {
  return {
    config: defaultDispatcherCodexConfig(),
    cwd: '/fake/cwd',
    injectEnv: session.env,
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
    expect(firstPage.records.map((r) => (r.kind === 'assistant_message' ? r.text : null)))
      .toEqual(['before growth']);

    await appendAssistantMessage(session, 'after growth');
    const secondPage = await provider.readRecentActivity(
      { sessionId: session.sessionId },
      readContext(session),
    );
    expect(secondPage.records.map((r) => (r.kind === 'assistant_message' ? r.text : null)))
      .toEqual(['before growth', 'after growth']);
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
    expect(page.records).toEqual([{ kind: 'assistant_message', text: 'only message' }]);
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
    await appendToolCall(session, { callId: 'c1', name: 'search_files', output: 'ok' });
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
    expect(firstPage.records.map((r) => (r.kind === 'assistant_message' ? r.text : null)))
      .toEqual(['message-3', 'message-4']);
    expect(firstPage.nextCursor).toBeDefined();

    // Grow the session BETWEEN page reads — the cursor is anchored to a byte
    // position, not a record count, so new growth must not shift what the
    // already-issued cursor points at.
    await appendAssistantMessage(session, 'message-5');

    const secondPage = await provider.readRecentActivity(
      { sessionId: session.sessionId, limit: 2, cursor: firstPage.nextCursor },
      readContext(session),
    );
    const firstTexts = firstPage.records.map((r) => (r.kind === 'assistant_message' ? r.text : null));
    const secondTexts = secondPage.records.map((r) => (r.kind === 'assistant_message' ? r.text : null));
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
    ).rejects.toMatchObject({ name: 'AgentActivityError', reason: 'cursor_invalid' });
  });

  it('rejects a cursor from a different query fingerprint (includeTools flip) as cursor_invalid', async () => {
    const session = await makeSession();
    await appendAssistantMessage(session, 'hello');
    await appendToolCall(session, { callId: 'c1', name: 'search', output: 'x' });

    const page = await provider.readRecentActivity(
      { sessionId: session.sessionId, limit: 1, includeTools: true },
      readContext(session),
    );
    expect(page.nextCursor).toBeDefined();

    await expect(
      provider.readRecentActivity(
        {
          sessionId: session.sessionId,
          cursor: page.nextCursor,
          includeTools: false,
        },
        readContext(session),
      ),
    ).rejects.toMatchObject({ name: 'AgentActivityError', reason: 'cursor_invalid' });
  });
});

describe('readRecentActivity: includeTools', () => {
  it('includes tool records by default', async () => {
    const session = await makeSession();
    await appendToolCall(session, { callId: 'c1', name: 'search_files', output: 'result text' });

    const page = await provider.readRecentActivity(
      { sessionId: session.sessionId },
      readContext(session),
    );
    // A call and its output settle the SAME positioned record (started ->
    // completed in place) — one native call produces one neutral record.
    expect(page.records).toHaveLength(1);
    expect(page.records[0]).toMatchObject({ kind: 'tool', name: 'search_files', status: 'completed' });
  });

  it('hides ALL tool records as one group when includeTools is false, never partially', async () => {
    const session = await makeSession();
    await appendAssistantMessage(session, 'before tools');
    await appendToolCall(session, { callId: 'c1', name: 'search_files', output: 'x' });
    await appendToolCall(session, { callId: 'c2', name: 'apply_patch', failed: true });
    await appendAssistantMessage(session, 'after tools');

    const page = await provider.readRecentActivity(
      { sessionId: session.sessionId, includeTools: false },
      readContext(session),
    );
    expect(page.records.every((r) => r.kind !== 'tool')).toBe(true);
    expect(page.records.map((r) => (r.kind === 'assistant_message' ? r.text : null)))
      .toEqual(['before tools', 'after tools']);
  });

  it('reports a failed tool call status distinctly from a completed one', async () => {
    const session = await makeSession();
    await appendToolCall(session, { callId: 'c1', name: 'apply_patch', failed: true });
    await appendToolCall(session, { callId: 'c2', name: 'search_files', output: 'ok' });

    const page = await provider.readRecentActivity(
      { sessionId: session.sessionId },
      readContext(session),
    );
    const statuses = page.records
      .filter((r): r is Extract<typeof r, { kind: 'tool' }> => r.kind === 'tool')
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
    ).rejects.toMatchObject({ name: 'AgentActivityError', reason: 'session_unavailable' });
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
    ).rejects.toMatchObject({ name: 'AgentActivityError', reason: 'activity_corrupt' });
  });

  it('never leaks a filesystem path, native record shape, or tool arguments/results into a record or error', async () => {
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
    const serialized = JSON.stringify(page);
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
      provider.readRecentActivity(
        { sessionId },
        readContext(session),
      ),
    ).rejects.toMatchObject({ name: 'AgentActivityError', reason: 'provider_failure' });
  });
});
