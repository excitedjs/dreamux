import type {
  AgentRuntime,
  AgentRuntimeCapabilities,
  AgentRuntimeCreateContext,
  AgentRuntimeLastResult,
  AgentRuntimeProvider,
  AgentRuntimeStatus,
  AgentRuntimeTextInput,
  AgentRuntimeTurnResult,
  DreamuxLogger,
  InboundTurnInput,
  TurnSettledSignal,
} from '@excitedjs/dreamux-types';

import type { AgentRuntimeProviderCatalog } from '../../src/agent-runtime/index.js';
import type {
  CompletionDeliveryResult,
  CompletionEnvelope,
} from '../../src/service/completion-router/index.js';

export const FAKE_RUNTIME_REF = 'test:runtime';

const CAPABILITIES: AgentRuntimeCapabilities = {
  resume: { supported: false },
  structuredOutput: { supported: true, scope: 'per-turn' },
};

export class FakeRuntime implements AgentRuntime {
  readonly providerRef = FAKE_RUNTIME_REF;
  readonly submitted: InboundTurnInput[] = [];
  readonly textSubmitted: AgentRuntimeTextInput[] = [];
  stopAttempts = 0;
  private status: AgentRuntimeStatus = 'declared';
  private onTurnSettled: ((settled: TurnSettledSignal) => void) | undefined;
  private readonly queuedStopErrors: Error[] = [];

  constructor(
    private readonly opts: {
      settleImmediately?: boolean;
      lastText?: string;
      startError?: Error;
      submitError?: Error;
      stopError?: Error;
      completionResult?: AgentRuntimeTurnResult;
      waitIdle?: () => Promise<void>;
    } = {},
  ) {}

  setOnTurnSettled(onTurnSettled: (settled: TurnSettledSignal) => void): void {
    this.onTurnSettled = onTurnSettled;
  }

  settle(turnId: string, status: TurnSettledSignal['status'] = 'completed'): void {
    this.onTurnSettled?.({
      turnId,
      status,
      result: { text: this.opts.lastText ?? null },
    });
  }

  async start(): Promise<void> {
    if (this.opts.startError !== undefined) throw this.opts.startError;
    this.status = 'ready';
  }

  async resume(): Promise<void> {
    this.status = 'ready';
  }

  async stop(): Promise<void> {
    this.stopAttempts += 1;
    const error = this.queuedStopErrors.shift() ?? this.opts.stopError;
    if (error !== undefined) throw error;
    this.status = 'stopped';
  }

  failNextStop(error: Error): void {
    this.queuedStopErrors.push(error);
  }

  async channelInput(input: InboundTurnInput): Promise<AgentRuntimeTurnResult> {
    if (this.opts.submitError !== undefined) throw this.opts.submitError;
    this.submitted.push(input);
    const turnId = `turn-${this.submitted.length}`;
    if (this.opts.settleImmediately) {
      queueMicrotask(() =>
        this.onTurnSettled?.({
          turnId,
          status: 'completed',
          result: { text: this.opts.lastText ?? null },
        }),
      );
    }
    return { status: 'submitted', turnId };
  }

  async completionInput(input: AgentRuntimeTextInput): Promise<AgentRuntimeTurnResult> {
    if (this.opts.submitError !== undefined) throw this.opts.submitError;
    this.textSubmitted.push(input);
    this.submitted.push({ sourceId: input.sourceId ?? '', text: input.text });
    if (this.opts.completionResult !== undefined) {
      return this.opts.completionResult;
    }
    const turnId = `turn-${this.submitted.length}`;
    if (this.opts.settleImmediately) {
      this.onTurnSettled?.({
        turnId,
        status: 'completed',
        result: { text: this.opts.lastText ?? null },
      });
    }
    return { status: 'submitted', turnId };
  }

  async waitIdle(): Promise<void> {
    await this.opts.waitIdle?.();
  }

  getStatus(): AgentRuntimeStatus {
    return this.status;
  }

  getCheckpoint(): { id: string } | null {
    return { id: 'thread-fake' };
  }

  wasCheckpointResumed(): boolean {
    return false;
  }

  async getLast(): Promise<AgentRuntimeLastResult> {
    return { text: this.opts.lastText ?? 'fake last' };
  }

  async getContext(): Promise<null> {
    return null;
  }

  getCapabilities(): AgentRuntimeCapabilities {
    return CAPABILITIES;
  }
}

export function fakeRuntimeCatalog(
  runtimes: FakeRuntime[],
  opts: {
    settleImmediately?: boolean;
    lastText?: string;
    startError?: Error;
    submitError?: Error;
    stopError?: Error;
    completionResult?: AgentRuntimeTurnResult;
    waitIdle?: () => Promise<void>;
    createRuntime?: () => FakeRuntime;
  } = {},
  contexts: AgentRuntimeCreateContext[] = [],
): AgentRuntimeProviderCatalog {
  const provider: AgentRuntimeProvider = {
    ref: FAKE_RUNTIME_REF,
    descriptor: {
      id: 'test-runtime',
      kind: 'agentRuntime',
      ref: { source: 'builtin', id: 'test-runtime', raw: FAKE_RUNTIME_REF },
    },
    getCapabilities: () => CAPABILITIES,
    createRuntime(context: AgentRuntimeCreateContext) {
      contexts.push(context);
      const runtime = opts.createRuntime?.() ?? new FakeRuntime(opts);
      if (context.onTurnSettled !== undefined) {
        runtime.setOnTurnSettled(context.onTurnSettled);
      }
      runtimes.push(runtime);
      return runtime;
    },
  };
  return {
    list: () => [provider],
    resolve(ref: string) {
      if (ref !== FAKE_RUNTIME_REF) {
        throw new Error(`unexpected runtime provider ${JSON.stringify(ref)}`);
      }
      return provider;
    },
  } as AgentRuntimeProviderCatalog;
}

export class FakeInitiator {
  readonly completions: CompletionEnvelope[] = [];

  async completionInput(
    completion: CompletionEnvelope,
  ): Promise<CompletionDeliveryResult> {
    this.completions.push(completion);
    return { status: 'accepted' };
  }
}

export function noopLog(): DreamuxLogger {
  const log = {
    error: () => undefined,
    warn: () => undefined,
    info: () => undefined,
    debug: () => undefined,
    trace: () => undefined,
    child: () => log,
  };
  return log as DreamuxLogger;
}

export function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}
