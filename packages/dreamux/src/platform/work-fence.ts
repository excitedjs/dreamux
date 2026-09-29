import { ServerShuttingDownError } from './errors.js';
import { InFlightWork } from './in-flight-work.js';

/** The admission view held by work producers. */
export interface WorkAdmission {
  admit<T>(task: () => Promise<T>): Promise<T>;
  isClosing(): boolean;
}

/** One dispatcher's permanent close fence and already-admitted work. */
export class WorkFence implements WorkAdmission {
  private closed = false;
  private readonly work = new InFlightWork();

  constructor(private readonly dispatcherId: string) {}

  isClosing(): boolean {
    return this.closed;
  }

  assertOpen(): void {
    if (this.closed) {
      throw new ServerShuttingDownError(
        `dispatcher '${this.dispatcherId}' is shutting down`,
      );
    }
  }

  admit<T>(task: () => Promise<T>): Promise<T> {
    this.assertOpen();
    return this.work.track(Promise.resolve().then(task));
  }

  close(): void {
    this.closed = true;
  }

  drain(): Promise<void> {
    return this.work.drain();
  }
}
