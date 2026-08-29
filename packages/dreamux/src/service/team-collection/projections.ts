/**
 * The Team result projections both caller-facing surfaces share.
 *
 * A Team is reachable two ways — the canonical Commands (`admin.sock` and the
 * in-process Channel invoker) and the Team MCP delegate — and they must not
 * disagree about what a submission receipt looks like. Two copies of that
 * answer is exactly the drift this module exists to prevent, so the shape
 * lives here and both surfaces call it.
 *
 * Argument parsing stays with each surface: one reads a Command payload, the
 * other reads SDK-validated tool arguments, and those are genuinely different
 * inputs to the same operation.
 */
import type { TeamSubmitResult } from '@excitedjs/dreamux-types';

import type { TurnAdmission } from '../teammate-service/turn-recording.js';

/** The canonical public receipt of one TeamLeader submission. */
export function teamSubmitResult(admission: TurnAdmission): TeamSubmitResult {
  switch (admission.status) {
    case 'submitted':
      return { status: 'submitted', turn_id: admission.turn.id };
    case 'duplicate':
      // Core returned before runtime admission, so there is no second turn
      // identity to report.
      return { status: 'duplicate' };
    case 'stopped':
      return { status: 'stopped' };
    // The provider seam's internal `skipped` is normalized at this boundary.
    case 'skipped':
      return {
        status: 'stopped',
        error: { code: 'TURN_SKIPPED', message: 'turn skipped' },
      };
    case 'failed':
      return {
        status: 'failed',
        error: { code: 'TEAM_SUBMIT_FAILED', message: admission.error.message },
      };
    case 'ambiguous':
      return {
        status: 'ambiguous',
        error: {
          code: 'TEAM_SUBMIT_AMBIGUOUS',
          message: admission.error.message,
        },
      };
  }
}
