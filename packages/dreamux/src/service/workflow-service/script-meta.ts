import type { WorkflowScriptMeta } from './protocol.js';
import { isRecord } from './run-support.js';

export function assertWorkflowScriptMeta(
  value: unknown,
): asserts value is WorkflowScriptMeta {
  if (!isRecord(value)) {
    throw new Error('workflow script must export meta');
  }
  if (typeof value.name !== 'string' || typeof value.description !== 'string') {
    throw new Error('workflow meta must include string name and description');
  }
  if (
    value.phases !== undefined &&
    (!Array.isArray(value.phases) ||
      value.phases.some((phase: unknown) => !isWorkflowPhase(phase)))
  ) {
    throw new Error(
      'workflow meta phases must contain strings or objects with string title',
    );
  }
  if (value.whenToUse !== undefined && typeof value.whenToUse !== 'string') {
    throw new Error('workflow meta whenToUse must be a string');
  }
}

function isWorkflowPhase(value: unknown): boolean {
  return (
    typeof value === 'string' ||
    (
      isRecord(value) &&
      typeof value.title === 'string' &&
      (value.detail === undefined || typeof value.detail === 'string') &&
      (value.model === undefined || typeof value.model === 'string')
    )
  );
}
