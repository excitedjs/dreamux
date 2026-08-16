import { mkdtempSync, rmSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  COMPLETION_INLINE_BUDGET_DEFAULT,
  COMPLETION_INLINE_BUDGET_MAX,
  completionInlineBudget,
  resolveCompletionBody,
  type CompletionBodyInput,
} from '@excitedjs/dreamux-utils';

function completion(result: string): CompletionBodyInput {
  return { result };
}

describe('resolveCompletionBody', () => {
  let spillDir: string;

  beforeEach(() => {
    // A throwaway spill dir per test, standing in for a dispatcher's
    // cache/<id>/spill — the dir need not pre-exist (resolveCompletionBody
    // creates it owner-only).
    spillDir = join(mkdtempSync(join(tmpdir(), 'dx-spill-')), 'spill');
  });

  afterEach(() => {
    delete process.env['TASK_MAX_OUTPUT_LENGTH'];
    rmSync(spillDir, { recursive: true, force: true });
  });

  it('inlines a result within the budget', async () => {
    const body = await resolveCompletionBody(completion('short result'), spillDir);
    expect(body).toEqual({ kind: 'inline', text: 'short result' });
    await expect(stat(spillDir)).rejects.toThrow();
  });

  it('inlines a result exactly at the budget boundary', async () => {
    const result = 'x'.repeat(COMPLETION_INLINE_BUDGET_DEFAULT);
    const body = await resolveCompletionBody(completion(result), spillDir);
    expect(body.kind).toBe('inline');
  });

  it('spills a result over the budget to a 0600 file with the full content', async () => {
    const result = 'y'.repeat(COMPLETION_INLINE_BUDGET_DEFAULT + 1);
    const body = await resolveCompletionBody(completion(result), spillDir);
    if (body.kind !== 'spilled') throw new Error('expected spilled');
    expect(body.path).toMatch(/\/completion-[0-9a-f-]+\.output$/u);
    expect(body.path).not.toContain('reviewer');

    // Full result on disk — not truncated.
    expect(await readFile(body.path, 'utf8')).toBe(result);
    // Owner-only file in an owner-only spill dir.
    expect((await stat(body.path)).mode & 0o777).toBe(0o600);
    expect((await stat(spillDir)).mode & 0o777).toBe(0o700);

    const second = await resolveCompletionBody(completion(result), spillDir);
    if (second.kind !== 'spilled') throw new Error('expected second spill');
    expect(second.path).not.toBe(body.path);
  });

  it('honors a TASK_MAX_OUTPUT_LENGTH override that forces a small budget', async () => {
    process.env['TASK_MAX_OUTPUT_LENGTH'] = '8';
    expect(completionInlineBudget()).toBe(8);
    const body = await resolveCompletionBody(
      completion('this is longer than eight'),
      spillDir,
    );
    expect(body.kind).toBe('spilled');
  });
});

describe('completionInlineBudget', () => {
  it('defaults when unset or blank', () => {
    expect(completionInlineBudget({})).toBe(COMPLETION_INLINE_BUDGET_DEFAULT);
    expect(completionInlineBudget({ TASK_MAX_OUTPUT_LENGTH: '   ' })).toBe(
      COMPLETION_INLINE_BUDGET_DEFAULT,
    );
  });

  it('defaults on non-positive, non-numeric, or partially-numeric values', () => {
    expect(completionInlineBudget({ TASK_MAX_OUTPUT_LENGTH: '0' })).toBe(
      COMPLETION_INLINE_BUDGET_DEFAULT,
    );
    expect(completionInlineBudget({ TASK_MAX_OUTPUT_LENGTH: '-5' })).toBe(
      COMPLETION_INLINE_BUDGET_DEFAULT,
    );
    expect(completionInlineBudget({ TASK_MAX_OUTPUT_LENGTH: 'abc' })).toBe(
      COMPLETION_INLINE_BUDGET_DEFAULT,
    );
    // Strict parse: a leading-numeric string must NOT partially parse.
    expect(completionInlineBudget({ TASK_MAX_OUTPUT_LENGTH: '123abc' })).toBe(
      COMPLETION_INLINE_BUDGET_DEFAULT,
    );
    expect(completionInlineBudget({ TASK_MAX_OUTPUT_LENGTH: '32k' })).toBe(
      COMPLETION_INLINE_BUDGET_DEFAULT,
    );
    expect(completionInlineBudget({ TASK_MAX_OUTPUT_LENGTH: '12.5' })).toBe(
      COMPLETION_INLINE_BUDGET_DEFAULT,
    );
  });

  it('clamps values above the upper bound', () => {
    expect(
      completionInlineBudget({ TASK_MAX_OUTPUT_LENGTH: String(COMPLETION_INLINE_BUDGET_MAX + 1000) }),
    ).toBe(COMPLETION_INLINE_BUDGET_MAX);
  });
});
