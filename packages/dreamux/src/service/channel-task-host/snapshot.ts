import type { ChannelTaskSnapshotItem } from '@excitedjs/dreamux-types';

import type { TaskTargetRecord } from './types.js';

export function taskSnapshotItem(record: TaskTargetRecord): ChannelTaskSnapshotItem {
  return {
    receipt: structuredClone(record.receipt),
    container: {
      container_type: record.container.container_type,
      container_key: record.container.container_key,
    },
    phase: record.phase,
    revision: record.revision,
    terminal: structuredClone(record.terminal),
    blocked: record.blocked !== null
      ? {
          code: record.blocked.code,
          retryable: record.blocked.retryable,
        }
      : record.finalizer?.last_error_code === 'TASK_FINALIZER_RETRY_REQUIRED'
        ? { code: 'TASK_FINALIZER_RETRY_REQUIRED', retryable: true }
        : null,
    team: {
      team_id: record.team.team_name,
      status: teamSnapshotStatus(record),
    },
    worktree: worktreeSnapshot(record),
    turns: record.submissions.slice(-50).map((submission) => ({
      turn_key: submission.operation_id,
      status: submissionSnapshotStatus(record, submission),
    })),
    turns_truncated: record.submissions.length > 50,
    updated_at: record.updated_at,
    tombstone: record.tombstone,
  };
}

function teamSnapshotStatus(
  record: TaskTargetRecord,
): ChannelTaskSnapshotItem['team']['status'] {
  if (
    record.phase === 'finalized' ||
    record.finalizer?.step === 'team_closed' ||
    record.finalizer?.step === 'completed'
  ) {
    return 'closed';
  }
  if (record.terminal !== null) return 'closing';
  return record.team.leader_name === null ? 'provisioning' : 'ready';
}

function worktreeSnapshot(
  record: TaskTargetRecord,
): ChannelTaskSnapshotItem['worktree'] {
  if (
    record.phase === 'finalized' ||
    record.finalizer?.cleanup_status !== undefined
  ) {
    return {
      status: record.finalizer?.cleanup_status ?? 'retained',
      ...(record.finalizer?.cleanup_reason !== undefined
        ? { reason: record.finalizer.cleanup_reason }
        : record.finalizer?.cleanup_status === undefined
          ? { reason: 'cleanup_error' as const }
          : {}),
    };
  }
  if (record.terminal !== null) return { status: 'cleaning' };
  return { status: record.team.leader_name === null ? 'provisional' : 'ready' };
}

function submissionSnapshotStatus(
  target: TaskTargetRecord,
  submission: TaskTargetRecord['submissions'][number],
): ChannelTaskSnapshotItem['turns'][number]['status'] {
  if (
    target.terminal?.outcome === 'cancelled' &&
    (submission.state === 'intent' || submission.state === 'accepted')
  ) {
    return 'stopped';
  }
  if (submission.state === 'intent') return 'submitted';
  if (submission.state === 'accepted') return 'running';
  if (submission.state === 'in_doubt') return 'in_doubt';
  return submission.settlement?.status ?? 'failed';
}
