export class TeamUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TeamUnavailableError';
  }
}

export class TeamDissolveBlockedError extends Error {
  constructor(public readonly reason: WorktreeCleanupBlockedReason) {
    super(`Team dissolve is blocked because the managed worktree is ${reason}`);
    this.name = 'TeamDissolveBlockedError';
  }
}

export class TeamDissolveFailedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TeamDissolveFailedError';
  }
}

/** Process-local suspension; the durable dissolve remains active for restart. */
export class TeamDissolveInterruptedError extends Error {
  constructor() {
    super('Team dissolve was suspended for dispatcher shutdown');
    this.name = 'TeamDissolveInterruptedError';
  }
}

export function teamErrorInfo(error: unknown): Record<string, unknown> {
  if (error instanceof Error) {
    return { type: error.name, message: error.message, stack: error.stack };
  }
  return { value: String(error) };
}
import type { WorktreeCleanupBlockedReason } from '../worktree/manager.js';
