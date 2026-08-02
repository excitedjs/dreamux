/**
 * Smoke coverage for the consolidated @excitedjs/dreamux-utils helpers
 * (issue #209). These four modules were previously vendored byte-identically
 * into the codex / claude-code / feishu-channel packages and the host core; the
 * extraction is behavior-preserving, so these tests lock in the shapes the
 * consumers rely on (config-validation messages, owner-only dir enforcement,
 * the inline/spill completion decision, and the `<channel>` render envelope).
 */
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { InboundTurnInput } from '@excitedjs/dreamux-types';

import {
  COMPLETION_INLINE_BUDGET_DEFAULT,
  COMPLETION_INLINE_BUDGET_MAX,
  completionInlineBudget,
  ensureOwnerOnlyDir,
  isProcessAlive,
  isPlainObject,
  pathExists,
  rejectUnknownKeys,
  removeEmptyLogFile,
  renderChannelBlock,
  renderChannelInput,
  requireNonEmptyString,
  resolveCompletionBody,
  SupervisedChild,
  teamMateCompletionOutputPath,
  type CompletionBodyInput,
} from '../src/index.js';

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'dreamux-utils-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('config-validate', () => {
  it('isPlainObject distinguishes objects from arrays/null', () => {
    expect(isPlainObject({})).toBe(true);
    expect(isPlainObject([])).toBe(false);
    expect(isPlainObject(null)).toBe(false);
  });

  it('requireNonEmptyString fails loud with a config-error message', () => {
    expect(requireNonEmptyString({ k: 'v' }, 'k', 'cfg.json')).toBe('v');
    expect(() => requireNonEmptyString({ k: '' }, 'k', 'cfg.json')).toThrow(
      /dreamux config error in cfg\.json: k must be a non-empty string/,
    );
  });

  it('rejectUnknownKeys throws on an unexpected key', () => {
    expect(() =>
      rejectUnknownKeys({ extra: 1 }, new Set(['known']), 'cfg.json', 'root.'),
    ).toThrow(/root\.extra is not supported/);
  });
});

describe('os', () => {
  it('ensureOwnerOnlyDir creates a 0700 directory', async () => {
    const dir = join(root, 'owned');
    await ensureOwnerOnlyDir(dir);
    const info = await stat(dir);
    expect(info.isDirectory()).toBe(true);
    expect(info.mode & 0o077).toBe(0);
  });

  it('ensureOwnerOnlyDir rejects a foreign-uid directory', async () => {
    const dir = join(root, 'foreign');
    await expect(
      ensureOwnerOnlyDir(dir, { getuid: () => -424242 }),
    ).rejects.toThrow(/owned by uid/);
  });

  it('removeEmptyLogFile drops an empty file but keeps a non-empty one', async () => {
    const empty = join(root, 'empty.log');
    const full = join(root, 'full.log');
    await writeFile(empty, '');
    await writeFile(full, 'boom');
    await removeEmptyLogFile(empty);
    await removeEmptyLogFile(full);
    expect(await pathExists(empty)).toBe(false);
    expect(await pathExists(full)).toBe(true);
  });
});

describe('SupervisedChild', () => {
  it('reports a spawned child exit', async () => {
    const child = new SupervisedChild({
      kind: 'spawn',
      command: process.execPath,
      args: ['-e', 'process.exit(7)'],
      options: { stdio: 'ignore' },
    });
    const exited = new Promise<{ code: number | null }>((resolve) => {
      child.onExit(resolve);
    });

    await child.start();

    await expect(exited).resolves.toMatchObject({ code: 7 });
    await child.stop();
  });

  it('supports fork IPC and idempotent group stop', async () => {
    const modulePath = join(root, 'fork-child.mjs');
    await writeFile(
      modulePath,
      "process.on('message', value => process.send?.({ echo: value }));\n",
    );
    const supervised = new SupervisedChild({
      kind: 'fork',
      modulePath,
      options: { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] },
    });
    const child = await supervised.start();
    const reply = new Promise<unknown>((resolve) => child.once('message', resolve));

    child.send({ ping: true });

    await expect(reply).resolves.toEqual({ echo: { ping: true } });
    await Promise.all([supervised.stop(), supervised.stop()]);
  });

  it('does not let a child escape when stop races start', async () => {
    const supervised = new SupervisedChild({
      kind: 'spawn',
      command: process.execPath,
      args: ['-e', 'setInterval(() => {}, 1000)'],
      options: { stdio: 'ignore' },
    }, { stopTimeoutMs: 100 });

    const starting = supervised.start();
    const pid = supervised.pid;
    await supervised.stop();

    await expect(starting).rejects.toThrow(/stopped during start/);
    expect(pid).not.toBeNull();
    await vi.waitFor(() => expect(isProcessAlive(pid!)).toBe(false));
  });
});

describe('completion-body', () => {
  it('completionInlineBudget clamps and falls back to the default', () => {
    expect(completionInlineBudget({})).toBe(COMPLETION_INLINE_BUDGET_DEFAULT);
    expect(completionInlineBudget({ TASK_MAX_OUTPUT_LENGTH: '9999999' })).toBe(
      COMPLETION_INLINE_BUDGET_MAX,
    );
    expect(completionInlineBudget({ TASK_MAX_OUTPUT_LENGTH: '32k' })).toBe(
      COMPLETION_INLINE_BUDGET_DEFAULT,
    );
  });

  it('teamMateCompletionOutputPath sanitizes both segments', () => {
    expect(teamMateCompletionOutputPath('/spill', 'rev/iewer', 'a:b')).toBe(
      join('/spill', 'teammate-rev_iewer-a_b.output'),
    );
  });

  it('resolveCompletionBody inlines a short result and spills an over-budget one', async () => {
    const inline = await resolveCompletionBody(completion('hi'), root);
    expect(inline).toEqual({ kind: 'inline', text: 'hi' });

    const previous = process.env.TASK_MAX_OUTPUT_LENGTH;
    process.env.TASK_MAX_OUTPUT_LENGTH = '4';
    try {
      const big = await resolveCompletionBody(completion('overflowing'), root);
      expect(big.kind).toBe('spilled');
      if (big.kind === 'spilled') {
        expect(await readFile(big.path, 'utf8')).toBe('overflowing');
        expect((await stat(big.path)).mode & 0o077).toBe(0);
      }
    } finally {
      if (previous === undefined) delete process.env.TASK_MAX_OUTPUT_LENGTH;
      else process.env.TASK_MAX_OUTPUT_LENGTH = previous;
    }
  });
});

describe('turn-render', () => {
  it('renderChannelInput passes plain text through unchanged', () => {
    expect(renderChannelInput(plain('just text'))).toBe('just text');
  });

  it('renderChannelInput wraps a channel-structured input', () => {
    const input: InboundTurnInput = {
      text: 'ignored',
      sourceId: 'm1',
      source: 'feishu',
      attrs: [['chat_id', 'oc_x']],
      body: 'hello',
    };
    expect(renderChannelInput(input)).toBe(
      '<channel source="feishu" chat_id="oc_x">\nhello\n</channel>',
    );
  });

  it('renderChannelBlock escapes values and drops unsafe attribute keys', () => {
    expect(
      renderChannelBlock('feishu', [['1bad', 'x'], ['ok', 'a<b&c']], 'body'),
    ).toBe('<channel source="feishu" ok="a&lt;b&amp;c">\nbody\n</channel>');
  });
});

function completion(result: string): CompletionBodyInput {
  return { source: 'reviewer', id: 'reviewer:turn-1', result };
}

function plain(text: string): InboundTurnInput {
  return { text, sourceId: 's1' };
}
