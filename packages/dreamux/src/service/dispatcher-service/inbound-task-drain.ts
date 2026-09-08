import { InFlightWork } from '../in-flight-work.js';

/**
 * Dispatcher-owned admission gate for work that can publish runtime, scheduler,
 * route, or durable state. Stop closes admission first, then drains every task
 * that crossed this synchronous gate before the ownership tree is swept.
 */
export class DispatcherTaskDrain {
  private readonly tasks = new InFlightWork();
  private open = true;

  constructor(private readonly rejectMessage: () => string) {}

  /**
   * Whether this gate still admits work. Completion delivery reads it as the
   * dispatcher-scope fence: news for an owner whose admission is closed has no
   * one left to read it.
   */
  get accepting(): boolean {
    return this.open;
  }

  closeAdmission(): void {
    this.open = false;
  }

  openAdmission(): void {
    this.open = true;
  }

  run<T>(task: () => Promise<T>): Promise<T> {
    if (!this.open) throw new Error(this.rejectMessage());
    return this.tasks.track(Promise.resolve().then(task));
  }

  drain(): Promise<void> {
    return this.tasks.drain();
  }
}
