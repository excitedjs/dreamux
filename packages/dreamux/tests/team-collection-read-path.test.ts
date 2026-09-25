import { describe, expect, it } from 'vitest';

import { resolveSpawnWorkspace } from '../src/service/worktree/workspaces.js';
import type { SpawnTeamMateRequest } from '../src/service/teammate-collection/types.js';
import type { DreamuxConfig } from '../src/config/config.js';

/**
 * The sibling "lets a dispatcher-scoped TeamMate (no sharedWorkspace) take
 * its own managed, delete-on-close worktree" case that used to live here was
 * deleted as Stage 2a Item 6 collateral (its fixture built a `DispatcherConfig`
 * with the now-deleted `.runtime` field) — see
 * `.agents/tasks/architecture/code-organization-refactor/artifacts/deleted-tests.md`,
 * Stage 2a Item 6.
 */
describe('Team-scoped TeamMate workspace borrowing', () => {
  it('borrows the Team runtime directory as reuse-cwd/keep, never copying the Team worktree\'s own identity', async () => {
    const teamManagedWorktree = {
      mode: 'managed' as const,
      slug: 'team-slug',
      path: '/team/managed/checkout',
      branch: 'dreamux/team-branch',
      base_ref: 'main',
      cleanup: 'delete-on-close' as const,
      cleanup_state: 'managed-active' as const,
      cleanup_error: null,
    };
    const request: SpawnTeamMateRequest = {
      name: 'member-1',
      prompt: 'hi',
      intent: 'work',
      sharedWorkspace: {
        sourceCwd: '/team/managed/checkout',
        sourceRepo: 'git@example.com:org/repo.git',
        runtimeCwd: '/team/managed/checkout',
      },
    };
    const config: DreamuxConfig = { agents: {}, dispatchers: [] };
    const untouchedWorktrees = {
      prepare: () => { throw new Error('must not be called for a shared-workspace spawn'); },
      prepareDefaultWorkspace: () => {
        throw new Error('must not be called for a shared-workspace spawn');
      },
    } as unknown as import('../src/service/worktree/manager.js').WorktreeManager;

    const workspace = await resolveSpawnWorkspace({
      config,
      worktrees: untouchedWorktrees,
      dispatcherId: 'd1',
      name: 'member-1',
      request,
    });

    expect(workspace.createdCheckout).toBe(false);
    expect(workspace.worktree).toEqual({
      mode: 'reuse-cwd',
      slug: null,
      path: '/team/managed/checkout',
      branch: null,
      base_ref: null,
      cleanup: 'keep',
      cleanup_state: 'not-managed',
      cleanup_error: null,
    });
    // None of the Team's own managed-worktree facts (slug, branch, base_ref,
    // delete-on-close, active cleanup state) made it into the member's
    // workspace — the loan type carries no worktree identity at all, so
    // there is nothing for a member's own close to mistakenly clean up.
    expect(workspace.worktree).not.toMatchObject({
      slug: teamManagedWorktree.slug,
      cleanup: 'delete-on-close',
    });
  });
});
