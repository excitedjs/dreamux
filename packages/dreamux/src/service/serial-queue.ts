export class KeyedAsyncQueue {
  private readonly queues = new Map<string, Promise<void>>();

  async run<T>(key: string, task: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(key) ?? Promise.resolve();
    let release!: () => void;
    const next = new Promise<void>((resolve) => {
      release = resolve;
    });
    const gate = previous.catch(() => undefined).then(() => next);
    this.queues.set(key, gate);
    await previous.catch(() => undefined);
    try {
      return await task();
    } finally {
      release();
      if (this.queues.get(key) === gate) this.queues.delete(key);
    }
  }

  /**
   * Reserve the same serialized position as {@link run}, but abandon the task
   * if its predecessor has not released the key by the absolute deadline.
   * The abandoned reservation remains chained until that predecessor settles,
   * so later callers can never bypass the in-flight owner.
   */
  async runBefore<T>(
    key: string,
    deadlineAt: number,
    task: () => Promise<T>,
    timeoutError: () => Error,
  ): Promise<T> {
    const previous = this.queues.get(key) ?? Promise.resolve();
    const previousSettled = previous.catch(() => undefined);
    let release!: () => void;
    const next = new Promise<void>((resolve) => {
      release = resolve;
    });
    const gate = previousSettled.then(() => next);
    this.queues.set(key, gate);

    let timer: NodeJS.Timeout | null = null;
    const timedOut = new Promise<false>((resolve) => {
      timer = setTimeout(
        () => resolve(false),
        Math.max(0, deadlineAt - Date.now()),
      );
    });
    const acquired = await Promise.race([
      previousSettled.then(() => true as const),
      timedOut,
    ]);
    if (timer !== null) clearTimeout(timer);

    if (!acquired || Date.now() >= deadlineAt) {
      void previousSettled.then(() => {
        release();
        if (this.queues.get(key) === gate) this.queues.delete(key);
      });
      throw timeoutError();
    }

    try {
      return await task();
    } finally {
      release();
      if (this.queues.get(key) === gate) this.queues.delete(key);
    }
  }
}
