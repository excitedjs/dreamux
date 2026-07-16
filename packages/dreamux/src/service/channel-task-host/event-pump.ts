import type {
  ChannelTaskHostEventSink,
  DreamuxLogger,
} from '@excitedjs/dreamux-types';

import type { TaskHostStore } from './store.js';

export class TaskHostEventPump {
  private sink: ChannelTaskHostEventSink | null = null;
  private running: Promise<void> | null = null;
  private retry: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  private sinkEpoch = 0;
  offeredThrough = 0;

  constructor(
    private readonly store: TaskHostStore,
    private readonly log: DreamuxLogger,
    private readonly retryDelayMs = 1_000,
  ) {
    this.offeredThrough = store.acknowledgedThrough;
    store.setCommitListener(() => this.kick());
  }

  attach(sink: ChannelTaskHostEventSink | null): void {
    this.sinkEpoch += 1;
    if (this.retry !== null) clearTimeout(this.retry);
    this.retry = null;
    this.sink = sink;
    this.offeredThrough = this.store.acknowledgedThrough;
    this.stopped = false;
    this.kick();
  }

  isOffered(through: number, sessionThrough: number): boolean {
    return through <= Math.max(sessionThrough, this.offeredThrough);
  }

  detach(): void {
    this.sinkEpoch += 1;
    this.sink = null;
    this.offeredThrough = this.store.acknowledgedThrough;
    if (this.retry !== null) clearTimeout(this.retry);
    this.retry = null;
  }

  stop(): void {
    this.stopped = true;
    this.detach();
    this.store.setCommitListener(null);
  }

  kick(): void {
    if (this.stopped || this.sink === null || this.running !== null) return;
    this.running = this.pump()
      .catch((error) => {
        this.log.warn(
          { err: errorInfo(error) },
          'task channel host event delivery failed',
        );
        this.scheduleRetry();
      })
      .finally(() => {
        this.running = null;
        if (
          !this.stopped &&
          this.sink !== null &&
          this.store.acknowledgedThrough < this.store.watermark &&
          this.retry === null
        ) {
          this.kick();
        }
      });
  }

  async drain(): Promise<void> {
    this.kick();
    await this.running;
  }

  private async pump(): Promise<void> {
    while (!this.stopped) {
      const sink = this.sink;
      if (sink === null) return;
      const epoch = this.sinkEpoch;
      const batch = this.store.replay(this.store.acknowledgedThrough, 100);
      if (batch.events.length === 0) return;
      const before = this.store.acknowledgedThrough;
      const last = batch.last_sequence;
      if (last === null) {
        throw new Error('task channel event batch has no consecutive prefix');
      }
      this.offeredThrough = Math.max(this.offeredThrough, last);
      if (this.sink !== sink || this.sinkEpoch !== epoch || this.stopped) return;
      const result = await sink.acceptHostEvents(batch);
      if (this.sink !== sink || this.sinkEpoch !== epoch || this.stopped) return;
      const through = result.acknowledged_through;
      if (
        !Number.isSafeInteger(through) ||
        through < before ||
        through > last
      ) {
        throw new Error('task channel event sink returned an invalid prefix acknowledgement');
      }
      const current = this.store.acknowledgedThrough;
      if (through > current) {
        await this.store.acknowledge(batch.stream_generation, through, () => {
          if (this.sink !== sink || this.sinkEpoch !== epoch || this.stopped) {
            throw new Error('task channel event sink was replaced before durable ACK');
          }
        });
      } else if (current === before) {
        this.scheduleRetry();
        return;
      }
    }
  }

  private scheduleRetry(): void {
    if (this.stopped || this.sink === null || this.retry !== null) return;
    this.retry = setTimeout(() => {
      this.retry = null;
      this.kick();
    }, this.retryDelayMs);
    this.retry.unref?.();
  }
}

function errorInfo(error: unknown): Record<string, unknown> {
  return error instanceof Error
    ? { type: error.name, message: error.message }
    : { value: String(error) };
}
