import type { AgentRuntimeStateStore } from '../../agent-runtime/index.js';
import type { DispatcherStatus } from '../../state/dispatcher-store.js';
import type { TeamMateIdentityStore } from './identity-store.js';
import {
  runtimeStatusToIdentityStatus,
  type TeamMateIdentity,
} from './types.js';
import { preview } from './turns-store.js';

export class TeamMateRuntimeStateStore implements AgentRuntimeStateStore {
  constructor(
    private readonly store: TeamMateIdentityStore,
    private identity: TeamMateIdentity,
  ) {}

  current(): TeamMateIdentity {
    return this.identity;
  }

  /**
   * Update the recorded recovery subject (issue #182 PR-3 `send` intent). Kept
   * on this store so the live identity snapshot returned by `current()` stays in
   * sync with the persisted record.
   */
  async updateIntent(intent: string): Promise<void> {
    this.identity = await this.store.update(this.identity, { intent });
  }

  /**
   * Bump the record's rolling recovery summary when a turn is submitted (issue
   * #199 Slice 3). Routed through this store so the live `current()` snapshot
   * stays canonical and a later status/thread write never clobbers the bump.
   */
  async recordSubmittedTurn(prompt: string): Promise<void> {
    this.identity = await this.store.update(this.identity, {
      turnCount: this.identity.turn_count + 1,
      lastSeenAt: Date.now(),
      lastPromptPreview: preview(prompt),
    });
  }

  /** Record the most recent settled assistant output on the rolling summary. */
  async recordSettledTurn(assistant: string | null): Promise<void> {
    this.identity = await this.store.update(this.identity, {
      lastSeenAt: Date.now(),
      ...(assistant !== null ? { lastAssistantPreview: preview(assistant) } : {}),
    });
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
    // #199 Slice 3: persist the runtime-native thread id directly as the public
    // session_id. The resume checkpoint KIND is never persisted — it is rebuilt
    // from the runtime's own declared capability when reopening.
    this.identity = await this.store.update(this.identity, {
      sessionId: threadId,
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
