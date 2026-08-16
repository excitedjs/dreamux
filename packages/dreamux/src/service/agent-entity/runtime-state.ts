import type {
  AgentRuntimeResumeCheckpoint,
  AgentRuntimeStatus,
  AgentRuntimeStateCallbacks,
} from '@excitedjs/dreamux-types';
import type { AgentIdentityStore } from './identity-store.js';
import type { AgentIdentityUpdateInput } from './identity-store.js';
import {
  runtimeStatusToIdentityStatus,
  type AgentEntityIdentity,
  type AgentEntityTurnRecord,
} from './types.js';

export class AgentRuntimeStateStore implements AgentRuntimeStateCallbacks {
  private mutationTail: Promise<void> = Promise.resolve();

  constructor(
    private readonly store: AgentIdentityStore,
    private identity: AgentEntityIdentity,
  ) {}

  current(): AgentEntityIdentity {
    return this.identity;
  }

  /**
   * Update the recorded recovery subject (issue #182 PR-3 `send` intent). Kept
   * on this store so the live identity snapshot returned by `current()` stays in
   * sync with the persisted record.
   */
  async updateIntent(intent: string): Promise<void> {
    await this.update({ intent });
  }

  /** Project one already-committed terminal row into the rolling identity. */
  async recordTerminalTurn(row: AgentEntityTurnRecord): Promise<void> {
    await this.mutate((current) => ({
      turnCount: current.turn_count + 1,
      lastSeenAt: row.settled_at,
      lastPromptPreview: row.prompt_preview,
      ...(row.assistant_preview !== null
        ? { lastAssistantPreview: row.assistant_preview }
        : {}),
    }));
  }

  update(input: AgentIdentityUpdateInput): Promise<AgentEntityIdentity> {
    return this.mutate(() => input);
  }

  transact(
    task: (current: AgentEntityIdentity) => Promise<AgentEntityIdentity>,
  ): Promise<AgentEntityIdentity> {
    return this.enqueue(async () => {
      this.identity = await task(this.identity);
      return this.identity;
    });
  }

  async setStatus(
    status: AgentRuntimeStatus,
    extras: {
      last_error?: string | null;
      last_started_at?: number;
      last_ready_at?: number;
    } = {},
  ): Promise<void> {
    await this.update({
      status: runtimeStatusToIdentityStatus(status),
      ...(extras.last_error !== undefined
        ? { lastError: extras.last_error }
        : {}),
    });
  }

  async setCheckpoint(checkpoint: AgentRuntimeResumeCheckpoint): Promise<void> {
    // #199 Slice 3: persist the runtime-native thread id directly as the public
    // session_id. Runtime packages interpret the id in their own native format
    // when reopened.
    await this.update({
      sessionId: checkpoint.id,
    });
  }

  async recordLostCheckpoint(
    _lost: AgentRuntimeResumeCheckpoint,
    replacement: AgentRuntimeResumeCheckpoint,
    error: string,
  ): Promise<void> {
    await this.setCheckpoint(replacement);
    await this.update({
      status: 'degraded',
      lastError: error,
    });
  }

  private mutate(
    patch: (current: AgentEntityIdentity) => AgentIdentityUpdateInput,
  ): Promise<AgentEntityIdentity> {
    return this.enqueue(async () => {
      this.identity = await this.store.update(this.identity, patch(this.identity));
      return this.identity;
    });
  }

  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const result = this.mutationTail.then(task, task);
    this.mutationTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}
