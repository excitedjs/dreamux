import { randomUUID } from 'node:crypto';

import type {
  AgentRuntimeResumeCheckpoint,
  AgentRuntimeStateStore,
} from '../../agent-runtime/index.js';
import type { DispatcherStatus } from '../../state/dispatcher-store.js';
import type { TeamMateIdentityStore } from './identity-store.js';
import {
  runtimeStatusToIdentityStatus,
  type TeamMateIdentity,
} from './types.js';

export class TeamMateRuntimeStateStore implements AgentRuntimeStateStore {
  constructor(
    private readonly store: TeamMateIdentityStore,
    private identity: TeamMateIdentity,
    private readonly checkpointKind: AgentRuntimeResumeCheckpoint['kind'] | null,
  ) {}

  current(): TeamMateIdentity {
    return this.identity;
  }

  /**
   * Ensure the live identity carries a stable session id (issue #182 PR-5,
   * PR #187 review P3): a teammate spawned before PR-5 has `session_id: null`,
   * which would make every post-upgrade lifecycle event skip the session
   * ledger. Mint and persist one lazily on the first such event. Minting goes
   * through this store so its in-memory copy stays in sync — a later
   * status/thread write must not clobber the file back to a null session id. It
   * is a fresh id, never re-keyed to the runtime thread/checkpoint id.
   */
  async ensureSessionId(): Promise<string> {
    const current = this.identity.session_id;
    if (current !== null) return current;
    const sessionId = randomUUID();
    this.identity = await this.store.update(this.identity, { sessionId });
    return sessionId;
  }

  /**
   * Update the recorded recovery subject (issue #182 PR-3 `send` intent). Kept
   * on this store so the live identity snapshot returned by `current()` stays in
   * sync with the persisted record.
   */
  async updateIntent(intent: string): Promise<void> {
    this.identity = await this.store.update(this.identity, { intent });
  }

  async setStatus(
    _id: string,
    status: DispatcherStatus,
    extras: {
      last_error?: string | null;
      last_started_at?: number;
      last_ready_at?: number;
    } = {},
  ): Promise<void> {
    this.identity = await this.store.update(this.identity, {
      status: runtimeStatusToIdentityStatus(status),
      ...(extras.last_error !== undefined
        ? { lastError: extras.last_error }
        : {}),
    });
  }

  async setThreadId(_id: string, threadId: string): Promise<void> {
    // A runtime that declares no resume support has no checkpoint kind, so there
    // is nothing to persist a resumable checkpoint under.
    if (this.checkpointKind === null) return;
    this.identity = await this.store.update(this.identity, {
      checkpoint: { kind: this.checkpointKind, id: threadId },
    });
  }

  async recordLostThread(
    id: string,
    _lostThreadId: string,
    newThreadId: string,
    error: string,
  ): Promise<void> {
    await this.setThreadId(id, newThreadId);
    this.identity = await this.store.update(this.identity, {
      status: 'degraded',
      lastError: error,
    });
  }
}
