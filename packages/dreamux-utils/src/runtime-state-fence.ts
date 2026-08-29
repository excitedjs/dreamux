/**
 * The provider-local fatal path for authoritative state writes.
 *
 * Core's leased state sink is the single authority for an agent entity's
 * durable facts, and a runtime has no way to reconcile after a write it cannot
 * land: continuing would keep a native child alive whose observable state no
 * longer matches what Core persisted. So every write failure is terminal, in
 * exactly one of two shapes:
 *
 * - the lease was revoked, meaning a newer generation already owns the entity
 *   and this writer must disappear; or
 * - the write failed for any other reason, meaning Core's record of this
 *   runtime is stale and cannot be repaired from here.
 *
 * Both close the fence, which fences further input, tears the native runtime
 * down once, and stops any restart loop. Awaited callers still see the original
 * error; fire-and-forget callers use {@link RuntimeStateFence.publishDetached}
 * so a background write can never surface as an unhandled rejection.
 *
 * Termination stays provable: the teardown promise keeps its rejection for
 * {@link RuntimeStateFence.terminated}, which the runtime's public `stop()`
 * joins. A fatal teardown that failed therefore surfaces as a failed stop —
 * with the native authority still retained for a retry — instead of a runtime
 * that reports itself stopped while its child may still be alive.
 */

/**
 * The `error.name` Core's revoked state lease rejects with. It is the contract
 * a provider classifies on; the class itself is Core-private.
 */
export const STATE_LEASE_REVOKED_ERROR_NAME =
  'AgentRuntimeStateLeaseRevokedError';

export type RuntimeStateFenceReason = 'lease_revoked' | 'persist_failed';

/** Thrown to an awaited caller that reaches the fence after it closed. */
export class RuntimeStateFencedError extends Error {
  override readonly name = 'RuntimeStateFencedError';

  constructor(readonly reason: RuntimeStateFenceReason) {
    super(`agent runtime is fenced after a fatal state write (${reason})`);
  }
}

export function isStateLeaseRevoked(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { name?: unknown }).name === STATE_LEASE_REVOKED_ERROR_NAME
  );
}

export interface RuntimeStateFenceOptions {
  /**
   * The runtime's own native teardown — closing the child/transport and
   * settling in-flight work. It must NOT be the public `stop()`: `stop()`
   * publishes its own terminal state, which is exactly what cannot land once
   * the fence is closed.
   *
   * Two requirements the fence relies on and does not defend against: it must
   * be an async function (a synchronous throw would escape {@link
   * RuntimeStateFence.close} and mask the state-write failure that caused it),
   * and it must fence input synchronously before its first `await`, because
   * {@link RuntimeStateFence.close} returns as soon as it has been called.
   */
  terminate(): Promise<void>;
  log(level: 'warn' | 'error', message: string, error?: unknown): void;
}

export class RuntimeStateFence {
  private closedReason: RuntimeStateFenceReason | null = null;
  private teardown: Promise<void> | null = null;

  constructor(private readonly options: RuntimeStateFenceOptions) {}

  get isFenced(): boolean {
    return this.closedReason !== null;
  }

  /** Throw if the fence has already closed. */
  assertOpen(): void {
    if (this.closedReason !== null) {
      throw new RuntimeStateFencedError(this.closedReason);
    }
  }

  /**
   * Run one authoritative state write. A failure closes the fence and rethrows,
   * so an awaited lifecycle path (start, restart, ready) fails loud.
   */
  async publish(write: () => Promise<void>): Promise<void> {
    this.assertOpen();
    try {
      await write();
    } catch (error) {
      this.close(
        isStateLeaseRevoked(error) ? 'lease_revoked' : 'persist_failed',
        error,
      );
      throw error;
    }
  }

  /**
   * Best-effort variant for background paths (turn failure, child exit). It
   * never rejects, and once the fence is closed it does not attempt the write
   * at all — a fenced runtime has nothing left to persist, and retrying would
   * only emit noise for a decision already made.
   */
  publishDetached(write: () => Promise<void>): void {
    if (this.closedReason !== null) return;
    void this.publish(write).catch(() => undefined);
  }

  /**
   * Close the fence and start the single-flight native teardown. Idempotent:
   * the first reason wins and teardown runs once.
   */
  close(reason: RuntimeStateFenceReason, cause?: unknown): void {
    if (this.closedReason !== null) return;
    this.closedReason = reason;
    this.options.log(
      'error',
      `agent runtime state write is fatal (${reason}); terminating the native runtime`,
      cause,
    );
    const teardown = this.options.terminate();
    // Retain the promise itself, rejection included: `terminated()` is what
    // lets `stop()` discover that the native runtime was never proved dead.
    this.teardown = teardown;
    // Attach one handler so a failure cannot surface as an unhandled rejection
    // on the shared event loop. The retained promise stays rejected.
    void teardown.catch((error: unknown) => {
      this.options.log(
        'error',
        'native runtime teardown after a fatal state write failed',
        error,
      );
    });
  }

  /**
   * Join the teardown {@link close} started, if any.
   *
   * It rejects with the teardown's own failure, so a caller that must prove
   * termination — the runtime's public `stop()` — can retry or fail loudly
   * instead of reporting a stop that never converged.
   */
  terminated(): Promise<void> {
    return this.teardown ?? Promise.resolve();
  }
}
