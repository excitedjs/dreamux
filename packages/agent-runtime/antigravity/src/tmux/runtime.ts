import { readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';

import type {
  AgentRuntime,
  AgentRuntimeCreateContext,
  AgentRuntimeInterruptOutcome,
  AgentRuntimeStartOutcome,
  AgentRuntimeStateUpdate,
  AgentRuntimeSubmissionInput,
  RuntimeAdmission,
} from '@excitedjs/dreamux-types';
import { RuntimeStateFence } from '@excitedjs/dreamux-utils';

import type { AntigravityConfig } from '../config.js';
import {
  antigravityTranscriptPath,
  resolveAntigravityNativeRoots,
} from '../paths.js';
import type { AntigravityRuntimeOptions } from '../runtime-options.js';
import { DeferredTranscript } from '../transcript/live.js';
import { userInputText } from '../transcript/records.js';
import { reportActivity } from './activity.js';
import { deferred, errorFrom, TmuxInput } from './input.js';
import { TmuxSession } from './session.js';
import { TmuxTerminal, type NativeTurnEnd } from './terminal.js';
import { parseViewport, type TmuxViewport } from './viewport.js';

const POLL_MS = 100;
const START_TIMEOUT_MS = 30_000;
const INTERRUPT_TIMEOUT_MS = 5000;
const CONVERSATION_LOG =
  /\bStreaming conversation ([a-f\d]{8}-(?:[a-f\d]{4}-){3}[a-f\d]{12})(?=\s|$)/gi;

interface RuntimeInterrupt {
  turn: object | undefined;
  finish: (end: NativeTurnEnd | undefined) => void;
  wait: Promise<AgentRuntimeInterruptOutcome>;
}

export class TmuxRuntime implements AgentRuntime {
  private readonly session: TmuxSession;
  private readonly terminal: TmuxTerminal;
  private readonly fence: RuntimeStateFence;
  private transcript: DeferredTranscript | undefined;
  private sessionId: string | undefined;
  private input: TmuxInput | undefined;
  private viewport: TmuxViewport | undefined;
  private launching: Promise<AgentRuntimeStartOutcome> | undefined;
  private observing: Promise<void> | undefined;
  private poll: NodeJS.Timeout | undefined;
  private closing: Promise<void> | undefined;
  private stopping: Promise<void> | undefined;
  private closed: Error | null | undefined;
  private interrupting: RuntimeInterrupt | undefined;

  constructor(
    private readonly context: AgentRuntimeCreateContext<AntigravityConfig>,
    private readonly options: AntigravityRuntimeOptions,
  ) {
    this.session = new TmuxSession(context, options);
    this.terminal = new TmuxTerminal(context.events, (turn, end) => {
      if (this.interrupting?.turn === turn) this.interrupting.finish(end);
    });
    this.fence = new RuntimeStateFence({
      terminate: () =>
        this.closeNative(
          new Error('Antigravity runtime state publication failed'),
        ),
      log: (level, message, cause) =>
        context.logger[level]({ err: cause }, message),
    });
  }

  start(): Promise<AgentRuntimeStartOutcome> {
    return (this.launching ??= this.launchNative());
  }

  private async launchNative(): Promise<AgentRuntimeStartOutcome> {
    try {
      this.assertStarting();
      await this.publish({ kind: 'status', status: 'starting' });
      this.assertStarting();
      const transcript = new DeferredTranscript();
      this.transcript = transcript;
      this.input = new TmuxInput(
        this.session,
        transcript,
        () => this.observe(),
        () => this.writeBlocker(),
        () => this.viewport?.busy === true,
        (error) => this.transportFailed(error),
      );
      await this.session.start();
      this.assertStarting();
      await this.waitForComposer();
      this.assertStarting();
      await this.publish({ kind: 'status', status: 'ready' });
      this.assertStarting();
      this.scheduleObservation();
      return {
        continuity:
          this.context.identity.sessionId === null ? 'fresh' : 'resumed',
      };
    } catch (cause) {
      const error = errorFrom(cause);
      if (this.closed === undefined) this.transportFailed(error);
      await this.closing;
      throw error;
    }
  }

  private async waitForComposer(): Promise<void> {
    const deadline = Date.now() + START_TIMEOUT_MS;
    const expected = this.context.identity.sessionId;
    while (Date.now() < deadline) {
      this.assertStarting();
      await this.observeConversation();
      const viewport = parseViewport(await this.session.capture());
      if (viewport.blocker) throw viewport.blocker;
      if (
        viewport.ready &&
        (expected === null || this.sessionId === expected)
      ) {
        this.viewport = viewport;
        this.terminal.viewport(viewport);
        return;
      }
      await delay(POLL_MS);
    }
    throw new Error(
      expected === null
        ? 'Antigravity native TUI did not reach a ready composer'
        : 'Antigravity native TUI did not restore the requested conversation at a ready composer',
    );
  }

  private async observeConversation(): Promise<void> {
    if (this.sessionId !== undefined) return;
    const log = await readFile(this.options.nativeLogPath, 'utf8');
    const id = [...log.matchAll(CONVERSATION_LOG)].at(-1)?.[1];
    if (!id || this.sessionId === id) return;
    const expected = this.context.identity.sessionId;
    if (expected !== null && id !== expected) {
      throw new Error(
        'Antigravity native resume selected a different conversation',
      );
    }
    if (this.sessionId !== undefined) {
      throw new Error('Antigravity native conversation changed during runtime');
    }
    const roots = resolveAntigravityNativeRoots({
      ...process.env,
      ...this.context.config.extra_env,
    });
    await this.transcript?.attach(
      antigravityTranscriptPath(roots, id),
      expected === null,
    );
    this.sessionId = id;
    await this.publish({ kind: 'session', sessionId: id });
  }

  async submit(input: AgentRuntimeSubmissionInput): Promise<RuntimeAdmission> {
    if (this.stopping || this.closed === null) return { status: 'stopped' };
    if (this.closed) return { status: 'failed', error: this.closed };
    if (!this.input) return { status: 'stopped' };
    const blocked = this.writeBlocker();
    if (blocked) return { status: 'failed', error: blocked };
    return this.input.submit(input);
  }

  private writeBlocker(): Error | undefined {
    return this.viewport?.blocker;
  }

  interrupt(): Promise<AgentRuntimeInterruptOutcome> {
    if (this.interrupting) return this.interrupting.wait;
    if (!this.input || this.closed !== undefined)
      return Promise.resolve({ status: 'idle' });
    const signal = deferred<NativeTurnEnd | undefined>();
    const attempt: RuntimeInterrupt = {
      turn: undefined,
      finish: signal.resolve,
      wait: this.input.useComposer(async () => {
        await this.observe();
        attempt.turn = this.terminal.active;
        if (!attempt.turn || this.closed !== undefined)
          return { status: 'idle' };
        return this.waitForInterrupt(signal.promise);
      }),
    };
    this.interrupting = attempt;
    const clear = (): void => {
      this.interrupting = undefined;
    };
    void attempt.wait.then(clear, clear);
    return attempt.wait;
  }

  private async waitForInterrupt(
    terminal: Promise<NativeTurnEnd | undefined>,
  ): Promise<AgentRuntimeInterruptOutcome> {
    const deadline = new AbortController();
    try {
      await this.session.interrupt();
      const result = await Promise.race([
        terminal,
        delay(INTERRUPT_TIMEOUT_MS, undefined, { signal: deadline.signal }),
      ]);
      if (!result) {
        if (this.closed !== undefined) return { status: 'idle' };
        throw new Error(
          'Antigravity native TUI did not confirm interruption after Escape',
        );
      }
      if (result.status !== 'interrupted') return { status: 'idle' };
      if (!result.hasIdentity) {
        throw new Error(
          'Antigravity native TUI interrupted the turn without a native interrupted record ID',
        );
      }
      return { status: 'interrupted' };
    } finally {
      deadline.abort();
    }
  }

  stop(): Promise<void> {
    if (this.stopping) return this.stopping;
    const closing = this.closeNative();
    return (this.stopping = this.stopRuntime(closing));
  }

  private async stopRuntime(closing: Promise<void>): Promise<void> {
    await closing;
    await this.launching?.catch(() => undefined);
    await this.observing?.catch(() => undefined);
    await this.fence.terminated();
    if (!this.fence.isFenced)
      await this.publish({ kind: 'status', status: 'stopped' });
  }

  private closeNative(error?: Error): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = error ?? null;
    clearTimeout(this.poll);
    this.interrupting?.finish(undefined);
    if (this.transcript) this.terminal.teardown(error);
    const admissions = this.input?.close(error);
    return (this.closing = Promise.all([this.session.stop(), admissions]).then(
      () => undefined,
    ));
  }

  private scheduleObservation(): void {
    this.poll = setTimeout(() => {
      void this.observe()
        .catch(() => undefined)
        .finally(() => {
          if (this.closed === undefined) this.scheduleObservation();
        });
    }, POLL_MS).unref();
  }

  private observe(): Promise<void> {
    if (this.observing) return this.observing;
    const observing = this.observeNative();
    this.observing = observing;
    const clear = (): void => {
      if (this.observing === observing) this.observing = undefined;
    };
    void observing.then(clear, (error: unknown) => {
      clear();
      this.transportFailed(errorFrom(error));
    });
    return observing;
  }

  private async observeNative(): Promise<void> {
    if (this.closed !== undefined || !this.transcript) return;
    const capture = this.session.capture().then(parseViewport, errorFrom);
    await this.observeConversation();
    if (this.closed !== undefined) return;
    const records = await this.transcript.read();
    if (this.closed !== undefined) return;
    for (const entry of records) {
      const record = entry.record;
      const text =
        record.source === 'USER_EXPLICIT' ? userInputText(record) : null;
      const member = text === null ? undefined : this.input?.admit(entry, text);
      if (this.closed !== undefined) return;
      reportActivity(this.context.events, record);
      this.terminal.observe(
        record,
        member instanceof Error ? undefined : member,
      );
      if (member instanceof Error) {
        this.transportFailed(member);
        return;
      }
    }
    const viewport = await capture;
    if (this.closed !== undefined) return;
    if (viewport instanceof Error) throw viewport;
    this.viewport = viewport;
    this.terminal.viewport(viewport);
    if (viewport.blocker) throw viewport.blocker;
  }

  private transportFailed(error: Error): void {
    if (this.closed !== undefined) return;
    const closing = this.closeNative(error);
    void closing.catch((cause: unknown) => {
      this.context.logger.error(
        { err: cause },
        'Antigravity native tmux cleanup failed',
      );
    });
    this.fence.publishDetached(() =>
      this.context.state.publish({
        kind: 'status',
        status: 'degraded',
        lastError: error.message,
      }),
    );
  }

  private assertStarting(): void {
    this.fence.assertOpen();
    if (this.closed !== undefined)
      throw (
        this.closed ?? new Error('Antigravity runtime stopped during start')
      );
  }

  private publish(update: AgentRuntimeStateUpdate): Promise<void> {
    return this.fence.publish(() => this.context.state.publish(update));
  }
}
