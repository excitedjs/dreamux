import {
  FeishuOperationError,
  isFeishuOperationError,
  runFeishuBoundedOperation,
} from '../feishu-bounded-operation.js';
import type { FeishuLifecycle } from '../session/lifecycle.js';

export const FEISHU_ENRICHMENT_TIMEOUT_MS = 60_000;
export const FEISHU_RESOURCE_TIMEOUT_MS = 20_000;

export interface FeishuInboundWorkOptions {
  timeoutMs?: number;
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

export function createFeishuInboundWork(
  fence: FeishuLifecycle,
  options: FeishuInboundWorkOptions = {},
): FeishuInboundWorkContext {
  const controller = new AbortController();
  const deadlineAt =
    Date.now() + (options.timeoutMs ?? FEISHU_ENRICHMENT_TIMEOUT_MS);
  let stopReason: 'deadline' | 'session_closed' | undefined;
  const stop = (reason: 'deadline' | 'session_closed'): void => {
    if (stopReason !== undefined) return;
    stopReason = reason;
    controller.abort();
  };
  const onSessionAbort = (): void => stop('session_closed');
  fence.signal.addEventListener('abort', onSessionAbort, { once: true });
  if (fence.signal.aborted || !fence.isLive()) stop('session_closed');
  const timer = setTimeout(
    () => stop('deadline'),
    Math.max(0, deadlineAt - Date.now()),
  );

  const sessionActive = (): boolean => !fence.signal.aborted && fence.isLive();
  const assertSessionActive = (): void => {
    if (!sessionActive() || stopReason === 'session_closed') {
      throw new FeishuOperationError('aborted');
    }
  };
  const assertEnrichmentActive = (): void => {
    assertSessionActive();
    if (stopReason === 'deadline' || Date.now() >= deadlineAt) {
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
    remainingTimeMs: () => Math.max(0, deadlineAt - Date.now()),
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
      onLateValue,
    });
  } catch (error) {
    if (!isFeishuOperationError(error)) throw error;
    if (!work.isSessionActive()) throw new FeishuOperationError('aborted');
    if (effectiveDeadlineAt < work.deadlineAt && work.remainingTimeMs() > 0) {
      throw new FeishuOperationError('timeout');
    }
    throw new FeishuOperationError('deadline');
  }
}
