/**
 * Real Codex TeamMate worker provider (issue #126 PR3).
 *
 * This is the first worker that performs *actual* execution behind the PR2
 * seam: it launches a per-task Codex app-server, drives one thread + turn
 * against the task's local target, and reports the real assistant result —
 * with no hidden `tm` CLI shell-out. It reuses the same Codex primitives the
 * dispatcher runtime is built on (`CodexProcess`, `CodexWsClient`,
 * `performInitializeHandshake`, the turn collector, the fail-fast approval
 * handler) so a worker never runs with weaker sandbox/approval semantics than
 * the dispatcher.
 *
 * Model — one task = one Codex turn:
 *   - The task prompt drives a single `turn/start`; a Codex turn is itself a
 *     full agentic loop (many tool calls), so one turn is the natural unit of a
 *     TeamMate task.
 *   - `turn/completed` → `onCompleted(lastAssistantText)`. The process is reaped
 *     and the session ends. Multi-turn persistent sessions, resume/recovery and
 *     a true `interrupt` primitive are deliberately deferred (issue #126).
 *
 * Steering — `send_input` while the turn is in flight folds an additional
 * `turn/start` onto the active turn. This is the exact mechanism the dispatcher
 * runtime already relies on in production (`dispatcher/turn-manager.ts`:
 * "inbound submission folds onto Codex's active turn"), validated end-to-end
 * against real Codex — so the worker advertises `modes.steer: true`. `queue`
 * and `interrupt` are not distinct capabilities yet and their dispositions are
 * rejected (the input then stays `queued` in the ledger, PR1 behaviour).
 *
 * The provider never writes the ledger; it only drives the {@link
 * TeamMateWorkerCallbacks}. The execution service performs every ledger
 * transition, keeping the server-owned ledger the single source of truth.
 */

import { performInitializeHandshake } from '../../codex/handshake.js';
import {
  extractAssistantText,
  subscribeTurnCollection,
  submitTurnStart,
} from '../../codex/events.js';
import { CodexWsClient } from '../../codex/rpc.js';
import {
  CodexProcess,
  type CodexProcessOptions,
} from '../../codex/supervisor.js';
import type {
  ThreadStartParams,
  ThreadStartResponse,
} from '../../codex/types.js';
import { createFailFastApprovalHandler } from '../../dispatcher/approval.js';
import {
  BUILTIN_CODEX_PROVIDER_REF,
  type DispatcherCodexConfig,
} from '../../runtime/config.js';
import { codexArgsToCli } from '../../runtime/codex-args.js';
import { dispatcherProcessEnv } from '../../runtime/package-bin.js';
import {
  dispatcherTeamMateWorkerErrorLogPath,
  dispatcherTeamMateWorkerLogPath,
  dispatcherTeamMateWorkerSocketPath,
} from '../../runtime/paths.js';
import type { TeamMateInputMode } from '../ledger.js';
import { resolveConfinedWorkerCwd } from './confine.js';
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

export type CodexWorkerLogger = (
  level: 'info' | 'warn' | 'error',
  message: string,
  fields?: Record<string, unknown>,
) => void;

export interface CodexTeamMateWorkerProviderOptions {
  /** Resolve the effective codex binary path (mirrors the agent-runtime seam). */
  resolveBinPath: (bin: string) => string;
  /** Per-dispatcher Codex launch config (bin, approval, sandbox, env, timeout). */
  resolveCodexConfig: (dispatcherId: string) => DispatcherCodexConfig;
  /** Fallback cwd when a task carries no resolved target (e.g. a scheduled task). */
  resolveDispatcherCwd: (dispatcherId: string) => string;
  /** Test seam: build the app-server child process (defaults to a real one). */
  codexProcessFactory?: (opts: CodexProcessOptions) => CodexProcess;
  /** Test seam: build the WS client (defaults to a real socket client). */
  codexClientFactory?: (socketPath: string) => CodexWsClient;
  log?: CodexWorkerLogger;
}

/**
 * Build the real `builtin:codex` TeamMate worker provider. Wired into the
 * server's default worker catalog so `get_capabilities` reports the runtime as
 * worker-available; tests still override the whole catalog via
 * `ServerOptions.teamMateWorkerProviders`.
 */
export function createCodexTeamMateWorkerProvider(
  options: CodexTeamMateWorkerProviderOptions,
): TeamMateWorkerProvider {
  return new CodexTeamMateWorkerProvider(options);
}

const CODEX_WORKER_CAPABILITIES: TeamMateWorkerCapabilities = {
  worker_available: true,
  unsupported_reason: '',
  // steer: folded turn/start onto the active turn (production-validated path).
  // queue/interrupt are not distinct capabilities yet (issue #126 deferral).
  modes: { steer: true, queue: false, interrupt: false },
  // resume of a live/retained worker session is deferred to a later slice.
  resume: false,
  // a per-task app-server log file IS written, but there is no get_logs MCP
  // tool to retrieve it yet (issue #126 deferral) — this advertises existence,
  // not retrieval.
  logs: true,
};

class CodexTeamMateWorkerProvider implements TeamMateWorkerProvider {
  readonly ref = BUILTIN_CODEX_PROVIDER_REF;

  constructor(private readonly options: CodexTeamMateWorkerProviderOptions) {}

  capabilities(): TeamMateWorkerCapabilities {
    return { ...CODEX_WORKER_CAPABILITIES, modes: { ...CODEX_WORKER_CAPABILITIES.modes } };
  }

  async startSession(
    context: TeamMateWorkerStartContext,
    callbacks: TeamMateWorkerCallbacks,
  ): Promise<TeamMateWorkerStartOutcome> {
    const { dispatcherId, taskId } = context;
    const dispatcherDir = this.options.resolveDispatcherCwd(dispatcherId);
    // PR1 confined the target lexically and deferred symlink/realpath
    // confinement to this worker slice (issue #126), "to be done when the path
    // actually exists." Do it now, before spawning anything: realpath-resolve
    // the target and re-assert it is inside the dispatcher dir, so a symlinked
    // target cannot launch a sandbox=workspace-write codex rooted outside the
    // dispatcher tree. A violation throws loudly (no process is created); it is
    // not a retryable `unavailable`.
    const cwd = await resolveConfinedWorkerCwd(
      context.target?.path ?? null,
      dispatcherDir,
    );
    const codexConfig = this.options.resolveCodexConfig(dispatcherId);

    let process: CodexProcess | null = null;
    let client: CodexWsClient | null = null;
    try {
      const socketPath = dispatcherTeamMateWorkerSocketPath(dispatcherId, taskId);
      const processFactory =
        this.options.codexProcessFactory ?? ((o) => new CodexProcess(o));
      process = processFactory({
        socketPath,
        cwd,
        stdoutLogPath: dispatcherTeamMateWorkerLogPath(dispatcherId, taskId),
        stderrLogPath: dispatcherTeamMateWorkerErrorLogPath(dispatcherId, taskId),
        binPath: this.options.resolveBinPath(codexConfig.bin),
        // No MCP servers are wired into a worker: a TeamMate must not be able to
        // nested-dispatch other TeamMates (issue #126). It still inherits the
        // dispatcher's approval/sandbox config so it is not more permissive.
        extraArgs: codexArgsToCli({
          approvalPolicy: codexConfig.approval_policy,
          sandboxMode: codexConfig.sandbox_mode,
          extraArgs: codexConfig.extra_args,
        }),
        env: dispatcherProcessEnv(globalThis.process.env, codexConfig.extra_env),
      });
      await process.start();

      const clientFactory =
        this.options.codexClientFactory ??
        ((sock) => new CodexWsClient({ socketPath: sock }));
      client = clientFactory(socketPath);
      await client.ready();

      client.setServerRequestHandler(
        createFailFastApprovalHandler({
          onReject: () => {
            this.options.log?.(
              'warn',
              'teammate codex worker rejected an approval request (MCP reply-only)',
              { dispatcher_id: dispatcherId, task_id: taskId },
            );
          },
        }),
      );

      await performInitializeHandshake(client, {
        timeoutMs: codexConfig.initialize_timeout_ms,
      });

      const threadParams: ThreadStartParams = { cwd };
      const threadStart = await client.request<ThreadStartResponse>(
        'thread/start',
        threadParams,
      );
      const threadId = threadStart.thread.id;

      const handle: TeamMateWorkerHandle = {
        providerRef: this.ref,
        sessionId: threadId,
        threadId,
      };
      const session = new CodexWorkerSession({
        dispatcherId,
        taskId,
        cwd,
        process,
        client,
        threadId,
        handle,
        callbacks,
        turnTimeoutMs: codexConfig.turn_timeout_ms,
        log: this.options.log,
      });
      // Hand ownership of the process/client to the session; the catch below
      // must not reap them now that the session will.
      process = null;
      client = null;

      await session.begin(context.prompt);
      return { status: 'started', session };
    } catch (err) {
      // Pre-`onRunning` failure: tear down and report the task as still
      // executable (retryable). The ledger stays accepted/queued.
      const reason = err instanceof Error ? err.message : String(err);
      this.options.log?.('warn', 'teammate codex worker failed to start', {
        dispatcher_id: dispatcherId,
        task_id: taskId,
        reason,
      });
      if (client !== null) client.close();
      if (process !== null) await process.reap();
      return {
        status: 'unavailable',
        reason: `codex worker failed to start: ${reason}`,
        code: 'TEAMMATE_CODEX_WORKER_START_FAILED',
        retryable: true,
      };
    }
  }
}

interface CodexWorkerSessionDeps {
  dispatcherId: string;
  taskId: string;
  cwd: string;
  process: CodexProcess;
  client: CodexWsClient;
  threadId: string;
  handle: TeamMateWorkerHandle;
  callbacks: TeamMateWorkerCallbacks;
  /** Per-turn deadline (ms): a turn that never completes fails the task. */
  turnTimeoutMs: number;
  log?: CodexWorkerLogger;
}

/**
 * Self-contained failure message for a stalled worker turn (issue #126 PR7).
 * The task is already `running`, so initialize + thread start + turn submission
 * succeeded; the stall is in turn *execution*. Codex frames flow over the WS
 * socket, not the stdout log, so an empty diagnostic log here is expected — the
 * message itself, readable via get_task, is the diagnostic.
 */
function codexTurnTimeoutMessage(turnTimeoutMs: number): string {
  return (
    `codex worker turn did not complete within ${turnTimeoutMs}ms. The worker ` +
    'reached running (initialize, thread start, and turn submission all ' +
    'succeeded), so the stall is in turn execution — commonly Codex auth, ' +
    'network, or model quota. Re-run after verifying the worker environment.'
  );
}

/**
 * One live Codex worker session. Owns the app-server child + WS client for a
 * single task and guarantees exactly one terminal callback
 * (`onCompleted`/`onFailed`/`onCancelled`) fires, even under interleaved
 * completion / connection-close / cancel races.
 */
class CodexWorkerSession implements TeamMateWorkerSession {
  readonly handle: TeamMateWorkerHandle;
  private settled = false;

  constructor(private readonly deps: CodexWorkerSessionDeps) {
    this.handle = deps.handle;
  }

  /**
   * Commit `running`, then submit the task prompt as the first turn and arm the
   * completion + connection-close listeners. Returns once the turn is submitted
   * — completion arrives asynchronously via the notification stream, so the
   * caller's `startSession` does not block for the whole task.
   */
  async begin(prompt: string): Promise<void> {
    // Mark running BEFORE submitting the turn so `onCompleted` can never land
    // before `onRunning` (no turn/completed can precede turn/start).
    await this.deps.callbacks.onRunning(this.handle);

    const collector = subscribeTurnCollection(this.deps.client, this.deps.threadId);
    // Bound the turn: a worker that reaches running but whose turn never emits
    // turn/completed (a post-start stall — auth/network/quota) must fail the
    // task with a visible reason, not sit `running` forever (issue #126 PR7).
    let deadline: ReturnType<typeof setTimeout> | null = null;
    const timeout = new Promise<never>((_resolve, reject) => {
      deadline = setTimeout(() => {
        reject(new Error(codexTurnTimeoutMessage(this.deps.turnTimeoutMs)));
      }, this.deps.turnTimeoutMs);
      // Do not keep the event loop alive solely for this timer.
      deadline.unref();
    });
    void Promise.race([collector.awaitTurn(), timeout])
      .then((turn) => this.complete(extractAssistantText(turn) ?? ''))
      .catch((err) => {
        void this.fail(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (deadline !== null) clearTimeout(deadline);
      });
    // A connection that drops before turn/completed is a real failure of a
    // now-running task (not a retryable start failure).
    this.deps.client.onClose((reason) => {
      void this.fail(`codex worker connection closed: ${reason.message}`);
    });

    try {
      await submitTurnStart(
        this.deps.client,
        this.deps.threadId,
        prompt,
        this.deps.cwd,
      );
    } catch (err) {
      await this.fail(
        `turn/start failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  async sendInput(input: {
    inputId: string;
    text: string;
    mode: TeamMateInputMode;
  }): Promise<TeamMateWorkerInputDisposition> {
    if (this.settled) {
      return { status: 'rejected', reason: 'worker session already finished' };
    }
    if (input.mode !== 'steer') {
      return {
        status: 'rejected',
        reason: `codex worker delivers steer only; '${input.mode}' is deferred (issue #126)`,
      };
    }
    try {
      // Fold the follow-up input onto the active turn (production-validated).
      await submitTurnStart(
        this.deps.client,
        this.deps.threadId,
        input.text,
        this.deps.cwd,
      );
      return { status: 'accepted' };
    } catch (err) {
      return {
        status: 'rejected',
        reason: `steer delivery failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  async cancel(reason: string | null): Promise<void> {
    if (this.settled) return;
    this.settled = true;
    await this.reap();
    await this.deps.callbacks.onCancelled(reason);
  }

  /**
   * Reap the process + close the client WITHOUT a ledger transition. Used by the
   * execution service on server shutdown to prevent app-server leaks; the task
   * stays `running` in the ledger for the (deferred) orphan-reconciliation path.
   */
  async dispose(): Promise<void> {
    if (this.settled) return;
    this.settled = true;
    await this.reap();
  }

  private async complete(finalText: string): Promise<void> {
    if (this.settled) return;
    this.settled = true;
    await this.reap();
    await this.deps.callbacks.onCompleted(finalText);
  }

  private async fail(errorText: string): Promise<void> {
    if (this.settled) return;
    this.settled = true;
    await this.reap();
    await this.deps.callbacks.onFailed(errorText);
  }

  /** Close the WS client and reap the app-server child. Idempotent. */
  private async reap(): Promise<void> {
    try {
      this.deps.client.close();
    } catch {
      /* best effort — the session is terminating regardless */
    }
    try {
      await this.deps.process.reap();
    } catch (err) {
      this.deps.log?.('warn', 'teammate codex worker reap failed', {
        dispatcher_id: this.deps.dispatcherId,
        task_id: this.deps.taskId,
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
