/**
 * Promise-queue mutex. Callers serialize on lock(fn); fn runs while lock held.
 * FIFO resolution on the same Promise tail is enough (Node single-threaded).
 */
export class AsyncMutex {
  private _tail: Promise<unknown> = Promise.resolve();

  lock<T>(fn: () => Promise<T>): Promise<T> {
    const next = this._tail.catch(() => undefined).then(fn);
    this._tail = next;
    return next;
  }

  async drain(): Promise<void> {
    await this._tail.catch(() => undefined);
  }
}
