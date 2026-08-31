/**
 * Completion-body resolution (completion-body.ts): the inline-vs-spill
 * decision, the env-driven budget, and the spill file's own privacy invariant.
 *
 * `completionInlineBudget` takes an injectable env, so the budget table below
 * uses that instead of mutating `process.env`. `resolveCompletionBody` calls
 * `completionInlineBudget()` with NO argument (it reads the real
 * `process.env`), so the spill tests below stub `process.env` directly and
 * restore it in `afterEach`.
 */
import { mkdtemp, readFile, rm, stat, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, it, expect, afterEach } from 'vitest';

import {
  COMPLETION_INLINE_BUDGET_DEFAULT,
  COMPLETION_INLINE_BUDGET_MAX,
  completionInlineBudget,
  resolveCompletionBody,
} from '../src/completion-body.js';

const ENV_KEY = 'TASK_MAX_OUTPUT_LENGTH';

describe('completionInlineBudget', () => {
  it('falls back to the default when the env var is unset', () => {
    expect(completionInlineBudget({})).toBe(COMPLETION_INLINE_BUDGET_DEFAULT);
  });

  it('falls back to the default for a blank/whitespace value', () => {
    expect(completionInlineBudget({ [ENV_KEY]: '' })).toBe(COMPLETION_INLINE_BUDGET_DEFAULT);
    expect(completionInlineBudget({ [ENV_KEY]: '   ' })).toBe(COMPLETION_INLINE_BUDGET_DEFAULT);
  });

  it('trims surrounding whitespace around a valid integer', () => {
    expect(completionInlineBudget({ [ENV_KEY]: '  500  ' })).toBe(500);
  });

  it('falls back to the default for a non-decimal-integer value ("32k")', () => {
    // Stricter than native's lenient parseInt: no partial parse.
    expect(completionInlineBudget({ [ENV_KEY]: '32k' })).toBe(COMPLETION_INLINE_BUDGET_DEFAULT);
  });

  it('falls back to the default for a value with trailing garbage ("123abc")', () => {
    expect(completionInlineBudget({ [ENV_KEY]: '123abc' })).toBe(
      COMPLETION_INLINE_BUDGET_DEFAULT,
    );
  });

  it('falls back to the default for zero and negative-looking input', () => {
    // "-5" fails the \d+ regex outright (no sign allowed), so it also falls
    // back to the default rather than being read as a negative number.
    expect(completionInlineBudget({ [ENV_KEY]: '0' })).toBe(COMPLETION_INLINE_BUDGET_DEFAULT);
    expect(completionInlineBudget({ [ENV_KEY]: '-5' })).toBe(COMPLETION_INLINE_BUDGET_DEFAULT);
  });

  it('accepts a valid positive integer under the max as-is', () => {
    expect(completionInlineBudget({ [ENV_KEY]: '1000' })).toBe(1000);
  });

  it('clamps a value above the upper bound to the max, without throwing', () => {
    expect(completionInlineBudget({ [ENV_KEY]: '999999' })).toBe(COMPLETION_INLINE_BUDGET_MAX);
  });

  it('passes the exact max value through unclamped', () => {
    expect(
      completionInlineBudget({ [ENV_KEY]: String(COMPLETION_INLINE_BUDGET_MAX) }),
    ).toBe(COMPLETION_INLINE_BUDGET_MAX);
  });
});

describe('resolveCompletionBody', () => {
  let root: string;
  let originalEnv: string | undefined;

  afterEach(async () => {
    if (root) await rm(root, { recursive: true, force: true });
    if (originalEnv === undefined) delete process.env[ENV_KEY];
    else process.env[ENV_KEY] = originalEnv;
  });

  it('inlines a null result as an empty string (never spills)', async () => {
    root = await mkdtemp(join(tmpdir(), 'dreamux-utils-cb-'));
    const resolved = await resolveCompletionBody({ result: null }, root);
    expect(resolved).toEqual({ kind: 'inline', text: '' });
  });

  it('inlines a result exactly at the budget boundary (<=, not <)', async () => {
    originalEnv = process.env[ENV_KEY];
    process.env[ENV_KEY] = '10';
    root = await mkdtemp(join(tmpdir(), 'dreamux-utils-cb-'));
    const exact = 'a'.repeat(10);
    const resolved = await resolveCompletionBody({ result: exact }, root);
    expect(resolved).toEqual({ kind: 'inline', text: exact });
  });

  it('spills a result one character over the budget', async () => {
    originalEnv = process.env[ENV_KEY];
    process.env[ENV_KEY] = '10';
    root = await mkdtemp(join(tmpdir(), 'dreamux-utils-cb-'));
    const overflow = 'a'.repeat(11);
    const resolved = await resolveCompletionBody({ result: overflow }, root);
    expect(resolved.kind).toBe('spilled');
    if (resolved.kind !== 'spilled') throw new Error('unreachable');
    expect(resolved.path.startsWith(root)).toBe(true);
    expect(resolved.path).toMatch(/completion-[0-9a-f-]+\.output$/);

    const content = await readFile(resolved.path, 'utf8');
    expect(content).toBe(overflow);

    const info = await stat(resolved.path);
    expect(info.mode & 0o777).toBe(0o600);
  });

  it('creates the spill directory if it does not exist yet, as owner-only 0700', async () => {
    originalEnv = process.env[ENV_KEY];
    process.env[ENV_KEY] = '5';
    root = await mkdtemp(join(tmpdir(), 'dreamux-utils-cb-'));
    const spillDir = join(root, 'nested', 'spill');
    await resolveCompletionBody({ result: 'overflow-value' }, spillDir);
    const info = await stat(spillDir);
    expect(info.mode & 0o777).toBe(0o700);
  });

  it('tightens a pre-existing permissive spill directory to 0700', async () => {
    originalEnv = process.env[ENV_KEY];
    process.env[ENV_KEY] = '5';
    root = await mkdtemp(join(tmpdir(), 'dreamux-utils-cb-'));
    const spillDir = join(root, 'loose-spill');
    await mkdir(spillDir, { mode: 0o755 });
    await resolveCompletionBody({ result: 'overflow-value' }, spillDir);
    const info = await stat(spillDir);
    expect(info.mode & 0o777).toBe(0o700);
  });

  it('produces distinct spill files (opaque storage key, no business label) across two calls', async () => {
    originalEnv = process.env[ENV_KEY];
    process.env[ENV_KEY] = '5';
    root = await mkdtemp(join(tmpdir(), 'dreamux-utils-cb-'));
    const first = await resolveCompletionBody({ result: 'overflow-one' }, root);
    const second = await resolveCompletionBody({ result: 'overflow-two' }, root);
    if (first.kind !== 'spilled' || second.kind !== 'spilled') {
      throw new Error('expected both results to spill');
    }
    expect(first.path).not.toBe(second.path);
    // The filename must not embed either business string.
    expect(first.path).not.toMatch(/overflow/);
    expect(second.path).not.toMatch(/overflow/);
  });
});
