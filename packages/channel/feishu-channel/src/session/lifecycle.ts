/**
 * The one value naming whether this Feishu channel session is still live.
 *
 * Every inbound route, outbound send, and extension call in this package
 * checks the same fact before it runs — is this session still taking work —
 * and the session's own teardown needs that same fact to decide when it is
 * safe to release the bot. `FeishuLifecycle` is that one fact plus the two
 * derived operations every caller actually wants: a cancellation signal so a
 * bounded operation can race it, a synchronous liveness check, a hook to run
 * work tracked against teardown, and an assertion that turns "not live" into
 * the same aborted-operation error every bounded Feishu call already raises.
 *
 * Ending the lifecycle and waiting for its tracked work to settle are not
 * part of `FeishuLifecycle` itself — only the session that owns ending its
 * own lifecycle ever does either, so `createFeishuLifecycle` returns that
 * pair separately as `OwnedFeishuLifecycle`. Passing an `OwnedFeishuLifecycle`
 * anywhere a `FeishuLifecycle` is expected works unchanged: it is a
 * structural superset.
 */
import { FeishuOperationError } from '../feishu-bounded-operation.js';

export interface FeishuLifecycle {
  /** Aborts once this lifecycle stops accepting work. */
  readonly signal: AbortSignal;
  /** Whether this lifecycle still accepts work. */
  isLive(): boolean;
  /** Runs `work` tracked, so `OwnedFeishuLifecycle.drain` can wait for it. */
  track<T>(work: Promise<T>): Promise<T>;
  /** Throws `FeishuOperationError('aborted')` once this lifecycle has ended. */
  assertLive(): void;
}

/** A lifecycle plus the two capabilities only its owner ever calls. */
export interface OwnedFeishuLifecycle extends FeishuLifecycle {
  /** Ends the lifecycle. Idempotent. */
  abort(): void;
  /** Settles once every task passed to `track` has settled. */
  drain(): Promise<void>;
}

/** A real, abortable lifecycle for one live session. */
export function createFeishuLifecycle(): OwnedFeishuLifecycle {
  const controller = new AbortController();
  const inFlight = new Set<Promise<unknown>>();
  const isLive = (): boolean => !controller.signal.aborted;
  return {
    signal: controller.signal,
    isLive,
    assertLive(): void {
      if (!isLive()) throw new FeishuOperationError('aborted');
    },
    async track<T>(work: Promise<T>): Promise<T> {
      inFlight.add(work);
      try {
        return await work;
      } finally {
        inFlight.delete(work);
      }
    },
    abort: () => controller.abort(),
    async drain(): Promise<void> {
      await Promise.allSettled([...inFlight]);
    },
  };
}
