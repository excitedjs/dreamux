
import { join } from 'node:path';

import {
  CodexProcess,
  type CodexProcessExit,
} from './supervisor.js';
import { CodexWsClient } from './rpc.js';
import { performInitializeHandshake } from './handshake.js';
import type {
  ThreadResumeParams,
  ThreadResumeResponse,
  ThreadStartParams,
  ThreadStartResponse,
} from './types.js';
import {
  TurnManager,
} from './turn-manager.js';
import { createFailFastApprovalHandler } from './approval.js';
import { RuntimeStateFence } from '@excitedjs/dreamux-utils';
import type {
  AgentRuntime,
  AgentRuntimeIdentity,
  AgentRuntimePathContext,
  AgentRuntimeStartOutcome,
  AgentRuntimeStateSink,
  AgentRuntimeStateUpdate,
  AgentRuntimeStatus,
  AgentRuntimeSubmissionInput,
  RuntimeAdmission,
} from '@excitedjs/dreamux-types';
import {
  codexProcessEnv,
  renderCodexSystemPromptAppend,
} from './runtime-support.js';
import { applyCodexSkillExtraRoots } from './skill-roots.js';
import type { CodexRuntimeDeps } from './runtime-deps.js';

const DEFAULT_RESTART_BACKOFF_BASE_MS = 1000;
const DEFAULT_RESTART_BACKOFF_MAX_MS = 30_000;

export class CodexRuntime implements AgentRuntime {
  private process: CodexProcess | null = null;
  private client: CodexWsClient | null = null;
  private turnManager: TurnManager | null = null;
  private threadId: string | null = null;
  private threadResumed = false;
  private startOutcome: AgentRuntimeStartOutcome | null = null;
  /**
   * The provider-local fatal path for authoritative state writes. Any failure
   * to persist — a revoked lease or a plain write failure — fences input, stops
   * the restart loop, and tears the app-server child down; the runtime never
   * keeps running against a state record it could not update.
   */
  private readonly fence = new RuntimeStateFence({
    terminate: () => this.terminateForFence(),
    log: (level, message, error) => this.log(level, message, error),
  });
  private status: AgentRuntimeStatus = 'declared';
  private readonly log: (
    level: 'info' | 'warn' | 'error',
    msg: string,
    err?: unknown,
  ) => void;
  private stopping = false;
  private restarting = false;
  private generation = 0;
  private startupTask: Promise<AgentRuntimeStartOutcome> | null = null;
  private restartTask: Promise<void> | null = null;
  private stopTask: Promise<void> | null = null;
  private restartAttempts = 0;
  private restartTimer: NodeJS.Timeout | null = null;
  private readonly state: AgentRuntimeStateSink;
  private readonly paths: AgentRuntimePathContext;

  constructor(
    private readonly identity: AgentRuntimeIdentity,
    private readonly deps: CodexRuntimeDeps,
  ) {
    const logger = deps.logger;
    this.log =
      logger !== undefined
        ? (lvl, msg, err) =>
            logger[lvl](err !== undefined ? { err } : {}, msg)
        : (lvl, msg, err) => {
            const prefix = `[dispatcher ${identity.runtimeId}] ${lvl}`;
            if (err !== undefined) console.error(prefix, msg, err);
            else console.error(prefix, msg);
          };
    this.threadId = identity.sessionId;
    this.state = deps.state;
    this.paths = deps.paths;
  }

  /**
   * The host-supplied runtime id, used for this package's own paths and log
   * fields. Private: the live handle Core holds is `start`/`submit`/`stop`, and
   * a runtime answers no questions about itself.
   */
  private get dispatcherId(): string {
    return this.identity.runtimeId;
  }

  start(): Promise<AgentRuntimeStartOutcome> {
    if (this.startupTask !== null) return this.startupTask;
    if (this.stopping || this.stopTask !== null || this.status === 'stopped') {
      return Promise.reject(new Error('codex runtime is stopped'));
    }
    if (this.status === 'ready' && this.startOutcome !== null) {
      return Promise.resolve(this.startOutcome);
    }
    this.restarting = false;
    this.generation += 1;
    this.clearRestartTimer();
    const generation = this.generation;
    const task = this.startRuntime(generation);
    this.startupTask = task;
    void task.finally(() => {
      if (this.startupTask === task) this.startupTask = null;
    }).catch(() => undefined);
    return task;
  }

  private async startRuntime(
    generation: number,
  ): Promise<AgentRuntimeStartOutcome> {
    this.setStatus('starting');
    await this.publish({ kind: 'status', status: 'starting' });

    try {
      await this.startCodexRuntime(generation, { allowFreshFallback: false });
      this.assertGeneration(generation);
      await this.markReady(generation);
      const outcome: AgentRuntimeStartOutcome = Object.freeze({
        continuity: this.threadResumed ? 'resumed' : 'fresh',
      });
      this.startOutcome = outcome;
      return outcome;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.log('error', `start failed: ${msg}`, err);
      const failures: unknown[] = [err];
      if (!this.stopping && generation === this.generation) {
        this.setStatus('degraded');
        // Awaited for ordering, but not folded into `failures`: the fence has
        // already made a failed write terminal, and start must report the
        // original start failure.
        await this.settleState({
          kind: 'status',
          status: 'degraded',
          lastError: msg,
        });
      }
      try {
        await this.cleanupOnFailure();
      } catch (cleanupError) {
        failures.push(cleanupError);
      }
      if (failures.length > 1) {
        const failureDetails = failures.slice(1).map((failure) =>
          failure instanceof Error ? failure.message : String(failure)
        ).join('; ');
        throw new AggregateError(
          failures,
          `codex runtime start failed and cleanup did not fully converge: ${failureDetails}`,
        );
      }
      throw err;
    }
  }

  private async startCodexRuntime(
    generation: number,
    options: { allowFreshFallback: boolean },
  ): Promise<void> {
    this.assertGeneration(generation);
    if (this.process !== null) {
      throw new Error(
        'codex runtime retains an unterminated process from a prior attempt',
      );
    }
    const cwd = this.deps.cwd;
    const socketPath = this.deps.allocateSocketPath(this.dispatcherId);
    const extraArgs = this.deps.resolveExtraArgs?.() ?? [];
    if (this.deps.codexHomeDoctor !== undefined) {
      await this.deps.codexHomeDoctor({ runtimeId: this.dispatcherId, cwd });
      this.assertGeneration(generation);
    }
    const codexLogDir = join(this.paths.logsDir(), 'codex-app-server');
    const factory = this.deps.codexProcessFactory ?? ((o) => new CodexProcess(o));
    const process = factory({
      socketPath,
      cwd,
      stdoutLogPath: join(codexLogDir, `${this.dispatcherId}.log`),
      stderrLogPath: join(codexLogDir, `${this.dispatcherId}.stderr.log`),
      binPath: this.deps.codexBinPath,
      extraArgs,
      env: codexProcessEnv(this.deps.injectEnv, this.deps.extraEnv),
    });
    this.process = process;
    process.onExit((exit) => {
      if (this.process !== process) return;
      this.handleChildExit(exit);
    });
    await process.start();
    this.assertGeneration(generation);

    const clientFactory =
      this.deps.codexClientFactory ?? ((sock) => new CodexWsClient({ socketPath: sock }));
    const client = clientFactory(socketPath);
    this.client = client;
    client.onClose((reason) => {
      if (this.client !== client) return;
      this.handleClientClose(reason);
    });
    await client.ready();
    this.assertGeneration(generation);

    const approvalHandler = createFailFastApprovalHandler({
      onReject: async (req) => {
        this.log(
          'warn',
          `rejected Codex approval request '${req.method}'; approvals are unsupported in Dreamux-managed runtimes`,
        );
      },
    });
    this.client.setServerRequestHandler(approvalHandler);
    const initResponse = await performInitializeHandshake(this.client, {
      ...(this.deps.handshakeTimeoutMs !== undefined
        ? { timeoutMs: this.deps.handshakeTimeoutMs }
        : {}),
    });
    this.assertGeneration(generation);
    this.log(
      'info',
      `codex initialized: ${initResponse.userAgent} (home=${initResponse.codexHome}, ${initResponse.platformOs})`,
    );
    await this.applySkillExtraRoots();
    this.assertGeneration(generation);

    await this.resolveThread(generation, options);
    this.assertGeneration(generation);

    this.turnManager = new TurnManager({
      dispatcherId: this.dispatcherId,
      getThreadId: () => this.threadId,
      client: this.client,
      codec: this.deps.codec,
      log: this.log,
      activitySink: this.deps.activitySink,
      nativeTurnSink: this.deps.nativeTurnSink,
    });
  }

  private async applySkillExtraRoots(): Promise<void> {
    if (this.client === null) throw new Error('client not initialized');
    await applyCodexSkillExtraRoots({
      client: this.client,
      sources: this.deps.skillSources ?? [],
      log: this.log,
    });
  }

  /**
   * Establish the native thread for this generation.
   *
   * Recovery is continuous by contract: when a prior session exists, a failed
   * `thread/resume` rejects rather than silently becoming a fresh thread. Only
   * a mid-life restart — where start has already resolved and the caller can no
   * longer be told — may fall back to a fresh thread, and it must publish the
   * loss before publishing the replacement session.
   */
  private async resolveThread(
    generation: number,
    options: { allowFreshFallback: boolean },
  ): Promise<void> {
    if (this.client === null) throw new Error('client not initialized');
    this.threadResumed = false;
    const threadInstructions = this.threadInstructionParams();
    const existing = this.threadId ?? this.identity.sessionId;
    if (existing === null) {
      const params: ThreadStartParams = {
        ...threadInstructions,
      };
      const res = await this.client.request<ThreadStartResponse>(
        'thread/start',
        params,
      );
      this.assertGeneration(generation);
      const candidateThreadId = res.thread.id;
      await this.publish({
        kind: 'session',
        sessionId: candidateThreadId,
      });
      this.assertGeneration(generation);
      this.threadId = candidateThreadId;
      this.log('info', `started fresh thread ${this.threadId}`);
      return;
    }
    let resumed: ThreadResumeResponse;
    try {
      const params: ThreadResumeParams = {
        threadId: existing,
        ...threadInstructions,
      };
      resumed = await this.client.request<ThreadResumeResponse>(
        'thread/resume',
        params,
      );
    } catch (err) {
      this.assertGeneration(generation);
      const msg = err instanceof Error ? err.message : String(err);
      if (!options.allowFreshFallback) {
        throw new Error(
          `codex could not restore session ${existing}: ${msg}`,
          { cause: err },
        );
      }
      this.log(
        'warn',
        `thread/resume failed for ${existing}: ${msg}; starting fresh thread`,
      );
      const res = await this.client.request<ThreadStartResponse>(
        'thread/start',
        { ...threadInstructions },
      );
      this.assertGeneration(generation);
      const replacementThreadId = res.thread.id;
      await this.publish({
        kind: 'session_lost',
        reason: `thread/resume failed: ${msg}`,
      });
      await this.publish({
        kind: 'session',
        sessionId: replacementThreadId,
      });
      this.assertGeneration(generation);
      this.threadId = replacementThreadId;
      return;
    }
    this.assertGeneration(generation);
    const resumedThreadId = resumed.thread.id;
    await this.publish({
      kind: 'session',
      sessionId: resumedThreadId,
    });
    this.assertGeneration(generation);
    this.threadId = resumedThreadId;
    this.threadResumed = true;
    this.log('info', `resumed thread ${this.threadId}`);
  }

  private threadInstructionParams(): Pick<
    ThreadStartParams,
    'baseInstructions' | 'developerInstructions'
  > {
    const params: Pick<
      ThreadStartParams,
      'baseInstructions' | 'developerInstructions'
    > = {};
    if (this.deps.systemPromptReplace !== undefined) {
      params.baseInstructions = this.deps.systemPromptReplace;
      return params;
    }
    if (this.deps.systemPromptAppend !== undefined) {
      const rendered = renderCodexSystemPromptAppend(this.deps.systemPromptAppend);
      if (rendered !== '') params.developerInstructions = rendered;
    }
    return params;
  }

  async submit(input: AgentRuntimeSubmissionInput): Promise<RuntimeAdmission> {
    if (this.stopping || this.status === 'stopped') {
      return { status: 'stopped' };
    }
    const turnManager = this.turnManager;
    if (turnManager === null) {
      return { status: 'failed', error: new Error('turn manager not initialized') };
    }
    // The text is already the complete model-facing message: this runtime
    // renders no envelope and never branches on where the turn came from.
    return turnManager.submitInput(input);
  }

  stop(): Promise<void> {
    if (this.stopTask !== null) return this.stopTask;
    // A fenced runtime is already being torn down by the fence. Join that
    // teardown instead of publishing a terminal state through the sink that
    // just failed, and never report a stop the fence could not prove.
    if (this.fence.isFenced) return this.track(this.stopAfterFatalTeardown());
    if (this.status === 'stopped') return Promise.resolve();
    if (!this.stopping) {
      this.stopping = true;
      this.generation += 1;
    }
    this.clearRestartTimer();
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
   * failed retained the client, turn manager, and child process, so this
   * retries against that retained authority and rejects if the retry fails too.
   */
  private async stopAfterFatalTeardown(): Promise<void> {
    let fatal: unknown = null;
    try {
      await this.fence.terminated();
    } catch (error) {
      fatal = error;
    }
    if (fatal === null) {
      this.status = 'stopped';
      return;
    }
    this.log(
      'warn',
      'retrying codex runtime teardown after a fatal state write left it unproven',
      fatal,
    );
    await this.teardownCodexRuntime();
    this.status = 'stopped';
  }

  private async stopRuntime(): Promise<void> {
    this.setStatus('stopping');
    // Teardown must be initiated before any status/start/restart join. Closing
    // the client is what rejects stuck ready/RPC admissions; the generation
    // fence prevents pre-authority startup work from publishing later.
    const teardown = this.teardownCodexRuntime();
    void teardown.catch(() => undefined);
    // The terminal writes are awaited so stop cannot resolve before they land
    // — Core revokes this generation's lease right after stop settles — but
    // they do not decide whether stop converged. Only the native teardown does;
    // a failed write is already terminal through the fence.
    const stoppingState = Promise.resolve().then(() =>
      this.settleState({ kind: 'status', status: 'stopping' }));
    const [, teardownResult] = await Promise.allSettled([
      stoppingState,
      teardown,
    ]);
    throwSettledFailures(
      [teardownResult],
      'codex runtime stop did not converge',
    );
    await this.settleState({ kind: 'status', status: 'stopped' });
    this.setStatus('stopped');
  }

  private async cleanupOnFailure(): Promise<void> {
    this.clearRestartTimer();
    const wasStopping = this.stopping;
    this.stopping = true;
    try {
      await this.teardownCodexRuntime();
      this.stopping = wasStopping;
    } catch (error) {
      // Retain the stop fence together with the process authority. Only a
      // successful stop retry may permit any later lifecycle transition.
      this.stopping = true;
      throw error;
    }
  }

  private async teardownCodexRuntime(): Promise<void> {
    const turnManager = this.turnManager;
    const managerStop = turnManager?.stop() ?? Promise.resolve();
    void managerStop.catch(() => undefined);

    const client = this.client;
    let clientClose: Promise<void> = Promise.resolve();
    if (client !== null) {
      try {
        client.close();
      } catch (error) {
        clientClose = Promise.reject(error);
        void clientClose.catch(() => undefined);
      }
    }

    const process = this.process;
    const processReap = process?.reap() ?? Promise.resolve();
    void processReap.catch(() => undefined);
    const results = await Promise.allSettled([
      managerStop,
      clientClose,
      processReap,
    ]);
    if (results[0]?.status === 'fulfilled' && this.turnManager === turnManager) {
      this.turnManager = null;
    }
    if (results[1]?.status === 'fulfilled' && this.client === client) {
      this.client = null;
    }
    if (results[2]?.status === 'fulfilled' && this.process === process) {
      this.process = null;
    }
    throwSettledFailures(results, 'codex runtime teardown did not converge');
  }

  private handleChildExit(exit: CodexProcessExit): void {
    const details =
      exit.signal !== null ? `signal=${exit.signal}` : `code=${exit.code ?? 'null'}`;
    this.scheduleRestart(`codex app-server child exited (${details})`);
  }

  private handleClientClose(reason: Error): void {
    this.scheduleRestart(`codex app-server websocket closed: ${reason.message}`);
  }

  private scheduleRestart(reason: string): void {
    // A fenced runtime is terminal: `terminateForFence` sets the stop fence
    // synchronously, so this guard also stops the restart loop.
    if (this.stopping || this.restartTimer !== null || this.restarting) return;
    const attempt = this.restartAttempts + 1;
    this.restartAttempts = attempt;
    const delay = this.restartDelayMs(attempt);
    this.log('warn', `${reason}; restarting in ${delay}ms`);
    this.setStatus('degraded');
    this.fence.publishDetached(() => this.state.publish({
      kind: 'status',
      status: 'degraded',
      lastError: reason,
    }));
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      const task = this.restartCodexRuntime(reason, this.generation);
      this.restartTask = task;
      void task.finally(() => {
        if (this.restartTask === task) this.restartTask = null;
      }).catch(() => undefined);
    }, delay);
  }

  private async restartCodexRuntime(
    reason: string,
    generation: number,
  ): Promise<void> {
    if (this.stopping || generation !== this.generation) return;
    this.restarting = true;
    let retryReason: string | null = null;
    try {
      this.setStatus('starting');
      await this.publish({ kind: 'status', status: 'starting' });
      await this.teardownCodexRuntime();
      this.assertGeneration(generation);
      await this.startCodexRuntime(generation, { allowFreshFallback: true });
      this.assertGeneration(generation);
      this.restartAttempts = 0;
      await this.markReady(generation);
      this.log('info', `restarted codex app-server after: ${reason}`);
    } catch (err) {
      const failures: unknown[] = [err];
      try {
        await this.teardownCodexRuntime();
      } catch (cleanupError) {
        failures.push(cleanupError);
      }
      if (this.stopping || generation !== this.generation) return;
      const msg = failures.map((failure) =>
        failure instanceof Error ? failure.message : String(failure)
      ).join('; ');
      this.log('error', `restart failed: ${msg}`, err);
      this.setStatus('degraded');
      await this.settleState({
        kind: 'status',
        status: 'degraded',
        lastError: msg,
      });
      // A fenced runtime never reaches the retry: `scheduleRestart` refuses
      // once the fence set the stop flag.
      retryReason = `codex app-server restart failed: ${msg}`;
    } finally {
      this.restarting = false;
    }
    if (retryReason !== null) this.scheduleRestart(retryReason);
  }

  private restartDelayMs(attempt: number): number {
    const base = Math.max(
      0,
      this.deps.restartBackoffBaseMs ?? DEFAULT_RESTART_BACKOFF_BASE_MS,
    );
    const max = Math.max(
      base,
      this.deps.restartBackoffMaxMs ?? DEFAULT_RESTART_BACKOFF_MAX_MS,
    );
    return Math.min(max, base * 2 ** Math.max(0, attempt - 1));
  }

  private clearRestartTimer(): void {
    if (this.restartTimer === null) return;
    clearTimeout(this.restartTimer);
    this.restartTimer = null;
  }

  private async markReady(generation: number): Promise<void> {
    this.assertGeneration(generation);
    this.setStatus('ready');
    await this.publish({ kind: 'status', status: 'ready' });
    this.assertGeneration(generation);
  }

  /**
   * Push one authoritative fact into the leased sink. Core resolves `publish`
   * only after the durable write, so awaiting it is what makes the session and
   * ready state durable before `start` resolves. Every failure is terminal and
   * runs through the fence — a revoked lease means a newer generation already
   * owns the entity, and any other failure means Core's record of this runtime
   * can no longer be repaired from here.
   */
  private publish(
    update: AgentRuntimeStateUpdate,
  ): Promise<void> {
    return this.fence.publish(() => this.state.publish(update));
  }

  /**
   * Persist a fact the caller's own outcome does not depend on, but whose
   * ordering does: `stop` must not resolve before its terminal write lands,
   * because Core keeps this generation's lease valid exactly until stop settles
   * and a detached write would race the revocation that follows.
   *
   * The error is not rethrown. The fence has already made it terminal, and
   * these callers report something else — whether the app-server child
   * terminated, or the original start/restart failure — which a state-write
   * failure does not change.
   */
  private async settleState(
    update: AgentRuntimeStateUpdate,
  ): Promise<void> {
    try {
      await this.publish(update);
    } catch {
      // Already logged and acted on by the fence.
    }
  }

  /**
   * The fence's native teardown. Deliberately not `stop()`: `stop()` publishes
   * `stopping`/`stopped` through the very sink that just proved unusable and
   * would only produce a second failure. This closes the client, turn manager,
   * and child process, and nothing else.
   *
   * It runs synchronously up to its first await, so the stop fence and bumped
   * generation refuse new input and cancel any pending restart immediately.
   */
  private async terminateForFence(): Promise<void> {
    this.stopping = true;
    this.generation += 1;
    this.clearRestartTimer();
    await this.teardownCodexRuntime();
    // Reached only when teardown converged. A failed teardown propagates to
    // `RuntimeStateFence.terminated()` and leaves the status alone, so a later
    // `stop()` cannot read 'stopped' off a child that was never proved dead.
    // Assigned directly because `setStatus` refuses once the fence is closed.
    this.status = 'stopped';
  }

  private setStatus(s: AgentRuntimeStatus): void {
    // A fenced runtime is terminal: its status is owned by the teardown, and a
    // late background transition must not reopen it.
    if (this.fence.isFenced) return;
    this.status = s;
  }

  private assertGeneration(generation: number): void {
    if (this.stopping || this.fence.isFenced || generation !== this.generation) {
      throw new Error('codex runtime is stopping');
    }
  }
}

function throwSettledFailures(
  results: readonly PromiseSettledResult<unknown>[],
  message: string,
): void {
  const failures = results
    .filter((result): result is PromiseRejectedResult =>
      result.status === 'rejected')
    .map((result) => result.reason);
  if (failures.length === 0) return;
  if (failures.length === 1) throw failures[0];
  throw new AggregateError(failures, message);
}
