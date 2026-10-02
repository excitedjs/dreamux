import { RuleViolation } from '@excitedjs/dreamux-utils';

export const DEFAULT_WORKFLOW_MAX_CONCURRENCY = 16;
export const MIN_WORKFLOW_MAX_CONCURRENCY = 1;
export const MAX_WORKFLOW_MAX_CONCURRENCY = 16;

/** Documented in `.agents/product/dynamic-workflow-usage.md#5.3`: a run can
 * start at most this many agents over its lifetime. */
export const MAX_AGENTS = 1000;

/** Documented in `.agents/product/dynamic-workflow-usage.md#5.3`: the item
 * cap shared by the `parallel()` and `pipeline()` script helpers. */
export const MAX_HELPER_ITEMS = 4096;

/** Internal read-size safety cap on a `scriptPath` file; not a user-facing
 * bound, so it is not in the product doc's exact-limits list. */
export const MAX_SCRIPT_BYTES = 1024 * 1024;

/**
 * Bounds-only check on an already-integer-or-defaulted value.
 *
 * The shape check (is it an integer at all) happens once, in the request
 * reader (`requests.ts`'s `workflowRunInput`, via the generic
 * `optionalInteger`); re-checking `typeof`/`Number.isInteger` here would
 * duplicate that.
 */
export function assertWorkflowMaxConcurrency(value: number): void {
  if (
    value < MIN_WORKFLOW_MAX_CONCURRENCY ||
    value > MAX_WORKFLOW_MAX_CONCURRENCY
  ) {
    throw new RuleViolation(
      `workflow max_concurrency must be an integer between ` +
        `${MIN_WORKFLOW_MAX_CONCURRENCY} and ${MAX_WORKFLOW_MAX_CONCURRENCY}`,
    );
  }
}
