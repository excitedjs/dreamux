import {
  appendFile,
  chmod,
  mkdtemp,
  mkdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { defaultDispatcherClaudeCodeConfig } from '../src/config.js';
import { claudeCodeResidentArgs } from '../src/args.js';
import { createClaudeTranscriptBudget } from '../src/transcript/budget.js';
import { claudeNativePathHash } from '../src/transcript/native-hash.js';
import {
  claudeTranscriptRoots,
  deriveClaudeTranscriptPath,
  locateClaudeTranscript,
  validateClaudeTranscriptPath,
} from '../src/transcript/path.js';
import { readClaudeTranscript } from '../src/transcript/reader.js';

const SESSION_ID = '11111111-1111-4111-8111-111111111111';

interface Fixture {
  root: string;
  cwd: string;
  path: string;
}

describe('Claude Code native transcript reader', () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) =>
      rm(root, { recursive: true, force: true }),
    ));
  });

  it('recovers parallel tool siblings and results from the native transcript DAG', async () => {
    const fixture = await createFixture();
    const entries = [
      message(null, 'u1', 'user', [{ type: 'text', text: 'first' }]),
      assistantMessage(
        'u1',
        'a-read',
        'native-message-parallel',
        '2026-08-16T00:00:01.000Z',
        {
          type: 'tool_use',
          id: 'tool-read-private',
          name: 'Read',
          input: { path: 'a' },
        },
      ),
      assistantMessage(
        'a-read',
        'a-search',
        'native-message-parallel',
        '2026-08-16T00:00:02.000Z',
        {
          type: 'tool_use',
          id: 'tool-search-private',
          name: 'Search',
          input: { query: 'b' },
        },
      ),
      toolResultMessage(
        'a-read',
        'r-read',
        '2026-08-16T00:00:03.000Z',
        {
          type: 'tool_result',
          tool_use_id: 'tool-read-private',
          content: 'contents',
          is_error: false,
        },
      ),
      toolResultMessage(
        'a-search',
        'r-search',
        '2026-08-16T00:00:04.000Z',
        {
          type: 'tool_result',
          tool_use_id: 'tool-search-private',
          content: 'match',
          is_error: false,
        },
      ),
      {
        ...message('r-read', 'a-final', 'assistant', [
          { type: 'text', text: 'done' },
        ]),
        timestamp: '2026-08-16T00:00:05.000Z',
      },
      turnDuration(
        'a-final',
        'duration-parallel',
        '2026-08-16T00:00:06.000Z',
      ),
      {
        ...message('a-final', 'side', 'assistant', [
          { type: 'text', text: 'hidden' },
        ]),
        isSidechain: true,
      },
      message('duration-parallel', 'u2', 'user', [
        { type: 'text', text: 'open' },
      ]),
    ];
    await writeFile(fixture.path, `${entries.map(JSON.stringify).join('\n')}\n`);

    const page = await read(fixture, { turns: 2, includeTools: true });
    expect(page.turns).toHaveLength(1);
    expect(
      page.turns[0]?.blocks.filter((block) => block.kind === 'tool'),
    ).toEqual([
      expect.objectContaining({
        kind: 'tool',
        name: 'Read',
        output: 'contents',
        status: 'ok',
      }),
      expect.objectContaining({
        kind: 'tool',
        name: 'Search',
        output: 'match',
        status: 'ok',
      }),
    ]);
    const publicPage = JSON.stringify(page);
    for (const privateValue of [
      'hidden',
      'open',
      'tool-read-private',
      'tool-search-private',
      'native-message-parallel',
      'a-read',
      'a-search',
      'r-read',
      'r-search',
      SESSION_ID,
      fixture.path,
    ]) {
      expect(publicPage).not.toContain(privateValue);
    }
  });

  it('orders recovered parallel siblings by code units instead of locale rules', async () => {
    const fixture = await createFixture();
    await writeEntries(fixture.path, [
      message(null, 'u1', 'user', [{ type: 'text', text: 'parallel' }]),
      assistantMessage(
        'u1',
        'a-anchor',
        'native-locale-group',
        'm',
        {
          type: 'tool_use',
          id: 'tool-anchor',
          name: 'Anchor',
          input: {},
        },
      ),
      assistantMessage(
        'a-anchor',
        'a-upper',
        'native-locale-group',
        'Z',
        {
          type: 'tool_use',
          id: 'tool-upper',
          name: 'Upper',
          input: {},
        },
      ),
      assistantMessage(
        'a-upper',
        'a-lower',
        'native-locale-group',
        'a',
        {
          type: 'tool_use',
          id: 'tool-lower',
          name: 'Lower',
          input: {},
        },
      ),
      toolResultMessage(
        'a-anchor',
        'r-anchor',
        'n',
        {
          type: 'tool_result',
          tool_use_id: 'tool-anchor',
          content: 'anchor',
        },
      ),
      toolResultMessage(
        'a-upper',
        'r-upper',
        'Z',
        {
          type: 'tool_result',
          tool_use_id: 'tool-upper',
          content: 'upper',
        },
      ),
      toolResultMessage(
        'a-lower',
        'r-lower',
        'a',
        {
          type: 'tool_result',
          tool_use_id: 'tool-lower',
          content: 'lower',
        },
      ),
      message('r-anchor', 'a-final', 'assistant', [
        { type: 'text', text: 'done' },
      ]),
      turnDuration('a-final', 'duration-locale'),
    ]);

    const page = await read(fixture, { turns: 1 });
    expect(
      page.turns[0]?.blocks
        .filter((block) => block.kind === 'tool')
        .map((block) => block.name),
    ).toEqual(['Anchor', 'Upper', 'Lower']);
  });

  it('recovers tool results from the legacy progress-fork shape', async () => {
    const fixture = await createFixture();
    await writeEntries(fixture.path, [
      message(null, 'u1', 'user', [{ type: 'text', text: 'legacy prompt' }]),
      assistantMessage(
        'u1',
        'a-one',
        'native-message-legacy',
        '2026-08-16T00:00:01.000Z',
        {
          type: 'tool_use',
          id: 'tool-one-private',
          name: 'First',
          input: { order: 1 },
        },
      ),
      assistantMessage(
        'a-one',
        'a-two',
        'native-message-legacy',
        '2026-08-16T00:00:02.000Z',
        {
          type: 'tool_use',
          id: 'tool-two-private',
          name: 'Second',
          input: { order: 2 },
        },
      ),
      progressMessage('a-one', 'progress-one', '2026-08-16T00:00:03.000Z'),
      progressMessage('a-two', 'progress-two', '2026-08-16T00:00:04.000Z'),
      toolResultMessage(
        'a-one',
        'result-one',
        '2026-08-16T00:00:05.000Z',
        {
          type: 'tool_result',
          tool_use_id: 'tool-one-private',
          content: 'first result',
          is_error: false,
        },
      ),
      toolResultMessage(
        'a-two',
        'result-two',
        '2026-08-16T00:00:06.000Z',
        {
          type: 'tool_result',
          tool_use_id: 'tool-two-private',
          content: 'second result',
          is_error: false,
        },
      ),
      {
        ...message('progress-one', 'a-final', 'assistant', [
          { type: 'text', text: 'legacy done' },
        ]),
        timestamp: '2026-08-16T00:00:07.000Z',
      },
      turnDuration(
        'a-final',
        'duration-legacy',
        '2026-08-16T00:00:08.000Z',
      ),
    ]);

    const page = await read(fixture, { turns: 1, includeTools: true });
    expect(
      page.turns[0]?.blocks.filter((block) => block.kind === 'tool'),
    ).toEqual([
      expect.objectContaining({
        name: 'First',
        output: 'first result',
      }),
      expect.objectContaining({
        name: 'Second',
        output: 'second result',
      }),
    ]);
    const publicPage = JSON.stringify(page);
    expect(publicPage).not.toContain('native-message-legacy');
    expect(publicPage).not.toContain('progress-one');
    expect(publicPage).not.toContain('progress-two');
  });

  it('selects the main leaf across parallel branches and excludes sidechain/meta records', async () => {
    const fixture = await createFixture();
    await writeEntries(fixture.path, [
      message(null, 'u1', 'user', [{ type: 'text', text: 'root prompt' }]),
      message('u1', 'a-main', 'assistant', [
        { type: 'text', text: 'main answer' },
      ]),
      {
        ...message('u1', 'a-side', 'assistant', [
          { type: 'text', text: 'side answer' },
        ]),
        isSidechain: true,
      },
      {
        ...message('a-main', 'meta', 'assistant', [
          { type: 'text', text: 'meta answer' },
        ]),
        isMeta: true,
      },
      turnDuration('a-main', 'duration-one'),
      message('duration-one', 'u2', 'user', [
        { type: 'text', text: 'second' },
      ]),
      message('u2', 'a2', 'assistant', [
        { type: 'text', text: 'selected leaf' },
      ]),
      turnDuration('a2', 'duration-two'),
    ]);

    const page = await read(fixture, { turns: 2 });
    expect(publicText(page)).toContain('main answer');
    expect(publicText(page)).toContain('selected leaf');
    expect(publicText(page)).not.toContain('side answer');
    expect(publicText(page)).not.toContain('meta answer');
  });

  it('applies snip and compact rewrite facts to the selected parent chain', async () => {
    const fixture = await createFixture();
    await writeEntries(fixture.path, [
      message(null, 'u1', 'user', [{ type: 'text', text: 'kept prompt' }]),
      message('u1', 'a1', 'assistant', [
        { type: 'text', text: 'removed answer' },
      ]),
      message('a1', 'u2', 'user', [{ type: 'text', text: 'removed prompt' }]),
      {
        parentUuid: 'u2',
        uuid: 'compact',
        type: 'system',
        subtype: 'compact_boundary',
        logicalParentUuid: 'u1',
        isSidechain: false,
        isMeta: false,
        sessionId: SESSION_ID,
        timestamp: '2026-08-16T00:00:01.000Z',
      },
      {
        parentUuid: 'compact',
        uuid: 'snip',
        type: 'system',
        subtype: 'snip',
        snipMetadata: { removedUuids: ['a1', 'u2'] },
        isSidechain: false,
        isMeta: false,
        sessionId: SESSION_ID,
        timestamp: '2026-08-16T00:00:02.000Z',
      },
      message('snip', 'u3', 'user', [{ type: 'text', text: 'new prompt' }]),
      message('u3', 'a3', 'assistant', [
        { type: 'text', text: 'new answer' },
      ]),
      turnDuration('a3', 'duration-three'),
    ]);

    const page = await read(fixture, { turns: 3 });
    expect(publicText(page)).toContain('new answer');
    expect(publicText(page)).not.toContain('removed answer');
    expect(publicText(page)).not.toContain('removed prompt');
  });

  it('supports append-stable pagination and rejects query, digest, position, and rewrite mismatches', async () => {
    const fixture = await createFixture();
    await writeEntries(fixture.path, conversationTurns(2));
    const first = await read(fixture, { turns: 1, includeTools: true });
    expect(first.nextCursor).not.toBeNull();
    const position = decodeCursor(first.nextCursor!).pos;
    expect(Object.keys(decodeCursorEnvelope(first.nextCursor!)).sort()).toEqual(
      ['bd', 'fp', 'gen', 'p', 'pos', 'rd', 'rp', 'rw', 'v'],
    );
    expect(publicText(decodeCursorEnvelope(first.nextCursor!))).not.toContain(
      SESSION_ID,
    );
    expect(publicText(decodeCursorEnvelope(first.nextCursor!))).not.toContain(
      'prompt',
    );

    await appendEntries(
      fixture.path,
      conversationTurn('u3', 'a3', 'third prompt', 'third answer', 'a2'),
    );
    const older = await read(fixture, {
      turns: 1,
      includeTools: true,
      cursor: first.nextCursor!,
    });
    expect(publicText(older)).toContain('first answer');
    await expect(
      read(fixture, {
        turns: 1,
        includeTools: false,
        cursor: first.nextCursor!,
      }),
    ).rejects.toMatchObject({ reason: 'cursor_query_mismatch' });
    await expect(
      read(fixture, {
        turns: 1,
        cursor: mutateCursor(first.nextCursor!, { bd: 'A'.repeat(43) }),
      }),
    ).rejects.toMatchObject({ reason: 'cursor_stale' });
    await expect(
      read(fixture, {
        turns: 1,
        cursor: mutateCursor(first.nextCursor!, { pos: position + 1 }),
      }),
    ).rejects.toMatchObject({ reason: 'cursor_stale' });
    await expect(
      read(fixture, {
        turns: 1,
        cursor: mutateCursor(first.nextCursor!, { rw: 0 }),
      }),
    ).rejects.toMatchObject({ reason: 'cursor_stale' });

    await appendEntries(fixture.path, [
      {
        parentUuid: 'a3',
        uuid: 'summary',
        type: 'summary',
        summary: 'native rewrite',
        sessionId: SESSION_ID,
      },
    ]);
    await expect(
      read(fixture, { turns: 1, cursor: first.nextCursor! }),
    ).rejects.toMatchObject({ reason: 'cursor_stale' });
  });

  it.each([0, -1, 1.5, 51])(
    'rejects direct provider turns query %s with a typed invalid reason',
    async (turns) => {
      const fixture = await createFixture();
      await writeEntries(fixture.path, conversationTurns(1));
      await expect(
        readClaudeTranscript(
          { turns },
          transcriptContext(fixture),
        ),
      ).rejects.toMatchObject({ reason: 'invalid' });
    },
  );

  it('fills session evidence, transcript windows, and cursor checks across short reads', async () => {
    const fixture = await createFixture();
    await writeEntries(fixture.path, conversationTurns(2));
    const first = await readClaudeTranscript(
      { turns: 1 },
      transcriptContext(fixture),
      { maxReadChunkBytes: 7 },
    );
    expect(publicText(first)).toContain('second answer');
    expect(first.nextCursor).not.toBeNull();

    const older = await readClaudeTranscript(
      { turns: 1, cursor: first.nextCursor! },
      transcriptContext(fixture),
      { maxReadChunkBytes: 5 },
    );
    expect(publicText(older)).toContain('first answer');
  });

  it('stales a cursor when an appended rewrite record is completed in two writes', async () => {
    const fixture = await createFixture();
    await writeEntries(fixture.path, conversationTurns(2));
    const first = await read(fixture, { turns: 1 });
    const rewrite = JSON.stringify({
      parentUuid: 'd2',
      uuid: 'split-summary',
      type: 'summary',
      summary: 'native rewrite',
      sessionId: SESSION_ID,
    });
    const split = Math.floor(rewrite.length / 2);
    await appendFile(fixture.path, rewrite.slice(0, split));

    const beforeCompletion = await read(fixture, {
      turns: 1,
      cursor: first.nextCursor!,
    });
    expect(publicText(beforeCompletion)).toContain('first answer');

    await appendFile(fixture.path, `${rewrite.slice(split)}\n`);
    await expect(
      read(fixture, { turns: 1, cursor: first.nextCursor! }),
    ).rejects.toMatchObject({ reason: 'cursor_stale' });
  });

  it('returns null cursor for an open tail and observes completion on a later fresh query', async () => {
    const fixture = await createFixture();
    await writeEntries(fixture.path, [
      message(null, 'u1', 'user', [{ type: 'text', text: 'open prompt' }]),
    ]);
    const open = await read(fixture, { turns: 1 });
    expect(open).toMatchObject({ turns: [], nextCursor: null });

    await appendEntries(fixture.path, [
      message('u1', 'a1', 'assistant', [
        { type: 'text', text: 'now complete' },
      ]),
      turnDuration('a1', 'duration-open'),
    ]);
    const complete = await read(fixture, { turns: 1 });
    expect(publicText(complete)).toContain('now complete');
  });

  it('returns a null cursor for an oversized open tool chain', async () => {
    const fixture = await createFixture();
    const filler = Array.from({ length: 850 }, (_, index) => ({
      parentUuid: index === 0 ? 'a-tool' : `open-${index - 1}`,
      uuid: `open-${index}`,
      type: 'system',
      subtype: 'status',
      detail: 'x'.repeat(10_000),
      sessionId: SESSION_ID,
    }));
    await writeEntries(fixture.path, [
      message(null, 'u1', 'user', [{ type: 'text', text: 'open tool prompt' }]),
      assistantMessage(
        'u1',
        'a-tool',
        'native-open-tool-message',
        '2026-08-16T00:00:01.000Z',
        {
          type: 'tool_use',
          id: 'open-tool-private',
          name: 'Read',
          input: { path: 'README.md' },
        },
      ),
      ...filler,
    ]);

    await expect(read(fixture, { turns: 1 })).resolves.toMatchObject({
      turns: [],
      nextCursor: null,
    });
  });

  it('omits an active tool chain until the native completion checkpoint arrives', async () => {
    const fixture = await createFixture();
    await writeEntries(fixture.path, [
      message(null, 'u1', 'user', [{ type: 'text', text: 'tool prompt' }]),
      assistantMessage(
        'u1',
        'a-tool',
        'native-tool-message',
        '2026-08-16T00:00:01.000Z',
        {
          type: 'tool_use',
          id: 'tool-private',
          name: 'Read',
          input: { path: 'README.md' },
        },
      ),
      toolResultMessage(
        'a-tool',
        'r-tool',
        '2026-08-16T00:00:02.000Z',
        {
          type: 'tool_result',
          tool_use_id: 'tool-private',
          content: 'contents',
          is_error: false,
        },
      ),
    ]);
    await expect(read(fixture, { turns: 1 })).resolves.toMatchObject({
      turns: [],
      nextCursor: null,
    });

    await appendEntries(fixture.path, [
      {
        ...message('r-tool', 'a-final', 'assistant', [
          { type: 'text', text: 'terminal answer' },
        ]),
        message: {
          id: 'native-final-message',
          role: 'assistant',
          stop_reason: 'end_turn',
          content: [{ type: 'text', text: 'terminal answer' }],
        },
      },
      turnDuration('a-final', 'duration-tool'),
    ]);
    const complete = await read(fixture, { turns: 1 });
    expect(publicText(complete)).toContain('terminal answer');
    expect(publicText(complete)).toContain('contents');
  });

  it('returns strictly older scan-bound continuation and reaches the older page', async () => {
    const fixture = await createFixture();
    const filler = Array.from({ length: 20_100 }, (_, index) => ({
      parentUuid: null,
      uuid: `control-${index}`,
      type: 'system',
      subtype: 'status',
      sessionId: SESSION_ID,
    }));
    await writeEntries(fixture.path, [
      ...conversationTurn('u1', 'a1', 'old prompt', 'old answer', null),
      ...filler,
      ...conversationTurn('u2', 'a2', 'new prompt', 'new answer', null),
    ]);
    const first = await read(fixture, { turns: 2 });
    expect(publicText(first)).toContain('new answer');
    expect(first.nextCursor).not.toBeNull();
    const firstPosition = decodeCursor(first.nextCursor!).pos;

    const second = await read(fixture, {
      turns: 2,
      cursor: first.nextCursor!,
    });
    expect(second.nextCursor).not.toBeNull();
    expect(decodeCursor(second.nextCursor!).pos).toBeLessThan(firstPosition);
    const third = await read(fixture, {
      turns: 2,
      cursor: second.nextCursor!,
    });
    expect(publicText(third)).toContain('old answer');
  });

  it('returns scan_unsupported for a completed turn larger than one scan window', async () => {
    const fixture = await createFixture();
    const filler = Array.from({ length: 850 }, (_, index) => ({
      parentUuid: `f-${index - 1}`,
      uuid: `f-${index}`,
      type: 'system',
      subtype: 'status',
      detail: 'x'.repeat(10_000),
      sessionId: SESSION_ID,
    }));
    await writeEntries(fixture.path, [
      message(null, 'u1', 'user', [{ type: 'text', text: 'large prompt' }]),
      ...filler,
      message('f-849', 'a1', 'assistant', [
        { type: 'text', text: 'large answer' },
      ]),
      turnDuration('a1', 'duration-large'),
    ]);
    await expect(read(fixture, { turns: 1 })).rejects.toMatchObject({
      reason: 'scan_unsupported',
    });
  });

  it('verifies a cursor boundary record larger than 64 KiB', async () => {
    const fixture = await createFixture();
    await writeEntries(fixture.path, [
      ...conversationTurn('u1', 'a1', 'old prompt', 'old answer', null),
      ...conversationTurn(
        'u2',
        'a2',
        'x'.repeat(70_000),
        'new answer',
        'd1',
      ),
    ]);
    const first = await read(fixture, { turns: 1 });
    expect(first.nextCursor).not.toBeNull();

    const older = await read(fixture, {
      turns: 1,
      cursor: first.nextCursor!,
    });
    expect(publicText(older)).toContain('old answer');
  });

  it('rediscovers a moved session for resume/reopen from the deterministic path', async () => {
    const fixture = await createFixture();
    await writeEntries(fixture.path, conversationTurns(1));
    const moved = join(
      fixture.root,
      '.claude',
      'projects',
      'moved-project',
      `${SESSION_ID}.jsonl`,
    );
    await mkdir(dirname(moved), { recursive: true });
    await writeFile(moved, await readFile(fixture.path));
    await unlink(fixture.path);
    const canonicalMoved = await realpath(moved);

    await expect(
      locateClaudeTranscript({
        sessionId: SESSION_ID,
        cwd: fixture.cwd,
        locator: fixture.path,
        env: { HOME: fixture.root, CLAUDE_CONFIG_DIR: join(fixture.root, '.claude') },
      }),
    ).resolves.toMatchObject({ path: canonicalMoved });
  });

  it('matches native Bun/Zig path hashing for long cwd values', async () => {
    expect(claudeNativePathHash('')).toBe('27k1wwwhf13t');
    expect(claudeNativePathHash('abc')).toBe('1g45uqqks6lu');
    const root = await mkdtemp(join(tmpdir(), 'dreamux-claude-long-path-'));
    roots.push(root);
    const cwd =
      '/native/' +
      Array.from(
        { length: 8 },
        (_, index) => `segment-${index}-abcdefghijklmnopqrstuvwx`,
      ).join('/');
    const path = await deriveClaudeTranscriptPath(SESSION_ID, cwd, {
      HOME: root,
      CLAUDE_CONFIG_DIR: join(root, '.claude'),
    });
    const canonical = cwd.normalize('NFC');
    const prefix = canonical.replace(/[^a-zA-Z0-9]/g, '-').slice(0, 200);
    expect(dirname(path).split(/[/\\]/).at(-1)).toBe(
      `${prefix}-2kw2d6c10a4h9`,
    );
  });

  it('resolves a relative config home against the runtime cwd', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dreamux-claude-relative-home-'));
    roots.push(root);
    const runtimeCwd = join(root, 'runtime');
    await mkdir(runtimeCwd, { recursive: true });
    const path = await deriveClaudeTranscriptPath(SESSION_ID, runtimeCwd, {
      HOME: root,
      CLAUDE_CONFIG_DIR: 'relative-config',
    });
    const canonicalRuntimeCwd = await realpath(runtimeCwd);
    expect(
      path.startsWith(
        join(canonicalRuntimeCwd, 'relative-config', 'projects'),
      ),
    )
      .toBe(true);
  });

  it('classifies an unreadable runtime cwd without falling back lexically', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dreamux-claude-unreadable-cwd-'));
    roots.push(root);
    const runtimeCwd = join(root, 'not-a-directory', 'child');
    await writeFile(join(root, 'not-a-directory'), 'file');

    await expect(
      deriveClaudeTranscriptPath(SESSION_ID, runtimeCwd, {
        HOME: root,
        CLAUDE_CONFIG_DIR: join(root, '.claude'),
      }),
    ).rejects.toMatchObject({ reason: 'unreadable' });
  });

  it('rejects a prospective project-directory symlink escape', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dreamux-claude-prospective-'));
    roots.push(root);
    const runtimeCwd = join(root, 'runtime');
    const config = join(root, '.claude');
    const outside = join(root, 'outside');
    await Promise.all([
      mkdir(runtimeCwd, { recursive: true }),
      mkdir(join(config, 'projects'), { recursive: true }),
      mkdir(outside, { recursive: true }),
    ]);
    const ordinary = await deriveClaudeTranscriptPath(
      SESSION_ID,
      runtimeCwd,
      { HOME: root, CLAUDE_CONFIG_DIR: config },
    );
    await symlink(outside, dirname(ordinary));
    await expect(
      deriveClaudeTranscriptPath(SESSION_ID, runtimeCwd, {
        HOME: root,
        CLAUDE_CONFIG_DIR: config,
      }),
    ).rejects.toMatchObject({ reason: 'locator_outside_root' });
  });

  it('discovers long-path prefixes, sibling worktrees, then cross-project fallback', async () => {
    const fixture = await createFixture();
    const longCwd =
      fixture.cwd +
      '/' +
      Array.from({ length: 8 }, (_, index) => `long-${index}-abcdefghijk`).join('/');
    const sanitized = longCwd.replace(/[^a-zA-Z0-9]/g, '-');
    const legacyProject = join(
      fixture.root,
      '.claude',
      'projects',
      `${sanitized.slice(0, 200)}-legacyhash`,
    );
    const longPath = join(legacyProject, `${SESSION_ID}.jsonl`);
    await mkdir(legacyProject, { recursive: true });
    await writeEntries(longPath, conversationTurns(1));
    const canonicalLongPath = await realpath(longPath);
    await expect(
      locateClaudeTranscript({
        sessionId: SESSION_ID,
        cwd: longCwd,
        env: {
          HOME: fixture.root,
          CLAUDE_CONFIG_DIR: join(fixture.root, '.claude'),
        },
        worktreePaths: [],
      }),
    ).resolves.toMatchObject({ path: canonicalLongPath });

    await unlink(longPath);
    const sibling = join(fixture.root, 'sibling-worktree');
    await mkdir(sibling, { recursive: true });
    const siblingPath = await deriveClaudeTranscriptPath(
      SESSION_ID,
      sibling,
      {
        HOME: fixture.root,
        CLAUDE_CONFIG_DIR: join(fixture.root, '.claude'),
      },
    );
    await mkdir(dirname(siblingPath), { recursive: true });
    await writeEntries(siblingPath, conversationTurns(1));
    const canonicalSiblingPath = await realpath(siblingPath);
    await expect(
      locateClaudeTranscript({
        sessionId: SESSION_ID,
        cwd: fixture.cwd,
        env: {
          HOME: fixture.root,
          CLAUDE_CONFIG_DIR: join(fixture.root, '.claude'),
        },
        worktreePaths: [fixture.cwd, sibling],
      }),
    ).resolves.toMatchObject({ path: canonicalSiblingPath });

    await unlink(siblingPath);
    const crossProject = join(
      fixture.root,
      '.claude',
      'projects',
      'unrelated-project',
      `${SESSION_ID}.jsonl`,
    );
    await mkdir(dirname(crossProject), { recursive: true });
    await writeEntries(crossProject, conversationTurns(1));
    const canonicalCrossProject = await realpath(crossProject);
    await expect(
      locateClaudeTranscript({
        sessionId: SESSION_ID,
        cwd: fixture.cwd,
        env: {
          HOME: fixture.root,
          CLAUDE_CONFIG_DIR: join(fixture.root, '.claude'),
        },
        worktreePaths: [],
      }),
    ).resolves.toMatchObject({ path: canonicalCrossProject });
  });

  it('bounds all-project discovery and oversized metadata records', async () => {
    const fixture = await createFixture();
    for (const name of ['one', 'two']) {
      await mkdir(
        join(fixture.root, '.claude', 'projects', name),
        { recursive: true },
      );
    }
    await expect(
      locateClaudeTranscript({
        sessionId: SESSION_ID,
        cwd: fixture.cwd,
        env: {
          HOME: fixture.root,
          CLAUDE_CONFIG_DIR: join(fixture.root, '.claude'),
        },
        budget: createClaudeTranscriptBudget({ maxEntries: 1 }),
        worktreePaths: [],
      }),
    ).rejects.toMatchObject({ reason: 'scan_unsupported' });

    await writeFile(fixture.path, 'x'.repeat(1_048_577));
    await expect(read(fixture, { turns: 1 })).rejects.toMatchObject({
      reason: 'invalid',
    });
  });

  it('requires session metadata and rejects a post-validation symlink swap', async () => {
    const fixture = await createFixture();
    const missingSession = message(
      null,
      'private-user',
      'user',
      [{ type: 'text', text: 'private content' }],
    );
    delete (missingSession as { sessionId?: string }).sessionId;
    await writeEntries(fixture.path, [missingSession]);
    await expect(read(fixture, { turns: 1 })).rejects.toMatchObject({
      reason: 'invalid',
    });

    await writeEntries(fixture.path, conversationTurns(1));
    const original = `${fixture.path}.original`;
    const outside = join(fixture.root, 'outside-race.jsonl');
    await writeEntries(outside, conversationTurns(1));
    await expect(
      readClaudeTranscript(
        { turns: 1 },
        transcriptContext(fixture),
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

  it('keeps a cursor stable when ordinary append moves old rewrite evidence out of the newest window', async () => {
    const fixture = await createFixture();
    await writeEntries(fixture.path, [
      {
        type: 'summary',
        uuid: 'rewrite-old',
        parentUuid: null,
        sessionId: SESSION_ID,
        timestamp: '2026-08-16T00:00:00.000Z',
      },
      ...Array.from({ length: 980 }, (_, index) => ({
        type: 'system',
        subtype: 'status',
        uuid: `initial-control-${index}`,
        parentUuid: null,
        sessionId: SESSION_ID,
        detail: 'x'.repeat(8_000),
      })),
      ...conversationTurns(2),
    ]);
    const first = await read(fixture, { turns: 1 });
    const filler = {
      type: 'system',
      subtype: 'status',
      sessionId: SESSION_ID,
      detail: 'x'.repeat(8_000),
    };
    await appendEntries(
      fixture.path,
      Array.from({ length: 50 }, () => filler),
    );
    const older = await read(fixture, {
      turns: 1,
      cursor: first.nextCursor!,
    });
    expect(publicText(older)).toContain('first answer');
  });

  it('returns scan_unsupported when the appended rewrite interval exceeds the bound', async () => {
    const fixture = await createFixture();
    await writeEntries(fixture.path, conversationTurns(2));
    const first = await read(fixture, { turns: 1 });
    const filler = {
      type: 'system',
      subtype: 'status',
      sessionId: SESSION_ID,
      detail: 'x'.repeat(8_000),
    };
    await appendEntries(
      fixture.path,
      Array.from({ length: 1_050 }, () => filler),
    );
    await expect(
      read(fixture, { turns: 1, cursor: first.nextCursor! }),
    ).rejects.toMatchObject({ reason: 'scan_unsupported' });
  });

  it.each([
    ['missing', async (fixture: Fixture) => {
      return fixture;
    }, 'not_found'],
    ['corrupt', async (fixture: Fixture) => {
      await writeFile(fixture.path, '{"broken":}\n');
      return fixture;
    }, 'invalid'],
  ])('returns typed errors for %s transcript input', async (
    _label,
    arrange,
    reason,
  ) => {
    const fixture = await createFixture();
    await arrange(fixture);
    await expect(read(fixture, { turns: 1 })).rejects.toMatchObject({ reason });
  });

  it('rejects locator escape and native session mismatch', async () => {
    const fixture = await createFixture();
    await writeEntries(fixture.path, conversationTurns(1));
    const outside = join(fixture.root, `${SESSION_ID}.jsonl`);
    await writeFile(outside, await readFile(fixture.path));
    const escaped = join(dirname(fixture.path), `${SESSION_ID}.jsonl`);
    await unlink(fixture.path);
    await symlink(outside, escaped);
    await expect(
      validateClaudeTranscriptPath(
        escaped,
        SESSION_ID,
        claudeTranscriptRoots({
          HOME: fixture.root,
          CLAUDE_CONFIG_DIR: join(fixture.root, '.claude'),
        }),
      ),
    ).rejects.toMatchObject({ reason: 'locator_outside_root' });

    await unlink(escaped);
    await writeEntries(fixture.path, [
      {
        ...message(null, 'u1', 'user', [
          { type: 'text', text: 'private prompt' },
        ]),
        sessionId: '22222222-2222-4222-8222-222222222222',
      },
    ]);
    await expect(read(fixture, { turns: 1 })).rejects.toMatchObject({
      reason: 'session_mismatch',
    });
  });

  it('rejects malformed cursors and strips provider-private content', async () => {
    const fixture = await createFixture();
    await writeEntries(fixture.path, conversationTurns(1));
    await expect(
      read(fixture, { turns: 1, cursor: 'not-a-cursor' }),
    ).rejects.toMatchObject({ reason: 'cursor_invalid' });
    const page = await read(fixture, { turns: 1 });
    expect(publicText(page)).not.toContain(SESSION_ID);
    expect(publicText(page)).not.toContain(fixture.path);
  });

  it('derives a fresh pinned path without creating a placeholder', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dreamux-claude-path-'));
    roots.push(root);
    const cwd = join(root, 'workspace');
    await mkdir(cwd, { recursive: true });
    const path = await deriveClaudeTranscriptPath(SESSION_ID, cwd, {
      HOME: root,
      CLAUDE_CONFIG_DIR: join(root, '.claude'),
    });
    await expect(stat(path)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(
      claudeCodeResidentArgs({
        config: defaultDispatcherClaudeCodeConfig(),
        mcpConfigJson: '{}',
        freshSessionId: SESSION_ID,
      }),
    ).toContain('--session-id');
  });

  async function createFixture(): Promise<Fixture> {
    const root = await mkdtemp(join(tmpdir(), 'dreamux-claude-transcript-'));
    roots.push(root);
    const cwd = join(root, 'workspace');
    await mkdir(cwd, { recursive: true });
    const path = await deriveClaudeTranscriptPath(SESSION_ID, cwd, {
      HOME: root,
      CLAUDE_CONFIG_DIR: join(root, '.claude'),
    });
    await mkdir(dirname(path), { recursive: true });
    return { root, cwd, path };
  }

  function read(
    fixture: Fixture,
    query: { turns: number; includeTools?: boolean; cursor?: string },
  ) {
    return readClaudeTranscript(query, transcriptContext(fixture));
  }

  function transcriptContext(fixture: Fixture) {
    return {
      checkpoint: { id: SESSION_ID, transcript_locator: fixture.path },
      config: defaultDispatcherClaudeCodeConfig(),
      cwd: fixture.cwd,
      injectEnv: { CLAUDE_CONFIG_DIR: join(fixture.root, '.claude') },
      outputBudgetBytes: 262_144 as const,
    };
  }
});

async function writeEntries(
  path: string,
  entries: readonly Record<string, unknown>[],
): Promise<void> {
  await writeFile(path, `${entries.map(JSON.stringify).join('\n')}\n`);
}

async function appendEntries(
  path: string,
  entries: readonly Record<string, unknown>[],
): Promise<void> {
  await appendFile(path, `${entries.map(JSON.stringify).join('\n')}\n`);
}

function conversationTurns(count: number): Record<string, unknown>[] {
  const entries: Record<string, unknown>[] = [];
  let parent: string | null = null;
  for (let index = 1; index <= count; index += 1) {
    entries.push(
      ...conversationTurn(
        `u${index}`,
        `a${index}`,
        `${ordinal(index)} prompt`,
        `${ordinal(index)} answer`,
        parent,
      ),
    );
    parent = `d${index}`;
  }
  return entries;
}

function conversationTurn(
  userId: string,
  assistantId: string,
  prompt: string,
  answer: string,
  parent: string | null,
): Record<string, unknown>[] {
  return [
    message(parent, userId, 'user', [{ type: 'text', text: prompt }]),
    {
      ...message(userId, assistantId, 'assistant', [
        { type: 'text', text: answer },
      ]),
      message: {
        id: `native-${assistantId}`,
        role: 'assistant',
        stop_reason: 'end_turn',
        content: [{ type: 'text', text: answer }],
      },
    },
    turnDuration(assistantId, assistantId.replace(/^a/, 'd')),
  ];
}

function ordinal(value: number): string {
  return ['zero', 'first', 'second', 'third'][value] ?? String(value);
}

function publicText(value: unknown): string {
  return JSON.stringify(value);
}

function decodeCursor(cursor: string): { pos: number } {
  return decodeCursorEnvelope(cursor) as {
    pos: number;
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

function message(
  parentUuid: string | null,
  uuid: string,
  type: 'user' | 'assistant',
  content: unknown[],
) {
  return {
    parentUuid,
    isSidechain: false,
    type,
    message: { role: type, content },
    uuid,
    timestamp: '2026-08-16T00:00:00.000Z',
    cwd: '/workspace',
    sessionId: SESSION_ID,
  };
}

function assistantMessage(
  parentUuid: string | null,
  uuid: string,
  messageId: string,
  timestamp: string,
  content: Record<string, unknown>,
) {
  return {
    ...message(parentUuid, uuid, 'assistant', [content]),
    timestamp,
    message: {
      id: messageId,
      role: 'assistant',
      stop_reason: 'tool_use',
      content: [content],
    },
  };
}

function toolResultMessage(
  parentUuid: string,
  uuid: string,
  timestamp: string,
  content: Record<string, unknown>,
) {
  return {
    ...message(parentUuid, uuid, 'user', [content]),
    timestamp,
  };
}

function progressMessage(
  parentUuid: string,
  uuid: string,
  timestamp: string,
) {
  return {
    parentUuid,
    uuid,
    type: 'progress',
    timestamp,
    sessionId: SESSION_ID,
  };
}

function turnDuration(
  parentUuid: string,
  uuid: string,
  timestamp = '2026-08-16T00:00:01.000Z',
) {
  return {
    parentUuid,
    uuid,
    type: 'system',
    subtype: 'turn_duration',
    durationMs: 1,
    timestamp,
    sessionId: SESSION_ID,
    isSidechain: false,
    isMeta: false,
  };
}
