/**
 * The one Workflow fact a caller can act on.
 *
 * A run id that names nothing was a plain `Error`, which made it `INTERNAL` to
 * every adapter: a caller that mistyped a run id, or asked about one this
 * dispatcher never owned, was told that something went wrong on the server. It
 * is an ordinary business failure — the service knows exactly what is true — so
 * it carries its own stable code, and only genuinely unclassified failures stay
 * `INTERNAL`.
 */
import { StatedFailure } from '../../platform/errors.js';

export class WorkflowRunNotFoundError extends StatedFailure {
  constructor(message: string) {
    super(
      'WORKFLOW_RUN_NOT_FOUND',
      message,
      'List the Workflow runs this agent owns through this surface and use an ' +
        'exact run_id from that list; the id a run was accepted under is the ' +
        'only one that resolves.',
    );
  }
}
