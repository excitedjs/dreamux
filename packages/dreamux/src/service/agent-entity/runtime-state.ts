import type {
  AgentRuntimeStateSink,
  AgentRuntimeStateUpdate,
  AgentRuntimeStatus,
} from '@excitedjs/dreamux-types';
import type { AgentIdentityStore } from './identity-store.js';
import type { AgentIdentityUpdateInput } from './identity-store.js';
import {
  runtimeStatusToIdentityStatus,
  type AgentEntityIdentity,
} from './types.js';

/**
 * The `Error` a revoked lease rejects with. Providers branch on `error.name`,
 * so the name is the contract; the class exists only so Core can throw it.
 */
export class AgentRuntimeStateLeaseRevoked extends Error {
  override readonly name = 'AgentRuntimeStateLeaseRevokedError';

  constructor(runtimeName: string) {
    super(
      `the state lease for ${JSON.stringify(runtimeName)} was revoked by a newer runtime generation`,
    );
  }
}

/**
 * The `Error` an empty published session id rejects with. It is an ordinary
 * persistence failure from the provider's point of view: an empty id is
 * indistinguishable from "no session", so Core refuses to persist it rather
 * than record a resume coordinate it cannot resume from.
 */
export class AgentRuntimeSessionIdInvalid extends Error {
  override readonly name = 'AgentRuntimeSessionIdInvalidError';

  constructor(runtimeName: string) {
    super(
      `the session id published by ${JSON.stringify(runtimeName)} is empty; ` +
        'an empty id cannot be told apart from having no session',
    );
  }
}

/**
 * One runtime generation's push-only write authority.
 *
 * State and activity share the generation: revoking it both fences the state
 * writer and silences the activity of a runtime that has been replaced.
 */
export interface AgentRuntimeGenerationLease {
  /** The leased state sink handed to this generation's create context. */
  readonly state: AgentRuntimeStateSink;
  /** True while this generation still owns the entity. */
  isCurrent(): boolean;
}

/**
 * The durable owner of one agent entity's identity record, and the source of the
 * leased, push-only write authority its runtimes publish through.
 *
 * Core is the sole state authority: a runtime never pulls state back out. Each
 * generation gets its own lease from {@link leaseRuntimeGeneration}; opening a
 * new one revokes the previous, so a stale writer that survived a replacement
 * fails loudly instead of overwriting its successor's facts. Writes are
 * serialized in call-receipt order and each `publish` resolves only after the
 * identity write is durable, which is what lets a provider treat awaiting its
 * own publishes as the start fence.
 */
export class AgentRuntimeStateStore {
  private currentLease = 0;

  private lastRuntimeStatus: AgentRuntimeStatus | null = null;

  /**
   * Immutable once set at construction. Used only for error-message text
   * (`AgentRuntimeStateLeaseRevoked`/`AgentRuntimeSessionIdInvalid`) — the
   * live identity itself is read from `this.store`, never kept here as a
   * second copy.
   */
  private readonly entityName: string;

  constructor(
    private readonly store: AgentIdentityStore,
    identity: AgentEntityIdentity,
    /**
     * Fired after a create, an upsert, or an update that changed status.
     * `AgentIdentityStoreBinding` no longer carries this — it has no
     * construction-time answer for a store several long-lived owners share
     * (the dispatcher root, a Team's leader) — so every write this store
     * makes passes it explicitly instead.
     */
    private readonly onPersisted: (identity: AgentEntityIdentity) => void,
  ) {
    this.entityName = identity.name;
  }

  current(): AgentEntityIdentity {
    const identity = this.store.current();
    if (identity === null) {
      throw new Error(
        `agent entity ${JSON.stringify(this.entityName)} has no identity`,
      );
    }
    return identity;
  }

  /**
   * The most recent runtime status the leased sink accepted. This store is the
   * single authority for it: Core never asks a runtime what its status is, and
   * never keeps a second copy elsewhere.
   */
  runtimeStatus(): AgentRuntimeStatus | null {
    return this.lastRuntimeStatus;
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
    return this.store.update(input, this.onPersisted);
  }

  transact(
    task: (
      current: AgentEntityIdentity,
    ) => AgentIdentityUpdateInput | Promise<AgentIdentityUpdateInput>,
  ): Promise<AgentEntityIdentity> {
    return this.store.update(task, this.onPersisted);
  }

  /**
   * Open a fresh lease for one runtime generation and revoke any prior one. The
   * generation counter is Core-private: it never appears on the sink, and the
   * provider supplies no sequence number of its own.
   */
  leaseRuntimeGeneration(): AgentRuntimeGenerationLease {
    this.currentLease += 1;
    const lease = this.currentLease;
    return {
      state: {
        publish: (update) => this.publish(lease, update),
      },
      isCurrent: () => lease === this.currentLease,
    };
  }

  /**
   * Revoke the current generation without opening a new one (runtime stopped, or
   * a start that failed and released everything it took). It fences both leased
   * sinks at once: the state writer starts rejecting, and the activity closure
   * bound to this generation stops being current.
   */
  revokeRuntimeGeneration(): void {
    this.currentLease += 1;
    this.lastRuntimeStatus = null;
  }

  private publish(
    lease: number,
    update: AgentRuntimeStateUpdate,
  ): Promise<void> {
    if (lease !== this.currentLease) {
      throw new AgentRuntimeStateLeaseRevoked(this.entityName);
    }
    // Reject before anything is queued: a session id Core cannot resume from is
    // a persistence failure the provider must see synchronously.
    if (update.kind === 'session' && update.sessionId.length === 0) {
      throw new AgentRuntimeSessionIdInvalid(this.entityName);
    }
    return this.store
      .update(() => {
        // Re-check inside `change`: a lease can be revoked while this write
        // was queued behind an earlier one on the store's own serialized
        // tail. `identityPatch(update)` reads no `current`, so the check is
        // the only reason this callback runs at all.
        if (lease !== this.currentLease) {
          throw new AgentRuntimeStateLeaseRevoked(this.entityName);
        }
        return identityPatch(update);
      }, this.onPersisted)
      .then(() => {
        if (update.kind === 'status') this.lastRuntimeStatus = update.status;
      });
  }
}

function identityPatch(
  update: AgentRuntimeStateUpdate,
): AgentIdentityUpdateInput {
  if (update.kind === 'session') {
    return { sessionId: update.sessionId };
  }
  if (update.kind === 'session_lost') {
    // The session id stays persisted: a provider that cannot restore it must
    // fail its next start loudly rather than quietly continue from a fresh one.
    return { status: 'degraded', lastError: update.reason };
  }
  return {
    status: runtimeStatusToIdentityStatus(update.status),
    lastError: update.lastError,
  };
}
