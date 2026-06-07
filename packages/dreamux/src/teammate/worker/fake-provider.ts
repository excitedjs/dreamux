/**
 * Deterministic in-memory TeamMate worker provider (issue #126 PR2).
 *
 * It implements the worker seam without launching any CLI, so the execution
 * service's orchestration can be proved end-to-end: a test injects this provider
 * via the worker catalog, runs a task, then drives the lifecycle with explicit
 * controls (`emitCompleted`/`emitFailed`/`emitCancelled`) — no timers, no
 * `sleep`. It is a TEST/seam-proving provider; production wires no worker for the
 * MVP, so capabilities still report real built-in runtimes as unavailable.
 */

import type { TeamMateInputMode } from '../ledger.js';
import type {
  TeamMateWorkerCallbacks,
  TeamMateWorkerCapabilities,
  TeamMateWorkerHandle,
  TeamMateWorkerInputDisposition,
  TeamMateWorkerProvider,
  TeamMateWorkerSession,
  TeamMateWorkerStartContext,
  TeamMateWorkerStartOutcome,
} from './types.js';

/** The canonical ref for the in-memory fake worker (neutral, not Codex-only). */
export const FAKE_TEAMMATE_WORKER_REF = 'fake';

export interface FakeTeamMateWorkerInput {
  inputId: string;
  text: string;
  mode: TeamMateInputMode;
}

interface FakeSessionState {
  context: TeamMateWorkerStartContext;
  callbacks: TeamMateWorkerCallbacks;
  handle: TeamMateWorkerHandle;
  inputs: FakeTeamMateWorkerInput[];
  closed: boolean;
}

export interface FakeTeamMateWorkerProviderOptions {
  ref?: string;
  /** When false, startSession returns `unavailable` (simulate a downed worker). */
  available?: boolean;
  unavailableReason?: string;
  capabilities?: Partial<Omit<TeamMateWorkerCapabilities, 'worker_available'>>;
  /**
   * Auto-emit `onRunning` during startSession so the event stream is
   * accepted → running before any terminal transition (default true).
   */
  autoRunning?: boolean;
  /** Decide a follow-up input's disposition; default accepts every mode. */
  inputDisposition?: (
    input: FakeTeamMateWorkerInput,
  ) => TeamMateWorkerInputDisposition;
}

export class FakeTeamMateWorkerProvider implements TeamMateWorkerProvider {
  readonly ref: string;
  private readonly available: boolean;
  private readonly unavailableReason: string;
  private readonly caps: TeamMateWorkerCapabilities;
  private readonly autoRunning: boolean;
  private readonly inputDisposition: (
    input: FakeTeamMateWorkerInput,
  ) => TeamMateWorkerInputDisposition;
  private readonly sessions = new Map<string, FakeSessionState>();

  constructor(options: FakeTeamMateWorkerProviderOptions = {}) {
    this.ref = options.ref ?? FAKE_TEAMMATE_WORKER_REF;
    this.available = options.available ?? true;
    this.unavailableReason =
      options.unavailableReason ?? 'fake worker is unavailable';
    this.caps = {
      worker_available: this.available,
      unsupported_reason: this.available ? '' : this.unavailableReason,
      modes: { steer: true, queue: true, interrupt: true },
      resume: false,
      logs: false,
      ...options.capabilities,
    };
    this.autoRunning = options.autoRunning ?? true;
    this.inputDisposition =
      options.inputDisposition ?? (() => ({ status: 'accepted' }));
  }

  capabilities(): TeamMateWorkerCapabilities {
    return { ...this.caps, modes: { ...this.caps.modes } };
  }

  async startSession(
    context: TeamMateWorkerStartContext,
    callbacks: TeamMateWorkerCallbacks,
  ): Promise<TeamMateWorkerStartOutcome> {
    if (!this.available) {
      return {
        status: 'unavailable',
        reason: this.unavailableReason,
        code: 'TEAMMATE_WORKER_UNAVAILABLE',
        retryable: true,
      };
    }
    const handle: TeamMateWorkerHandle = {
      providerRef: this.ref,
      sessionId: `fake-session-${context.taskId}`,
      threadId: null,
    };
    const state: FakeSessionState = {
      context,
      callbacks,
      handle,
      inputs: [],
      closed: false,
    };
    this.sessions.set(context.taskId, state);
    const session: TeamMateWorkerSession = {
      handle,
      sendInput: (input) => this.handleInput(context.taskId, input),
      cancel: (reason) => this.handleCancel(context.taskId, reason),
      dispose: () => this.handleDispose(context.taskId),
    };
    if (this.autoRunning) {
      await callbacks.onRunning(handle);
    }
    return { status: 'started', session };
  }

  /** Test control: drive a live session to completion. */
  async emitCompleted(taskId: string, finalText: string): Promise<void> {
    const state = this.mustLive(taskId);
    state.closed = true;
    await state.callbacks.onCompleted(finalText);
  }

  /** Test control: drive a live session to a reported failure. */
  async emitFailed(taskId: string, errorText: string): Promise<void> {
    const state = this.mustLive(taskId);
    state.closed = true;
    await state.callbacks.onFailed(errorText);
  }

  /** Test control: drive a live session to a cancelled close. */
  async emitCancelled(
    taskId: string,
    reason: string | null = null,
  ): Promise<void> {
    const state = this.mustLive(taskId);
    state.closed = true;
    await state.callbacks.onCancelled(reason);
  }

  /** Test control: emit an extra running event (e.g. to assert idempotency). */
  async emitRunning(taskId: string): Promise<void> {
    const state = this.mustLive(taskId);
    await state.callbacks.onRunning(state.handle);
  }

  /** The follow-up inputs the fake observed for a task (assertion helper). */
  inputsFor(taskId: string): FakeTeamMateWorkerInput[] {
    return [...(this.sessions.get(taskId)?.inputs ?? [])];
  }

  hasLiveSession(taskId: string): boolean {
    const state = this.sessions.get(taskId);
    return state !== undefined && !state.closed;
  }

  private async handleInput(
    taskId: string,
    input: FakeTeamMateWorkerInput,
  ): Promise<TeamMateWorkerInputDisposition> {
    const state = this.mustLive(taskId);
    const disposition = this.inputDisposition(input);
    if (disposition.status === 'accepted') {
      state.inputs.push({ ...input });
    }
    return disposition;
  }

  private async handleCancel(
    taskId: string,
    reason: string | null,
  ): Promise<void> {
    const state = this.sessions.get(taskId);
    if (state === undefined || state.closed) return;
    state.closed = true;
    await state.callbacks.onCancelled(reason);
  }

  /** Mirror a real worker's `dispose`: close the session, fire no callback. */
  private async handleDispose(taskId: string): Promise<void> {
    const state = this.sessions.get(taskId);
    if (state === undefined) return;
    state.closed = true;
  }

  private mustLive(taskId: string): FakeSessionState {
    const state = this.sessions.get(taskId);
    if (state === undefined) {
      throw new Error(
        `fake worker has no session for task ${JSON.stringify(taskId)}`,
      );
    }
    return state;
  }
}
