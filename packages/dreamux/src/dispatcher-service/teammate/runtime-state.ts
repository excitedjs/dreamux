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
    await this.store.appendHistory(this.identity, {
      type: 'state',
      note: status,
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
    await this.store.appendHistory(this.identity, {
      type: 'state',
      note: error,
    });
  }
}
