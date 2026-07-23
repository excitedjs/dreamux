import {
  FeishuOperationError,
  isFeishuOperationError,
  runFeishuBoundedOperation,
} from './feishu-bounded-operation.js';

export const FEISHU_ENRICHMENT_TIMEOUT_MS = 60_000;
export const FEISHU_RESOURCE_TIMEOUT_MS = 20_000;

export interface FeishuSessionFence {
  readonly signal: AbortSignal;
  isCurrent(): boolean;
}

export interface FeishuInboundWorkOptions {
  timeoutMs?: number;
  now?: () => number;
}

export interface FeishuInboundWorkContext {
  readonly signal: AbortSignal;
  readonly deadlineAt: number;
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
      throw new FeishuOperationError('aborted');
    }
  };
  const assertEnrichmentActive = (): void => {
    assertSessionActive();
    if (stopReason === 'deadline' || now() >= deadlineAt) {
      stop('deadline');
      throw new FeishuOperationError('deadline');
    }
  };

  return {
    signal: controller.signal,
    deadlineAt,
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
): Promise<T> {
  work.assertEnrichmentActive();
  const effectiveDeadlineAt = Math.min(deadlineAt, work.deadlineAt);
  try {
    return await runFeishuBoundedOperation({
      operation,
      deadlineAt: effectiveDeadlineAt,
      signal: work.signal,
      beforeStart: work.assertEnrichmentActive,
      ...(onLateValue !== undefined ? { onLateValue } : {}),
    });
  } catch (error) {
    if (!isFeishuOperationError(error)) throw error;
    if (!work.isSessionActive()) throw new FeishuOperationError('aborted');
    if (
      effectiveDeadlineAt < work.deadlineAt &&
      work.remainingTimeMs() > 0
    ) {
      throw new FeishuOperationError('timeout');
    }
    throw new FeishuOperationError('deadline');
  }
}
