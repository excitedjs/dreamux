import { describe, expect, it } from 'vitest';

import { teamView } from '../src/service/team-service/team-view.js';
import type { TeamRecord } from '../src/service/team-collection/types.js';
import { minimalTeamRecordInput } from './helpers/team-harness.js';

function record(worktree?: TeamRecord['worktree']): TeamRecord {
  const base = minimalTeamRecordInput({ dispatcherId: 'dsp', teamId: 'team-view' });
  return {
    ...base,
    ...(worktree === undefined ? {} : { worktree }),
    version: 1,
    created_at: 1,
    updated_at: 1,
    worktree_cleanup_force: false,
  };
}

describe('team.status projection of the workspace', () => {
  it('names a managed delete-on-close worktree by its mode and cleanup mode, not only its lifecycle state', () => {
    const view = teamView(record({
      mode: 'managed',
      slug: 'team-view',
      path: '/tmp/team-view',
      branch: 'dreamux/team-view',
      base_ref: 'HEAD',
      cleanup: 'delete-on-close',
      cleanup_state: 'managed-active',
      cleanup_error: null,
    }));
    expect(view).toMatchObject({
      worktree_cleanup: 'managed-active',
      worktree_mode: 'managed',
      worktree_cleanup_mode: 'delete-on-close',
    });
  });

  it('names a reused directory as kept', () => {
    expect(teamView(record())).toMatchObject({
      worktree_cleanup: 'not-managed',
      worktree_mode: 'reuse-cwd',
      worktree_cleanup_mode: 'keep',
    });
  });
});
