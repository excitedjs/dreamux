/**
 * Shared fakes for CodexRuntime / CodexWsClient / CodexProcess behavioral
 * tests (coverage cell B, node codex-adapter).
 *
 * These fakes replay ONLY native codex app-server facts: JSON-RPC responses
 * for `initialize` / `thread/start` / `thread/resume` / `turn/start` /
 * `skills/extraRoots/set`, and the `item/started` / `item/completed` /
 * `turn/completed` / `error` notification stream. Nothing here knows about
 * Dreamux core; that is exactly the seam CodexRuntime is supposed to hide.
 */
import type {
  NotificationHandler,
  ServerRequestHandler,
} from '../../src/rpc.js';
import type {
  ServerNotification,
  ThreadItem,
} from '../../src/types.js';
import type {
  AgentRuntimePathContext,
  AgentRuntimeSessionRef,
  AgentRuntimeStateSink,
  AgentRuntimeStateUpdate,
} from '@excitedjs/dreamux-types';

/** One recorded JSON-RPC request the fake client observed, in call order. */
export interface RecordedRequest {
  method: string;
  params: unknown;
}

export interface FakeCodexWsClientOptions {
  /** Thread id `thread/start` answers with when no script says otherwise. */
  freshThreadId?: string;
  /** Script `thread/resume` to fail with this error instead of succeeding. */
  failResumeWith?: Error;
  /** Auto-complete every `turn/start` on the next microtask (default true). */
  autoComplete?: boolean;
  /**
   * Script the native turn id `thread/start` returns per successive
   * `turn/start` call (consumed in order; once exhausted, falls back to the
   * default `turn-${n}` counter). Repeating the same id lets a test simulate
   * Codex folding a second submission into the SAME in-flight native turn.
   */
  scriptedTurnIds?: string[];
}

/**
 * A scriptable fake of `CodexWsClient`'s public surface. Tests construct one
 * per `codexClientFactory()` call so a restart gets a fresh instance, exactly
 * like the real transport would after teardown.
 */
export class FakeCodexWsClient {
  readonly requests: RecordedRequest[] = [];
  readonly methods: string[] = [];
  closeCalls = 0;
  notifyCalls: Array<{ method: string; params: unknown }> = [];
  private readonly notificationHandlers = new Set<NotificationHandler>();
  private readonly closeHandlers: Array<(reason: Error) => void> = [];
  private nextTurnId = 1;
  private turnStartCalls = 0;
  private closed = false;
  /** Per-method deferred gates: a pending request for `method` waits here. */
  private readonly gates = new Map<
    string,
    { resolve: (v: unknown) => void; reject: (e: Error) => void }[]
  >();
  private readonly blockedMethods = new Set<string>();

  constructor(private readonly options: FakeCodexWsClientOptions = {}) {}

  /** Block the next request for `method` until `release()`/`rejectBlocked()` is called. */
  block(method: string): void {
    this.blockedMethods.add(method);
  }

  release(method: string, value: unknown): void {
    const queue = this.gates.get(method);
    const gate = queue?.shift();
    if (gate === undefined) {
      throw new Error(`no blocked ${method} request to release`);
    }
    gate.resolve(value);
  }

  rejectBlocked(method: string, error: Error): void {
    const queue = this.gates.get(method);
    const gate = queue?.shift();
    if (gate === undefined) {
      throw new Error(`no blocked ${method} request to reject`);
    }
    gate.reject(error);
  }

  hasBlocked(method: string): boolean {
    return (this.gates.get(method)?.length ?? 0) > 0;
  }

  onNotification(handler: NotificationHandler): () => void {
    this.notificationHandlers.add(handler);
    return () => this.notificationHandlers.delete(handler);
  }

  setServerRequestHandler(_handler: ServerRequestHandler): void {
    // The fakes never emit a server→client request (approval, attestation),
    // so nothing here needs to invoke it; recorded only for interface parity.
  }

  onClose(handler: (reason: Error) => void): void {
    if (this.closed) {
      handler(new Error('fake codex client closed'));
      return;
    }
    this.closeHandlers.push(handler);
  }

  async ready(): Promise<void> {}

  notify(method: string, params: unknown): void {
    this.notifyCalls.push({ method, params });
  }

  close(): void {
    this.closeCalls += 1;
    this.closed = true;
    // Mirror the real transport: closing the socket rejects any request still
    // in flight rather than leaving it dangling forever, so a stop() racing an
    // admitted-but-not-yet-acknowledged submit converges instead of hanging.
    for (const [, queue] of this.gates) {
      for (const gate of [...queue]) {
        gate.reject(new Error('fake codex client closed while request was pending'));
      }
      queue.length = 0;
    }
    for (const handler of [...this.closeHandlers]) {
      handler(new Error('fake codex client closed by caller'));
    }
  }

  /** Simulate the transport dying underneath the runtime (child crash, etc). */
  emitClose(reason: Error): void {
    this.closed = true;
    for (const handler of [...this.closeHandlers]) handler(reason);
  }

  async request<R>(method: string, params: unknown): Promise<R> {
    this.methods.push(method);
    this.requests.push({ method, params });
    if (this.blockedMethods.has(method)) {
      this.blockedMethods.delete(method);
      return new Promise<R>((resolve, reject) => {
        const queue = this.gates.get(method) ?? [];
        queue.push({
          resolve: resolve as (v: unknown) => void,
          reject,
        });
        this.gates.set(method, queue);
      });
    }
    return this.answer<R>(method, params);
  }

  private async answer<R>(method: string, params: unknown): Promise<R> {
    if (method === 'initialize') {
      return {
        userAgent: 'fake-codex/0.999.0',
        codexHome: '/fake/codex-home',
        platformFamily: 'unix',
        platformOs: 'Linux',
      } as R;
    }
    if (method === 'skills/extraRoots/set') {
      return {} as R;
    }
    if (method === 'thread/start') {
      const id = this.options.freshThreadId ?? 'fresh-thread-1';
      return { thread: { id, path: `/fake/sessions/${id}.jsonl` } } as R;
    }
    if (method === 'thread/resume') {
      if (this.options.failResumeWith !== undefined) {
        throw this.options.failResumeWith;
      }
      const threadId = (params as { threadId: string }).threadId;
      return {
        thread: { id: threadId, path: `/fake/sessions/${threadId}.jsonl` },
      } as R;
    }
    if (method === 'turn/start') {
      const p = params as {
        threadId: string;
        input: Array<{ text: string }>;
        outputSchema?: Record<string, unknown>;
      };
      const scripted = this.options.scriptedTurnIds?.[this.turnStartCalls];
      this.turnStartCalls += 1;
      const turnId = scripted ?? `turn-${this.nextTurnId++}`;
      if (this.options.autoComplete !== false) {
        const text = p.outputSchema === undefined
          ? p.input[0]?.text ?? ''
          : '{"values":{}}';
        queueMicrotask(() => this.emitCompleted(p.threadId, turnId, text));
      }
      return { turn: { id: turnId } } as R;
    }
    throw new Error(`FakeCodexWsClient: unexpected method ${method}`);
  }

  emitCompleted(threadId: string, turnId: string, text: string): void {
    this.emit({
      method: 'item/completed',
      params: {
        threadId,
        turnId,
        completedAtMs: Date.now(),
        item: { type: 'agentMessage', id: `item-${turnId}`, text },
      },
    });
    this.emit({
      method: 'turn/completed',
      params: { threadId, turn: { id: turnId, items: [] } },
    });
  }

  emitTurnFailed(threadId: string, turnId: string, message: string): void {
    this.emit({
      method: 'turn/completed',
      params: { threadId, turn: { id: turnId, error: { message } } },
    });
  }

  /**
   * A codex `error` notification with no `turnId` — "unscoped" to any single
   * native turn, but still `threadId`-scoped: the collector's own thread match
   * (see events.ts) drops any notification whose `threadId` field does not
   * match the subscribed thread, unscoped errors included.
   */
  emitUnscopedError(threadId: string, message: string): void {
    this.emit({
      method: 'error',
      params: { threadId, willRetry: false, error: { message } },
    });
  }

  emitItem(
    threadId: string,
    turnId: string,
    phase: 'started' | 'completed',
    item: ThreadItem,
  ): void {
    this.emit({
      method: phase === 'started' ? 'item/started' : 'item/completed',
      params: phase === 'started'
        ? { threadId, turnId, item }
        : { threadId, turnId, completedAtMs: Date.now(), item },
    });
  }

  private emit(notification: ServerNotification): void {
    for (const handler of [...this.notificationHandlers]) handler(notification);
  }
}

/** A scriptable fake of `CodexProcess`'s public surface. */
export class FakeCodexProcess {
  reapCalls = 0;
  startCalls = 0;
  private exitHandlers: Array<(exit: { code: number | null; signal: NodeJS.Signals | null }) => void> = [];
  private releaseStart: (() => void) | null = null;
  private rejectStart: ((error: Error) => void) | null = null;
  private startGate: Promise<void> | null = null;

  constructor(
    private readonly options: {
      /** Block `start()` until `release()`/`fail()` is called. */
      deferStart?: boolean;
      /** Throw synchronously (well, on the returned promise) from `start()`. */
      failStartWith?: Error;
      /** Throw from `reap()` the first N calls (simulate an unproven teardown). */
      failReapTimes?: number;
    } = {},
  ) {}

  onExit(handler: (exit: { code: number | null; signal: NodeJS.Signals | null }) => void): void {
    this.exitHandlers.push(handler);
  }

  simulateExit(exit: { code: number | null; signal: NodeJS.Signals | null } = { code: null, signal: 'SIGKILL' }): void {
    for (const handler of [...this.exitHandlers]) handler(exit);
  }

  async start(): Promise<void> {
    this.startCalls += 1;
    if (this.options.failStartWith !== undefined) {
      throw this.options.failStartWith;
    }
    if (this.options.deferStart === true) {
      this.startGate = new Promise<void>((resolve, reject) => {
        this.releaseStart = resolve;
        this.rejectStart = reject;
      });
      await this.startGate;
    }
  }

  release(): void {
    this.releaseStart?.();
  }

  fail(error: Error): void {
    this.rejectStart?.(error);
  }

  private reapCallCount = 0;

  async reap(): Promise<void> {
    this.reapCalls += 1;
    this.reapCallCount += 1;
    if (
      this.options.failReapTimes !== undefined &&
      this.reapCallCount <= this.options.failReapTimes
    ) {
      throw new Error('reap did not prove termination');
    }
  }
}

export const FAKE_PATHS: AgentRuntimePathContext = {
  cacheDir: () => '/fake/cache',
  logsDir: () => '/fake/logs',
  runtimeSocketDirs: () => ['/fake/run/sockets'],
};

/** A state sink that just records every published update, in call order. */
export class RecordingStateSink<TSession extends AgentRuntimeSessionRef>
  implements AgentRuntimeStateSink<TSession> {
  readonly updates: AgentRuntimeStateUpdate<TSession>[] = [];
  /**
   * A one-shot gate: the promise is created eagerly so a test can call
   * `releaseGate()` at any point after `gateNext()` regardless of whether the
   * matching publish() call has landed yet. `consumed` (not nulling the field)
   * is what makes the gate one-shot, so `releaseGate()` always reaches the
   * same `resolve` the matching publish() is awaiting.
   */
  private gate: {
    match: (update: AgentRuntimeStateUpdate<TSession>) => boolean;
    resolve: () => void;
    promise: Promise<void>;
    consumed: boolean;
  } | null = null;
  /** One-shot rejection keyed by a predicate, analogous to the gate above. */
  private rejection: {
    match: (update: AgentRuntimeStateUpdate<TSession>) => boolean;
    error: Error;
    consumed: boolean;
  } | null = null;

  /** Hold the NEXT publish matching `match` open until `releaseGate()`. */
  gateNext(match: (update: AgentRuntimeStateUpdate<TSession>) => boolean): void {
    let resolve!: () => void;
    const promise = new Promise<void>((r) => {
      resolve = r;
    });
    this.gate = { match, resolve, promise, consumed: false };
  }

  releaseGate(): void {
    this.gate?.resolve();
  }

  /** Make the NEXT publish() call reject with `error` instead of landing. */
  rejectNextWith(error: Error): void {
    this.rejection = { match: () => true, error, consumed: false };
  }

  /** Make the first publish() call matching `match` reject with `error`. */
  rejectWhen(
    match: (update: AgentRuntimeStateUpdate<TSession>) => boolean,
    error: Error,
  ): void {
    this.rejection = { match, error, consumed: false };
  }

  async publish(update: AgentRuntimeStateUpdate<TSession>): Promise<void> {
    if (
      this.rejection !== null &&
      !this.rejection.consumed &&
      this.rejection.match(update)
    ) {
      this.rejection.consumed = true;
      throw this.rejection.error;
    }
    if (this.gate !== null && !this.gate.consumed && this.gate.match(update)) {
      this.gate.consumed = true;
      await this.gate.promise;
    }
    this.updates.push(update);
  }
}

export function noopStateSink<
  TSession extends AgentRuntimeSessionRef,
>(): AgentRuntimeStateSink<TSession> {
  return { async publish() {} };
}

export async function waitFor(
  predicate: () => boolean,
  timeoutMs = 2_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('waitFor timed out');
}
