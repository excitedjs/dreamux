/**
 * `builtin:claude-code` AgentRuntimeProvider (issue #110 PR6).
 *
 * A real second agent runtime that proves the AgentRuntimeProvider abstraction
 * is not "Codex renamed". It differs from `builtin:codex` in every
 * runtime-specific dimension:
 *
 * - **No persistent app-server / handshake / WebSocket.** Claude Code runs a
 *   turn per headless `claude --print` invocation, so there is no long-lived
 *   child to supervise, no restart/backoff loop, and no initialize timeout.
 * - **MCP injection is a JSON config document** (`--mcp-config <file>`), not
 *   Codex's `-c mcp_servers.*` TOML CLI flags. See `runtime/claude-code-args.ts`.
 * - **Runtime-owned config** is `DispatcherClaudeCodeConfig` (bin / model /
 *   permission_mode / extra_args / extra_env), distinct from the Codex config.
 * - **Completion delivery** is the Claude Code task-notification path, not the
 *   Codex inbox-then-trigger path.
 *
 * Process spawning goes through an injectable {@link ClaudeCodeTurnRunner} seam
 * (mirroring Codex's process-factory seam), so the lifecycle contract is fully
 * unit-testable with a fake runner. A live `claude` binary is exercised only by
 * the opt-in live test.
 *
 * Failure contract: a turn failure (missing binary, spawn error, non-zero exit)
 * is never swallowed. For inbound/restart turns it drives the runtime to
 * `degraded` with a persisted `last_error` (observable via status/doctor). For
 * `deliverTeamMateCompletion` it surfaces as a `failed` result the caller can
 * act on (PR8 delivery retry). `enqueueInbound` still returns after accept
 * (submit != completion) so the channel can ack promptly.
 *
 * Scope note: this PR declares the task-notification delivery capability and
 * provides the runtime's delivery entry point. The executable TeamMate delivery
 * loop (ledger, retry, pull fallback) belongs to the server-hosted TeamMate PRs
 * (#110 PR7/PR8), per `.agents/decisions/agent-runtime-provider.md`.
 */

import { execFile } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { promisify } from 'node:util';

import { createBuiltinRegistry } from '../registry/index.js';
import {
  BUILTIN_CLAUDE_CODE_PROVIDER_REF,
  defaultDispatcherClaudeCodeConfig,
  dispatcherClaudeCodeConfig,
  type DispatcherClaudeCodeConfig,
} from '../runtime/config.js';
import {
  dispatcherClaudeCodeMcpConfigPath,
  dispatcherCodexCwd,
} from '../runtime/paths.js';
import { dispatcherProcessEnv } from '../runtime/package-bin.js';
import {
  claudeCodeTurnArgs,
  stringifyClaudeCodeMcpConfig,
} from '../runtime/claude-code-args.js';
import type {
  InboundDeliveryHooks,
  InboundDeliveryResult,
  InboundTurnInput,
} from '../dispatcher/turn-manager.js';
import type { DispatcherStatus } from '../runtime/dispatcher-store.js';
import type {
  AgentRuntime,
  AgentRuntimeCreateContext,
  AgentRuntimeProvider,
  TeamMateCompletionDeliveryResult,
  TeamMateCompletionEnvelope,
} from './types.js';

const execFileAsync = promisify(execFile);

/** One headless Claude Code turn invocation. */
export interface ClaudeCodeTurnRequest {
  bin: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
}

/** The result of one turn: the (possibly new) session id and the final text. */
export interface ClaudeCodeTurnResult {
  sessionId: string | null;
  result: string;
}

/** Injectable seam for running a Claude Code turn (tests inject a fake). */
export interface ClaudeCodeTurnRunner {
  runTurn(request: ClaudeCodeTurnRequest): Promise<ClaudeCodeTurnResult>;
}

/** Parse the `claude --output-format json` result envelope, defensively. */
export function parseClaudeCodeJsonResult(stdout: string): ClaudeCodeTurnResult {
  const trimmed = stdout.trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return { sessionId: null, result: trimmed };
  }
  if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
    const obj = parsed as Record<string, unknown>;
    const sessionId =
      typeof obj['session_id'] === 'string' ? obj['session_id'] : null;
    const result = typeof obj['result'] === 'string' ? obj['result'] : trimmed;
    return { sessionId, result };
  }
  return { sessionId: null, result: trimmed };
}

/** The live turn runner: spawns the real `claude` binary. */
export function createDefaultClaudeCodeTurnRunner(): ClaudeCodeTurnRunner {
  return {
    async runTurn(request: ClaudeCodeTurnRequest): Promise<ClaudeCodeTurnResult> {
      const { stdout } = await execFileAsync(request.bin, request.args, {
        cwd: request.cwd,
        env: request.env,
        maxBuffer: 64 * 1024 * 1024,
      });
      return parseClaudeCodeJsonResult(stdout);
    },
  };
}

export interface ClaudeCodeAgentRuntimeProviderOptions {
  /** Optional host-level bin resolver (default: identity on the config bin). */
  resolveBinPath?: (bin: string) => string;
  /** Override the turn runner (tests inject a fake). */
  turnRunner?: ClaudeCodeTurnRunner;
}

interface ClaudeCodeRuntimeDeps {
  turnRunner: ClaudeCodeTurnRunner;
  resolveBinPath: (bin: string) => string;
}

/** Format a TeamMate completion as a Claude Code task-notification turn. */
function formatTaskNotification(completion: TeamMateCompletionEnvelope): string {
  return [
    `<teammate_task_completion task_id="${completion.taskId}" ` +
      `teammate_id="${completion.teammateId}" status="${completion.status}">`,
    completion.finalText,
    '</teammate_task_completion>',
  ].join('\n');
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * The Claude Code agent runtime for one dispatcher. Turns run serially (one at a
 * time) and `enqueueInbound` returns after the message is accepted — not after
 * the turn completes — matching the Codex runtime's submit-then-serialize
 * contract.
 */
export class ClaudeCodeRuntime implements AgentRuntime {
  readonly providerRef = BUILTIN_CLAUDE_CODE_PROVIDER_REF;

  private readonly dispatcherId: string;
  private readonly config: DispatcherClaudeCodeConfig;
  private readonly bin: string;
  private readonly cwd: string;
  private readonly mcpConfigPath: string;
  private readonly mcpConfigDoc: string;
  private status: DispatcherStatus = 'declared';
  private threadId: string | null;
  private readonly resumed: boolean;
  private stopped = false;
  private readonly seen = new Set<string>();
  private queue: Promise<void> = Promise.resolve();
  private turnCounter = 0;

  constructor(
    private readonly context: AgentRuntimeCreateContext,
    private readonly deps: ClaudeCodeRuntimeDeps,
  ) {
    this.dispatcherId = context.row.dispatcher_id;
    this.config =
      context.dispatcher === null
        ? defaultDispatcherClaudeCodeConfig()
        : dispatcherClaudeCodeConfig(context.dispatcher);
    this.bin = deps.resolveBinPath(this.config.bin);
    this.cwd = context.row.codex_cwd ?? dispatcherCodexCwd(this.dispatcherId);
    this.mcpConfigPath = dispatcherClaudeCodeMcpConfigPath(this.dispatcherId);
    this.mcpConfigDoc = stringifyClaudeCodeMcpConfig(context.mcpServers);
    this.threadId = context.row.thread_id;
    this.resumed = context.row.thread_id !== null;
  }

  getStatus(): DispatcherStatus {
    return this.status;
  }

  getThreadId(): string | null {
    return this.threadId;
  }

  wasThreadResumed(): boolean {
    return this.resumed;
  }

  async start(): Promise<void> {
    await this.setStatus('starting');
    try {
      await mkdir(dirname(this.mcpConfigPath), { recursive: true });
      await writeFile(this.mcpConfigPath, this.mcpConfigDoc, { mode: 0o600 });
    } catch (err) {
      await this.setStatus('degraded', err);
      throw err;
    }
    // No persistent app-server: a healthy "started" Claude Code runtime is one
    // whose MCP config is materialized and which is ready to accept per-turn
    // invocations. A missing `claude` binary surfaces on the first turn as a
    // degraded runtime status + persisted last_error (see the failure contract
    // in the file header), not a silent no-op.
    await this.setStatus('ready');
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    await this.setStatus('stopping');
    await this.setStatus('stopped');
  }

  async enqueueInbound(
    input: InboundTurnInput,
    hooks: InboundDeliveryHooks = {},
  ): Promise<InboundDeliveryResult> {
    if (this.stopped) return { status: 'stopped' };
    const key = input.source_message_id ?? '';
    if (key !== '' && this.seen.has(key)) return { status: 'duplicate' };
    if (key !== '') this.seen.add(key);
    try {
      await hooks.onAccepted?.(input);
    } catch (err) {
      // onAccepted is a best-effort side effect (e.g. a channel reaction); a
      // failure there must not drop the turn.
      this.log('warn', 'claude-code onAccepted hook failed', err);
    }
    const turnId = `claude-turn-${++this.turnCounter}`;
    // Submit-then-serialize: return after accept (so the channel can ack
    // promptly), run the turn on the serial queue. Unlike Codex there is no
    // separate submit-ack before execution, so a turn failure cannot be
    // returned to this caller without blocking the channel ack on full turn
    // completion. Instead, a failed turn drives the runtime to `degraded` with a
    // persisted `last_error` (visible via status/doctor) — the failure is never
    // swallowed. See the PR6 review thread / the agent-runtime decision record.
    void this.runTurnOnQueue(input.parsed_text, turnId).then(
      () => this.markTurnSucceeded(),
      (err) => this.markTurnFailed(turnId, err),
    );
    return { status: 'submitted', turnId };
  }

  async injectRestartNotice(text: string): Promise<void> {
    if (this.stopped) return;
    const turnId = `claude-restart-${++this.turnCounter}`;
    void this.runTurnOnQueue(text, turnId).then(
      () => this.markTurnSucceeded(),
      (err) => this.markTurnFailed(turnId, err),
    );
  }

  async deliverTeamMateCompletion(
    completion: TeamMateCompletionEnvelope,
  ): Promise<TeamMateCompletionDeliveryResult> {
    if (this.stopped) {
      return { status: 'unsupported', reason: 'runtime stopped' };
    }
    // Task-notification delivery entry: notify the Claude Code session with a
    // task-completion turn. Delivery AWAITS the turn so the result is real —
    // `accepted` only after the notification turn actually ran, `failed`
    // otherwise — which is the semantics the PR8 Dispatcher Service relies on
    // for delivery retry. The executable retry/pull loop itself stays in PR8.
    try {
      await this.runTurnOnQueue(
        formatTaskNotification(completion),
        `claude-teammate-${completion.taskId}`,
      );
      return { status: 'accepted' };
    } catch (err) {
      return {
        status: 'failed',
        error: err instanceof Error ? err : new Error(String(err)),
      };
    }
  }

  /**
   * Chain a turn onto the serial queue. Returns a promise that resolves when
   * this turn completes and rejects when it fails, so awaiting callers (delivery)
   * see the real outcome. The queue itself continues regardless of outcome so a
   * failed turn does not wedge later turns.
   */
  private runTurnOnQueue(prompt: string, turnId: string): Promise<void> {
    const run = this.queue.then(() => this.runTurn(prompt, turnId));
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async markTurnSucceeded(): Promise<void> {
    if (this.stopped) return;
    if (this.status !== 'ready') await this.setStatus('ready');
  }

  private async markTurnFailed(turnId: string, err: unknown): Promise<void> {
    this.log('error', `claude-code turn ${turnId} failed`, err);
    if (this.stopped) return;
    // Surface the failure as durable runtime state rather than swallowing it.
    await this.setStatus('degraded', err);
  }

  private async runTurn(prompt: string, turnId: string): Promise<void> {
    const args = claudeCodeTurnArgs({
      config: this.config,
      mcpConfigPath: this.mcpConfigPath,
      prompt,
      resumeSessionId: this.threadId,
    });
    const result = await this.deps.turnRunner.runTurn({
      bin: this.bin,
      args,
      cwd: this.cwd,
      env: dispatcherProcessEnv(globalThis.process.env, this.config.extra_env),
    });
    if (
      result.sessionId !== null &&
      result.sessionId !== '' &&
      result.sessionId !== this.threadId
    ) {
      this.threadId = result.sessionId;
      await this.context.dispatchers.setThreadId(
        this.dispatcherId,
        result.sessionId,
      );
    }
    this.log('info', `claude-code turn ${turnId} completed`);
  }

  private async setStatus(
    status: DispatcherStatus,
    err?: unknown,
  ): Promise<void> {
    this.status = status;
    await this.context.dispatchers.setStatus(
      this.dispatcherId,
      status,
      err !== undefined ? { last_error: errMessage(err) } : {},
    );
  }

  private log(
    level: 'info' | 'warn' | 'error',
    msg: string,
    err?: unknown,
  ): void {
    this.context.log(level, msg, err);
  }
}

/** Build the Phase 1 `builtin:claude-code` agent runtime provider. */
export function createClaudeCodeAgentRuntimeProvider(
  options: ClaudeCodeAgentRuntimeProviderOptions = {},
): AgentRuntimeProvider {
  const descriptor = createBuiltinRegistry().resolve(
    BUILTIN_CLAUDE_CODE_PROVIDER_REF,
  );
  const turnRunner = options.turnRunner ?? createDefaultClaudeCodeTurnRunner();
  const resolveBinPath = options.resolveBinPath ?? ((bin: string) => bin);
  return {
    ref: BUILTIN_CLAUDE_CODE_PROVIDER_REF,
    descriptor,
    delivery: {
      teammateCompletion: [
        {
          kind: 'claudeCodeTaskNotification',
          description:
            'notify the runtime through a Claude Code task notification path',
        },
      ],
    },
    createRuntime(context: AgentRuntimeCreateContext): AgentRuntime {
      return new ClaudeCodeRuntime(context, { turnRunner, resolveBinPath });
    },
  };
}
