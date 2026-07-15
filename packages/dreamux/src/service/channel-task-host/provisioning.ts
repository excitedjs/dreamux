import type { ChannelTarget } from '@excitedjs/dreamux-types';

import type { TaskTeamProvisionInput } from '../team-collection/types.js';
import type { TaskTargetRecord } from './types.js';

export function taskChannelTarget(record: TaskTargetRecord): ChannelTarget {
  return {
    target_type: 'dreamux.task-attempt.v1',
    target_key: record.canonical_target_key,
    bindable: true,
  };
}

export function taskTeamProvisionInput(
  record: TaskTargetRecord,
): TaskTeamProvisionInput {
  const binding = record.binding;
  if (binding === null) {
    throw new Error(`task target '${record.target_id}' has no collaboration binding`);
  }
  return {
    name: record.team.team_name,
    repoCwd: binding.repository.repo_cwd,
    leaderAgentRuntime: binding.leader_agent_runtime,
    worktree: {
      mode: 'managed',
      slug: record.team.worktree_slug,
      base_ref: binding.repository.base_commit,
      cleanup: 'delete-on-close',
    },
    intent: `Execute task attempt ${record.receipt.receipt_id}`,
    ...(binding.identity !== null ? { identity: binding.identity } : {}),
  };
}

export function cleanupEvent(
  state: string,
): {
  status: 'deleted' | 'retained';
  reason?: 'dirty' | 'unmerged' | 'unique_commits' | 'cleanup_error';
} {
  if (state === 'deleted') return { status: 'deleted' };
  const reason = state === 'retained-dirty'
    ? 'dirty'
    : state === 'retained-unmerged'
      ? 'unmerged'
      : state === 'retained-unique-commits'
        ? 'unique_commits'
        : 'cleanup_error';
  return { status: 'retained', reason };
}
