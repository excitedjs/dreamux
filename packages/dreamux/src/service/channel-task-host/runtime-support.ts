import { createHash } from 'node:crypto';

import type {
  AgentRuntime,
  AgentRuntimeDurableSubmissionDelivery,
  AgentRuntimeDurableSubmissionRecord,
} from '@excitedjs/dreamux-types';

import { buildConcreteName } from '../teammate-collection/name-allocator.js';
import {
  TaskRuntimeCapabilityUnavailableError,
  type TaskOperationInvocation,
} from '../task-runtime-submission.js';
import { taskOperationId } from './identity.js';
import type { TaskHostStore } from './store.js';
import type {
  RuntimeSubmissionRecord,
  TaskTargetRecord,
} from './types.js';

export interface SettlementSignal {
  teamId: string;
  runtimeId: string;
  durabilityNamespace: string;
  turnId: string;
}

export class DurabilityNamespaceChangedError extends Error {
  constructor() {
    super('task submission durability namespace changed');
    this.name = 'DurabilityNamespaceChangedError';
  }
}

export function rootOperationId(target: TaskTargetRecord): string {
  return taskOperationId({
    targetId: target.target_id,
    parentOperationId: null,
    toolCallId: 'root',
    toolCallOrdinal: 0,
    kind: 'root',
  });
}

export function textDelivery(
  operationId: string,
  text: string,
): AgentRuntimeDurableSubmissionDelivery {
  return { kind: 'text', input: { sourceId: `task:${operationId}`, text } };
}

export function validatedLeaderParent(
  target: TaskTargetRecord,
  invocation: TaskOperationInvocation,
): string {
  if (target.terminal !== null) throw new Error('task attempt is already terminal');
  const parent = target.submissions.find(
    (entry) => entry.operation_id === invocation.parentOperationId,
  );
  if (
    parent === undefined ||
    parent.runtime_role !== 'leader' ||
    parent.runtime_id !== invocation.runtimeId ||
    parent.durability_namespace !== invocation.durabilityNamespace ||
    parent.runtime_id === null ||
    parent.durability_namespace === null ||
    parent.state === 'in_doubt'
  ) {
    throw new Error('task tool invocation has no matching durable parent turn');
  }
  return parent.operation_id;
}

export function assertParentAllowsOperation(
  target: TaskTargetRecord,
  parentOperationId: string,
  childOperationId: string,
): void {
  const parent = requiredSubmission(target, parentOperationId);
  if (
    parent.state === 'settled' &&
    !target.submissions.some((entry) => entry.operation_id === childOperationId)
  ) {
    throw new Error('a settled parent turn cannot create a new task operation');
  }
}

export function taskMemberName(base: string, operationId: string): string {
  const suffix = createHash('sha256').update(operationId).digest('hex').slice(0, 8);
  return buildConcreteName({ role: 'team_member', base, suffix });
}

export function assertInvocation(invocation: TaskOperationInvocation): void {
  if (
    typeof invocation.callId !== 'string' ||
    invocation.callId === '' ||
    Buffer.byteLength(invocation.callId, 'utf8') > 512 ||
    !Number.isSafeInteger(invocation.ordinal) ||
    invocation.ordinal < 0 ||
    typeof invocation.parentOperationId !== 'string' ||
    invocation.parentOperationId === '' ||
    typeof invocation.runtimeId !== 'string' ||
    invocation.runtimeId === '' ||
    typeof invocation.durabilityNamespace !== 'string' ||
    invocation.durabilityNamespace === ''
  ) {
    throw new Error('task operation invocation identity is invalid');
  }
}

export function durableCapability(runtime: AgentRuntime) {
  if (
    runtime.getCapabilities().durableTaskSubmission?.protocol !==
      'durable_task_submission_v1' ||
    runtime.getCapabilities().durableTaskToolInvocation?.protocol !==
      'durable_task_mcp_invocation_v1' ||
    runtime.durableTaskSubmissions === undefined
  ) {
    throw new TaskRuntimeCapabilityUnavailableError();
  }
  return runtime.durableTaskSubmissions;
}

export function requiredTarget(
  store: TaskHostStore,
  targetId: string,
): TaskTargetRecord {
  const target = store.get(targetId);
  if (target === null) throw new Error(`unknown task target '${targetId}'`);
  return target;
}

export function targetForTeam(
  store: TaskHostStore,
  teamId: string,
): TaskTargetRecord {
  const target = store.list().find((entry) => entry.team.team_name === teamId);
  if (target === undefined) throw new Error('Team has no task attempt');
  return target;
}

export function activeTargetForTeam(
  store: TaskHostStore,
  teamId: string,
): TaskTargetRecord {
  const target = targetForTeam(store, teamId);
  if (target.phase === 'finalized' || target.terminal !== null) {
    throw new Error('task attempt is already terminal');
  }
  return target;
}

export function requiredSubmission(
  target: TaskTargetRecord,
  operationId: string,
): RuntimeSubmissionRecord {
  const submission = target.submissions.find(
    (entry) => entry.operation_id === operationId,
  );
  if (submission === undefined) throw new Error(`unknown task operation '${operationId}'`);
  return submission;
}

export function submissionFingerprint(target: TaskTargetRecord): string {
  return target.submissions.map((entry) => [
    entry.operation_id,
    entry.state,
    entry.runtime_id,
    entry.durability_namespace,
    entry.turn_id,
    entry.runtime_revision,
    entry.settlement_acknowledged_revision,
  ].join(':')).join('|');
}

export function findSubmissionsByTurn(
  store: TaskHostStore,
  teamId: string,
  runtimeId: string,
  durabilityNamespace: string,
  turnId: string,
): Array<{
  target: TaskTargetRecord;
  operationId: string;
  submission: RuntimeSubmissionRecord;
}> {
  const matches: Array<{
    target: TaskTargetRecord;
    operationId: string;
    submission: RuntimeSubmissionRecord;
  }> = [];
  for (const target of store.list()) {
    if (target.team.team_name !== teamId) continue;
    for (const submission of target.submissions) {
      if (
        submission.runtime_id === runtimeId &&
        submission.durability_namespace === durabilityNamespace &&
        submission.turn_id === turnId
      ) {
        matches.push({ target, operationId: submission.operation_id, submission });
      }
    }
  }
  return matches;
}

export function settlementKey(input: SettlementSignal): string {
  return `${input.teamId}\0${input.runtimeId}\0${input.durabilityNamespace}\0${input.turnId}`;
}

export function boundedCode(code: string): string {
  return typeof code === 'string' && /^[A-Za-z0-9._-]{1,128}$/.test(code)
    ? code
    : 'SUBMISSION_OUTCOME_UNKNOWN';
}

export function shouldDeliverChildCompletion(
  target: TaskTargetRecord,
  submission: RuntimeSubmissionRecord,
): boolean {
  return submission.runtime_role === 'member' &&
    (submission.kind === 'spawn' || submission.kind === 'send') &&
    target.terminal === null;
}

export function completionText(
  child: RuntimeSubmissionRecord,
  status: 'completed' | 'failed' | 'stopped',
  result: string | null,
): string {
  const subject = child.effect.kind === 'spawn' || child.effect.kind === 'send'
    ? child.effect.teammate_name
    : null;
  const name = subject ?? 'TeamMate';
  const line = status === 'completed'
    ? `TeamMate ${name} has finished its task.`
    : status === 'failed'
      ? `TeamMate ${name}'s task failed.`
      : `TeamMate ${name}'s task was stopped.`;
  return result === null ? line : `${line} Output below:\n\n${result}`;
}

export function assertRuntimeSubmission(
  submission: AgentRuntimeDurableSubmissionRecord,
  expectedOperationId: string,
): void {
  if (
    submission.operation_id !== expectedOperationId ||
    typeof submission.input_digest !== 'string' ||
    !/^[a-f0-9]{64}$/.test(submission.input_digest) ||
    typeof submission.turn_id !== 'string' ||
    submission.turn_id.length === 0 ||
    Buffer.byteLength(submission.turn_id, 'utf8') > 1024 ||
    !Number.isSafeInteger(submission.revision) ||
    submission.revision < 1 ||
    !Number.isSafeInteger(submission.settlement_acknowledged_revision) ||
    submission.settlement_acknowledged_revision < 0 ||
    submission.settlement_acknowledged_revision > submission.revision
  ) {
    throw new Error('runtime returned an invalid durable submission record');
  }
  const settlement = submission.settlement;
  if (settlement === null) return;
  if (
    !Number.isSafeInteger(settlement.revision) ||
    settlement.revision < 1 ||
    settlement.revision > submission.revision ||
    !['completed', 'failed', 'stopped'].includes(settlement.status) ||
    (settlement.result !== null &&
      (typeof settlement.result !== 'string' ||
        Buffer.byteLength(settlement.result, 'utf8') > 64 * 1024))
  ) {
    throw new Error('runtime returned an invalid durable settlement');
  }
}

export function errorInfo(error: unknown): Record<string, unknown> {
  return error instanceof Error
    ? { type: error.name, message: error.message }
    : { value: String(error) };
}
