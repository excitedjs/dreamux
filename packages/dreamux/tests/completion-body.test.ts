import { readFile, rm, stat } from 'node:fs/promises';

import { afterEach, describe, expect, it } from 'vitest';

import {
  COMPLETION_INLINE_BUDGET_DEFAULT,
  COMPLETION_INLINE_BUDGET_MAX,
  completionInlineBudget,
  resolveCompletionBody,
} from '../src/agent-runtime/completion-body.js';
import { teamMateCompletionOutputPath } from '../src/platform/paths.js';
import type { CompletionEnvelope } from '../src/agent-runtime/types.js';

const SOURCE = 'reviewer';
const ID = 'reviewer:turn-7';
const SPILL_PATH = teamMateCompletionOutputPath(SOURCE, ID);

function completion(result: string): CompletionEnvelope {
  return { source: SOURCE, id: ID, status: 'completed', result };
}

afterEach(async () => {
  delete process.env['TASK_MAX_OUTPUT_LENGTH'];
  await rm(SPILL_PATH, { force: true });
});

describe('resolveCompletionBody', () => {
  it('inlines a result within the budget', async () => {
    const body = await resolveCompletionBody(completion('short result'));
    expect(body).toEqual({ kind: 'inline', text: 'short result' });
    await expect(stat(SPILL_PATH)).rejects.toThrow();
  });

  it('inlines a result exactly at the budget boundary', async () => {
    const result = 'x'.repeat(COMPLETION_INLINE_BUDGET_DEFAULT);
    const body = await resolveCompletionBody(completion(result));
    expect(body.kind).toBe('inline');
  });

  it('spills a result over the budget to a 0600 file with the full content', async () => {
    const result = 'y'.repeat(COMPLETION_INLINE_BUDGET_DEFAULT + 1);
    const body = await resolveCompletionBody(completion(result));
    expect(body).toEqual({ kind: 'spilled', path: SPILL_PATH });
    if (body.kind !== 'spilled') throw new Error('expected spilled');

    // Full result on disk — not truncated.
    expect(await readFile(body.path, 'utf8')).toBe(result);
    // Owner-only permissions.
    const info = await stat(body.path);
    expect(info.mode & 0o777).toBe(0o600);
  });

  it('honors a TASK_MAX_OUTPUT_LENGTH override that forces a small budget', async () => {
    process.env['TASK_MAX_OUTPUT_LENGTH'] = '8';
    expect(completionInlineBudget()).toBe(8);
    const body = await resolveCompletionBody(completion('this is longer than eight'));
    expect(body.kind).toBe('spilled');
  });
});

describe('teamMateCompletionOutputPath', () => {
  it('sanitizes unsafe characters in source and id for filename safety', () => {
    expect(teamMateCompletionOutputPath('a/b', 'c:d')).toBe(
      '/tmp/teammate-a_b-c_d.output',
    );
    // The real id shape is `name:turnId` — the colon must be sanitized.
    expect(teamMateCompletionOutputPath('reviewer', 'reviewer:turn-7')).toBe(
      '/tmp/teammate-reviewer-reviewer_turn-7.output',
    );
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
