import { DreamuxError, StatedFailure } from '../../platform/errors.js';
import type { WorktreeCleanupBlockedReason } from '../worktree/manager.js';

/**
 * The Team does not exist.
 *
 * A valid, readable Team record is the only proof a Team exists, so missing,
 * malformed, and unreadable all arrive here. The name is free again.
 */
export class TeamNotFoundError extends StatedFailure {
  constructor(message: string) {
    super(
      'TEAM_NOT_FOUND',
      message,
      'Re-read the Team list this surface offers and use an exact name from ' +
        'it; a guessed or misspelled name never resolves.',
    );
  }
}

/** The Team exists but is closed, closing, or dissolving. */
export class TeamClosedError extends StatedFailure {
  constructor(message: string) {
    super(
      'TEAM_CLOSED',
      message,
      'A closed Team never takes work again; create a new Team for the ' +
        'follow-up, and read the closed one through this surface\'s history.',
    );
  }
}

/** Both facts that mean a Team cannot take work now. */
export function isTeamUnavailable(error: unknown): boolean {
  return (
    error instanceof TeamNotFoundError || error instanceof TeamClosedError
  );
}

/**
 * The same `request_id` was replayed with a different canonical payload.
 *
 * The accepted request identity lives in the Team record it produced, so this
 * is decided against that record: the caller must start a new provisioning
 * generation with a new id rather than retry.
 */
export class IdempotencyConflictError extends StatedFailure {
  constructor(message: string) {
    super(
      'IDEMPOTENCY_CONFLICT',
      message,
      'This request_id is settled and cannot be retried; start a new ' +
        'provisioning generation with a new request_id.',
    );
  }
}

/**
 * Why a submitted dissolve stopped short, for the operator log.
 *
 * A dissolve is answered with a receipt before any of this is known, so these
 * two never reach a caller: they exist to say in the log whether the Team is
 * still open because its checkout holds work somebody wants, or because the
 * dissolve itself went wrong. Neither states a next step, because neither is
 * answering anybody.
 */
export class TeamDissolveBlockedError extends DreamuxError {
  constructor(reason: WorktreeCleanupBlockedReason) {
    super(
      'TEAM_DISSOLVE_BLOCKED',
      `Team dissolve is blocked because the managed worktree is ${reason}`,
    );
  }
}

export class TeamDissolveFailedError extends DreamuxError {
  constructor(message: string) {
    super('TEAM_DISSOLVE_FAILED', message);
  }
}

export function teamErrorInfo(error: unknown): Record<string, unknown> {
  if (error instanceof Error) {
    return { type: error.name, message: error.message, stack: error.stack };
  }
  return { value: String(error) };
}
