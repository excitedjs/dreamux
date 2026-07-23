export type FeishuOperationFailure = 'aborted' | 'deadline' | 'timeout';

export class FeishuOperationError extends Error {
  constructor(readonly reason: FeishuOperationFailure) {
    super(
      reason === 'aborted'
        ? 'Feishu operation was aborted'
        : reason === 'deadline'
          ? 'Feishu operation deadline was reached'
          : 'Feishu operation timed out',
    );
    this.name = 'FeishuOperationError';
  }
}

export interface FeishuOperationScope {
  readonly signal?: AbortSignal;
  readonly deadlineAt: number;
}

interface FeishuBoundedOperationOptions<T> extends FeishuOperationScope {
  operation(): Promise<T>;
  beforeStart?(): void;
  onLateValue?(value: T): void | Promise<void>;
  now?: () => number;
}

/**
 * Run one Channel-owned async operation against an absolute deadline.
 *
 * Settlement owns timer/listener cleanup exactly once. A value which arrives
 * after timeout or abort may be disposed through `onLateValue`.
 */
export function runFeishuBoundedOperation<T>(
  options: FeishuBoundedOperationOptions<T>,
): Promise<T> {
  const now = options.now ?? Date.now;
  if (options.signal?.aborted === true) {
    return Promise.reject(new FeishuOperationError('aborted'));
  }
  const remaining = Math.max(0, options.deadlineAt - now());
  if (remaining === 0) {
    return Promise.reject(new FeishuOperationError('deadline'));
  }

  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void): boolean => {
      if (settled) return false;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
      callback();
      return true;
    };
    const onAbort = (): void => {
      finish(() => reject(new FeishuOperationError('aborted')));
    };
    const timer = setTimeout(
      () => finish(() => reject(new FeishuOperationError('deadline'))),
      remaining,
    );
    options.signal?.addEventListener('abort', onAbort, { once: true });
    if (options.signal?.aborted === true) {
      onAbort();
      return;
    }

    void Promise.resolve()
      .then(() => {
        options.beforeStart?.();
        return options.operation();
      })
      .then(
        (value) => {
          if (finish(() => resolve(value)) || options.onLateValue === undefined) {
            return;
          }
          try {
            void Promise.resolve(options.onLateValue(value)).catch(() => undefined);
          } catch {
            // Late cleanup is best-effort and cannot become a second failure.
          }
        },
        (error: unknown) => {
          finish(() => reject(error));
        },
      );
  });
}

export function isFeishuOperationError(
  error: unknown,
  reason?: FeishuOperationFailure,
): error is FeishuOperationError {
  return error instanceof FeishuOperationError &&
    (reason === undefined || error.reason === reason);
}
