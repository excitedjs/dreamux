import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  execa: vi.fn(),
}));

vi.mock('execa', () => ({ execa: mocks.execa }));

import { WorktreeManager } from '../src/service/worktree/manager.js';

const LARGE_REF_COUNT = 10_000;
const LARGE_REF_OUTPUT = Array.from(
  { length: LARGE_REF_COUNT },
  (_unused, index) =>
    `refs/remotes/archive/ref-${index}\0${(index + 1)
      .toString(16)
      .padStart(40, '0')}`,
).join('\n');

const identity = {
  source_cwd: process.cwd(),
  source_repo: process.cwd(),
  worktree: {
    mode: 'managed' as const,
    slug: 'team-alpha',
    path: process.cwd(),
    branch: 'dreamux/team-alpha',
    base_ref: 'HEAD',
    cleanup: 'delete-on-close' as const,
    cleanup_state: 'managed-active' as const,
    cleanup_error: null,
  },
};

afterEach(() => {
  vi.restoreAllMocks();
  mocks.execa.mockReset();
});

describe('repository-scale worktree-only cleanup', () => {
  it('does not enumerate refs or history and removes only the worktree non-force', async () => {
    mocks.execa.mockImplementation(async (
      command: unknown,
      rawArgs: unknown,
    ) => {
      const args = rawArgs as string[];
      switch (args[0]) {
        case 'ls-files':
        case 'status':
        case 'worktree':
          return { stdout: '' };
        case 'for-each-ref':
          return { stdout: LARGE_REF_OUTPUT };
        default:
          throw new Error(
            `unexpected git command: ${String(command)} ${args.join(' ')}`,
          );
      }
    });

    await expect(new WorktreeManager().cleanup(identity)).resolves.toEqual({
      ...identity.worktree,
      cleanup_state: 'deleted',
      cleanup_error: null,
    });

    const calls = mocks.execa.mock.calls;
    expect(calls.map((call) => call[1])).toEqual([
      ['ls-files', '-u'],
      ['status', '--porcelain=v1', '-uall'],
      ['worktree', 'remove', identity.worktree.path],
    ]);
    expect(LARGE_REF_OUTPUT.split('\n')).toHaveLength(LARGE_REF_COUNT);
    expect(calls.filter((call) =>
      (call[1] as string[])[0] === 'for-each-ref'
    )).toHaveLength(0);
    expect(calls.filter((call) =>
      ['rev-list', 'rev-parse', 'merge-base', 'log'].includes(
        (call[1] as string[])[0]!,
      )
    )).toHaveLength(0);
    expect(calls.filter((call) =>
      ['branch', 'update-ref'].includes((call[1] as string[])[0]!)
    )).toHaveLength(0);
    for (const call of calls) {
      expect(call[2]).not.toHaveProperty('input');
      expect(call[1]).not.toContain('--force');
      expect(call[1]).not.toContain('-D');
    }
  });
});
