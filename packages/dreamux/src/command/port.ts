/**
 * The process-level Command admission port.
 *
 * Shutdown safety is a property of invoking a Command, not of one transport:
 * an in-process Channel invocation can publish exactly the runtime, scheduler,
 * route, and durable state an `admin.sock` invocation can. So the fence lives
 * here, in front of the registry, and every adapter reaches Commands only
 * through this port. The raw registry stays private to the process wiring, so
 * there is structurally no bypass for an adapter to reach for.
 *
 * The port is itself a {@link CoreCommandRegistry}, which is why an adapter
 * cannot tell the difference — and cannot ask for the unadmitted one.
 */
import type {
  CoreCommandContext,
  CoreCommandRegistry,
  JsonValue,
} from '@excitedjs/dreamux-types';

import { ServerShuttingDownError } from './errors.js';
import type { CoreCommands } from './registry.js';

export class CoreCommandPort implements CoreCommandRegistry {
  private accepting = true;
  private readonly inFlight = new Set<Promise<unknown>>();

  constructor(private readonly registry: CoreCommands) {}

  /** Every registered name, in registration order. Diagnostics only. */
  names(): readonly string[] {
    return this.registry.names();
  }

  invoke(
    context: CoreCommandContext,
    name: string,
    payload: JsonValue,
  ): Promise<JsonValue> {
    if (!this.accepting) {
      return Promise.reject(new ServerShuttingDownError());
    }
    const promise = this.registry.invoke(context, name, payload);
    this.inFlight.add(promise);
    void promise
      .finally(() => {
        this.inFlight.delete(promise);
      })
      .catch(() => {});
    return promise;
  }

  /**
   * Refuse new invocations. Accepted ones keep running until they settle.
   *
   * The fence is a hard edge, not a grace period: a request that arrives after
   * it — including one an already accepted Command issues — is rejected with
   * {@link ServerShuttingDownError}. It never falls through to a Team, and it is
   * never reported as an internal defect.
   */
  closeAdmission(): void {
    this.accepting = false;
  }

  /**
   * Await every invocation admitted before the fence closed.
   *
   * This waits only on what this port admitted. Work an accepted Command
   * started elsewhere — a dispatcher runtime, a scheduler, a durable operation —
   * is converged by its own owner during shutdown, not here, which is why
   * dispatcher shutdown runs before this drain.
   */
  async drain(): Promise<void> {
    while (this.inFlight.size > 0) {
      await Promise.allSettled([...this.inFlight]);
    }
  }
}
