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
}
