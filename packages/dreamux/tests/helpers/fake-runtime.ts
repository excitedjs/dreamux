/**
 * A minimal in-memory {@link AgentRuntime} + catalog for tests that need a REAL
 * {@link TeamCollection} (and therefore a real leader runtime) without spinning
 * up the heavyweight codex/claude-code providers. It mirrors the local fake in
 * `team-collection-read-path.test.ts`: a runtime that starts/stops cleanly and
 * records submitted turns, exposed through an `AgentRuntimeProviderCatalog` keyed
 * by {@link FAKE_RUNTIME_REF}. Use it when the assertion is about the surrounding
 * lifecycle (managed worktrees, dissolve/close) rather than runtime behavior.
 */
import type {
  AgentRuntime,
  AgentRuntimeCapabilities,
  AgentRuntimeCreateContext,
  AgentRuntimeLastResult,
  AgentRuntimeProvider,
  AgentRuntimeStatus,
  AgentRuntimeTextInput,
  AgentRuntimeTurnResult,
  InboundTurnInput,
  TurnSettledSignal,
} from '@excitedjs/dreamux-types';

import type { AgentRuntimeProviderCatalog } from '../../src/agent-runtime/index.js';

export const FAKE_RUNTIME_REF = 'test:runtime';

const CAPABILITIES: AgentRuntimeCapabilities = {
  resume: { supported: false },
};

export class FakeRuntime implements AgentRuntime {
  readonly providerRef = FAKE_RUNTIME_REF;
  readonly submitted: InboundTurnInput[] = [];
  stopAttempts = 0;
  private status: AgentRuntimeStatus = 'declared';
  private onTurnSettled: ((settled: TurnSettledSignal) => void) | undefined;

  setOnTurnSettled(onTurnSettled: (settled: TurnSettledSignal) => void): void {
    this.onTurnSettled = onTurnSettled;
  }

  async start(): Promise<void> {
    this.status = 'ready';
  }

  async resume(): Promise<void> {
    this.status = 'ready';
  }

  async stop(): Promise<void> {
    this.stopAttempts += 1;
    this.status = 'stopped';
  }

  async channelInput(input: InboundTurnInput): Promise<AgentRuntimeTurnResult> {
    this.submitted.push(input);
    const turnId = `turn-${this.submitted.length}`;
    queueMicrotask(() =>
      this.onTurnSettled?.({ turnId, status: 'completed', result: { text: null } }),
    );
    return { status: 'submitted', turnId };
  }

  async completionInput(
    input: AgentRuntimeTextInput,
  ): Promise<AgentRuntimeTurnResult> {
    this.submitted.push({ sourceId: input.sourceId ?? '', text: input.text });
    return { status: 'submitted', turnId: `turn-${this.submitted.length}` };
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
    return { text: 'fake last' };
  }

  async getContext(): Promise<null> {
    return null;
  }

  getCapabilities(): AgentRuntimeCapabilities {
    return CAPABILITIES;
  }
}

/** An `AgentRuntimeProviderCatalog` that hands out {@link FakeRuntime}s. */
export function fakeRuntimeCatalog(
  runtimes: FakeRuntime[] = [],
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
      const runtime = new FakeRuntime();
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
