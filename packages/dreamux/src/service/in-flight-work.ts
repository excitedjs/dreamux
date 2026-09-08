/**
 * The work one scope has let in and must join before it stops.
 *
 * Every scope that fences admission — the dispatcher, a Workflow run, a
 * TeamMate's ordinary mutations — has the same second half: whatever crossed
 * the fence before it closed is still running, and a stop that swept the
 * ownership tree underneath it would tear down what that work is about to
 * publish. This counts that work in and out and lets the stop wait for zero.
 * The fence itself stays with the scope that decides it; nothing here refuses.
 */
export class InFlightWork {
  private outstanding = 0;
  private readonly idleWaiters = new Set<() => void>();

  get idle(): boolean {
    return this.outstanding === 0;
  }

  /** Count one unit of work in until the returned leave is called; leaving twice is a no-op. */
  enter(): () => void {
    this.outstanding += 1;
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      this.outstanding -= 1;
      if (this.outstanding === 0) {
        for (const resolve of this.idleWaiters) resolve();
        this.idleWaiters.clear();
      }
    };
  }

  /** Count a task in until it settles, however it settles. */
  track<T>(task: Promise<T>): Promise<T> {
    const leave = this.enter();
    void task.finally(leave).catch(() => undefined);
    return task;
  }

  /** Resolve once nothing is in flight, including work that entered while waiting. */
  drain(): Promise<void> {
    if (this.outstanding === 0) return Promise.resolve();
    return new Promise((resolve) => this.idleWaiters.add(resolve));
  }
}
