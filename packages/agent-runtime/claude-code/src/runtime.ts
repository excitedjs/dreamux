/**
 * `builtin:claude-code` AgentRuntime (issue #110 PR6, resident stream-json
 * transport since issue #120; extracted into `@excitedjs/agent-runtime-claude-code`
 * in issue #209).
 *
 * A real second agent runtime that proves the AgentRuntimeProvider abstraction
 * is not "Codex renamed". Like Codex it runs a **resident child process**
 * supervised for the runtime's lifetime — but it differs in every
 * runtime-specific dimension:
 *
 * - **Stream-json over stdio, not an app-server WebSocket.** The resident child
 *   is `claude --print --input-format stream-json --output-format stream-json`
 *   (see `./args.ts`); turns are NDJSON `user` lines on stdin and
 *   `init`/`assistant`/`result` envelopes on stdout (see `./stream.ts`). There
 *   is no `initialize` handshake — the child emits `init` lazily with the first
 *   turn — so readiness is "child spawned", not "handshake completed".
 * - **MCP injection is a JSON config document** (`--mcp-config <file>`), not
 *   Codex's `-c mcp_servers.*` TOML CLI flags.
 * - **Runtime-owned config** is `DispatcherClaudeCodeConfig` (bin / model /
 *   permission_mode / remote_control / extra_args / extra_env), distinct from
 *   the Codex config.
 * - **Completion delivery** is a plain user turn (no fake task-notification),
 *   not the Codex inbox-then-trigger path.
 *
 * Process spawning goes through an injectable {@link ClaudeCodeSessionFactory}
 * seam (mirroring Codex's process-factory seam), so the lifecycle contract is
 * fully unit-testable with a fake session. A live `claude` binary is exercised
 * only by the opt-in live test.
 *
 * Failure contract (unchanged by #120): a turn failure (spawn error, child
 * exit, error `result`) is never swallowed. For inbound/restart turns it drives
 * the runtime to `degraded` with a persisted `last_error` (observable via
 * status/doctor). For `completionInput` it surfaces as a `failed`
 * result the caller can act on (PR8 delivery retry). `channelInput` still
 * returns after accept (submit != completion) so the channel can ack promptly.
 *
 * Restart: an unexpected child exit marks the runtime `degraded`; the next turn
 * re-spawns the resident child with `--resume <session_id>`, restoring the
 * conversation. There is no background backoff timer — re-spawn is lazy and
 * bound to the (serialized) turn queue, so it stays deterministic.
 *
 * Per-turn idle deadline: a turn whose still-alive child goes silent — never
 * emitting another stream line (a stall, or a wait on input the runtime cannot
 * satisfy) — would otherwise pend forever and wedge the serial queue, and behind
 * it TeamMate completion delivery, which awaits this runtime. `turn_timeout_ms`
 * is a *max-idle* window (issue #156): it is reset on every inbound stream line,
 * so a long but continuously-streaming turn (e.g. a deep audit running many
 * tool calls for far longer than the window) is never reaped, while a child that
 * emits nothing for the whole window still is — turning an infinite hang into a
 * normal degraded + `last_error` (inbound) or `failed` delivery result.
 *
 * Reference: the resident stream-json protocol model and process-supervision
 * shape are adapted from the Claudemux `next` implementation; the AgentRuntime /
 * Channel / DispatcherService boundaries (provider seam, runtime-owned MCP
 * injection, degraded/last_error status, TeamMate delivery result contract) are
 * Dreamux's own, per `.agents/decisions/agent-runtime-provider.md`.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { BUILTIN_CLAUDE_CODE_PROVIDER_REF } from './provider-ref.js';
import type { DispatcherClaudeCodeConfig } from './config.js';
import { claudeCodeResidentArgs } from './args.js';
import { stringifyClaudeCodeMcpConfig } from './mcp-config.js';
import {
  type ClaudeCodeSession,
  type ClaudeCodeSessionFactory,
  type TurnOutcome,
  type TurnSubmitOptions,
} from './supervisor.js';
import { renderChannelInput, resolveCompletionBody } from '@excitedjs/dreamux-utils';
import { CLAUDE_CODE_AGENT_RUNTIME_CAPABILITIES } from './provider.js';
import type {
  AgentRuntimeCapabilities,
  AgentRuntime,
  AgentRuntimeIdentity,
  AgentRuntimeLastResult,
  AgentRuntimeMcpServer,
  AgentRuntimePathContext,
  AgentRuntimeResumeInput,
  AgentRuntimeSkillSource,
  AgentRuntimeStateCallbacks,
  AgentRuntimeStatus,
  AgentRuntimeSystemInput,
  AgentRuntimeTurnResult,
  CompletionEnvelope,
  DreamuxLogger,
  InboundDeliveryHooks,
  InboundTurnInput,
  TeamMateCompletionDeliveryResult,
  TurnSettledSignal,
} from '@excitedjs/dreamux-types';

/**
 * Everything the Claude Code runtime needs, assembled by the provider from the
 * neutral create context plus host-supplied hooks. The host contracts the
 * package must not reconstruct — the per-dispatcher path context, the durable
 * state sink, and the base process env (`PATH` seeded with the host package
 * bins) — arrive here; nothing references a Dreamux host module.
 */
export interface ClaudeCodeRuntimeDeps {
  /** Provider-parsed Claude Code runtime config. */
  config: DispatcherClaudeCodeConfig;
  /** Working directory the resident `claude` child runs in. */
  cwd: string;
  /** Neutral state sink for status/thread transitions. */
  state: AgentRuntimeStateCallbacks;
  /** Neutral path context: the runtime derives its mcp-config / log subpaths here. */
  paths: AgentRuntimePathContext;
  /** MCP server descriptors translated into the `--mcp-config` JSON document. */
  mcpServers: readonly AgentRuntimeMcpServer[];
  /** Resident-session factory (tests inject a fake). */
  sessionFactory: ClaudeCodeSessionFactory;
  /** Host-level bin resolver (default: identity on the config bin). */
  resolveBinPath: (bin: string) => string;
  /**
   * The host's neutral env-injection entries from the create context, merged
   * into the resident child env before this provider's own `extra_env`.
   * Empty/omitted means inject nothing (the common case).
   */
  injectEnv?: Record<string, string>;
  /**
   * Launcher-supplied role/system-prompt content, applied as an APPEND via
   * `--append-system-prompt`. Omitted for launches that supply none (teammates).
   */
  systemPromptContent?: string;
  /**
   * Role-gated skill sources core selected (issue #209 slice 6). The
   * add-dir-compatible ones become `--add-dir` flags on every (re)spawn.
   */
  skillSources?: readonly AgentRuntimeSkillSource[];
  /** Fired each time a delivered turn reaches a terminal state. */
  onTurnSettled?: (settled: TurnSettledSignal) => void;
  /** Structured logger; falls back to a minimal `console.error` sink. */
  logger?: DreamuxLogger;
}

interface ActiveChannelTurn {
  turnId: string;
  pendingSteers: string[];
  session: ClaudeCodeSession | null;
  steerQueue: Promise<void>;
}

let nextRuntimeInstanceId = 0;

/**
 * Status line opening a TeamMate completion turn. Plain English, status-varied —
 * NOT claude-code's native `<task-notification>` XML. The old XML mimicked
 * claude-code's real task-notification system, so the model could mistake the
 * fabricated task-id / output-file for a live background task and act on them
 * (hallucination / harness collision). A plain user turn avoids that entirely.
 */
function completionStatusLine(completion: CompletionEnvelope): string {
  switch (completion.status) {
    case 'completed':
      return `TeamMate ${completion.source} has finished its task.`;
    case 'failed':
      return `TeamMate ${completion.source}'s task failed.`;
    case 'stopped':
      return `TeamMate ${completion.source}'s task was stopped.`;
  }
}

/**
 * Build the plain-text completion turn. The result is inlined when short; when
 * it overflows the inline budget the full result is spilled to a file (see
 * {@link resolveCompletionBody}) and only the path is inlined.
 */
async function buildCompletionTurnText(
  completion: CompletionEnvelope,
  spillDir: string,
): Promise<string> {
  const line = completionStatusLine(completion);
  const body = await resolveCompletionBody(completion, spillDir);
  return body.kind === 'inline'
    ? `${line} Output below:\n\n${body.text}`
    : `${line} The output is too long, so the full result was saved to a file:\n\n${body.path}`;
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
  private readonly mcpConfigPath: string;
  private readonly mcpConfigDoc: string;
  private readonly stderrLogPath: string;
  private readonly completionSpillDir: string;
  private readonly logger: DreamuxLogger;
  private status: AgentRuntimeStatus = 'declared';
  private threadId: string | null;
  private resumed: boolean;
  private stopped = false;
  private readonly seen = new Set<string>();
  private queue: Promise<void> = Promise.resolve();
  private readonly runtimeInstanceId = ++nextRuntimeInstanceId;
  private turnCounter = 0;
  private session: ClaudeCodeSession | null = null;
  private lastResult: AgentRuntimeLastResult | null = null;
  private activeChannelTurn: ActiveChannelTurn | null = null;
  private queuedTurnCount = 0;
  private idlePromise: Promise<void> | null = null;
  private idleResolve: (() => void) | null = null;

  constructor(
    identity: AgentRuntimeIdentity,
    private readonly deps: ClaudeCodeRuntimeDeps,
  ) {
    this.dispatcherId = identity.runtime_id;
    this.config = deps.config;
    this.bin = deps.resolveBinPath(this.config.bin);
    this.cwd = deps.cwd;
    this.mcpConfigPath = join(
      deps.paths.dispatcherDir(this.dispatcherId),
      'mcp.json',
    );
    this.mcpConfigDoc = stringifyClaudeCodeMcpConfig(deps.mcpServers);
    // Compose the resident stream-json child's stderr log under the neutral
    // central logs root (B2): core no longer names a per-runtime log file. The
    // host supplies a unique, filesystem-safe `runtime_id`.
    this.stderrLogPath = join(
      deps.paths.logsDir(),
      'claude-code',
      `${this.dispatcherId}.stderr.log`,
    );
    this.completionSpillDir = deps.paths.completionSpillDir(this.dispatcherId);
    this.threadId = identity.checkpoint_id ?? null;
    this.resumed = (identity.checkpoint_id ?? null) !== null;
    this.logger = deps.logger ?? consoleFallbackLogger(this.dispatcherId);
  }

  getStatus(): AgentRuntimeStatus {
    return this.status;
  }

  getCapabilities(): AgentRuntimeCapabilities {
    return CLAUDE_CODE_AGENT_RUNTIME_CAPABILITIES;
  }

  getThreadId(): string | null {
    return this.threadId;
  }

  wasThreadResumed(): boolean {
    return this.resumed;
  }

  async getLast(): Promise<AgentRuntimeLastResult | null> {
    return this.lastResult;
  }

  async getContext(): Promise<null> {
    return null;
  }

  async resume(input: AgentRuntimeResumeInput = {}): Promise<void> {
    if (input.checkpoint !== undefined && input.checkpoint !== null) {
      if (input.checkpoint.kind !== 'claudeCodeSession') {
        throw new Error(
          `unsupported resume checkpoint for Claude Code runtime: ${input.checkpoint.kind}`,
        );
      }
      this.threadId = input.checkpoint.id;
      this.resumed = true;
    }
    await this.start();
  }

  async start(): Promise<void> {
    await this.setStatus('starting');
    try {
      await mkdir(dirname(this.mcpConfigPath), { recursive: true });
      await writeFile(this.mcpConfigPath, this.mcpConfigDoc, { mode: 0o600 });
      // Spawn the resident child up front so the runtime is truly resident
      // (Codex-aligned). A missing/broken `claude` binary fails here and drives
      // the runtime to degraded + throws, rather than a silent no-op.
      await this.ensureSession();
    } catch (err) {
      await this.setStatus('degraded', err);
      throw err;
    }
    await this.setStatus('ready');
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    await this.setStatus('stopping');
    const session = this.session;
    this.session = null;
    if (session !== null) {
      try {
        await session.stop();
      } catch (err) {
        this.log('warn', 'claude-code session stop errored', err);
      }
    }
    this.queuedTurnCount = 0;
    this.resolveIdleWaitersIfIdle();
    await this.setStatus('stopped');
  }

  async systemInput(notice: AgentRuntimeSystemInput): Promise<AgentRuntimeTurnResult> {
    if (this.stopped) return { status: 'stopped' };
    const turnId = this.nextTurnId('system');
    this.recordQueuedTurnStart();
    void this.runTurnOnQueue(notice.text, turnId).then(
      () => this.markTurnSucceeded(turnId),
      (err) => this.markTurnFailed(turnId, err),
    );
    return { status: 'submitted', turnId };
  }

  async channelInput(
    input: InboundTurnInput,
    hooks: InboundDeliveryHooks = {},
  ): Promise<AgentRuntimeTurnResult> {
    if (this.stopped) return { status: 'stopped' };
    const key = input.sourceId;
    if (key !== '' && this.seen.has(key)) return { status: 'duplicate' };
    if (key !== '') this.seen.add(key);
    try {
      await hooks.onAccepted?.(input);
    } catch (err) {
      // onAccepted is a best-effort side effect (e.g. a channel reaction); a
      // failure there must not drop the turn.
      this.log('warn', 'claude-code onAccepted hook failed', err);
    }
    // This runtime owns wrapping the channel input into its delivery shape: a
    // structured channel turn becomes the native `<channel source="…">` block;
    // a plain turn passes through unchanged.
    const text = renderChannelInput(input);
    const active = this.activeChannelTurn;
    if (active !== null) {
      try {
        await this.steerChannelTurn(active, text);
        return { status: 'submitted', turnId: active.turnId };
      } catch (err) {
        return {
          status: 'failed',
          error: err instanceof Error ? err : new Error(String(err)),
        };
      }
    }
    const turnId = this.nextTurnId('turn');
    this.recordQueuedTurnStart();
    const channelTurn: ActiveChannelTurn = {
      turnId,
      pendingSteers: [],
      session: null,
      steerQueue: Promise.resolve(),
    };
    this.activeChannelTurn = channelTurn;
    // Submit-then-serialize: return after accept (so the channel can ack
    // promptly), run the turn on the serial queue. A turn failure cannot be
    // returned to this caller without blocking the channel ack on full turn
    // completion. Instead, a failed turn drives the runtime to `degraded` with a
    // persisted `last_error` (visible via status/doctor) — never swallowed.
    void this.runChannelTurnOnQueue(text, channelTurn).then(
      () => this.markTurnSucceeded(turnId),
      (err) => this.markTurnFailed(turnId, err),
    );
    return { status: 'submitted', turnId };
  }

  async completionInput(
    completion: CompletionEnvelope,
  ): Promise<TeamMateCompletionDeliveryResult> {
    if (this.stopped) {
      return { status: 'unsupported', reason: 'runtime stopped' };
    }
    // Plain user-turn delivery: a stream-json user message marked
    // `isSynthetic: false`, so claude-code treats it as ordinary human input
    // rather than routing it through its native task-notification harness path.
    // Submit-then-serialize: return accepted at enqueue so delivery acceptance
    // is decoupled from model thinking time.
    let text: string;
    try {
      text = await buildCompletionTurnText(completion, this.completionSpillDir);
    } catch (err) {
      return {
        status: 'failed',
        error: err instanceof Error ? err : new Error(String(err)),
      };
    }
    const turnId = `claude-teammate-${completion.id}`;
    this.recordQueuedTurnStart();
    void this.runTurnOnQueue(text, turnId, { isSynthetic: false }).then(
      () => this.markTurnSucceeded(turnId),
      (err) => this.markTurnFailed(turnId, err),
    );
    return { status: 'accepted' };
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

  /**
   * Chain a turn onto the serial queue. Returns a promise that resolves when
   * this turn completes and rejects when it fails, so awaiting callers (delivery)
   * see the real outcome. The queue itself continues regardless of outcome so a
   * failed turn does not wedge later turns.
   */
  private runTurnOnQueue(
    prompt: string,
    turnId: string,
    options?: TurnSubmitOptions,
  ): Promise<void> {
    const run = this.queue.then(() => this.runTurn(prompt, turnId, options));
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private runChannelTurnOnQueue(
    prompt: string,
    active: ActiveChannelTurn,
  ): Promise<void> {
    const run = this.queue.then(() => this.runChannelTurn(prompt, active));
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async runChannelTurn(
    prompt: string,
    active: ActiveChannelTurn,
  ): Promise<void> {
    const session = await this.ensureSession();
    const steers = active.pendingSteers.splice(0);
    const fullPrompt =
      steers.length === 0 ? prompt : [prompt, ...steers].join('\n\n');
    const outcome = session.submitTurn(fullPrompt);
    active.session = session;
    try {
      await this.applyTurnOutcome(await outcome, active.turnId);
    } finally {
      active.session = null;
      if (this.activeChannelTurn === active) this.activeChannelTurn = null;
      active.pendingSteers = [];
    }
  }

  private async steerChannelTurn(
    active: ActiveChannelTurn,
    prompt: string,
  ): Promise<void> {
    const session = active.session;
    if (session === null) {
      active.pendingSteers.push(prompt);
      return;
    }
    const steer = active.steerQueue.then(() =>
      session.steerTurn(prompt, { priority: 'next' }),
    );
    active.steerQueue = steer.then(
      () => undefined,
      () => undefined,
    );
    await steer;
  }

  private async markTurnSucceeded(turnId: string): Promise<void> {
    this.recordQueuedTurnEnd();
    this.deps.onTurnSettled?.({ turnId, status: 'completed' });
    if (this.stopped) return;
    if (this.status !== 'ready') await this.setStatus('ready');
  }

  private async markTurnFailed(turnId: string, err: unknown): Promise<void> {
    this.recordQueuedTurnEnd();
    this.log('error', `claude-code turn ${turnId} failed`, err);
    // A turn that fails after stop() was requested (the resident child is being
    // torn down) is a `stopped` settlement; otherwise it is a genuine `failed`.
    // Fire before the stopped early-return so an interrupted teammate turn is
    // never lost.
    this.deps.onTurnSettled?.({
      turnId,
      status: this.stopped ? 'stopped' : 'failed',
      error: err instanceof Error ? err : new Error(String(err)),
    });
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

  /**
   * Ensure a live resident session exists, spawning (or re-spawning after an
   * unexpected exit) as needed. Re-spawn resumes the persisted session id so the
   * conversation survives a crash.
   */
  private async ensureSession(): Promise<ClaudeCodeSession> {
    if (this.session !== null && this.session.isAlive()) return this.session;
    const args = claudeCodeResidentArgs({
      config: this.config,
      mcpConfigPath: this.mcpConfigPath,
      resumeSessionId: this.threadId,
      systemPromptContent: this.deps.systemPromptContent,
      skillSources: this.deps.skillSources,
    });
    const session = this.deps.sessionFactory({
      bin: this.bin,
      args,
      cwd: this.cwd,
      env: this.buildProcessEnv(this.config.extra_env),
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
    await session.start();
    this.session = session;
    return session;
  }

  /** React to an unexpected resident-child exit: degrade and drop the session. */
  private async onSessionExit(session: ClaudeCodeSession): Promise<void> {
    if (this.session !== session) return; // already replaced/stopped
    this.session = null;
    if (this.stopped) return;
    this.log('error', 'claude-code resident child exited unexpectedly');
    await this.setStatus('degraded', new Error('claude resident child exited'));
  }

  private async runTurn(
    prompt: string,
    turnId: string,
    options?: TurnSubmitOptions,
  ): Promise<void> {
    const session = await this.ensureSession();
    await this.runTurnWithSession(session, prompt, turnId, options);
  }

  private async runTurnWithSession(
    session: ClaudeCodeSession,
    prompt: string,
    turnId: string,
    options?: TurnSubmitOptions,
  ): Promise<void> {
    const outcome = await session.submitTurn(prompt, options);
    await this.applyTurnOutcome(outcome, turnId);
  }

  private async applyTurnOutcome(
    outcome: TurnOutcome,
    turnId: string,
  ): Promise<void> {
    if (
      outcome.sessionId !== null &&
      outcome.sessionId !== '' &&
      outcome.sessionId !== this.threadId
    ) {
      this.threadId = outcome.sessionId;
      await this.deps.state.setThreadId(this.dispatcherId, outcome.sessionId);
    }
    if (!outcome.isError) this.lastResult = { text: outcome.text };
    if (outcome.isError) {
      const detail =
        outcome.errors.length > 0
          ? outcome.errors.join('; ')
          : (outcome.subtype ?? 'unknown error');
      throw new Error(`claude turn ${turnId} returned an error result: ${detail}`);
    }
    this.log('info', `claude-code turn ${turnId} completed`);
  }

  private nextTurnId(kind: 'system' | 'turn'): string {
    return `claude-${kind}-${this.runtimeInstanceId}-${++this.turnCounter}`;
  }

  private buildProcessEnv(
    extraEnv: Record<string, string>,
  ): NodeJS.ProcessEnv {
    // Neutral env boundary: { ...process.env, ...injectEnv, ...extra_env }.
    // `injectEnv` is the host's optional injection seam (empty today); `extraEnv`
    // is this provider's own `config.extra_env`, merged last so it can override.
    return {
      ...globalThis.process.env,
      ...(this.deps.injectEnv ?? {}),
      ...extraEnv,
    };
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
        this.dispatcherId,
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

/**
 * Minimal `console.error`-backed logger the runtime falls back to when the host
 * passes none (the bare generic-loader / standalone path). Owned here, never in
 * `@excitedjs/dreamux-types` (which is declaration-only).
 */
function consoleFallbackLogger(dispatcherId: string): DreamuxLogger {
  const sink =
    (level: string) =>
    (fields: Record<string, unknown> | string, message?: string): void => {
      const prefix = `[claude-code ${dispatcherId}] ${level}`;
      if (typeof fields === 'string') {
        console.error(prefix, fields);
        return;
      }
      const err = fields['err'];
      if (err !== undefined) console.error(prefix, message ?? '', err);
      else console.error(prefix, message ?? '');
    };
  return {
    error: sink('error'),
    warn: sink('warn'),
    info: sink('info'),
    debug: () => {},
    trace: () => {},
  };
}
