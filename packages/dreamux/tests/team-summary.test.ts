import { describe, expect, it } from 'vitest';

import { teamSummary } from '../src/service/team/team-summary.js';
import type { TeamRecord } from '../src/service/team/types.js';
import { reuseCwdWorktree } from '../src/service/worktree/manager.js';

function record(worktree?: TeamRecord['worktree']): TeamRecord {
  const base = {
    dispatcher_id: 'dsp',
    team_id: 'team-view',
    name: 'Team',
    repo_cwd: '/tmp/team-view',
    runtime_cwd: '/tmp/team-view',
    source_repo: null,
    leader_name: 'leader',
    leader_agent_runtime: 'runtime',
    leader_identity_prompt: null,
    leader_skill_sources: [],
    worktree: reuseCwdWorktree('/tmp/team-view'),
    status: 'running' as const,
    intent: null,
    closed_at: null,
    close_note: null,
    create_request_id: null,
    create_payload_hash: null,
  };
  return {
    ...base,
    ...(worktree === undefined ? {} : { worktree }),
    version: 1,
    created_at: 1,
    updated_at: 1,
    worktree_cleanup_force: false,
  };
}

describe('canonical Team summary projection', () => {
  it('names a managed delete-on-close worktree by its mode and cleanup mode, not only its lifecycle state', () => {
    const summary = teamSummary(
      record({
        mode: 'managed',
        slug: 'team-view',
        path: '/tmp/team-view',
        branch: 'dreamux/team-view',
        base_ref: 'HEAD',
        cleanup: 'delete-on-close',
        cleanup_state: 'managed-active',
        cleanup_error: null,
      }),
      null,
      0,
    );
    expect(summary).toMatchObject({
      worktree_cleanup: 'managed-active',
      worktree_mode: 'managed',
      worktree_cleanup_mode: 'delete-on-close',
    });
  });

  it('names a reused directory as kept', () => {
    expect(teamSummary(record(), null, 0)).toMatchObject({
      worktree_cleanup: 'not-managed',
      worktree_mode: 'reuse-cwd',
      worktree_cleanup_mode: 'keep',
    });
  });
});
