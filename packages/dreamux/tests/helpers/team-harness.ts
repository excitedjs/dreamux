/**
 * Record-only Team fixtures, for tests that plant a `record.json` directly
 * (bypassing `TeamService` entirely) rather than create one through the
 * ordinary path.
 */
import { rm } from 'node:fs/promises';

import type { TeamRecord } from '../../src/service/team-collection/types.js';
import { reuseCwdWorktree } from '../../src/service/worktree/manager.js';
import { dispatcherDir } from '../../src/platform/paths.js';

/**
 * A minimal, valid {@link TeamStore.create} input for a team a test plants
 * directly (bypassing `TeamService` entirely) — for tests that need a Team
 * record to already exist (a replay target, a closed record, a corrupt
 * neighbor) without paying for a full leader materialization.
 *
 * Every field this exercises is exactly the record-validity boundary
 * `TeamStore`'s reader checks (directory-bound identity, leader name,
 * lifecycle status, leader runtime, repo/runtime directories, worktree
 * identity, identity prompt, normalized skill sources) plus the two
 * idempotency fields — nothing speculative.
 */
export function minimalTeamRecordInput(input: {
  dispatcherId: string;
  teamId: string;
  leaderName?: string;
  status?: TeamRecord['status'];
  createRequestId?: string | null;
  createPayloadHash?: string | null;
  runtimeCwd?: string;
}): Omit<TeamRecord, 'version' | 'created_at' | 'updated_at' | 'worktree_cleanup_force'> {
  const runtimeCwd = input.runtimeCwd ?? '/tmp/dreamux-harness-unused-cwd';
  return {
    dispatcher_id: input.dispatcherId,
    team_id: input.teamId,
    name: input.teamId,
    repo_cwd: runtimeCwd,
    source_repo: null,
    leader_name: input.leaderName ?? `tl-${input.teamId}-seed`,
    leader_agent_runtime: 'fake',
    leader_identity_prompt: null,
    leader_skill_sources: [],
    runtime_cwd: runtimeCwd,
    worktree: reuseCwdWorktree(runtimeCwd),
    status: input.status ?? 'running',
    intent: 'seeded directly, not through TeamService',
    closed_at: null,
    close_note: null,
    create_request_id: input.createRequestId ?? null,
    create_payload_hash: input.createPayloadHash ?? null,
  };
}

/** Remove the given dispatcher root under the real state tree, defensively. */
export async function rmDispatcherState(dispatcherId: string): Promise<void> {
  await rm(dispatcherDir(dispatcherId), { recursive: true, force: true });
}
