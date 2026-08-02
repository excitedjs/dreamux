import type {
  AgentRuntimeTurnResult,
  TurnSettledSignal,
} from '@excitedjs/dreamux-types';

/**
 * Orders runtime settle callbacks behind the durable submit fact for one agent
 * entity. A runtime may synchronously settle from inside a submission before it
 * returns the turn id; those callbacks wait here until the caller has persisted
 * that id. Persistence is serialized so concurrent submissions cannot overwrite
 * the entity's rolling state from stale snapshots.
 */
export class TurnSubmissionReadiness {
  private activeSubmissions = 0;
  private persistenceTail: Promise<void> = Promise.resolve();
  private readonly bufferedSettles = new Map<string, TurnSettledSignal[]>();
  private readonly idleWaiters = new Set<() => void>();

  constructor(
    private readonly deliver: (settled: TurnSettledSignal) => void,
  ) {}

  capture(settled: TurnSettledSignal): void {
    if (this.activeSubmissions === 0) {
      this.deliver(settled);
      return;
    }
    const buffered = this.bufferedSettles.get(settled.turnId) ?? [];
    buffered.push(settled);
    this.bufferedSettles.set(settled.turnId, buffered);
  }

  async submit(
    operation: () => Promise<AgentRuntimeTurnResult>,
    persist: (result: AgentRuntimeTurnResult) => Promise<void>,
  ): Promise<AgentRuntimeTurnResult> {
    this.activeSubmissions += 1;
    try {
      const result = await operation();
      await this.persist(() => persist(result));
      return result;
    } finally {
      this.activeSubmissions -= 1;
      if (this.activeSubmissions === 0) {
        this.flushBuffered();
        for (const resolve of this.idleWaiters) resolve();
        this.idleWaiters.clear();
      }
    }
  }

  persist(operation: () => Promise<void>): Promise<void> {
    const queued = this.persistenceTail.then(operation);
    this.persistenceTail = queued.catch(() => undefined);
    return queued;
  }

  async drain(): Promise<void> {
    while (true) {
      if (this.activeSubmissions > 0) await this.waitForIdle();
      const tail = this.persistenceTail;
      await tail;
      if (
        this.activeSubmissions === 0 &&
        tail === this.persistenceTail
      ) return;
    }
  }

  private waitForIdle(): Promise<void> {
    if (this.activeSubmissions === 0) return Promise.resolve();
    return new Promise((resolve) => {
      this.idleWaiters.add(resolve);
    });
  }

  private flushBuffered(): void {
    const buffered = [...this.bufferedSettles.values()];
    this.bufferedSettles.clear();
    for (const settles of buffered) {
      for (const settled of settles) this.deliver(settled);
    }
  }
}
