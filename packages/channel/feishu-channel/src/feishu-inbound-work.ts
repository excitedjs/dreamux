/** Lifecycle and budget state shared by one accepted Feishu inbound message. */

export const FEISHU_ENRICHMENT_TIMEOUT_MS = 60_000;
export const FEISHU_MAX_RESOURCE_BYTES = 25 * 1024 * 1024;
export const FEISHU_MAX_AGGREGATE_RESOURCE_BYTES = 100 * 1024 * 1024;
export const FEISHU_MAX_UNIQUE_RESOURCES = 32;
export const FEISHU_RESOURCE_TIMEOUT_MS = 20_000;

export interface FeishuSessionFence {
  readonly signal: AbortSignal;
  isCurrent(): boolean;
}

export interface FeishuInboundWorkOptions {
  timeoutMs?: number;
  maxResourceBytes?: number;
  maxAggregateResourceBytes?: number;
  maxUniqueResources?: number;
  now?: () => number;
}

export interface FeishuInboundWorkContext {
  readonly signal: AbortSignal;
  readonly deadlineAt: number;
  readonly maxResourceBytes: number;
  readonly maxUniqueResources: number;
  readonly seenResourceKeys: Set<string>;
  remainingAggregateBytes: number;
  isSessionActive(): boolean;
  assertSessionActive(): void;
  assertEnrichmentActive(): void;
  remainingTimeMs(): number;
  dispose(): void;
}

const NEVER_ABORTED = new AbortController().signal;

export function alwaysActiveSessionFence(): FeishuSessionFence {
  return { signal: NEVER_ABORTED, isCurrent: () => true };
}

export function createFeishuInboundWork(
  fence: FeishuSessionFence,
  options: FeishuInboundWorkOptions = {},
): FeishuInboundWorkContext {
  const now = options.now ?? Date.now;
  const controller = new AbortController();
  const deadlineAt = now() + (options.timeoutMs ?? FEISHU_ENRICHMENT_TIMEOUT_MS);
  let stopReason: 'deadline' | 'session_closed' | undefined;
  const stop = (reason: 'deadline' | 'session_closed'): void => {
    if (stopReason !== undefined) return;
    stopReason = reason;
    controller.abort();
  };
  const onSessionAbort = (): void => stop('session_closed');
  fence.signal.addEventListener('abort', onSessionAbort, { once: true });
  if (fence.signal.aborted || !fence.isCurrent()) stop('session_closed');
  const timer = setTimeout(
    () => stop('deadline'),
    Math.max(0, deadlineAt - now()),
  );

  const sessionActive = (): boolean =>
    !fence.signal.aborted && fence.isCurrent();
  const assertSessionActive = (): void => {
    if (!sessionActive() || stopReason === 'session_closed') {
      throw new FeishuSessionRevokedError();
    }
  };
  const assertEnrichmentActive = (): void => {
    assertSessionActive();
    if (stopReason === 'deadline' || now() >= deadlineAt) {
      stop('deadline');
      throw new FeishuEnrichmentDeadlineError();
    }
  };

  return {
    signal: controller.signal,
    deadlineAt,
    maxResourceBytes: options.maxResourceBytes ?? FEISHU_MAX_RESOURCE_BYTES,
    maxUniqueResources: options.maxUniqueResources ?? FEISHU_MAX_UNIQUE_RESOURCES,
    seenResourceKeys: new Set(),
    remainingAggregateBytes:
      options.maxAggregateResourceBytes ?? FEISHU_MAX_AGGREGATE_RESOURCE_BYTES,
    isSessionActive: sessionActive,
    assertSessionActive,
    assertEnrichmentActive,
    remainingTimeMs: () => Math.max(0, deadlineAt - now()),
    dispose(): void {
      clearTimeout(timer);
      fence.signal.removeEventListener('abort', onSessionAbort);
    },
  };
}

export async function runFeishuInboundWork<T>(
  work: FeishuInboundWorkContext,
  operation: () => Promise<T>,
  deadlineAt: number = work.deadlineAt,
  onLateValue?: (value: T) => void | Promise<void>,
  onOperationTimeout?: () => void,
): Promise<T> {
  work.assertEnrichmentActive();
  const effectiveDeadlineAt = Math.min(deadlineAt, work.deadlineAt);
  const remaining = Math.max(0, effectiveDeadlineAt - Date.now());
  const endsAtMessageDeadline = effectiveDeadlineAt === work.deadlineAt;
  const timeoutError = ():
    | FeishuSessionRevokedError
    | FeishuEnrichmentDeadlineError
    | FeishuResourceTimeoutError =>
    endsAtMessageDeadline
      ? deadlineError(work)
      : new FeishuResourceTimeoutError();
  if (remaining === 0) throw timeoutError();

  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void): boolean => {
      if (settled) return false;
      settled = true;
      clearTimeout(timer);
      work.signal.removeEventListener('abort', onAbort);
      callback();
      return true;
    };
    const onAbort = (): void => {
      finish(() => reject(deadlineError(work)));
    };
    const timer = setTimeout(
      () => finish(() => {
        try {
          onOperationTimeout?.();
        } catch {
          // Timeout cleanup is best-effort; the bounded operation still fails.
        }
        reject(timeoutError());
      }),
      remaining,
    );
    work.signal.addEventListener('abort', onAbort, { once: true });
    if (work.signal.aborted) {
      onAbort();
      return;
    }
    void Promise.resolve()
      .then(() => {
        // The initial assertion and this microtask are separated by a revocation
        // window. Recheck immediately before invoking the SDK/fs operation so a
        // close cannot reject the wrapper while still starting new side effects.
        work.assertEnrichmentActive();
        return operation();
      })
      .then(
        (value) => {
          if (finish(() => resolve(value)) || onLateValue === undefined) return;
          try {
            void Promise.resolve(onLateValue(value)).catch(() => undefined);
          } catch {
            // Late cleanup is best-effort and must never create a second failure.
          }
        },
        (error: unknown) => finish(() => reject(error)),
      );
  });
}

function deadlineError(
  work: FeishuInboundWorkContext,
): FeishuSessionRevokedError | FeishuEnrichmentDeadlineError {
  return work.isSessionActive()
    ? new FeishuEnrichmentDeadlineError()
    : new FeishuSessionRevokedError();
}

export class FeishuSessionRevokedError extends Error {
  constructor() {
    super('Feishu inbound session was revoked');
    this.name = 'FeishuSessionRevokedError';
  }
}

export class FeishuEnrichmentDeadlineError extends Error {
  constructor() {
    super('Feishu inbound enrichment deadline was reached');
    this.name = 'FeishuEnrichmentDeadlineError';
  }
}

export class FeishuResourceTimeoutError extends Error {
  constructor() {
    super('Feishu resource operation timed out');
    this.name = 'FeishuResourceTimeoutError';
  }
}
