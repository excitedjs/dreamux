import { RuleViolation } from '../../platform/errors.js';

export const DEFAULT_WORKFLOW_MAX_CONCURRENCY = 16;
export const MIN_WORKFLOW_MAX_CONCURRENCY = 1;
export const MAX_WORKFLOW_MAX_CONCURRENCY = 16;

export function parseWorkflowMaxConcurrency(
  value: unknown,
): number {
  if (value === undefined) {
    return DEFAULT_WORKFLOW_MAX_CONCURRENCY;
  }
  if (
    typeof value !== 'number' ||
    !Number.isInteger(value) ||
    value < MIN_WORKFLOW_MAX_CONCURRENCY ||
    value > MAX_WORKFLOW_MAX_CONCURRENCY
  ) {
    throw new RuleViolation(
      `workflow max_concurrency must be an integer between ` +
        `${MIN_WORKFLOW_MAX_CONCURRENCY} and ${MAX_WORKFLOW_MAX_CONCURRENCY}`,
    );
  }
  return value;
}
