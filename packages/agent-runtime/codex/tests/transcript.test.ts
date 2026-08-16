import {
  appendFile,
  mkdtemp,
  mkdir,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative, sep } from 'node:path';
import { zstdCompressSync } from 'node:zlib';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { defaultDispatcherCodexConfig } from '../src/config.js';
import { createCodexTranscriptBudget } from '../src/transcript/budget.js';
import {
  locateCodexTranscript,
  resolveCodexTranscriptRoots,
  validateCodexThreadPath,
  validateCodexTranscriptLocator,
} from '../src/transcript/path.js';
import { readCodexTranscript } from '../src/transcript/reader.js';

const SESSION_ID = '11111111-1111-4111-8111-111111111111';
const PARENT_SESSION_ID = '22222222-2222-4222-8222-222222222222';
const REVERTED_ROLLOUT_ID = '33333333-3333-4333-8333-333333333333';
const GRANDPARENT_ROLLOUT_ID = '44444444-4444-4444-8444-444444444444';

describe('Codex native transcript reader', () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) =>
      rm(root, { recursive: true, force: true }),
    ));
  });

  it('projects completed turns and paired tools with backward pagination', async () => {
    const fixture = await transcriptFixture([
      turn('one', 'first', 'shell', '{"token":"secret","z":1}', 'ok'),
      turn('two', 'second', 'read_file', '{"path":"README.md"}', 'contents'),
    ]);

    const first = await read(fixture.path, { turns: 1, includeTools: true });
    expect(first.turns).toHaveLength(1);
    expect(first.turns[0]?.blocks).toContainEqual(
      expect.objectContaining({
        kind: 'tool',
        name: 'read_file',
        input: '{"path":"README.md"}',
        output: 'contents',
      }),
    );
    expect(first.nextCursor).not.toBeNull();
    expect(Object.keys(decodeCursorEnvelope(first.nextCursor!)).sort()).toEqual(
      ['bd', 'fp', 'gen', 'p', 'pos', 'v'],
    );
    expect(publicText(decodeCursorEnvelope(first.nextCursor!))).not.toContain(
      SESSION_ID,
    );
    expect(publicText(decodeCursorEnvelope(first.nextCursor!))).not.toContain(
      'prompt-',
    );

    const second = await read(fixture.path, {
      turns: 1,
      includeTools: true,
      cursor: first.nextCursor!,
    });
    expect(second.turns[0]?.blocks).toContainEqual(
      expect.objectContaining({
        kind: 'message',
        role: 'assistant',
        text: 'first',
      }),
    );
    expect(second.nextCursor).toBeNull();
    await expect(
      read(fixture.path, {
        turns: 1,
        includeTools: false,
        cursor: first.nextCursor!,
      }),
    ).rejects.toMatchObject({ reason: 'cursor_query_mismatch' });
  });

  it('keeps append-only cursors stable and rejects digest, position, and rewrite mismatches', async () => {
    const fixture = await transcriptFixture([
      turn('one', 'first'),
      turn('two', 'second'),
    ]);
    const first = await read(fixture.path, { turns: 1 });
    expect(first.nextCursor).not.toBeNull();
    const originalCursor = decodeCursor(first.nextCursor!);

    await appendFile(fixture.path, turn('three', 'third').join('\n') + '\n');
    const older = await read(fixture.path, {
      turns: 1,
      cursor: first.nextCursor!,
    });
    expect(publicText(older)).toContain('first');

    await expect(
      read(fixture.path, {
        turns: 1,
        cursor: mutateCursor(first.nextCursor!, {
          bd: 'A'.repeat(43),
        }),
      }),
    ).rejects.toMatchObject({ reason: 'cursor_stale' });
    await expect(
      read(fixture.path, {
        turns: 1,
        cursor: mutateCursor(first.nextCursor!, {
          pos: { segment: 0, offset: originalCursor.pos.offset + 1 },
        }),
      }),
    ).rejects.toMatchObject({ reason: 'cursor_stale' });
    await expect(
      read(fixture.path, {
        turns: 1,
        cursor: mutateCursor(first.nextCursor!, {
          gen: 'A'.repeat(43),
        }),
      }),
    ).rejects.toMatchObject({ reason: 'cursor_stale' });

    const original = await readFile(fixture.path, 'utf8');
    await writeFile(
      fixture.path,
      replaceOccurrence(original, 'task_started', 'turn_started', 2),
    );
    await expect(
      read(fixture.path, {
        turns: 1,
        cursor: first.nextCursor!,
      }),
    ).rejects.toMatchObject({ reason: 'cursor_stale' });
  });

  it.each([0, -1, 1.5, 51])(
    'rejects direct provider turns query %s with a typed invalid reason',
    async (turns) => {
      const fixture = await transcriptFixture([turn('one', 'done')]);
      await expect(
        readCodexTranscript(
          { turns },
          transcriptContext(fixture.root, fixture.path),
        ),
      ).rejects.toMatchObject({ reason: 'invalid' });
    },
  );

  it('fills uncompressed windows and cursor boundaries across short reads', async () => {
    const fixture = await transcriptFixture([
      turn('one', 'first'),
      turn('two', 'second'),
    ]);
    const first = await readCodexTranscript(
      { turns: 1 },
      transcriptContext(fixture.root, fixture.path),
      { maxReadChunkBytes: 7 },
    );
    expect(publicText(first)).toContain('second');
    expect(first.nextCursor).not.toBeNull();

    const older = await readCodexTranscript(
      { turns: 1, cursor: first.nextCursor! },
      transcriptContext(fixture.root, fixture.path),
      { maxReadChunkBytes: 5 },
    );
    expect(publicText(older)).toContain('first');
  });

  it.each([
    ['task aliases', 'task_started', 'task_complete'],
    ['turn aliases', 'turn_started', 'turn_complete'],
  ])('accepts both %s', async (_label, start, complete) => {
    const fixture = await transcriptFixture([
      turn('one', 'done', undefined, undefined, undefined, start, complete),
    ]);
    const page = await read(fixture.path, { turns: 1 });
    expect(publicText(page)).toContain('done');
    expect(JSON.stringify(page)).not.toContain('call-one');
    expect(JSON.stringify(page)).not.toContain(SESSION_ID);
    expect(JSON.stringify(page)).not.toContain(fixture.path);
  });

  it('follows history_base lineage and selects the native revert cut', async () => {
    const root = await createRoot();
    const parentPath = rolloutPath(root, PARENT_SESSION_ID);
    const parentBefore = turn('parent-one', 'parent kept');
    const parentPrefix = rollout(
      [parentBefore],
      PARENT_SESSION_ID,
    );
    const cut = Buffer.byteLength(parentPrefix, 'utf8');
    await mkdir(dirname(parentPath), { recursive: true });
    await writeFile(
      parentPath,
      parentPrefix + turn('parent-two', 'parent reverted').join('\n') + '\n',
    );

    const tailPath = rolloutPath(root, SESSION_ID, '17');
    await mkdir(dirname(tailPath), { recursive: true });
    await writeFile(
      tailPath,
      rollout(
        [turn('tail', 'tail selected')],
        SESSION_ID,
        { rolloutId: PARENT_SESSION_ID, endByteOffset: cut },
      ),
    );

    const page = await readFromRoot(root, tailPath, { turns: 3 });
    expect(publicText(page)).toContain('parent kept');
    expect(publicText(page)).toContain('tail selected');
    expect(publicText(page)).not.toContain('parent reverted');
  });

  it('follows nested reverted lineage without conflating rollout and stable thread ids', async () => {
    const root = await createRoot();
    const grandparentPath = rolloutPath(root, GRANDPARENT_ROLLOUT_ID, '14');
    const grandparentPrefix = rollout(
      [turn('grandparent-kept', 'grandparent kept')],
      SESSION_ID,
    );
    await mkdir(dirname(grandparentPath), { recursive: true });
    await writeFile(
      grandparentPath,
      grandparentPrefix +
        turn('grandparent-dropped', 'grandparent dropped').join('\n') +
        '\n',
    );

    const parentPath = rolloutPath(
      root,
      SESSION_ID,
      '15',
      REVERTED_ROLLOUT_ID,
    );
    const parentPrefix = rollout(
      [turn('parent-kept', 'parent kept')],
      SESSION_ID,
      {
        rolloutId: GRANDPARENT_ROLLOUT_ID,
        endByteOffset: Buffer.byteLength(grandparentPrefix, 'utf8'),
      },
    );
    await mkdir(dirname(parentPath), { recursive: true });
    await writeFile(
      parentPath,
      parentPrefix +
        turn('parent-dropped', 'parent dropped').join('\n') +
        '\n',
    );

    const tailPath = rolloutPath(root, SESSION_ID, '16');
    await mkdir(dirname(tailPath), { recursive: true });
    await writeFile(
      tailPath,
      rollout([turn('tail', 'tail selected')], SESSION_ID, {
        rolloutId: REVERTED_ROLLOUT_ID,
        endByteOffset: Buffer.byteLength(parentPrefix, 'utf8'),
      }),
    );

    const page = await readFromRoot(root, tailPath, { turns: 5 });
    expect(publicText(page)).toContain('grandparent kept');
    expect(publicText(page)).toContain('parent kept');
    expect(publicText(page)).toContain('tail selected');
    expect(publicText(page)).not.toContain('grandparent dropped');
    expect(publicText(page)).not.toContain('parent dropped');
  });

  it('rediscoveries active and archived representations and preserves a cursor across archive/compression movement', async () => {
    const fixture = await transcriptFixture([
      turn('one', 'first'),
      turn('two', 'second'),
    ]);
    const first = await read(fixture.path, { turns: 1 });
    const archived = join(
      fixture.root,
      '.codex',
      'archived_sessions',
      fixture.path.split(sep).at(-1)!,
    );
    await mkdir(dirname(archived), { recursive: true });
    await rename(fixture.path, archived);

    const archivedPage = await readFromRoot(
      fixture.root,
      fixture.path,
      { turns: 1, cursor: first.nextCursor! },
    );
    expect(publicText(archivedPage)).toContain('first');

    const compressed = `${archived}.zst`;
    await writeFile(
      compressed,
      zstdCompressSync(await readFile(archived)),
    );
    await unlink(archived);
    const compressedPage = await readFromRoot(
      fixture.root,
      fixture.path,
      { turns: 1, cursor: first.nextCursor! },
    );
    expect(publicText(compressedPage)).toContain('first');
  });

  it('selects the newest archived reverted rollout over an older active representation', async () => {
    const root = await createRoot();
    const active = rolloutPath(root, SESSION_ID, '14');
    await mkdir(dirname(active), { recursive: true });
    await writeFile(active, rollout([turn('old', 'old active')]));
    const archived = join(
      root,
      '.codex',
      'archived_sessions',
      `rollout-2026-08-18T00-00-00-${SESSION_ID}_${REVERTED_ROLLOUT_ID}.jsonl`,
    );
    await mkdir(dirname(archived), { recursive: true });
    await writeFile(
      archived,
      rollout([turn('new', 'new archived revert')], SESSION_ID),
    );

    const page = await readFromRoot(
      root,
      join(root, '.codex', 'missing', `rollout-x-${SESSION_ID}.jsonl`),
      { turns: 1 },
    );
    expect(publicText(page)).toContain('new archived revert');
    expect(publicText(page)).not.toContain('old active');
  });

  it('returns null cursor for a bounded open tail and observes it on a later fresh query', async () => {
    const fixture = await transcriptFixture([]);
    const filler = line('response_item', {
      type: 'reasoning',
      encrypted_content: 'x'.repeat(10_000),
    });
    await appendFile(
      fixture.path,
      [
        line('event_msg', { type: 'turn_started' }),
        line('response_item', {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: 'open prompt' }],
        }),
        ...Array.from({ length: 850 }, () => filler),
        '',
      ].join('\n'),
    );
    const open = await read(fixture.path, { turns: 1 });
    expect(open).toMatchObject({ turns: [], nextCursor: null });

    await writeFile(
      fixture.path,
      rollout([
        turn(
          'completed',
          'now complete',
          undefined,
          undefined,
          undefined,
          'turn_started',
          'turn_complete',
        ),
      ]),
    );
    const complete = await read(fixture.path, { turns: 1 });
    expect(publicText(complete)).toContain('now complete');
  });

  it('returns scan_unsupported for a completed turn larger than one scan window', async () => {
    const fixture = await transcriptFixture([]);
    const filler = line('response_item', {
      type: 'reasoning',
      encrypted_content: 'x'.repeat(10_000),
    });
    await appendFile(
      fixture.path,
      [
        line('event_msg', { type: 'turn_started' }),
        line('response_item', {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: 'large prompt' }],
        }),
        ...Array.from({ length: 850 }, () => filler),
        line('response_item', {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'large result' }],
        }),
        line('event_msg', { type: 'turn_complete' }),
        '',
      ].join('\n'),
    );
    await expect(read(fixture.path, { turns: 1 })).rejects.toMatchObject({
      reason: 'scan_unsupported',
    });
  });

  it('returns scan_unsupported for a large indexless compressed rollout', async () => {
    const fixture = await transcriptFixture([]);
    const compressed = `${fixture.path}.zst`;
    const filler = line('response_item', {
      type: 'reasoning',
      encrypted_content: 'x'.repeat(10_000),
    });
    const content = [
      rollout([]).trimEnd(),
      line('event_msg', { type: 'turn_started' }),
      ...Array.from({ length: 850 }, () => filler),
      line('event_msg', { type: 'turn_complete' }),
      '',
    ].join('\n');
    await writeFile(compressed, zstdCompressSync(Buffer.from(content, 'utf8')));
    await unlink(fixture.path);

    await expect(
      readFromRoot(fixture.root, fixture.path, { turns: 1 }),
    ).rejects.toMatchObject({ reason: 'scan_unsupported' });
  });

  it('returns a strictly older scan-bound continuation when safe progress exists', async () => {
    const fixture = await transcriptFixture([turn('old', 'oldest')]);
    const filler = line('response_item', {
      type: 'reasoning',
      encrypted_content: 'x'.repeat(350),
    });
    await appendFile(
      fixture.path,
      [
        ...Array.from({ length: 20_100 }, () => filler),
        ...turn('recent', 'newest'),
        '',
      ].join('\n'),
    );
    const first = await read(fixture.path, { turns: 2 });
    expect(publicText(first)).toContain('newest');
    expect(first.nextCursor).not.toBeNull();
    const firstPosition = decodeCursor(first.nextCursor!).pos;

    const second = await read(fixture.path, {
      turns: 2,
      cursor: first.nextCursor!,
    });
    expect(second).toMatchObject({ turns: [] });
    expect(second.nextCursor).not.toBeNull();
    const secondPosition = decodeCursor(second.nextCursor!).pos;
    expect(secondPosition.segment).toBeGreaterThanOrEqual(
      firstPosition.segment,
    );
    if (secondPosition.segment === firstPosition.segment) {
      expect(secondPosition.offset).toBeLessThan(firstPosition.offset);
    }
    const third = await read(fixture.path, {
      turns: 2,
      cursor: second.nextCursor!,
    });
    expect(publicText(third)).toContain('oldest');
  });

  it('returns null cursor when the exact native-record budget reaches byte zero', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-16T00:00:00.000Z'));
    try {
      const fixture = await transcriptFixture([]);
      const filler = line('response_item', {
        type: 'reasoning',
        encrypted_content: 'x',
      });
      const completed = turn('oldest', 'at origin');
      await writeFile(
        fixture.path,
        [
          rollout([]).trimEnd(),
          ...completed,
          ...Array.from({ length: 20_000 - 1 - completed.length }, () => filler),
          '',
        ].join('\n'),
      );

      const page = await read(fixture.path, { turns: 1 });
      expect(publicText(page)).toContain('at origin');
      expect(page.nextCursor).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('continues into a parent after an exact tail native-record budget', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-16T00:00:00.000Z'));
    try {
      const root = await createRoot();
      const parentPath = rolloutPath(root, PARENT_SESSION_ID, '15');
      const parent = rollout([turn('parent', 'older parent')], SESSION_ID);
      await mkdir(dirname(parentPath), { recursive: true });
      await writeFile(parentPath, parent);

      const tailPath = rolloutPath(root, SESSION_ID, '16');
      const completed = turn('tail', 'newer tail');
      const filler = line('response_item', {
        type: 'reasoning',
        encrypted_content: 'x',
      });
      await mkdir(dirname(tailPath), { recursive: true });
      await writeFile(
        tailPath,
        [
          rollout([], SESSION_ID, {
            rolloutId: PARENT_SESSION_ID,
            endByteOffset: Buffer.byteLength(parent, 'utf8'),
          }).trimEnd(),
          ...completed,
          ...Array.from(
            { length: 20_000 - 1 - completed.length },
            () => filler,
          ),
          '',
        ].join('\n'),
      );

      const first = await readFromRoot(root, tailPath, { turns: 2 });
      expect(publicText(first)).toContain('newer tail');
      expect(publicText(first)).not.toContain('older parent');
      expect(first.nextCursor).not.toBeNull();

      const second = await readFromRoot(root, tailPath, {
        turns: 2,
        cursor: first.nextCursor!,
      });
      expect(publicText(second)).toContain('older parent');
      expect(publicText(second)).not.toContain('newer tail');
      expect(second.nextCursor).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    ['missing', async (fixture: Awaited<ReturnType<typeof transcriptFixture>>) => {
      await unlink(fixture.path);
      return 'not_found';
    }],
    ['corrupt', async (fixture: Awaited<ReturnType<typeof transcriptFixture>>) => {
      await writeFile(fixture.path, '{"broken":}\n');
      return 'invalid';
    }],
  ])('returns typed errors for %s input', async (_label, arrange) => {
    const fixture = await transcriptFixture([turn('one', 'done')]);
    const reason = await arrange(fixture);
    await expect(read(fixture.path, { turns: 1 })).rejects.toMatchObject({
      reason,
    });
  });

  it('rejects malformed cursors without exposing provider-private content', async () => {
    const fixture = await transcriptFixture([turn('one', 'done')]);
    await expect(
      read(fixture.path, { turns: 1, cursor: 'not-a-cursor' }),
    ).rejects.toMatchObject({ reason: 'cursor_invalid' });
  });

  it('rejects a post-validation symlink swap without exposing outside content', async () => {
    const fixture = await transcriptFixture([turn('one', 'inside')]);
    const outside = join(fixture.root, 'outside-race.jsonl');
    await writeFile(outside, rollout([turn('outside', 'private outside')]));
    const original = `${fixture.path}.original`;
    await expect(
      readCodexTranscript(
        { turns: 1 },
        transcriptContext(fixture.root, fixture.path),
        {
          afterLocate: async () => {
            await rename(fixture.path, original);
            await symlink(outside, fixture.path);
          },
        },
      ),
    ).rejects.toMatchObject({
      reason: expect.stringMatching(/unreadable|locator_outside_root/),
    });
  });

  it('bounds discovery and rejects oversized metadata without a newline', async () => {
    const root = await createRoot();
    const codexHome = join(root, '.codex');
    for (const day of ['01', '02']) {
      await mkdir(
        join(codexHome, 'sessions', '2026', '08', day),
        { recursive: true },
      );
    }
    const nativeRoots = await resolveCodexTranscriptRoots({
      HOME: root,
      CODEX_HOME: codexHome,
    });
    await expect(
      locateCodexTranscript(
        null,
        SESSION_ID,
        nativeRoots,
        createCodexTranscriptBudget({ maxEntries: 1 }),
      ),
    ).rejects.toMatchObject({ reason: 'scan_unsupported' });

    const path = rolloutPath(root, SESSION_ID);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, 'x'.repeat(1_048_577));
    await expect(
      readFromRoot(root, path, { turns: 1 }),
    ).rejects.toMatchObject({ reason: 'invalid' });
  });

  it('matches explicit CODEX_HOME native validation semantics', async () => {
    const root = await createRoot();
    await expect(
      resolveCodexTranscriptRoots({
        HOME: root,
        CODEX_HOME: 'relative-home',
      }),
    ).rejects.toMatchObject({ reason: 'invalid' });
    await expect(
      resolveCodexTranscriptRoots({
        HOME: root,
        CODEX_HOME: join(root, 'missing'),
      }),
    ).rejects.toMatchObject({ reason: 'not_found' });
    const file = join(root, 'not-a-directory');
    await writeFile(file, 'x');
    await expect(
      resolveCodexTranscriptRoots({ HOME: root, CODEX_HOME: file }),
    ).rejects.toMatchObject({ reason: 'invalid' });
  });

  it('rejects locator escape and session mismatch', async () => {
    const fixture = await transcriptFixture([turn('one', 'done')]);
    const outside = join(fixture.root, 'outside.jsonl');
    await writeFile(outside, rollout([turn('one', 'done')]));
    const escaped = join(
      dirname(fixture.path),
      `rollout-2026-08-17T00-00-00-${SESSION_ID}.jsonl`,
    );
    await symlink(outside, escaped);

    await expect(
      validateCodexTranscriptLocator(
        escaped,
        SESSION_ID,
        await resolveCodexTranscriptRoots({
          HOME: fixture.root,
          CODEX_HOME: join(fixture.root, '.codex'),
        }),
      ),
    ).rejects.toMatchObject({ reason: 'locator_outside_root' });
    await expect(
      read(fixture.path, { turns: 1 }, '22222222-2222-4222-8222-222222222222'),
    ).rejects.toMatchObject({ reason: 'session_mismatch' });
  });

  it('accepts a confined exact-session thread path before the first append', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dreamux-codex-thread-path-'));
    roots.push(root);
    const configuredRoot = join(root, '.codex');
    const path = join(
      configuredRoot,
      'sessions',
      '2026',
      '08',
      '16',
      `rollout-2026-08-16T00-00-00-${SESSION_ID}.jsonl`,
    );
    await mkdir(configuredRoot, { recursive: true });
    const rootsForTest = await resolveCodexTranscriptRoots({
      HOME: root,
      CODEX_HOME: configuredRoot,
    });
    const canonicalPath = join(
      await realpath(configuredRoot),
      relative(configuredRoot, path),
    );

    await expect(
      validateCodexThreadPath(
        path,
        SESSION_ID,
        rootsForTest,
      ),
    ).resolves.toMatchObject({
      path: canonicalPath,
      sessionId: SESSION_ID,
      rolloutId: SESSION_ID,
    });
    await expect(
      validateCodexThreadPath(
        path,
        '22222222-2222-4222-8222-222222222222',
        rootsForTest,
      ),
    ).rejects.toMatchObject({ reason: 'session_mismatch' });
    await expect(
      validateCodexTranscriptLocator(
        path,
        SESSION_ID,
        rootsForTest,
      ),
    ).rejects.toMatchObject({ reason: 'not_found' });

    const outside = join(root, 'outside');
    const sessions = join(root, '.codex', 'sessions');
    await Promise.all([
      mkdir(outside, { recursive: true }),
      mkdir(sessions, { recursive: true }),
    ]);
    await symlink(outside, join(sessions, 'escaped'));
    const escaped = join(
      sessions,
      'escaped',
      `rollout-2026-08-16T00-00-00-${SESSION_ID}.jsonl`,
    );
    await expect(
      validateCodexThreadPath(
        escaped,
        SESSION_ID,
        rootsForTest,
      ),
    ).rejects.toMatchObject({ reason: 'locator_outside_root' });
  });

  async function createRoot() {
    const root = await mkdtemp(join(tmpdir(), 'dreamux-codex-transcript-'));
    roots.push(root);
    return root;
  }

  async function transcriptFixture(turns: string[][]) {
    const root = await createRoot();
    const path = rolloutPath(root, SESSION_ID);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, rollout(turns));
    return { root, path };
  }

  function read(
    path: string,
    query: { turns: number; includeTools?: boolean; cursor?: string },
    sessionId = SESSION_ID,
  ) {
    return readFromRoot(
      join(dirname(path), '..', '..', '..', '..', '..'),
      path,
      query,
      sessionId,
    );
  }

  function readFromRoot(
    root: string,
    path: string,
    query: { turns: number; includeTools?: boolean; cursor?: string },
    sessionId = SESSION_ID,
  ) {
    return readCodexTranscript(
      query,
      transcriptContext(root, path, sessionId),
    );
  }

  function transcriptContext(
    root: string,
    path: string,
    sessionId = SESSION_ID,
  ) {
    return {
      checkpoint: { id: sessionId, transcript_locator: path },
      config: defaultDispatcherCodexConfig(),
      cwd: '/workspace',
      injectEnv: { CODEX_HOME: join(root, '.codex') },
      outputBudgetBytes: 262_144 as const,
    };
  }
});

function rollout(
  turns: string[][],
  sessionId = SESSION_ID,
  historyBase?: { rolloutId: string; endByteOffset: number },
): string {
  return [
    JSON.stringify({
      timestamp: '2026-08-16T00:00:00.000Z',
      type: 'session_meta',
      payload: {
        id: sessionId,
        session_id: sessionId,
        cwd: '/workspace',
        ...(historyBase === undefined
          ? {}
          : {
              history_base: {
                thread_id: historyBase.rolloutId,
                end_byte_offset: historyBase.endByteOffset,
              },
            }),
      },
    }),
    ...turns.flat(),
    '',
  ].join('\n');
}

function turn(
  id: string,
  assistant: string,
  toolName?: string,
  toolInput?: string,
  toolOutput?: string,
  start = 'task_started',
  complete = 'task_complete',
): string[] {
  const callId = `call-${id}`;
  return [
    line('event_msg', { type: start, turn_id: id }),
    line('response_item', {
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text: `prompt-${id}` }],
    }),
    ...(toolName === undefined
      ? []
      : [
          line('response_item', {
            type: 'function_call',
            call_id: callId,
            name: toolName,
            arguments: toolInput,
          }),
          line('response_item', {
            type: 'function_call_output',
            call_id: callId,
            output: toolOutput,
          }),
        ]),
    line('response_item', {
      type: 'message',
      role: 'assistant',
      content: [{ type: 'output_text', text: assistant }],
    }),
    line('event_msg', { type: complete, turn_id: id }),
  ];
}

function line(type: string, payload: Record<string, unknown>): string {
  return JSON.stringify({
    timestamp: '2026-08-16T00:00:01.000Z',
    type,
    payload,
  });
}

function rolloutPath(
  root: string,
  sessionId: string,
  day = '16',
  rolloutId?: string,
): string {
  return join(
    root,
    '.codex',
    'sessions',
    '2026',
    '08',
    day,
    `rollout-2026-08-${day}T00-00-00-${sessionId}` +
      `${rolloutId === undefined ? '' : `_${rolloutId}`}.jsonl`,
  );
}

function publicText(value: unknown): string {
  return JSON.stringify(value);
}

function decodeCursor(cursor: string): {
  pos: { segment: number; offset: number };
} {
  return decodeCursorEnvelope(cursor) as {
    pos: { segment: number; offset: number };
  };
}

function decodeCursorEnvelope(cursor: string): Record<string, unknown> {
  return JSON.parse(
    Buffer.from(cursor, 'base64url').toString('utf8'),
  ) as Record<string, unknown>;
}

function mutateCursor(
  cursor: string,
  patch: Record<string, unknown>,
): string {
  const envelope = JSON.parse(
    Buffer.from(cursor, 'base64url').toString('utf8'),
  ) as Record<string, unknown>;
  return Buffer.from(
    JSON.stringify({ ...envelope, ...patch }),
    'utf8',
  ).toString('base64url');
}

function replaceOccurrence(
  input: string,
  search: string,
  replacement: string,
  occurrence: number,
): string {
  let start = 0;
  for (let index = 1; index <= occurrence; index += 1) {
    const found = input.indexOf(search, start);
    if (found < 0) return input;
    if (index === occurrence) {
      return (
        input.slice(0, found) +
        replacement +
        input.slice(found + search.length)
      );
    }
    start = found + search.length;
  }
  return input;
}
