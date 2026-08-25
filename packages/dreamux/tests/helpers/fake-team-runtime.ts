/**
 * The richer team/dissolve/scheduler fake runtime, migrated to the value-keyed
 * submission/completion contract.
 *
 * Fold vs queue is expressed by WIRING, never by a "how many pushes" knob:
 * - {@link FakeRuntime.settle} settles one submission with its OWN fresh token
 *   (the queued shape);
 * - {@link FakeRuntime.foldSettle} settles several submissions with ONE shared
 *   frozen token (the steer/fold shape);
 * - {@link FakeRuntime.stopSettle} settles internally with no token at all, so
 *   close/dissolve can never manufacture a push.
 */
import type {
  AgentRuntime,
  AgentRuntimeCapabilities,
  AgentRuntimeCreateContext,
  AgentRuntimeProvider,
  AgentRuntimeStatus,
  AgentRuntimeTextInput,
  DreamuxLogger,
  InboundTurnInput,
  RuntimeActivity,
  RuntimeActivitySink,
  RuntimeAdmission,
  RuntimeCompletion,
} from '@excitedjs/dreamux-types';

import type { AgentRuntimeProviderCatalog } from '../../src/agent-runtime/index.js';
import type {
  CompletionDeliveryResult,
  PreparedCompletionFact,
} from '../../src/service/completion-router/index.js';
import type { ControllableRuntimeSubmission } from './runtime-submission.js';
import {
  controllableRuntimeSubmission,
  foldSubmissions,
} from './runtime-submission.js';

export const FAKE_RUNTIME_REF = 'test:runtime';

const CAPABILITIES: AgentRuntimeCapabilities = {
  resume: { supported: false },
  structuredOutput: { supported: true, scope: 'per-turn' },
};

export type FakeSettleStatus = 'completed' | 'failed' | 'stopped';

export class FakeRuntime implements AgentRuntime {
  readonly providerRef = FAKE_RUNTIME_REF;
  readonly submitted: InboundTurnInput[] = [];
  readonly textSubmitted: AgentRuntimeTextInput[] = [];
  stopAttempts = 0;
  private status: AgentRuntimeStatus = 'declared';
  private readonly queuedStopErrors: Error[] = [];
  private readonly submissions: ControllableRuntimeSubmission[] = [];
  /** Installed by `createRuntime` so a suite can push live activity facts. */
  activitySink: RuntimeActivitySink | null = null;
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

  /** Every accepted submission, in send order. */
  get pending(): readonly ControllableRuntimeSubmission[] {
    return this.submissions;
  }

  private require(index: number): ControllableRuntimeSubmission {
    const pending = this.submissions[index];
    if (pending === undefined) throw new Error(`missing fake submission ${index}`);
    return pending;
  }

  /** Settle ONE submission on its own native result boundary (queued shape). */
  settle(index = 0, status: FakeSettleStatus = 'completed'): void {
    const pending = this.require(index);
    if (status === 'completed') {
      pending.complete(this.opts.lastText ?? null);
      this.recordTranscript(index);
      return;
    }
    if (status === 'failed') {
      pending.failCompletion(new Error('fake Turn failed'));
      return;
    }
    pending.stop();
  }

  /**
   * Settle several submissions with ONE shared frozen completion token: the
   * steer/fold shape. The first index is the display representative.
   */
  foldSettle(indexes: readonly number[], resultText?: string | null): RuntimeCompletion {
    const members = indexes.map((index) => this.require(index));
    const completion = foldSubmissions(
      members,
      resultText ?? this.opts.lastText ?? null,
    );
    const first = indexes[0];
    if (first !== undefined) this.recordTranscript(first);
    return completion;
  }

  /** Settle internally with NO completion token: close/dissolve must not push. */
  stopSettle(index = 0): void {
    this.require(index).stop();
  }

  /** Settle as an internal, non-result failure: no token, so no push. */
  failSettle(index: number, error: Error): void {
    this.require(index).fail(error);
  }

  /** Emit a live activity fact through the installed sink. */
  emitActivity(index: number, activity: RuntimeActivity, occurredAt = Date.now()): void {
    const sink = this.activitySink;
    if (sink === null) throw new Error('fake runtime has no activity sink installed');
    sink(Object.freeze({
      submission: this.require(index).submission,
      activity: Object.freeze(activity),
      occurredAt,
    }));
  }

  private recordTranscript(index: number): void {
    const input = this.textSubmitted[index]?.text ?? this.submitted[index]?.text ?? '';
    this.transcriptTurns.push({
      startedAt: null,
      endedAt: null,
      blocks: [
        { kind: 'message', role: 'user', text: input, truncated: false },
        {
          kind: 'message',
          role: 'assistant',
          text: this.opts.lastText ?? '',
          truncated: false,
        },
      ],
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
    // Contract: stop() must not return while an accepted submission is still
    // unsettled. No native result was observed, so these are internal `stopped`.
    for (const pending of this.submissions) pending.stop();
  }

  failNextStop(error: Error): void {
    this.queuedStopErrors.push(error);
  }

  async channelInput(input: InboundTurnInput): Promise<RuntimeAdmission> {
    if (this.opts.submitError !== undefined) throw this.opts.submitError;
    this.submitted.push(input);
    const pending = controllableRuntimeSubmission();
    this.submissions.push(pending);
    if (this.opts.settleImmediately) {
      const index = this.submissions.indexOf(pending);
      queueMicrotask(() => this.settle(index));
    }
    return { status: 'submitted', submission: pending.submission };
  }

  async completionInput(input: AgentRuntimeTextInput): Promise<RuntimeAdmission> {
    if (this.opts.submitError !== undefined) throw this.opts.submitError;
    this.textSubmitted.push(input);
    this.submitted.push({ sourceId: input.sourceId ?? '', text: input.text });
    if (this.opts.completionResult !== undefined) {
      return this.opts.completionResult;
    }
    const pending = controllableRuntimeSubmission();
    this.submissions.push(pending);
    if (this.opts.settleImmediately) {
      this.settle(this.submissions.indexOf(pending));
    }
    return { status: 'submitted', submission: pending.submission };
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
    createRuntime?: (context: AgentRuntimeCreateContext) => FakeRuntime;
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
      const runtime = opts.createRuntime?.(context) ?? new FakeRuntime(opts);
      runtime.activitySink = context.activitySink ?? null;
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
  /** Stable process-local recipient identity, preserved across wrappers. */
  readonly recipientKey = {};

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
