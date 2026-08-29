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

/**
 * The TeamLeader generation the caller holds is no longer the current one.
 *
 * Deliberately NOT reported as a closed Team: the Team is still open, and
 * `TEAM_CLOSED` is a published, retryable fact a Channel acts on by dropping
 * its binding. A superseded lease is neither retryable nor a Team lifecycle
 * fact, so it carries its own code.
 */
export class TeamGenerationChangedError extends DreamuxError {
  constructor(message: string) {
    super('TEAM_GENERATION_CHANGED', message);
  }
}

/** The three facts that mean a Team cannot take work through this lease now. */
export function isTeamUnavailable(error: unknown): boolean {
  return (
    error instanceof TeamNotFoundError ||
    error instanceof TeamClosedError ||
    error instanceof TeamGenerationChangedError
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

export class TeamDissolveBlockedError extends DreamuxError {
  constructor(public readonly reason: WorktreeCleanupBlockedReason) {
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

/** Process-local suspension; the durable dissolve remains active for restart. */
export class TeamDissolveInterruptedError extends DreamuxError {
  constructor() {
    super(
      'TEAM_DISSOLVE_FAILED',
      'Team dissolve was suspended for dispatcher shutdown',
    );
  }
}

export function teamErrorInfo(error: unknown): Record<string, unknown> {
  if (error instanceof Error) {
    return { type: error.name, message: error.message, stack: error.stack };
  }
  return { value: String(error) };
}

/**
 * Re-throw one failed dissolve as the failure its caller should read.
 *
 * Both caller-facing surfaces make the same two judgements, so they make them
 * here rather than each in its own words: a Team that cannot be dissolved
 * because it is already gone is, to the caller, the same fact as a missing one;
 * and the useful part of a blocked dissolve is the reason token itself, not the
 * internal sentence built around it.
 */
export function throwPublicDissolveError(error: unknown): never {
  if (isTeamUnavailable(error)) {
    throw new TeamNotFoundError(errorMessage(error));
  }
  if (error instanceof TeamDissolveBlockedError) {
    throw new DreamuxError('TEAM_DISSOLVE_BLOCKED', error.reason);
  }
  throw toDreamuxError(error);
}
