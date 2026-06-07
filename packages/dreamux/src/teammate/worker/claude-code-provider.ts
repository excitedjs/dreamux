/**
 * Real Claude Code TeamMate worker provider (issue #126 PR4).
 *
 * This is the second worker behind the PR2 seam (after PR3's Codex worker): it
 * runs an *actual* Claude Code turn for a TeamMate task, with no hidden `tm` CLI
 * shell-out. It reuses the exact runtime primitive the dispatcher's
 * `builtin:claude-code` runtime is built on — the resident stream-json session
 * (`claude --print --input-format stream-json`, see
 * `agent-runtime/claude-code-session.ts`) — through the same injectable
 * `ClaudeCodeSessionFactory` seam, so a worker is unit-testable with a fake
 * session and never runs with weaker permission/sandbox semantics than the
 * dispatcher.
 *
 * Model — one task = one turn:
 *   - The task prompt is submitted as a single stream-json `user` turn;
 *     `submitTurn` resolves only when the terminal `result` lands (a Claude Code
 *     turn is itself a full agentic loop), so one turn is the natural unit of a
 *     TeamMate task.
 *   - A successful `result` → `onCompleted(finalText)`; an error `result`, a
 *     mid-turn child exit, or the per-turn deadline → `onFailed`. The resident
 *     child is then reaped and the session ends. Multi-turn persistent sessions,
 *     resume/recovery, and a true `interrupt` primitive are deferred (issue #126).
 *
 * Steering — unlike the Codex worker (which folds a follow-up `turn/start` onto
 * the active turn), the Claude Code resident session is strictly serial and has
 * no mid-turn fold primitive: the dispatcher's own claude-code runtime queues a
 * follow-up as a *subsequent* turn rather than folding it. The single-turn worker
 * therefore advertises `modes.steer: false` and rejects `send_input` while live,
 * which keeps the input `queued` in the ledger (PR1 behaviour). Honest live
 * steer/queue/interrupt for Claude Code are deferred (issue #126).
 *
 * The provider never writes the ledger; it only drives the {@link
 * TeamMateWorkerCallbacks}. The execution service performs every ledger
 * transition, keeping the server-owned ledger the single source of truth.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import {
  createDefaultClaudeCodeSession,
  type ClaudeCodeSession,
  type ClaudeCodeSessionFactory,
} from '../../agent-runtime/claude-code-session.js';
import {
  claudeCodeResidentArgs,
  stringifyClaudeCodeMcpConfig,
} from '../../runtime/claude-code-args.js';
import {
  BUILTIN_CLAUDE_CODE_PROVIDER_REF,
  type DispatcherClaudeCodeConfig,
} from '../../runtime/config.js';
import { dispatcherProcessEnv } from '../../runtime/package-bin.js';
import {
  dispatcherTeamMateWorkerClaudeMcpConfigPath,
  dispatcherTeamMateWorkerClaudeStreamLogPath,
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

export type ClaudeCodeWorkerLogger = (
  level: 'info' | 'warn' | 'error',
  message: string,
  fields?: Record<string, unknown>,
) => void;

export interface ClaudeCodeTeamMateWorkerProviderOptions {
  /** Resolve the effective claude binary path (mirrors the agent-runtime seam). */
  resolveBinPath: (bin: string) => string;
  /** Per-dispatcher Claude Code launch config (bin, model, permission, env, timeout). */
  resolveClaudeCodeConfig: (dispatcherId: string) => DispatcherClaudeCodeConfig;
  /** Fallback cwd when a task carries no resolved target (e.g. a scheduled task). */
  resolveDispatcherCwd: (dispatcherId: string) => string;
  /** Test seam: build the resident session (defaults to a real `claude` child). */
  sessionFactory?: ClaudeCodeSessionFactory;
  log?: ClaudeCodeWorkerLogger;
}

/**
 * Build the real `builtin:claude-code` TeamMate worker provider. Wired into the
 * server's default worker catalog alongside the Codex worker so
 * `get_capabilities` reports the runtime as worker-available; tests still
 * override the whole catalog via `ServerOptions.teamMateWorkerProviders`.
 */
export function createClaudeCodeTeamMateWorkerProvider(
  options: ClaudeCodeTeamMateWorkerProviderOptions,
): TeamMateWorkerProvider {
  return new ClaudeCodeTeamMateWorkerProvider(options);
}

const CLAUDE_CODE_WORKER_CAPABILITIES: TeamMateWorkerCapabilities = {
  worker_available: true,
  unsupported_reason: '',
  // The resident session is strictly serial with no mid-turn fold primitive
  // (unlike Codex turn folding), so steer is not honoured live; queue/interrupt
  // are not distinct capabilities yet (issue #126 deferral).
  modes: { steer: false, queue: false, interrupt: false },
  // resume of a live/retained worker session is deferred to a later slice.
  resume: false,
  // a per-task resident-child stderr log IS written, but there is no get_logs
  // MCP tool to retrieve it yet (issue #126 deferral) — this advertises
  // existence, not retrieval.
  logs: true,
};

class ClaudeCodeTeamMateWorkerProvider implements TeamMateWorkerProvider {
  readonly ref = BUILTIN_CLAUDE_CODE_PROVIDER_REF;

  constructor(
    private readonly options: ClaudeCodeTeamMateWorkerProviderOptions,
  ) {}

  capabilities(): TeamMateWorkerCapabilities {
    return {
      ...CLAUDE_CODE_WORKER_CAPABILITIES,
      modes: { ...CLAUDE_CODE_WORKER_CAPABILITIES.modes },
    };
  }

  async startSession(
    context: TeamMateWorkerStartContext,
    callbacks: TeamMateWorkerCallbacks,
  ): Promise<TeamMateWorkerStartOutcome> {
    const { dispatcherId, taskId } = context;
    const dispatcherDir = this.options.resolveDispatcherCwd(dispatcherId);
    // Realpath-confine the target before spawning anything (issue #126): a
    // symlinked target must not launch a worker rooted outside the dispatcher
    // tree. A violation throws loudly (no process created); it is not a
    // retryable `unavailable`.
    const cwd = await resolveConfinedWorkerCwd(
      context.target?.path ?? null,
      dispatcherDir,
    );
    const config = this.options.resolveClaudeCodeConfig(dispatcherId);

    let session: ClaudeCodeSession | null = null;
    try {
      // Write an EMPTY MCP config before spawn: a worker wires NO MCP servers, so
      // a TeamMate cannot nested-dispatch other TeamMates (issue #126). The child
      // reads `--mcp-config` at startup, so the doc must exist first.
      const mcpConfigPath = dispatcherTeamMateWorkerClaudeMcpConfigPath(
        dispatcherId,
        taskId,
      );
      await mkdir(dirname(mcpConfigPath), { recursive: true });
      await writeFile(mcpConfigPath, stringifyClaudeCodeMcpConfig([]), {
        mode: 0o600,
      });

      const sessionFactory =
        this.options.sessionFactory ?? createDefaultClaudeCodeSession;
      session = sessionFactory({
        bin: this.options.resolveBinPath(config.bin),
        // A worker is single-turn and per-task: never resume a prior session.
        args: claudeCodeResidentArgs({
          config,
          mcpConfigPath,
          resumeSessionId: null,
        }),
        cwd,
        env: dispatcherProcessEnv(globalThis.process.env, config.extra_env),
        stderrLogPath: dispatcherTeamMateWorkerClaudeStreamLogPath(
          dispatcherId,
          taskId,
        ),
        turnTimeoutMs: config.turn_timeout_ms,
        log: (level, message, err) =>
          this.options.log?.(level, message, {
            dispatcher_id: dispatcherId,
            task_id: taskId,
            ...(err !== undefined
              ? { detail: err instanceof Error ? err.message : String(err) }
              : {}),
          }),
      });
      await session.start();

      const handle: TeamMateWorkerHandle = {
        providerRef: this.ref,
        // The resident child emits its session id lazily with the first turn's
        // `init`/`result`, so it is not known yet at start time.
        sessionId: null,
        threadId: null,
      };
      const workerSession = new ClaudeCodeWorkerSession({
        dispatcherId,
        taskId,
        session,
        handle,
        callbacks,
        log: this.options.log,
      });
      // Hand ownership of the resident child to the session; the catch below
      // must not reap it now that the session will.
      session = null;

      await workerSession.begin(context.prompt);
      return { status: 'started', session: workerSession };
    } catch (err) {
      // Pre-`onRunning` failure: tear down and report the task as still
      // executable (retryable). The ledger stays accepted/queued.
      const reason = err instanceof Error ? err.message : String(err);
      this.options.log?.('warn', 'teammate claude-code worker failed to start', {
        dispatcher_id: dispatcherId,
        task_id: taskId,
        reason,
      });
      if (session !== null) await session.stop();
      return {
        status: 'unavailable',
        reason: `claude-code worker failed to start: ${reason}`,
        code: 'TEAMMATE_CLAUDE_CODE_WORKER_START_FAILED',
        retryable: true,
      };
    }
  }
}

interface ClaudeCodeWorkerSessionDeps {
  dispatcherId: string;
  taskId: string;
  session: ClaudeCodeSession;
  handle: TeamMateWorkerHandle;
  callbacks: TeamMateWorkerCallbacks;
  log?: ClaudeCodeWorkerLogger;
}

/**
 * One live Claude Code worker session. Owns the resident stream-json child for a
 * single task and guarantees exactly one terminal callback
 * (`onCompleted`/`onFailed`/`onCancelled`) fires, even under interleaved
 * completion / child-exit / cancel races.
 */
class ClaudeCodeWorkerSession implements TeamMateWorkerSession {
  readonly handle: TeamMateWorkerHandle;
  private settled = false;

  constructor(private readonly deps: ClaudeCodeWorkerSessionDeps) {
    this.handle = deps.handle;
  }

  /**
   * Commit `running`, then submit the task prompt as the one turn and arm its
   * terminal handler. Returns once the turn is submitted — completion arrives
   * asynchronously when `submitTurn` resolves (it resolves only at the terminal
   * `result`), so the caller's `startSession` does not block for the whole task.
   */
  async begin(prompt: string): Promise<void> {
    // Mark running BEFORE submitting the turn so `onCompleted` can never land
    // before `onRunning`.
    await this.deps.callbacks.onRunning(this.handle);

    // `submitTurn` resolves at the terminal `result` and rejects on a mid-turn
    // child exit / per-turn timeout / stdin write failure — so its promise is
    // the single terminal signal; no separate `setOnExit` wiring is needed in
    // the one-turn model. Fire-and-forget: do not await the whole task here.
    void this.deps.session
      .submitTurn(prompt)
      .then((outcome) => {
        if (outcome.isError) {
          const detail =
            outcome.errors.length > 0
              ? outcome.errors.join('; ')
              : (outcome.subtype ?? 'unknown error');
          return this.fail(`claude turn returned an error result: ${detail}`);
        }
        return this.complete(outcome.text);
      })
      .catch((err) => {
        void this.fail(err instanceof Error ? err.message : String(err));
      });
  }

  async sendInput(input: {
    inputId: string;
    text: string;
    mode: TeamMateInputMode;
  }): Promise<TeamMateWorkerInputDisposition> {
    if (this.settled) {
      return { status: 'rejected', reason: 'worker session already finished' };
    }
    // The resident session is strictly serial with no mid-turn fold primitive,
    // so no input mode can be honoured live in the single-turn model. Reject so
    // the input stays `queued` in the ledger (PR1 behaviour) rather than
    // pretending it was delivered.
    return {
      status: 'rejected',
      reason: `claude-code worker is single-turn; '${input.mode}' delivery to a live turn is deferred (issue #126)`,
    };
  }

  async cancel(reason: string | null): Promise<void> {
    if (this.settled) return;
    this.settled = true;
    await this.reap();
    await this.deps.callbacks.onCancelled(reason);
  }

  /**
   * Reap the resident child WITHOUT a ledger transition. Used by the execution
   * service on server shutdown to prevent child leaks; the task stays `running`
   * in the ledger for the (deferred) orphan-reconciliation path.
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

  /** Reap the resident child. Idempotent (`session.stop()` is). */
  private async reap(): Promise<void> {
    try {
      await this.deps.session.stop();
    } catch (err) {
      this.deps.log?.('warn', 'teammate claude-code worker reap failed', {
        dispatcher_id: this.deps.dispatcherId,
        task_id: this.deps.taskId,
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
