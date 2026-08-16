/** Resident Claude Code AgentRuntime using stream-json stdio. */

import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

import { BUILTIN_CLAUDE_CODE_PROVIDER_REF } from './provider-ref.js';
import type { DispatcherClaudeCodeConfig } from './config.js';
import { claudeCodeResidentArgs } from './args.js';
import { stringifyClaudeCodeMcpConfig } from './mcp-config.js';
import { skillAdapterKey } from './skill-adapter.js';
import { materializeClaudeSkillAddDir } from './skill-materializer.js';
import {
  type ClaudeCodeSession,
  type TurnSubmitOptions,
} from './supervisor.js';
import {
  DEFAULT_MESSAGE_ID_DEDUPE_WINDOW,
  renderChannelInput,
  unsupportedFeatureError,
} from '@excitedjs/dreamux-utils';
import { CLAUDE_CODE_AGENT_RUNTIME_CAPABILITIES } from './provider.js';
import { consoleFallbackLogger } from './logger.js';
import { createRuntimeTurn } from './runtime-turn.js';
import { ClaudeSteerAdmissionError } from './rpc.js';
import type { ClaudeCodeRuntimeDeps } from './runtime-deps.js';
import {
  asError,
  classifySteerFailure,
  reserveSource,
} from './source-reservation.js';
import {
  buildClaudeProcessEnv,
  resolveRuntimeTranscriptPath,
  resultTextFromTurnOutcome,
} from './runtime-session.js';
import type {
  AgentRuntimeCapabilities,
  AgentRuntime,
  AgentRuntimeIdentity,
  AgentRuntimeStatus,
  AgentRuntimeTextInput,
  DreamuxLogger,
  InboundTurnInput,
  RuntimeAdmission,
  RuntimeTurn,
  RuntimeTurnOutcome,
} from '@excitedjs/dreamux-types';
interface ActiveTurn {
  runtimeTurn: RuntimeTurn;
  settle: (outcome: RuntimeTurnOutcome) => boolean;
  pendingSteers: string[];
  session: ClaudeCodeSession | null;
  steerQueue: Promise<void>;
  generation: number;
  /** Options passed to the initial `submitTurn` for this logical turn. */
  submitOptions?: TurnSubmitOptions;
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * The Claude Code agent runtime for one dispatcher. A single resident
 * stream-json child serves every turn. Turns run serially (one at a time) and
 * `channelInput` returns after the message is accepted — not after the turn
 * completes — matching the Codex runtime's submit-then-serialize contract.
 */
export class ClaudeCodeRuntime implements AgentRuntime {
  readonly providerRef = BUILTIN_CLAUDE_CODE_PROVIDER_REF;

  private readonly dispatcherId: string;
  private readonly config: DispatcherClaudeCodeConfig;
  private readonly bin: string;
  private readonly cwd: string;
  private readonly mcpConfigJson: string;
  private readonly skillAddDirRoot: string;
  private readonly stderrLogPath: string;
  private readonly logger: DreamuxLogger;
  private status: AgentRuntimeStatus = 'declared';
  private threadId: string | null;
  private transcriptLocator: string | null;
  private resumeOnNextSpawn: boolean;
  private resumed: boolean;
  private stopped = false;
  private readonly seen = new Set<string>();
  private readonly seenOrder: string[] = [];
  private readonly seenTextInputIds = new Set<string>();
  private readonly seenTextInputIdOrder: string[] = [];
  private readonly sourceIdDedupeWindow: number;
  private readonly pendingChannelSources = new Map<
    string,
    Promise<RuntimeAdmission>
  >();
  private readonly pendingTextSources = new Map<
    string,
    Promise<RuntimeAdmission>
  >();
  private readonly pendingAdmissions = new Set<Promise<RuntimeAdmission>>();
  private queue: Promise<void> = Promise.resolve();
  private session: ClaudeCodeSession | null = null;
  private sessionStarting: Promise<ClaudeCodeSession> | null = null;
  private startTask: Promise<void> | null = null;
  private stopTask: Promise<void> | null = null;
  private generation = 0;
  private activeTurn: ActiveTurn | null = null;
  private queuedTurnCount = 0;
  private idlePromise: Promise<void> | null = null;
  private idleResolve: (() => void) | null = null;

  constructor(
    identity: AgentRuntimeIdentity,
    private readonly deps: ClaudeCodeRuntimeDeps,
  ) {
    const checkpoint = identity.checkpoint ?? null;
    this.dispatcherId = identity.runtime_id;
    this.config = deps.config;
    this.bin = deps.resolveBinPath(this.config.bin);
    this.cwd = deps.cwd;
    this.skillAddDirRoot = join(
      deps.paths.cacheDir(),
      'claude-code',
      'skills',
      skillAdapterKey(deps.skillSources ?? []),
    );
    this.mcpConfigJson = stringifyClaudeCodeMcpConfig(deps.mcpServers);
    // Compose the resident stream-json child's stderr log under the neutral
    // central logs root (B2): core no longer names a per-runtime log file. The
    // host supplies a unique, filesystem-safe `runtime_id`.
    this.stderrLogPath = join(
      deps.paths.logsDir(),
      'claude-code',
      `${this.dispatcherId}.stderr.log`,
    );
    this.threadId = checkpoint?.id ?? null;
    this.transcriptLocator = checkpoint?.transcript_locator ?? null;
    this.resumeOnNextSpawn = checkpoint !== null;
    this.resumed = identity.checkpoint !== null;
    this.sourceIdDedupeWindow = Math.max(0,
      deps.sourceIdDedupeWindow ?? DEFAULT_MESSAGE_ID_DEDUPE_WINDOW);
    this.logger = deps.logger ?? consoleFallbackLogger(this.dispatcherId);
  }

  getStatus(): AgentRuntimeStatus {
    return this.status;
  }

  getCapabilities(): AgentRuntimeCapabilities {
    return CLAUDE_CODE_AGENT_RUNTIME_CAPABILITIES;
  }

  getCheckpoint(): {
    id: string;
    transcript_locator?: string | null;
  } | null {
    return this.threadId === null
      ? null
      : {
          id: this.threadId,
          transcript_locator: this.transcriptLocator,
        };
  }

  wasCheckpointResumed(): boolean {
    return this.resumed;
  }

  async getContext(): Promise<null> {
    return null;
  }

  async resume(): Promise<void> {
    await this.start();
  }

  start(): Promise<void> {
    if (this.stopped) {
      return Promise.reject(new Error('claude-code runtime is stopped'));
    }
    if (this.startTask !== null) return this.startTask;
    if (this.status === 'ready') return Promise.resolve();
    const generation = this.generation;
    const task = this.startRuntime(generation);
    this.startTask = task;
    void task.finally(() => {
      if (this.startTask === task) this.startTask = null;
    }).catch(() => undefined);
    return task;
  }

  private async startRuntime(generation: number): Promise<void> {
    this.assertGeneration(generation);
    await this.setStatus('starting');
    try {
      await materializeClaudeSkillAddDir(
        this.skillAddDirRoot,
        this.deps.skillSources ?? [],
      );
      this.assertGeneration(generation);
      // Spawn the resident child up front so the runtime is truly resident
      // (Codex-aligned). A missing/broken `claude` binary fails here and drives
      // the runtime to degraded + throws, rather than a silent no-op.
      await this.ensureSession();
      this.assertGeneration(generation);
    } catch (err) {
      if (!this.stopped && generation === this.generation) {
        await this.setStatus('degraded', err);
      }
      throw err;
    }
    await this.setStatus('ready');
    this.assertGeneration(generation);
  }

  async stop(): Promise<void> {
    if (this.status === 'stopped') return;
    if (this.stopTask !== null) return this.stopTask;
    this.stopped = true;
    this.generation += 1;
    this.activeTurn?.settle({ status: 'stopped' });
    const task = this.stopRuntime();
    this.stopTask = task;
    try {
      await task;
    } catch (error) {
      if (this.stopTask === task) this.stopTask = null;
      throw error;
    }
  }

  private async stopRuntime(): Promise<void> {
    const sessionAtStop = this.session;
    const sessionStop = sessionAtStop?.stop() ?? null;
    void sessionStop?.catch(() => undefined);
    await this.setStatus('stopping');
    const session = this.session;
    if (session !== null) {
      await (session === sessionAtStop && sessionStop !== null
        ? sessionStop
        : session.stop());
      if (this.session === session) this.session = null;
    }
    await this.drainAdmissions();
    await this.queue;
    this.resolveIdleWaitersIfIdle();
    await this.setStatus('stopped');
  }

  completionInput(input: AgentRuntimeTextInput): Promise<RuntimeAdmission> {
    return this.trackAdmission(this.completionInputImpl(input));
  }

  private async completionInputImpl(
    input: AgentRuntimeTextInput,
  ): Promise<RuntimeAdmission> {
    if (this.stopped) return { status: 'stopped' };
    if (input.outputSchema !== undefined) {
      // `--json-schema` is fixed at spawn time. A per-turn schema matching the
      // spawn-time one is a no-op; a different one fails loud.
      const spawnSchema = this.deps.outputSchema;
      const matchesSpawn =
        spawnSchema !== undefined &&
        JSON.stringify(spawnSchema) === JSON.stringify(input.outputSchema);
      if (!matchesSpawn) {
        const error = unsupportedFeatureError(
          'outputSchema',
          spawnSchema === undefined
            ? 'claude-code runtime does not support per-turn outputSchema on the resident session'
            : 'claude-code runtime cannot change the output schema mid-session',
        );
        return { status: 'failed', error };
      }
    }
    return reserveSource(
      input.sourceId,
      this.seenTextInputIds,
      this.seenTextInputIdOrder,
      this.pendingTextSources,
      this.sourceIdDedupeWindow,
      () => this.acceptTextInput(input),
    );
  }

  private async acceptTextInput(
    input: AgentRuntimeTextInput,
  ): Promise<RuntimeAdmission> {
    if (this.stopped) return { status: 'stopped' };
    // Plain-text teammate/completion turns share the same active steerable
    // logical-turn slot as channel inbound (PR #282 E2E regression): a send
    // that arrives while an earlier turn is still in-flight folds into that
    // active turn via `steerTurn({ priority: 'next' })` and returns the same
    // exact RuntimeTurn, aligned with the Codex active-slot semantics. This is
    // the runtime-owned plain-text path — no channel/XML
    // rendering is applied.
    const active = this.activeTurn;
    if (active !== null) {
      try {
        await this.steerActiveTurn(active, input.text);
        return { status: 'submitted', turn: active.runtimeTurn };
      } catch (err) {
        return classifySteerFailure(err, this.stopped);
      }
    }
    const runtimeTurn = createRuntimeTurn();
    this.recordQueuedTurnStart();
    const turn: ActiveTurn = {
      runtimeTurn: runtimeTurn.turn,
      settle: runtimeTurn.settle,
      pendingSteers: [],
      session: null,
      steerQueue: Promise.resolve(),
      generation: this.generation,
      // Dreamux-owned plain text turns are real user turns, not synthetic
      // system injections.
      submitOptions: { isSynthetic: false },
    };
    this.activeTurn = turn;
    void this.runActiveTurnOnQueue(input.text, turn).then(
      (resultText) => this.markTurnSucceeded(turn, resultText),
      (err) => this.markTurnFailed(turn, err),
    );
    return { status: 'submitted', turn: turn.runtimeTurn };
  }

  channelInput(input: InboundTurnInput): Promise<RuntimeAdmission> {
    return this.trackAdmission(this.channelInputImpl(input));
  }

  private async channelInputImpl(
    input: InboundTurnInput,
  ): Promise<RuntimeAdmission> {
    if (this.stopped) return { status: 'stopped' };
    // This runtime owns wrapping the channel input into its delivery shape: a
    // structured channel turn becomes the native `<channel source="…">` block;
    // a plain turn passes through unchanged.
    let text: string;
    try {
      text = renderChannelInput(input);
    } catch (error) {
      return { status: 'failed', error: asError(error) };
    }
    return reserveSource(
      input.sourceId,
      this.seen,
      this.seenOrder,
      this.pendingChannelSources,
      this.sourceIdDedupeWindow,
      () => this.acceptChannelInput(text),
    );
  }

  private async acceptChannelInput(text: string): Promise<RuntimeAdmission> {
    if (this.stopped) return { status: 'stopped' };
    const active = this.activeTurn;
    if (active !== null) {
      try {
        await this.steerActiveTurn(active, text);
        return { status: 'submitted', turn: active.runtimeTurn };
      } catch (err) {
        return classifySteerFailure(err, this.stopped);
      }
    }
    const runtimeTurn = createRuntimeTurn();
    this.recordQueuedTurnStart();
    const turn: ActiveTurn = {
      runtimeTurn: runtimeTurn.turn,
      settle: runtimeTurn.settle,
      pendingSteers: [],
      session: null,
      steerQueue: Promise.resolve(),
      generation: this.generation,
      // Channel-initial turns carry no explicit submit options; the native
      // `submitTurn(prompt)` call is unchanged from before the shared active-slot
      // refactor (the existing test asserts `submitOptions[0]` is undefined).
    };
    this.activeTurn = turn;
    // Submit-then-serialize: return after accept (so the channel can ack
    // promptly), run the turn on the serial queue. A turn failure cannot be
    // returned to this caller without blocking the channel ack on full turn
    // completion. Instead, a failed turn drives the runtime to `degraded` with a
    // persisted `last_error` (visible via status/doctor) — never swallowed.
    void this.runActiveTurnOnQueue(text, turn).then(
      (resultText) => this.markTurnSucceeded(turn, resultText),
      (err) => this.markTurnFailed(turn, err),
    );
    return { status: 'submitted', turn: turn.runtimeTurn };
  }

  private trackAdmission(
    admission: Promise<RuntimeAdmission>,
  ): Promise<RuntimeAdmission> {
    this.pendingAdmissions.add(admission);
    void admission.finally(() => {
      this.pendingAdmissions.delete(admission);
    }).catch(() => undefined);
    return admission;
  }

  private async drainAdmissions(): Promise<void> {
    while (this.pendingAdmissions.size > 0) {
      await Promise.allSettled([...this.pendingAdmissions]);
    }
  }

  waitIdle(): Promise<void> {
    if (this.queuedTurnCount === 0) return Promise.resolve();
    // All concurrent waiters share one promise for the current busy period; it
    // is replaced with a fresh one the next time a turn is queued.
    if (this.idlePromise === null) {
      this.idlePromise = new Promise((resolve) => {
        this.idleResolve = resolve;
      });
    }
    return this.idlePromise;
  }

  private runActiveTurnOnQueue(
    prompt: string,
    active: ActiveTurn,
  ): Promise<string | null> {
    const run = this.queue.then(() => this.runActiveTurn(prompt, active));
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async runActiveTurn(
    prompt: string,
    active: ActiveTurn,
  ): Promise<string | null> {
    try {
      this.assertGeneration(active.generation);
      const session = await this.ensureSession();
      this.assertGeneration(active.generation);
      const steers = active.pendingSteers.splice(0);
      const fullPrompt =
        steers.length === 0 ? prompt : [prompt, ...steers].join('\n\n');
      const outcome = session.submitTurn(fullPrompt, active.submitOptions);
      active.session = session;
      const settled = await outcome;
      this.assertGeneration(active.generation);
      const resultText = resultTextFromTurnOutcome(
        settled,
        this.threadId,
        this.deps.outputSchema !== undefined,
      );
      this.log('info', 'claude-code turn completed');
      return resultText;
    } finally {
      active.session = null;
      if (this.activeTurn === active) this.activeTurn = null;
      active.pendingSteers = [];
    }
  }

  private async steerActiveTurn(
    active: ActiveTurn,
    prompt: string,
  ): Promise<void> {
    this.assertGeneration(active.generation);
    const session = active.session;
    if (session === null) {
      active.pendingSteers.push(prompt);
      return;
    }
    const steer = active.steerQueue.then(() => {
      this.assertGeneration(active.generation);
      if (active.session !== session || this.session !== session) {
        throw new ClaudeSteerAdmissionError(
          'failed',
          'claude-code session changed before live steer',
        );
      }
      return session.steerTurn(prompt, { priority: 'next' });
    });
    active.steerQueue = steer.then(
      () => undefined,
      () => undefined,
    );
    await steer;
    this.assertGeneration(active.generation);
  }

  private async markTurnSucceeded(
    turn: ActiveTurn,
    resultText: string | null,
  ): Promise<void> {
    this.recordQueuedTurnEnd();
    turn.settle({
      status: 'completed',
      resultText,
      truncated: false,
    });
    if (this.stopped) return;
    if (this.status !== 'ready') await this.setStatus('ready');
  }

  private async markTurnFailed(turn: ActiveTurn, err: unknown): Promise<void> {
    this.recordQueuedTurnEnd();
    this.log('error', 'claude-code turn failed', err);
    // A turn that fails after stop() was requested (the resident child is being
    // torn down) is a `stopped` settlement; otherwise it is a genuine `failed`.
    // Fire before the stopped early-return so an interrupted teammate turn is
    // never lost.
    turn.settle(
      this.stopped
        ? { status: 'stopped' }
        : {
            status: 'failed',
            error: err instanceof Error ? err : new Error(String(err)),
          },
    );
    if (this.stopped) return;
    // Surface the failure as durable runtime state rather than swallowing it.
    await this.setStatus('degraded', err);
  }

  private recordQueuedTurnStart(): void {
    this.queuedTurnCount += 1;
  }

  private recordQueuedTurnEnd(): void {
    this.queuedTurnCount = Math.max(0, this.queuedTurnCount - 1);
    this.resolveIdleWaitersIfIdle();
  }

  private resolveIdleWaitersIfIdle(): void {
    if (this.queuedTurnCount !== 0) return;
    const resolve = this.idleResolve;
    this.idlePromise = null;
    this.idleResolve = null;
    resolve?.();
  }

  /** Ensure a live resident session exists, resuming after a child exit. */
  private async ensureSession(): Promise<ClaudeCodeSession> {
    if (this.stopped) throw new Error('claude-code runtime is stopped');
    if (this.sessionStarting !== null) return this.sessionStarting;
    if (this.session !== null && this.session.isAlive()) return this.session;
    const generation = this.generation;
    const starting = this.createSession(generation);
    this.sessionStarting = starting;
    void starting.finally(() => {
      if (this.sessionStarting === starting) this.sessionStarting = null;
    }).catch(() => undefined);
    return starting;
  }

  private async createSession(generation: number): Promise<ClaudeCodeSession> {
    this.assertGeneration(generation);
    const previous = this.session;
    if (previous !== null) {
      await previous.stop();
      if (this.session === previous) this.session = null;
      this.assertGeneration(generation);
    }
    const resuming = this.resumeOnNextSpawn;
    const candidateSessionId =
      resuming
        ? this.threadId!
        : (this.deps.generateSessionId?.() ?? randomUUID());
    const candidatePath = await this.resolveTranscriptPath({
      sessionId: candidateSessionId,
      locator: resuming ? this.transcriptLocator : null,
      resume: resuming,
    });
    const args = claudeCodeResidentArgs({
      config: this.config,
      mcpConfigJson: this.mcpConfigJson,
      ...(resuming
        ? { resumeSessionId: candidateSessionId }
        : { freshSessionId: candidateSessionId }),
      systemPromptAppend: this.deps.systemPromptAppend,
      skillAddDirs:
        (this.deps.skillSources ?? []).length === 0
          ? []
          : [this.skillAddDirRoot],
      disableFeatures: this.deps.disableFeatures,
      outputSchema: this.deps.outputSchema,
    });
    const session = this.deps.sessionFactory({
      bin: this.bin,
      args,
      cwd: this.cwd,
      env: buildClaudeProcessEnv(this.deps.injectEnv, this.config.extra_env),
      stderrLogPath: this.stderrLogPath,
      turnTimeoutMs: this.config.turn_timeout_ms,
      remoteControl: this.config.remote_control,
      onRemoteControlUrl: this.config.remote_control
        ? (url) => {
            this.log('info', `claude-code remote control URL: ${url}`);
          }
        : undefined,
      log: (level, msg, err) => this.log(level, msg, err),
    });
    session.setOnExit(() => {
      void this.onSessionExit(session);
    });
    // Retain termination authority before spawn.
    this.session = session;
    try {
      this.assertGeneration(generation);
      await session.start();
      this.assertGeneration(generation);
      await this.deps.state.setCheckpoint({
        id: candidateSessionId,
        transcript_locator: candidatePath,
      });
      this.assertGeneration(generation);
      this.threadId = candidateSessionId;
      this.transcriptLocator = candidatePath;
      this.resumeOnNextSpawn = true;
    } catch (error) {
      if (this.stopped) throw error;
      try {
        await session.stop();
        if (this.session === session) this.session = null;
      } catch (stopError) {
        throw new AggregateError(
          [error, stopError],
          'claude session start failed and termination could not be proved',
        );
      }
      throw error;
    }
    return session;
  }

  private resolveTranscriptPath(input: {
    sessionId: string;
    locator: string | null;
    resume: boolean;
  }): Promise<string> {
    return resolveRuntimeTranscriptPath({
      sessionId: input.sessionId,
      cwd: this.cwd,
      locator: input.locator,
      env: buildClaudeProcessEnv(
        this.deps.injectEnv,
        this.config.extra_env,
      ),
      resume: input.resume,
      override: this.deps.resolveTranscriptPath,
    });
  }
  /** React to an unexpected resident-child exit: degrade and drop the session. */
  private async onSessionExit(session: ClaudeCodeSession): Promise<void> {
    if (this.session !== session) return; // already replaced/stopped
    if (this.stopped) return;
    this.log('error', 'claude-code resident child exited unexpectedly');
    try {
      await session.stop();
      if (this.session === session) this.session = null;
    } catch (error) {
      await this.setStatus('degraded', error);
      return;
    }
    if (!this.stopped) {
      await this.setStatus(
        'degraded',
        new Error('claude resident child exited'),
      );
    }
  }
  private assertGeneration(generation: number): void {
    if (this.stopped || generation !== this.generation) {
      throw new Error('claude-code runtime is stopped');
    }
  }

  private async setStatus(
    status: AgentRuntimeStatus,
    err?: unknown,
  ): Promise<void> {
    // The in-memory status is authoritative (getStatus reads it). Persisting it is
    // best-effort recovery state (#98): a write failure (e.g. the host state dir is
    // momentarily unavailable) must not crash the runtime or surface as an
    // unhandled rejection on the shared event loop (#85) — especially from the
    // fire-and-forget turn-failure / child-exit paths. Log and continue.
    this.status = status;
    try {
      await this.deps.state.setStatus(
        status,
        err !== undefined ? { last_error: errMessage(err) } : {},
      );
    } catch (persistErr) {
      this.log('warn', 'failed to persist runtime status', persistErr);
    }
  }

  private log(
    level: 'info' | 'warn' | 'error',
    msg: string,
    err?: unknown,
  ): void {
    this.logger[level](err !== undefined ? { err } : {}, msg);
  }
}
