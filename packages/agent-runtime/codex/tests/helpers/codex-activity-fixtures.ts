/**
 * Real-file fixtures for `readCodexRecentActivity` behavioral tests.
 *
 * The reader discovers a session's rollout purely from `CODEX_HOME` +
 * `query.session.id` (see activity/path.ts): it never receives a persisted
 * native path. These helpers write actual `rollout-*.jsonl` files under a temp
 * `CODEX_HOME/sessions` tree in exactly the shape the reader's discovery scan
 * requires — session id embedded in BOTH the filename (`discoverRollouts`
 * filters by substring) and the first `session_meta` line (`validateCodexRollout`
 * cross-checks it).
 */
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, appendFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * A fresh session id shaped exactly like Codex's own thread ids. Every test
 * gets its own, so filename-substring discovery never confuses two fixtures.
 */
export function fixtureSessionId(): string {
  return randomUUID();
}

export interface FixtureSession {
  codexHome: string;
  sessionsDir: string;
  rolloutPath: string;
  sessionId: string;
  env: Record<string, string>;
}

/** Create a fresh CODEX_HOME temp tree with one empty rollout file, metadata written. */
export async function createFixtureSession(
  sessionId: string,
  options: { historyBase?: { rolloutId: string; endByteOffset: number } } = {},
): Promise<FixtureSession> {
  const codexHome = await mkdtemp(join(tmpdir(), 'codex-activity-fixture-'));
  const sessionsDir = join(codexHome, 'sessions');
  await mkdir(sessionsDir, { recursive: true });
  const rolloutPath = join(sessionsDir, `rollout-2024-01-01T00-00-00-${sessionId}.jsonl`);
  const meta: Record<string, unknown> = { id: sessionId };
  if (options.historyBase !== undefined) {
    meta['history_base'] = {
      thread_id: options.historyBase.rolloutId,
      end_byte_offset: options.historyBase.endByteOffset,
    };
  }
  await writeFile(
    rolloutPath,
    `${JSON.stringify({ type: 'session_meta', payload: meta })}\n`,
    'utf8',
  );
  return {
    codexHome,
    sessionsDir,
    rolloutPath,
    sessionId,
    env: { CODEX_HOME: codexHome, HOME: codexHome },
  };
}

/** Append one `event_msg`/`agent_message` line (a live assistant message). */
export async function appendAssistantMessage(
  session: FixtureSession,
  text: string,
): Promise<void> {
  await appendFile(
    session.rolloutPath,
    `${JSON.stringify({
      type: 'event_msg',
      payload: { type: 'agent_message', message: text },
    })}\n`,
    'utf8',
  );
}

/** Append a `function_call` / `function_call_output` pair (or call only). */
export async function appendToolCall(
  session: FixtureSession,
  input: { callId: string; name: string; output?: unknown; failed?: boolean },
): Promise<void> {
  await appendFile(
    session.rolloutPath,
    `${JSON.stringify({
      type: 'response_item',
      payload: { type: 'function_call', call_id: input.callId, name: input.name },
    })}\n`,
    'utf8',
  );
  if (input.output !== undefined || input.failed !== undefined) {
    await appendFile(
      session.rolloutPath,
      `${JSON.stringify({
        type: 'response_item',
        payload: {
          type: 'function_call_output',
          call_id: input.callId,
          output: input.output ?? null,
          status: input.failed === true ? 'error' : 'success',
        },
      })}\n`,
      'utf8',
    );
  }
}

/** Append a raw, deliberately unparseable line — simulates a corrupt record. */
export async function appendCorruptLine(session: FixtureSession): Promise<void> {
  await appendFile(session.rolloutPath, '{not json at all\n', 'utf8');
}

/**
 * Build a tail session whose `history_base` lineage chains through
 * `parentCount` additional rollout files (session id irrelevant on parents —
 * `findCodexRolloutById` matches by filename-embedded rollout id, never
 * session id; see path.ts). `buildLineage` in reader.ts throws
 * `scan_unsupported` once the lineage exceeds 64 entries (tail + 64 parents),
 * so `parentCount: 64` is the exact minimum that reproduces the bounded-depth
 * error deterministically and cheaply (no large files needed).
 */
export async function createDeepLineageSession(
  sessionId: string,
  parentCount: number,
): Promise<FixtureSession> {
  const codexHome = await mkdtemp(join(tmpdir(), 'codex-activity-fixture-'));
  const sessionsDir = join(codexHome, 'sessions');
  await mkdir(sessionsDir, { recursive: true });

  const parentIds = Array.from({ length: parentCount }, () => randomUUID());
  const rolloutPath = join(sessionsDir, `rollout-2024-01-01T00-00-00-${sessionId}.jsonl`);
  await writeFile(
    rolloutPath,
    `${JSON.stringify({
      type: 'session_meta',
      payload: {
        id: sessionId,
        history_base: { thread_id: parentIds[0], end_byte_offset: 0 },
      },
    })}\n`,
    'utf8',
  );

  for (let index = 0; index < parentCount; index += 1) {
    const id = parentIds[index]!;
    const next = parentIds[index + 1];
    const parentPath = join(
      sessionsDir,
      `rollout-2024-01-01T01-${String(index).padStart(2, '0')}-00-${id}.jsonl`,
    );
    const meta: Record<string, unknown> = { id: randomUUID() };
    if (next !== undefined) {
      meta['history_base'] = { thread_id: next, end_byte_offset: 0 };
    }
    await writeFile(
      parentPath,
      `${JSON.stringify({ type: 'session_meta', payload: meta })}\n`,
      'utf8',
    );
  }

  return {
    codexHome,
    sessionsDir,
    rolloutPath,
    sessionId,
    env: { CODEX_HOME: codexHome, HOME: codexHome },
  };
}

/**
 * Build a two-segment lineage where the tail segment alone exceeds
 * `MAX_NATIVE_RECORDS` (reader.ts) with native lines that project to nothing
 * (unrecognized `type`, deliberately). The tail's own records fit on the page,
 * so the scan only discovers it has run out of native-record budget when it
 * reaches the *next* lineage segment (the parent) — reproducing
 * `truncated: true` without needing an oversized file (the parent segment is
 * never actually read).
 */
export async function createBoundsExceedingLineageSession(
  sessionId: string,
): Promise<FixtureSession> {
  const codexHome = await mkdtemp(join(tmpdir(), 'codex-activity-fixture-'));
  const sessionsDir = join(codexHome, 'sessions');
  await mkdir(sessionsDir, { recursive: true });

  const parentId = randomUUID();
  const rolloutPath = join(sessionsDir, `rollout-2024-01-01T00-00-00-${sessionId}.jsonl`);
  const lines: string[] = [
    JSON.stringify({
      type: 'session_meta',
      payload: {
        id: sessionId,
        history_base: { thread_id: parentId, end_byte_offset: 0 },
      },
    }),
    JSON.stringify({
      type: 'event_msg',
      payload: { type: 'agent_message', message: 'visible before the bound hits' },
    }),
  ];
  // One more than MAX_NATIVE_RECORDS (20_000 in reader.ts) so the tail segment
  // alone exhausts the native-record budget.
  for (let index = 0; index < 20_001; index += 1) {
    lines.push(JSON.stringify({ type: 'noise', index }));
  }
  await writeFile(rolloutPath, `${lines.join('\n')}\n`, 'utf8');

  const parentPath = join(sessionsDir, `rollout-2024-01-01T01-00-00-${parentId}.jsonl`);
  await writeFile(
    parentPath,
    `${JSON.stringify({ type: 'session_meta', payload: { id: randomUUID() } })}\n`,
    'utf8',
  );

  return {
    codexHome,
    sessionsDir,
    rolloutPath,
    sessionId,
    env: { CODEX_HOME: codexHome, HOME: codexHome },
  };
}
