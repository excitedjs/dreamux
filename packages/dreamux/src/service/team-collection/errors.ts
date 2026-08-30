import { DreamuxError, errorMessage, toDreamuxError } from '../../platform/errors.js';
import type { WorktreeCleanupBlockedReason } from '../worktree/manager.js';

/**
 * The Team does not exist.
 *
 * A valid, readable Team record is the only proof a Team exists, so missing,
 * malformed, and unreadable all arrive here. The name is free again.
 */
export class TeamNotFoundError extends DreamuxError {
  constructor(message: string) {
    super('TEAM_NOT_FOUND', message);
  }
}

/** The Team exists but is closed, closing, or dissolving. */
export class TeamClosedError extends DreamuxError {
  constructor(message: string) {
    super('TEAM_CLOSED', message);
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
export class IdempotencyConflictError extends DreamuxError {
  constructor(message: string) {
    super('IDEMPOTENCY_CONFLICT', message);
  }
}

/**
 * Why a submitted dissolve stopped short, for the operator log.
 *
 * A dissolve is answered with a receipt before any of this is known, so these
 * two never reach a caller: they exist to say in the log whether the Team is
 * still open because its checkout holds work somebody wants, or because the
 * dissolve itself went wrong. Nothing advertises them as public failures.
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

/**
 * Re-throw one refused dissolve submission as the failure its caller reads.
 *
 * Only the submission can fail here — whether this Team can actually be taken
 * apart is decided behind the receipt — so there is one judgement left, and
 * both caller-facing surfaces make it here rather than each in its own words: a
 * Team that cannot be dissolved because it is already gone is, to the caller,
 * the same fact as a missing one.
 */
export function throwPublicDissolveError(error: unknown): never {
  if (isTeamUnavailable(error)) {
    throw new TeamNotFoundError(errorMessage(error));
  }
  throw toDreamuxError(error);
}
