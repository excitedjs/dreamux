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
    await this.update({
      sessionId: checkpoint.id,
      transcriptLocator: checkpoint.transcript_locator ?? null,
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
