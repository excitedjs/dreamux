/** Resident Claude Code AgentRuntime using stream-json stdio. */

import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

import type { DispatcherClaudeCodeConfig } from './config.js';
import { claudeCodeResidentArgs } from './args.js';
import { stringifyClaudeCodeMcpConfig } from './mcp-config.js';
import { materializeClaudeSkillAddDir } from './skill-materializer.js';
import type { ClaudeCodeSession } from './supervisor.js';
import type { ClaudeProtocolEvent } from './types.js';
import { consoleFallbackLogger } from './logger.js';
import type { ClaudeCodeRuntimeDeps } from './runtime-deps.js';
import {
  endNativeTurn,
  handleProtocolEvent,
  type NativeActivityState,
} from './runtime-activity.js';
import { buildClaudeProcessEnv } from './runtime-session.js';
import { RuntimeStateFence } from '@excitedjs/dreamux-utils';
import type {
  AgentRuntime,
  AgentRuntimeIdentity,
  AgentRuntimeStartOutcome,
  AgentRuntimeStatus,
  AgentRuntimeSubmissionInput,
  DreamuxLogger,
  RuntimeAdmission,
} from '@excitedjs/dreamux-types';

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * The Claude Code agent runtime for one dispatcher. A single resident
 * stream-json child accepts every input through the same native write path.
 * Admission returns after the write is acknowledged; each request is settled
 * by the session that consumed it, independently of later inputs.
 */
export class ClaudeCodeRuntime implements AgentRuntime {
  private readonly dispatcherId: string;
  private readonly config: DispatcherClaudeCodeConfig;
  private readonly bin: string;
  private readonly cwd: string;
  private readonly mcpConfigJson: string;
  /**
   * The materialized Claude view of this runtime's skill sources, or null when
   * it has none. The adapter root is keyed by what the sources hold on disk, so
   * it is only known once `startRuntime` has read them; every spawn happens
   * after that.
   */
  private skillAddDirRoot: string | null = null;
  private readonly stderrLogPath: string;
  private readonly logger: DreamuxLogger;
  private status: AgentRuntimeStatus = 'declared';
  private threadId: string | null;
  private resumeOnNextSpawn: boolean;
  private readonly resumed: boolean;
  /**
   * The provider-local fatal path for authoritative state writes. Any failure
   * to persist — a revoked lease or a plain write failure — fences input and
   * tears the resident child down; the runtime never continues on a state
   * record it could not update.
   */
  private readonly fence = new RuntimeStateFence({
    terminate: () => this.terminateForFence(),
    log: (level, message, error) => this.log(level, message, error),
  });
  private stopped = false;
  private readonly pendingAdmissions = new Set<Promise<RuntimeAdmission>>();
  private session: ClaudeCodeSession | null = null;
  private sessionStarting: Promise<ClaudeCodeSession> | null = null;
  private startTask: Promise<AgentRuntimeStartOutcome> | null = null;
  private stopTask: Promise<void> | null = null;
  private generation = 0;

  constructor(
    identity: AgentRuntimeIdentity,
    private readonly deps: ClaudeCodeRuntimeDeps,
  ) {
    const priorSessionId = identity.sessionId;
    this.dispatcherId = identity.runtimeId;
    this.config = deps.config;
    this.bin = deps.resolveBinPath(this.config.bin);
    this.cwd = deps.cwd;
    this.mcpConfigJson = stringifyClaudeCodeMcpConfig(deps.mcpServers);
    // Compose the resident stream-json child's stderr log under the neutral
    // central logs root (B2): core no longer names a per-runtime log file. The
    // host supplies a unique, filesystem-safe `runtimeId`.
    this.stderrLogPath = join(
      deps.paths.logsDir(),
      'claude-code',
      `${this.dispatcherId}.stderr.log`,
    );
    this.threadId = priorSessionId;
    this.resumeOnNextSpawn = priorSessionId !== null;
    this.resumed = priorSessionId !== null;
    this.logger = deps.logger ?? consoleFallbackLogger(this.dispatcherId);
  }

  start(): Promise<AgentRuntimeStartOutcome> {
    if (this.stopped) {
      return Promise.reject(new Error('claude-code runtime is stopped'));
    }
    if (this.startTask !== null) return this.startTask;
    if (this.status === 'ready') return Promise.resolve(this.startOutcome());
    const generation = this.generation;
    const task = this.startRuntime(generation);
    this.startTask = task;
    void task.finally(() => {
      if (this.startTask === task) this.startTask = null;
    }).catch(() => undefined);
    return task;
  }

  /**
   * Recovery is continuous by contract: when a prior session exists the child is
   * always spawned with `--resume`, and a failed resume propagates out of
   * `start` rather than silently becoming a fresh session.
   */
  private async startRuntime(
    generation: number,
  ): Promise<AgentRuntimeStartOutcome> {
    this.assertGeneration(generation);
    await this.publishStatus('starting');
    try {
      this.skillAddDirRoot = await materializeClaudeSkillAddDir(
        this.deps.paths.cacheDir(),
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
        await this.settleStatus('degraded', err);
      }
      throw err;
    }
    // The ready state must be durable before start resolves, so this publish is
    // awaited un-swallowed unlike the best-effort background status writes.
    await this.publishStatus('ready');
    this.assertGeneration(generation);
    return this.startOutcome();
  }

  private startOutcome(): AgentRuntimeStartOutcome {
    return Object.freeze({
      continuity: this.resumed ? 'resumed' : 'fresh',
    });
  }

  async stop(): Promise<void> {
    if (this.stopTask !== null) return this.stopTask;
    // A fenced runtime is already being torn down by the fence. Join that
    // teardown instead of publishing a terminal state through the sink that
    // just failed, and never report a stop the fence could not prove.
    if (this.fence.isFenced) return this.track(this.stopAfterFatalTeardown());
    if (this.status === 'stopped') return;
    this.stopped = true;
    this.generation += 1;
    // A live child being torn down will never report the native turn it was
    // still running, so this stop reports one interrupted end for it, without
    // asking whether a turn was open: the runtime keeps no such answer, and a
    // consumer with nothing open ignores the end. The end is for a live child
    // and not otherwise, as the fence's is: a start that failed left no child,
    // and Core stops that runtime before revoking its generation, so an end
    // here would close the card ahead of Core's own failed end carrying the
    // start error.
    if (this.session?.isAlive()) this.endNativeTurn('interrupted', null);
    return this.track(this.stopRuntime());
  }

  /** Single-flight the stop task, releasing the slot so a failure can retry. */
  private track(task: Promise<void>): Promise<void> {
    this.stopTask = task;
    void task.catch(() => {
      if (this.stopTask === task) this.stopTask = null;
    });
    return task;
  }

  /**
   * Converge a stop that arrived after the fence already started the fatal
   * teardown. A teardown that succeeded left the runtime stopped; one that
   * failed retained the resident session, so this retries against that retained
   * authority and rejects if the retry fails too.
   */
  private async stopAfterFatalTeardown(): Promise<void> {
    let fatal: unknown = null;
    try {
      await this.fence.terminated();
    } catch (error) {
      fatal = error;
    }
    if (fatal !== null) {
      this.log(
        'warn',
        'retrying claude-code teardown after a fatal state write left it unproven',
        fatal,
      );
      const session = this.session;
      if (session !== null) {
        // Rejects out of `stop()`: the child was not proved dead, and the
        // session reference stays so a further retry still has authority.
        await session.stop();
        if (this.session === session) this.session = null;
      }
    }
    // Same quiescence as an ordinary stop, on both paths.
    await this.drainAdmissions();
    this.status = 'stopped';
  }

  private async stopRuntime(): Promise<void> {
    const sessionAtStop = this.session;
    const sessionStop = sessionAtStop?.stop() ?? null;
    void sessionStop?.catch(() => undefined);
    await this.settleStatus('stopping');
    const session = this.session;
    if (session !== null) {
      await (session === sessionAtStop && sessionStop !== null
        ? sessionStop
        : session.stop());
      if (this.session === session) this.session = null;
    }
    await this.drainAdmissions();
    await this.settleStatus('stopped');
  }

  /**
   * Admit one already-rendered submission. The runtime holds no source ledger:
   * the text is the complete model-facing message, and deduplication is Core's,
   * ahead of this call.
   */
  submit(input: AgentRuntimeSubmissionInput): Promise<RuntimeAdmission> {
    return this.trackAdmission(this.acceptInput(input.text));
  }

  private async acceptInput(text: string): Promise<RuntimeAdmission> {
    if (this.stopped) return { status: 'stopped' };
    let session: ClaudeCodeSession;
    try {
      session = await this.ensureSession();
    } catch (error) {
      if (this.stopped) return { status: 'stopped' };
      this.setStatus('degraded', error);
      return { status: 'failed', error: error instanceof Error ? error : new Error(String(error)) };
    }
    if (this.stopped) return { status: 'stopped' };
    const admission = await session.submit(text);
    if (
      !this.stopped && this.session === session && session.isAlive() &&
      admission.status === 'submitted' && this.status !== 'ready'
    ) {
      this.setStatus('ready');
    }
    return admission;
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

  private endNativeTurn(
    status: 'completed' | 'failed' | 'interrupted',
    reason: string | null,
  ): void {
    endNativeTurn(status, reason, this.deps.activitySink);
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
    const args = claudeCodeResidentArgs({
      config: this.config,
      mcpConfigJson: this.mcpConfigJson,
      ...(resuming
        ? { resumeSessionId: candidateSessionId }
        : { freshSessionId: candidateSessionId }),
      systemPromptAppend: this.deps.systemPromptAppend,
      skillAddDirs:
        this.skillAddDirRoot === null ? [] : [this.skillAddDirRoot],
      disableFeatures: this.deps.disableFeatures,
      outputSchema: this.deps.outputSchema,
    });
    const activity: NativeActivityState = { activitySequence: 0, tools: new Map() };
    const session = this.deps.sessionFactory({
      bin: this.bin,
      args,
      cwd: this.cwd,
      env: buildClaudeProcessEnv(this.deps.injectEnv, this.config.extra_env),
      stderrLogPath: this.stderrLogPath,
      sessionId: candidateSessionId,
      outputSchemaEnabled: this.deps.outputSchema !== undefined,
      turnTimeoutMs: this.config.turn_timeout_ms,
      remoteControl: this.config.remote_control,
      onRemoteControlUrl: this.config.remote_control
        ? (url) => {
            this.log('info', `claude-code remote control URL: ${url}`);
          }
        : undefined,
      onProtocolEvent: (event) => this.onProtocolEvent(event, activity),
      log: (level, msg, err) => this.log(level, msg, err),
    });
    session.setOnExit((error) => {
      void this.onSessionExit(session, error);
    });
    // Retain termination authority before spawn.
    this.session = session;
    try {
      this.assertGeneration(generation);
      await session.start();
      this.assertGeneration(generation);
      // Publish resolves only after the durable write, so awaiting it here is
      // what makes the session durable before start resolves.
      await this.fence.publish(() => this.deps.state.publish({
        kind: 'session',
        sessionId: candidateSessionId,
      }));
      this.assertGeneration(generation);
      this.threadId = candidateSessionId;
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

  /** React to an unexpected resident-child exit: degrade and drop the session. */
  private async onSessionExit(session: ClaudeCodeSession, error: Error): Promise<void> {
    if (this.session !== session) return; // already replaced/stopped
    if (this.stopped) return;
    this.log('error', 'claude-code resident child exited unexpectedly');
    this.endNativeTurn('failed', error.message);
    try {
      await session.stop();
      if (this.session === session) this.session = null;
    } catch (error) {
      this.setStatus('degraded', error);
      return;
    }
    if (!this.stopped) {
      this.setStatus('degraded', error);
    }
  }

  private onProtocolEvent(event: ClaudeProtocolEvent, activity: NativeActivityState): void {
    if (this.stopped) return;
    handleProtocolEvent(event, {
      activity,
      activitySink: this.deps.activitySink,
    });
  }

  private assertGeneration(generation: number): void {
    if (this.stopped || this.fence.isFenced || generation !== this.generation) {
      throw new Error('claude-code runtime is stopped');
    }
  }

  /**
   * The fence's native teardown. Deliberately not `stop()`: `stop()` publishes
   * `stopping`/`stopped` through the very sink that just proved unusable, so it
   * would only produce a second failure. This closes the resident child and
   * settles in-flight work, and nothing else.
   *
   * It runs synchronously up to its first await, so `stopped` and the bumped
   * generation fence input immediately — a submit arriving after the fatal
   * write is already refused.
   */
  private async terminateForFence(): Promise<void> {
    this.stopped = true;
    this.generation += 1;
    const session = this.session;
    if (session !== null) {
      // Killing a live child interrupts whatever it was running; the end is
      // reported for that child and not otherwise. A fence that fires while a
      // start is still failing has no child, and the card is then closed by
      // Core's own failed end carrying the start error.
      if (session.isAlive()) this.endNativeTurn('interrupted', null);
      // The reference is dropped only once this child's own stop succeeded; a
      // failure propagates to `RuntimeStateFence.terminated()` with the
      // termination authority intact, and leaves the status alone so a later
      // `stop()` cannot read 'stopped' off a child never proved dead.
      await session.stop();
      if (this.session === session) this.session = null;
    }
    this.status = 'stopped';
  }

  private async publishStatus(
    status: AgentRuntimeStatus,
    err?: unknown,
  ): Promise<void> {
    this.status = status;
    await this.fence.publish(() => this.deps.state.publish({
      kind: 'status',
      status,
      ...(err !== undefined ? { lastError: errMessage(err) } : {}),
    }));
  }

  /**
   * Persist a status the caller's own outcome does not depend on, but whose
   * ordering does: `stop` must not resolve before its terminal write lands,
   * because Core keeps this generation's lease valid exactly until stop
   * settles and a detached write would race the revocation that follows.
   *
   * The error is not rethrown. The fence has already made it terminal, and
   * these callers report something else — whether the child terminated, or the
   * original start failure — which a state-write failure does not change.
   */
  private async settleStatus(
    status: AgentRuntimeStatus,
    err?: unknown,
  ): Promise<void> {
    try {
      await this.publishStatus(status, err);
    } catch {
      // Already logged and acted on by the fence.
    }
  }

  /**
   * Record a status on the background paths (turn failure, child exit).
   *
   * Core's durable state is the authority; this field is only the runtime's own
   * lifecycle guard, and it is updated first so the guard stays correct even as
   * the fence closes. The write itself is detached: it
   * must not surface as an unhandled rejection on the shared event loop (#85),
   * and a failure is already terminal through the fence, so there is nothing
   * left for this caller to do about it. The start path awaits `publishStatus`
   * instead, because the ready state must be durable before `start` resolves.
   */
  private setStatus(status: AgentRuntimeStatus, err?: unknown): void {
    // A fenced runtime is terminal: its status is owned by the teardown, and a
    // late background transition must not reopen it.
    if (this.fence.isFenced) return;
    this.status = status;
    this.fence.publishDetached(() => this.deps.state.publish({
      kind: 'status',
      status,
      ...(err !== undefined ? { lastError: errMessage(err) } : {}),
    }));
  }

  private log(
    level: 'info' | 'warn' | 'error',
    msg: string,
    err?: unknown,
  ): void {
    this.logger[level](err !== undefined ? { err } : {}, msg);
  }
}
