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
import type {
  AgentRuntimeTranscriptTurn,
  InboundTurnInput,
} from '@excitedjs/dreamux-types';

import {
  TRANSCRIPT_TOOL_NAME_MAX_CHARS,
  boundTranscriptTurn,
  budgetTranscriptTurns,
  COMPLETION_INLINE_BUDGET_DEFAULT,
  COMPLETION_INLINE_BUDGET_MAX,
  completionInlineBudget,
  createTranscriptScanBudget,
  ensureOwnerOnlyDir,
  isPathWithin,
  isProcessGroupAlive,
  killProcessGroup,
  isProcessAlive,
  isPlainObject,
  isTranscriptDigest,
  pathExists,
  readTranscriptBytesAt,
  rejectUnknownKeys,
  removeEmptyLogFile,
  renderChannelBlock,
  renderChannelInput,
  requireNonEmptyString,
  resolveCompletionBody,
  SupervisedChild,
  transcriptDigest,
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
  it('treats EPERM process-group probes as alive and signal attempts as failures', () => {
    const error = Object.assign(new Error('not permitted'), { code: 'EPERM' });
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => {
      throw error;
    });
    try {
      expect(isProcessGroupAlive(424242)).toBe(true);
      expect(() => killProcessGroup(424242, 'SIGTERM')).toThrow(error);
    } finally {
      kill.mockRestore();
    }
  });

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

  it('retains process-group authority when SIGKILL absence cannot be proved', async () => {
    const supervised = new SupervisedChild(
      {
        kind: 'spawn',
        command: process.execPath,
        args: ['-e', 'setInterval(() => {}, 1000)'],
        options: { stdio: 'ignore' },
      },
      { stopTimeoutMs: 250, pollIntervalMs: 5 },
    );
    await supervised.start();
    const pid = supervised.pid!;
    const realKill = process.kill.bind(process);
    const kill = vi.spyOn(process, 'kill').mockImplementation((target, signal) => {
      if (target === -pid) return true;
      return realKill(target, signal);
    });
    try {
      await expect(supervised.stop()).rejects.toThrow(/still exists after SIGKILL/);
      expect(supervised.pid).toBe(pid);
      expect(kill).toHaveBeenCalledWith(-pid, 'SIGKILL');
    } finally {
      kill.mockRestore();
      await supervised.stop();
      await vi.waitFor(() => expect(isProcessAlive(pid)).toBe(false));
    }
    expect(supervised.pid).toBeNull();
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

  it('resolveCompletionBody inlines a short result and spills an over-budget one', async () => {
    const inline = await resolveCompletionBody(completion('hi'), root);
    expect(inline).toEqual({ kind: 'inline', text: 'hi' });

    const previous = process.env.TASK_MAX_OUTPUT_LENGTH;
    process.env.TASK_MAX_OUTPUT_LENGTH = '4';
    try {
      const big = await resolveCompletionBody(completion('overflowing'), root);
      expect(big.kind).toBe('spilled');
      if (big.kind === 'spilled') {
        expect(big.path).toMatch(/\/completion-[0-9a-f-]+\.output$/u);
        expect(big.path).not.toContain('reviewer');
        expect(await readFile(big.path, 'utf8')).toBe('overflowing');
        expect((await stat(big.path)).mode & 0o077).toBe(0);

        const second = await resolveCompletionBody(
          completion('another overflow'),
          root,
        );
        expect(second.kind).toBe('spilled');
        if (second.kind === 'spilled') expect(second.path).not.toBe(big.path);
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

describe('transcript primitives', () => {
  it('creates and validates opaque SHA-256 digests', () => {
    const digest = transcriptDigest('boundary bytes');
    expect(digest).toHaveLength(43);
    expect(isTranscriptDigest(digest)).toBe(true);
    expect(isTranscriptDigest('not-a-digest')).toBe(false);
  });

  it('enforces count and elapsed discovery bounds through a caller error', () => {
    let now = 10;
    const budget = createTranscriptScanBudget({
      maxEntries: 2,
      maxElapsedMs: 5,
      now: () => now,
      limitError: () => new Error('bounded'),
    });
    budget.inspect(2);
    expect(() => budget.inspect()).toThrow('bounded');

    const elapsed = createTranscriptScanBudget({
      maxEntries: 10,
      maxElapsedMs: 5,
      now: () => now,
      limitError: () => new Error('elapsed'),
    });
    now = 16;
    expect(() => elapsed.inspect()).toThrow('elapsed');
  });

  it('fills an exact positional window across controlled short reads', async () => {
    const source = Buffer.from('0123456789', 'utf8');
    const reader = {
      async read(
        buffer: Buffer,
        offset: number,
        length: number,
        position: number,
      ) {
        const bytesRead = Math.min(2, length, source.length - position);
        if (bytesRead <= 0) return { bytesRead: 0 };
        source.copy(buffer, offset, position, position + bytesRead);
        return { bytesRead };
      },
    };
    await expect(readTranscriptBytesAt(reader, 3, 6)).resolves.toEqual(
      Buffer.from('345678'),
    );
    await expect(readTranscriptBytesAt(reader, 8, 6)).resolves.toEqual(
      Buffer.from('89'),
    );
  });

  it('checks lexical containment without prefix confusion', () => {
    expect(isPathWithin('/native/root', '/native/root/session.jsonl')).toBe(true);
    expect(isPathWithin('/native/root', '/native/root-other/session.jsonl'))
      .toBe(false);
  });

  it('caps tool names by Unicode code point and marks returned clipping', () => {
    const oversizedName = '🧰'.repeat(TRANSCRIPT_TOOL_NAME_MAX_CHARS + 1);
    const bounded = boundTranscriptTurn(transcriptToolTurn(oversizedName));

    expect(bounded.truncated).toBe(true);
    expect(bounded.turn.blocks[0]).toMatchObject({
      kind: 'tool',
      name: '🧰'.repeat(TRANSCRIPT_TOOL_NAME_MAX_CHARS),
    });
    expect([
      ...(bounded.turn.blocks[0]?.kind === 'tool'
        ? bounded.turn.blocks[0].name
        : ''),
    ]).toHaveLength(TRANSCRIPT_TOOL_NAME_MAX_CHARS);

    const page = budgetTranscriptTurns(
      [transcriptToolTurn(oversizedName)],
      262_144,
    );
    expect(page).toMatchObject({ consumed: 1, truncated: true });
  });

  it('does not inherit truncation from a candidate omitted after returned turns', () => {
    const returned = transcriptMessageTurn('returned');
    const omitted = transcriptToolTurn(
      'x'.repeat(TRANSCRIPT_TOOL_NAME_MAX_CHARS + 1),
    );
    const exactReturnedBudget = Buffer.byteLength(
      JSON.stringify([returned]),
      'utf8',
    );

    expect(
      budgetTranscriptTurns([returned, omitted], exactReturnedBudget),
    ).toEqual({
      turnsNewestFirst: [returned],
      consumed: 1,
      truncated: false,
    });
  });
});

function completion(result: string): CompletionBodyInput {
  return { result };
}

function plain(text: string): InboundTurnInput {
  return { text, sourceId: 's1' };
}

function transcriptMessageTurn(text: string): AgentRuntimeTranscriptTurn {
  return {
    startedAt: null,
    endedAt: null,
    blocks: [
      {
        kind: 'message',
        role: 'assistant',
        text,
        truncated: false,
      },
    ],
  };
}

function transcriptToolTurn(name: string): AgentRuntimeTranscriptTurn {
  return {
    startedAt: null,
    endedAt: null,
    blocks: [
      {
        kind: 'tool',
        name,
        input: null,
        output: null,
        status: 'ok',
        inputTruncated: false,
        outputTruncated: false,
      },
    ],
  };
}
