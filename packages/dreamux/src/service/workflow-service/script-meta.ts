import type { WorkflowScriptMeta } from './protocol.js';
import { isRecord } from './run-support.js';

type WorkflowScriptDialect = 'legacy' | 'ultracode';

export function assertWorkflowScriptMeta(
  value: unknown,
  dialect: WorkflowScriptDialect,
): asserts value is WorkflowScriptMeta {
  if (!isRecord(value)) {
    throw new Error('workflow script must export meta');
  }
  if (typeof value.name !== 'string' || typeof value.description !== 'string') {
    throw new Error('workflow meta must include string name and description');
  }

  if (dialect === 'ultracode') {
    assertWorkflowWhenToUse(value.whenToUse);
    assertWorkflowPhases(value.phases, dialect);
    return;
  }
  assertWorkflowPhases(value.phases, dialect);
  assertWorkflowWhenToUse(value.whenToUse);
}

function assertWorkflowWhenToUse(value: unknown): void {
  if (value !== undefined && typeof value !== 'string') {
    throw new Error('workflow meta whenToUse must be a string');
  }
}

function assertWorkflowPhases(
  value: unknown,
  dialect: WorkflowScriptDialect,
): void {
  if (value === undefined) return;
  if (!Array.isArray(value)) {
    throw new Error(
      dialect === 'ultracode'
        ? 'workflow meta phases must be an array'
        : 'workflow meta phases must contain strings or objects with string title',
    );
  }
  for (const phase of value) {
    const error = workflowPhaseError(phase);
    if (error === null) continue;
    throw new Error(
      dialect === 'ultracode'
        ? error
        : 'workflow meta phases must contain strings or objects with string title',
    );
  }
}

function workflowPhaseError(value: unknown): string | null {
  if (typeof value === 'string') return null;
  if (!isRecord(value) || typeof value.title !== 'string') {
    return 'workflow meta phases must contain strings or objects with string title';
  }
  for (const key of ['detail', 'model'] as const) {
    if (value[key] !== undefined && typeof value[key] !== 'string') {
      return `workflow meta phase ${key} must be a string`;
    }
  }
  return null;
}
