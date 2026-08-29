import type {
  AgentRuntimeSessionRef,
  AgentRuntimeStateSink,
  AgentRuntimeStateUpdate,
  AgentRuntimeStatus,
} from '@excitedjs/dreamux-types';
import {
  canonicalJsonValue,
  isPlainObject,
  JsonValueError,
} from '../../platform/json-value.js';
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
 * The `Error` an invalid session ref rejects with. It is an ordinary
 * persistence failure from the provider's point of view: the contract requires
 * a JSON-serializable session, and Core will not persist a value it cannot
 * return unchanged.
 */
export class AgentRuntimeSessionRefInvalid extends Error {
  override readonly name = 'AgentRuntimeSessionRefInvalidError';

  constructor(runtimeName: string, detail: string) {
    super(
      `the session published by ${JSON.stringify(runtimeName)} is not JSON-serializable: ${detail}`,
    );
  }
}

/** Core's independent bounds on a persisted session ref. */
const SESSION_JSON_BOUNDS = {
  maxDepth: 8,
  maxEntries: 256,
  maxBytes: 8192,
} as const;

/**
 * One runtime generation's push-only write authority.
 *
 * State and activity share the generation: revoking it both fences the state
 * writer and silences the activity of a runtime that has been replaced.
 */
export interface AgentRuntimeGenerationLease {
  /** The leased state sink handed to this generation's create context. */
  readonly state: AgentRuntimeStateSink<AgentRuntimeSessionRef>;
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
  private mutationTail: Promise<void> = Promise.resolve();

  private currentLease = 0;

  private lastRuntimeStatus: AgentRuntimeStatus | null = null;

  constructor(
    private readonly store: AgentIdentityStore,
    private identity: AgentEntityIdentity,
  ) {}

  current(): AgentEntityIdentity {
    return this.identity;
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

  private async publish(
    lease: number,
    update: AgentRuntimeStateUpdate<AgentRuntimeSessionRef>,
  ): Promise<void> {
    if (lease !== this.currentLease) {
      throw new AgentRuntimeStateLeaseRevoked(this.identity.name);
    }
    // Validate and copy before anything is queued: Core persists a session as
    // opaque JSON and returns it to the provider verbatim, so a value
    // `JSON.stringify` would silently reshape (functions, `undefined`) or choke
    // on (cycles, BigInt) must be rejected rather than written.
    const durable = canonicalStateUpdate(update, this.identity.name);
    await this.enqueue(async () => {
      // Re-check inside the serialized tail: a lease can be revoked while this
      // write was queued behind an earlier one.
      if (lease !== this.currentLease) {
        throw new AgentRuntimeStateLeaseRevoked(this.identity.name);
      }
      this.identity = await this.store.update(
        this.identity,
        identityPatch(durable),
      );
      if (durable.kind === 'status') this.lastRuntimeStatus = durable.status;
      return this.identity;
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

function identityPatch(
  update: AgentRuntimeStateUpdate<AgentRuntimeSessionRef>,
): AgentIdentityUpdateInput {
  if (update.kind === 'session') {
    return { session: update.session };
  }
  if (update.kind === 'session_lost') {
    // The session stays persisted: a provider that cannot restore it must fail
    // its next start loudly rather than quietly continue from a fresh one.
    return { status: 'degraded', lastError: update.reason };
  }
  return {
    status: runtimeStatusToIdentityStatus(update.status),
    ...(update.lastError !== undefined ? { lastError: update.lastError } : {}),
  };
}

/**
 * Return `update` with any published session replaced by a validated, frozen
 * deep copy. Only `id` is interpreted; the rest is opaque provider data that
 * Core must be able to persist and hand back unchanged.
 */
function canonicalStateUpdate(
  update: AgentRuntimeStateUpdate<AgentRuntimeSessionRef>,
  runtimeName: string,
): AgentRuntimeStateUpdate<AgentRuntimeSessionRef> {
  if (update.kind !== 'session') return update;
  return {
    kind: 'session',
    session: canonicalSessionRef(update.session, runtimeName),
  };
}

function canonicalSessionRef(
  session: AgentRuntimeSessionRef,
  runtimeName: string,
): AgentRuntimeSessionRef {
  if (!isPlainObject(session)) {
    throw new AgentRuntimeSessionRefInvalid(
      runtimeName,
      'session must be an object',
    );
  }
  if (typeof session.id !== 'string' || session.id.length === 0) {
    throw new AgentRuntimeSessionRefInvalid(
      runtimeName,
      'session.id must be a non-empty string',
    );
  }
  try {
    // The canonical value is a validated JSON object whose `id` was checked
    // above; `AgentRuntimeSessionRef` is an interface, so it needs the explicit
    // widening step rather than a direct structural assertion.
    return canonicalJsonValue(
      session,
      SESSION_JSON_BOUNDS,
    ) as unknown as AgentRuntimeSessionRef;
  } catch (error) {
    if (error instanceof JsonValueError) {
      throw new AgentRuntimeSessionRefInvalid(runtimeName, error.message);
    }
    throw error;
  }
}
