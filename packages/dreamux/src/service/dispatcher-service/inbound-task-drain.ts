/**
 * Dispatcher-owned admission gate for work that can publish runtime, scheduler,
 * route, or durable state. Stop closes admission first, then drains every task
 * that crossed this synchronous gate before the ownership tree is swept.
 */
export class DispatcherTaskDrain {
  private readonly tasks = new Set<Promise<unknown>>();
  private accepting = true;

  constructor(private readonly rejectMessage: () => string) {}

  closeAdmission(): void {
    this.accepting = false;
  }

  openAdmission(): void {
    this.accepting = true;
  }

  run<T>(task: () => Promise<T>): Promise<T> {
    if (!this.accepting) throw new Error(this.rejectMessage());
    const tracked = Promise.resolve().then(task);
    this.track(tracked);
    return tracked;
  }

  private track<T>(task: Promise<T>): void {
    this.tasks.add(task);
    void task.finally(() => {
      this.tasks.delete(task);
    }).catch(() => {});
  }

  async drain(): Promise<void> {
    while (this.tasks.size > 0) {
      await Promise.allSettled([...this.tasks]);
    }
  }
}
