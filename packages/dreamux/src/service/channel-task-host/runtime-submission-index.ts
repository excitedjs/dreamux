import type {
  AgentRuntimeDurableSubmissionDelivery,
  AgentRuntimeDurableSettlement,
  AgentRuntimeDurableSubmissionRecord,
} from '@excitedjs/dreamux-types';

import type {
  TaskRuntimeEffect,
  TaskRuntimeRole,
} from '../task-runtime-submission.js';
import type { TaskHostStore } from './store.js';
import type {
  RuntimeSubmissionKind,
  RuntimeSubmissionRecord,
  TaskTargetRecord,
} from './types.js';
import { canonicalJson } from './wal.js';

export class RuntimeSubmissionIndex {
  constructor(private readonly store: TaskHostStore) {}

  lookup(targetId: string, operationId: string): RuntimeSubmissionRecord | null {
    const target = this.store.get(targetId);
    return structuredClone(
      target?.submissions.find((entry) => entry.operation_id === operationId) ?? null,
    );
  }

  async recordIntent(input: {
    targetId: string;
    kind: RuntimeSubmissionKind;
    operationId: string;
    inputDigest: string;
    parentOperationId: string | null;
    toolCallId: string;
    toolCallOrdinal: number;
    runtimeId: string | null;
    runtimeRole: TaskRuntimeRole;
    durabilityNamespace: string | null;
    delivery: AgentRuntimeDurableSubmissionDelivery;
    effect: TaskRuntimeEffect;
  }): Promise<RuntimeSubmissionRecord> {
    const existing = this.lookup(input.targetId, input.operationId);
    if (existing !== null) {
      assertSameIntent(existing, input);
      return existing;
    }
    const now = Date.now();
    const submission: RuntimeSubmissionRecord = {
      operation_id: input.operationId,
      input_digest: input.inputDigest,
      kind: input.kind,
      parent_operation_id: input.parentOperationId,
      tool_call_id: input.toolCallId,
      tool_call_ordinal: input.toolCallOrdinal,
      runtime_id: input.runtimeId,
      runtime_role: input.runtimeRole,
      durability_namespace: input.durabilityNamespace,
      delivery: structuredClone(input.delivery),
      effect: structuredClone(input.effect),
      turn_id: null,
      state: 'intent',
      runtime_revision: 0,
      settlement: null,
      settlement_acknowledged_revision: 0,
      created_at: now,
      updated_at: now,
    };
    const target = await this.store.updateTarget(
      input.targetId,
      null,
      (record) => {
        if (record.terminal !== null || record.phase === 'finalized') {
          throw new Error('task attempt is already terminal');
        }
        const concurrent = record.submissions.find(
          (entry) => entry.operation_id === input.operationId,
        );
        if (concurrent !== undefined) {
          assertSameIntent(concurrent, input);
          return false;
        }
        record.submissions.push(submission);
        this.store.assertOperationCapacity(record);
        return true;
      },
      (record) => [{
        payload: {
          kind: 'turn.lifecycle',
          turn_key: input.operationId,
          status: record.terminal?.outcome === 'cancelled'
            ? 'stopped'
            : 'submitted',
        },
      }],
    );
    return requiredSubmission(target, input.operationId);
  }

  async bindRuntime(input: {
    targetId: string;
    operationId: string;
    runtimeId: string;
    runtimeRole: TaskRuntimeRole;
    durabilityNamespace: string;
  }): Promise<RuntimeSubmissionRecord> {
    const current = this.required(input.targetId, input.operationId);
    assertRuntimeBinding(current, input);
    if (
      current.runtime_id === input.runtimeId &&
      current.durability_namespace === input.durabilityNamespace
    ) {
      return current;
    }
    const target = await this.store.updateTarget(
      input.targetId,
      null,
      (record) => {
        const submission = requiredSubmission(record, input.operationId);
        assertRuntimeBinding(submission, input);
        if (
          submission.runtime_id === input.runtimeId &&
          submission.durability_namespace === input.durabilityNamespace
        ) {
          return false;
        }
        submission.runtime_id = input.runtimeId;
        submission.durability_namespace = input.durabilityNamespace;
        submission.updated_at = Date.now();
        return true;
      },
      [{
        payload: {
          kind: 'turn.lifecycle',
          turn_key: input.operationId,
          status: 'submitted',
        },
      }],
    );
    return requiredSubmission(target, input.operationId);
  }

  async recordAccepted(input: {
    targetId: string;
    operationId: string;
    runtime: AgentRuntimeDurableSubmissionRecord;
  }): Promise<RuntimeSubmissionRecord> {
    const current = this.required(input.targetId, input.operationId);
    if (current.runtime_id === null || current.durability_namespace === null) {
      throw new Error('task submission runtime is not durably bound');
    }
    if (current.input_digest !== input.runtime.input_digest) {
      throw new Error('runtime durable submission input digest changed');
    }
    if (current.state === 'settled') {
      assertSameRuntimeRecord(current, input.runtime);
      return current;
    }
    if (current.state === 'accepted') {
      assertSameRuntimeRecord(current, input.runtime);
      return input.runtime.settlement === null
        ? current
        : this.recordSettlement({
            targetId: input.targetId,
            operationId: input.operationId,
            settlement: input.runtime.settlement,
          });
    }
    if (current.state === 'in_doubt') {
      throw new Error('an in-doubt durable submission cannot become accepted');
    }
    const target = await this.store.updateTarget(
      input.targetId,
      null,
      (record) => {
        const submission = requiredSubmission(record, input.operationId);
        submission.turn_id = input.runtime.turn_id;
        submission.runtime_revision = input.runtime.revision;
        submission.settlement = structuredClone(input.runtime.settlement);
        submission.settlement_acknowledged_revision =
          input.runtime.settlement_acknowledged_revision;
        submission.state = input.runtime.settlement === null ? 'accepted' : 'settled';
        submission.updated_at = Date.now();
        if (submission.kind === 'root' && record.terminal === null) {
          record.phase = 'running';
        }
      },
      (record) => [{
        payload: eventPayload(
          current,
          input.runtime,
          record.terminal?.outcome === 'cancelled',
        ),
      }],
    );
    return requiredSubmission(target, input.operationId);
  }

  async recordSettlement(input: {
    targetId: string;
    operationId: string;
    settlement: AgentRuntimeDurableSettlement;
  }): Promise<RuntimeSubmissionRecord> {
    const current = this.required(input.targetId, input.operationId);
    if (current.settlement !== null) {
      if (JSON.stringify(current.settlement) !== JSON.stringify(input.settlement)) {
        throw new Error('conflicting durable runtime settlement');
      }
      return current;
    }
    if (current.state !== 'accepted') {
      throw new Error('only an accepted durable submission can settle');
    }
    const target = await this.store.updateTarget(
      input.targetId,
      null,
      (record) => {
        const submission = requiredSubmission(record, input.operationId);
        if (submission.settlement !== null) {
          if (JSON.stringify(submission.settlement) !== JSON.stringify(input.settlement)) {
            throw new Error('conflicting durable runtime settlement');
          }
          return false;
        }
        if (submission.state !== 'accepted') {
          throw new Error('only an accepted durable submission can settle');
        }
        submission.state = 'settled';
        submission.settlement = structuredClone(input.settlement);
        submission.runtime_revision = Math.max(
          submission.runtime_revision,
          input.settlement.revision,
        );
        submission.updated_at = Date.now();
        return true;
      },
      (record) => [{
        payload: {
          kind: 'turn.lifecycle',
          turn_key: current.operation_id,
          status: record.terminal?.outcome === 'cancelled'
            ? 'stopped'
            : input.settlement.status,
        },
      }],
    );
    return requiredSubmission(target, input.operationId);
  }

  async recordSettlementAcknowledged(input: {
    targetId: string;
    operationId: string;
    revision: number;
  }): Promise<RuntimeSubmissionRecord> {
    const current = this.required(input.targetId, input.operationId);
    if (input.revision <= current.settlement_acknowledged_revision) return current;
    if (current.settlement === null || input.revision > current.settlement.revision) {
      throw new Error('settlement acknowledgement is beyond the durable settlement');
    }
    const target = await this.store.updateTarget(
      input.targetId,
      null,
      (record) => {
        const submission = requiredSubmission(record, input.operationId);
        if (input.revision <= submission.settlement_acknowledged_revision) {
          return false;
        }
        if (
          submission.settlement === null ||
          input.revision > submission.settlement.revision
        ) {
          throw new Error(
            'settlement acknowledgement is beyond the durable settlement',
          );
        }
        submission.settlement_acknowledged_revision = input.revision;
        submission.updated_at = Date.now();
        return true;
      },
      (record) => [{
        payload: { kind: 'task.lifecycle', phase: record.phase },
      }],
    );
    return requiredSubmission(target, input.operationId);
  }

  async recordInDoubt(input: {
    targetId: string;
    operationId: string;
    code: string;
  }): Promise<RuntimeSubmissionRecord> {
    const current = this.required(input.targetId, input.operationId);
    if (current.state === 'in_doubt') return current;
    if (current.state !== 'intent' && current.state !== 'accepted') {
      throw new Error('only an unresolved durable submission can become in-doubt');
    }
    const target = await this.store.updateTarget(
      input.targetId,
      null,
      (record) => {
        const submission = requiredSubmission(record, input.operationId);
        if (submission.state === 'in_doubt') return false;
        if (submission.state !== 'intent' && submission.state !== 'accepted') {
          throw new Error(
            'only an unresolved durable submission can become in-doubt',
          );
        }
        submission.state = 'in_doubt';
        submission.updated_at = Date.now();
        if (record.terminal === null) {
          const fromPhase = record.phase;
          record.blocked = {
            from_phase: fromPhase,
            code: 'TASK_SUBMISSION_IN_DOUBT',
            retryable: false,
            at: Date.now(),
          };
          record.phase = 'blocked';
        }
        return true;
      },
      (record) => [{
        payload: {
          kind: 'turn.lifecycle',
          turn_key: current.operation_id,
          status: record.terminal?.outcome === 'cancelled'
            ? 'stopped'
            : 'in_doubt',
        },
      }, ...(record.terminal !== null
        ? []
        : [{
            payload: {
              kind: 'task.lifecycle' as const,
              phase: 'blocked' as const,
              blocked_code: 'TASK_SUBMISSION_IN_DOUBT' as const,
              retryable: false,
            },
          }])],
    );
    return requiredSubmission(target, input.operationId);
  }

  private required(targetId: string, operationId: string): RuntimeSubmissionRecord {
    const submission = this.lookup(targetId, operationId);
    if (submission === null) throw new Error(`unknown task operation '${operationId}'`);
    return submission;
  }
}

function requiredSubmission(
  target: TaskTargetRecord,
  operationId: string,
): RuntimeSubmissionRecord {
  const submission = target.submissions.find(
    (entry) => entry.operation_id === operationId,
  );
  if (submission === undefined) throw new Error(`unknown task operation '${operationId}'`);
  return submission;
}

function assertSameIntent(
  existing: RuntimeSubmissionRecord,
  input: {
    kind: RuntimeSubmissionKind;
    inputDigest: string;
    parentOperationId: string | null;
    toolCallId: string;
    toolCallOrdinal: number;
    runtimeId: string | null;
    runtimeRole: TaskRuntimeRole;
    durabilityNamespace: string | null;
    delivery: AgentRuntimeDurableSubmissionDelivery;
    effect: TaskRuntimeEffect;
  },
): void {
  if (
    existing.kind !== input.kind ||
    existing.input_digest !== input.inputDigest ||
    existing.parent_operation_id !== input.parentOperationId ||
    existing.tool_call_id !== input.toolCallId ||
    existing.tool_call_ordinal !== input.toolCallOrdinal ||
    (input.runtimeId !== null && existing.runtime_id !== input.runtimeId) ||
    existing.runtime_role !== input.runtimeRole ||
    (input.durabilityNamespace !== null &&
      existing.durability_namespace !== input.durabilityNamespace) ||
    canonicalJson(existing.delivery) !== canonicalJson(input.delivery) ||
    canonicalJson(existing.effect) !== canonicalJson(input.effect)
  ) {
    throw new Error('operation id was reused for a different task submission');
  }
}

function assertRuntimeBinding(
  existing: RuntimeSubmissionRecord,
  input: {
    runtimeId: string;
    runtimeRole: TaskRuntimeRole;
    durabilityNamespace: string;
  },
): void {
  if (
    existing.runtime_role !== input.runtimeRole ||
    (existing.runtime_id !== null && existing.runtime_id !== input.runtimeId) ||
    (existing.durability_namespace !== null &&
      existing.durability_namespace !== input.durabilityNamespace)
  ) {
    throw new Error('task submission runtime binding changed');
  }
}

function assertSameRuntimeRecord(
  existing: RuntimeSubmissionRecord,
  runtime: AgentRuntimeDurableSubmissionRecord,
): void {
  if (
    existing.input_digest !== runtime.input_digest ||
    existing.turn_id !== runtime.turn_id ||
    (existing.settlement !== null &&
      JSON.stringify(existing.settlement) !== JSON.stringify(runtime.settlement))
  ) {
    throw new Error('runtime returned a conflicting durable submission record');
  }
}

function eventPayload(
  current: RuntimeSubmissionRecord,
  runtime: AgentRuntimeDurableSubmissionRecord,
  cancelled: boolean,
) {
  if (cancelled) {
    return {
      kind: 'turn.lifecycle' as const,
      turn_key: current.operation_id,
      status: 'stopped' as const,
    };
  }
  if (runtime.settlement === null) {
    return {
      kind: 'turn.lifecycle' as const,
      turn_key: current.operation_id,
      status: 'running' as const,
    };
  }
  return {
    kind: 'turn.lifecycle' as const,
    turn_key: current.operation_id,
    status: runtime.settlement.status,
  };
}
