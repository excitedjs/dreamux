import { createHash } from 'node:crypto';

import type {
  ChannelTaskResource,
} from '@excitedjs/dreamux-types';

import type {
  RuntimeSubmissionRecord,
  TaskStoreEventInput,
  TaskTargetRecord,
} from './types.js';

const MAX_SNAPSHOT_MEMBERS = 100;
const MAX_SNAPSHOT_TURNS = 50;

export function taskResourceProjection(record: TaskTargetRecord): {
  resources: ChannelTaskResource[];
  resourcesTruncated: boolean;
  turnsTruncated: boolean;
} {
  const members = memberResources(record);
  const selectedMembers = members.slice(0, MAX_SNAPSHOT_MEMBERS);
  const turns = record.submissions
    .slice(-MAX_SNAPSHOT_TURNS)
    .map((submission) => turnResource(record, submission));
  return {
    resources: [
      teamResource(record),
      leaderResource(record),
      ...selectedMembers,
      ...turns,
      worktreeResource(record),
    ],
    resourcesTruncated:
      members.length > MAX_SNAPSHOT_MEMBERS ||
      record.submissions.length > MAX_SNAPSHOT_TURNS,
    turnsTruncated: record.submissions.length > MAX_SNAPSHOT_TURNS,
  };
}

export function teamResource(
  record: TaskTargetRecord,
  state: Extract<ChannelTaskResource, { kind: 'team' }>['state'] =
    teamState(record),
): Extract<ChannelTaskResource, { kind: 'team' }> {
  return {
    kind: 'team',
    resource_id: resourceId(record.target_id, 'team'),
    revision: record.revision,
    state,
  };
}

export function leaderResource(
  record: TaskTargetRecord,
  state: Extract<ChannelTaskResource, { kind: 'leader' }>['state'] =
    agentState(record, latestSubmission(record, 'leader'), 'leader'),
): Extract<ChannelTaskResource, { kind: 'leader' }> {
  return {
    kind: 'leader',
    resource_id: resourceId(record.target_id, 'leader'),
    parent_resource_id: resourceId(record.target_id, 'team'),
    revision: record.revision,
    state,
  };
}

export function memberResources(
  record: TaskTargetRecord,
  state?: Extract<ChannelTaskResource, { kind: 'member' }>['state'],
): Array<Extract<ChannelTaskResource, { kind: 'member' }>> {
  const latest = new Map<string, RuntimeSubmissionRecord>();
  for (const submission of record.submissions) {
    const key = memberKey(submission);
    if (key !== null) latest.set(key, submission);
  }
  return [...latest.entries()]
    .map(([key, submission]) => memberResource(record, key, submission, state))
    .sort((left, right) => left.resource_id.localeCompare(right.resource_id));
}

export function submissionResourceEvents(
  record: TaskTargetRecord,
  operationId: string,
): TaskStoreEventInput[] {
  const submission = record.submissions.find(
    (candidate) => candidate.operation_id === operationId,
  );
  if (submission === undefined) {
    throw new Error(`unknown task resource submission '${operationId}'`);
  }
  const agent = submission.runtime_role === 'leader'
    ? leaderResource(record)
    : memberResource(
        record,
        memberKey(submission) ?? submission.operation_id,
        submission,
      );
  return [resourceEvent(agent), resourceEvent(turnResource(record, submission))];
}

export function worktreeResource(
  record: TaskTargetRecord,
  state: Extract<ChannelTaskResource, { kind: 'worktree' }>['state'] =
    worktreeState(record),
  reason?: Extract<ChannelTaskResource, { kind: 'worktree' }>['reason'],
): Extract<ChannelTaskResource, { kind: 'worktree' }> {
  const resolvedReason = reason ?? record.finalizer?.cleanup_reason;
  return {
    kind: 'worktree',
    resource_id: resourceId(record.target_id, 'worktree'),
    parent_resource_id: resourceId(record.target_id, 'team'),
    revision: record.revision,
    state,
    ...(resolvedReason !== undefined ? { reason: resolvedReason } : {}),
  };
}

export function resourceEvent(resource: ChannelTaskResource): TaskStoreEventInput {
  return { payload: { kind: 'resource.lifecycle', resource } };
}

function memberResource(
  record: TaskTargetRecord,
  key: string,
  submission: RuntimeSubmissionRecord,
  state?: Extract<ChannelTaskResource, { kind: 'member' }>['state'],
): Extract<ChannelTaskResource, { kind: 'member' }> {
  return {
    kind: 'member',
    resource_id: resourceId(record.target_id, 'member', key),
    parent_resource_id: resourceId(record.target_id, 'team'),
    revision: record.revision,
    state: state ?? agentState(record, submission, 'member'),
  };
}

function turnResource(
  record: TaskTargetRecord,
  submission: RuntimeSubmissionRecord,
): Extract<ChannelTaskResource, { kind: 'turn' }> {
  const member = memberKey(submission);
  return {
    kind: 'turn',
    resource_id: resourceId(record.target_id, 'turn', submission.operation_id),
    parent_resource_id: submission.runtime_role === 'leader'
      ? resourceId(record.target_id, 'leader')
      : resourceId(record.target_id, 'member', member ?? submission.operation_id),
    revision: record.revision,
    state: submissionState(record, submission),
  };
}

function teamState(
  record: TaskTargetRecord,
): Extract<ChannelTaskResource, { kind: 'team' }>['state'] {
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

function agentState(
  record: TaskTargetRecord,
  submission: RuntimeSubmissionRecord | undefined,
  role: 'leader' | 'member',
): Extract<ChannelTaskResource, { kind: 'leader' | 'member' }>['state'] {
  if (
    record.phase === 'finalized' ||
    record.finalizer?.step === 'team_closed' ||
    record.finalizer?.step === 'completed'
  ) {
    return 'closed';
  }
  if (record.phase === 'finalizing') return 'closing';
  if (submission === undefined) {
    if (role === 'leader' && record.team.leader_name !== null) return 'ready';
    return 'provisioning';
  }
  const state = submissionState(record, submission);
  return state === 'submitted'
    ? role === 'leader' || submission.kind === 'send'
      ? 'ready'
      : 'provisioning'
    : state;
}

function submissionState(
  record: TaskTargetRecord,
  submission: RuntimeSubmissionRecord,
): Extract<ChannelTaskResource, { kind: 'turn' }>['state'] {
  if (
    record.terminal?.outcome === 'cancelled' &&
    (submission.state === 'intent' || submission.state === 'accepted')
  ) {
    return 'stopped';
  }
  if (submission.state === 'intent') return 'submitted';
  if (submission.state === 'accepted') return 'running';
  if (submission.state === 'in_doubt') return 'in_doubt';
  return submission.settlement?.status ?? 'failed';
}

function worktreeState(
  record: TaskTargetRecord,
): Extract<ChannelTaskResource, { kind: 'worktree' }>['state'] {
  if (
    record.phase === 'finalized' ||
    record.finalizer?.cleanup_status !== undefined
  ) {
    return record.finalizer?.cleanup_status ?? 'retained';
  }
  if (record.terminal !== null) return 'cleaning';
  return record.team.leader_name === null ? 'provisional' : 'ready';
}

function latestSubmission(
  record: TaskTargetRecord,
  role: RuntimeSubmissionRecord['runtime_role'],
): RuntimeSubmissionRecord | undefined {
  return [...record.submissions].reverse().find(
    (submission) => submission.runtime_role === role,
  );
}

function memberKey(submission: RuntimeSubmissionRecord): string | null {
  if (submission.runtime_role !== 'member') return null;
  if (submission.effect.kind === 'spawn') return submission.effect.teammate_name;
  if (submission.effect.kind === 'send') return submission.effect.teammate_name;
  return null;
}

function resourceId(targetId: string, kind: string, key = ''): string {
  const digest = createHash('sha256')
    .update('task-resource-v1')
    .update('\0')
    .update(targetId)
    .update('\0')
    .update(kind)
    .update('\0')
    .update(key)
    .digest('base64url');
  return `${kind}_v1_${digest}`;
}
