import type {
  AgentRuntime,
  AgentRuntimeCapabilities,
  AgentRuntimeCreateContext,
  AgentRuntimeProvider,
  AgentRuntimeStatus,
  AgentRuntimeTextInput,
  DreamuxLogger,
  InboundTurnInput,
  RuntimeAdmission,
  RuntimeTurnOutcome,
} from '@excitedjs/dreamux-types';

import type { AgentRuntimeProviderCatalog } from '../../src/agent-runtime/index.js';
import type {
  CompletionDeliveryResult,
  PreparedCompletionFact,
} from '../../src/service/completion-router/index.js';
import type { ControllableRuntimeTurn } from './runtime-turn.js';
import { controllableRuntimeTurn } from './runtime-turn.js';

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
  private readonly queuedStopErrors: Error[] = [];
  private readonly turns: ControllableRuntimeTurn[] = [];
  readonly transcriptTurns: Array<{
    startedAt: number | null;
    endedAt: number | null;
    blocks: Array<{
      kind: 'message';
      role: 'user' | 'assistant';
      text: string;
      truncated: false;
    }>;
  }> = [];

  constructor(
    private readonly opts: {
      settleImmediately?: boolean;
      lastText?: string;
      startError?: Error;
      submitError?: Error;
      stopError?: Error;
      completionResult?: RuntimeAdmission;
      waitIdle?: () => Promise<void>;
    } = {},
  ) {}

  settle(index = 0, status: RuntimeTurnOutcome['status'] = 'completed'): void {
    const pending = this.turns[index];
    if (pending === undefined) throw new Error(`missing fake Turn ${index}`);
    pending.settle(
      status === 'completed'
        ? {
            status,
            resultText: this.opts.lastText ?? null,
            truncated: false,
          }
        : status === 'failed'
          ? { status, error: new Error('fake Turn failed') }
          : { status },
    );
    if (status === 'completed') {
      const input = this.textSubmitted[index]?.text ?? this.submitted[index]?.text ?? '';
      this.transcriptTurns.push({
        startedAt: null,
        endedAt: null,
        blocks: [
          {
            kind: 'message',
            role: 'user',
            text: input,
            truncated: false,
          },
          {
            kind: 'message',
            role: 'assistant',
            text: this.opts.lastText ?? '',
            truncated: false,
          },
        ],
      });
    }
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

  async channelInput(input: InboundTurnInput): Promise<RuntimeAdmission> {
    if (this.opts.submitError !== undefined) throw this.opts.submitError;
    this.submitted.push(input);
    const pending = controllableRuntimeTurn();
    this.turns.push(pending);
    if (this.opts.settleImmediately) {
      queueMicrotask(() => this.settle(this.turns.indexOf(pending)));
    }
    return { status: 'submitted', turn: pending.turn };
  }

  async completionInput(input: AgentRuntimeTextInput): Promise<RuntimeAdmission> {
    if (this.opts.submitError !== undefined) throw this.opts.submitError;
    this.textSubmitted.push(input);
    this.submitted.push({ sourceId: input.sourceId ?? '', text: input.text });
    if (this.opts.completionResult !== undefined) {
      return this.opts.completionResult;
    }
    const pending = controllableRuntimeTurn();
    this.turns.push(pending);
    if (this.opts.settleImmediately) {
      this.settle(this.turns.indexOf(pending));
    }
    return { status: 'submitted', turn: pending.turn };
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
    completionResult?: RuntimeAdmission;
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
    async readTranscript(query) {
      const turns = runtimes
        .flatMap((runtime) => runtime.transcriptTurns)
        .slice(-query.turns);
      return { turns, nextCursor: null, truncated: false };
    },
    createRuntime(context: AgentRuntimeCreateContext) {
      contexts.push(context);
      const runtime = opts.createRuntime?.() ?? new FakeRuntime(opts);
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
  readonly completions: PreparedCompletionFact[] = [];

  async prepareCompletion(completion: PreparedCompletionFact) {
    this.completions.push(completion);
    return Object.freeze({
      submit: async (): Promise<CompletionDeliveryResult> => ({
        status: 'accepted',
      }),
    });
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
