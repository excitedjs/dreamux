/**
 * Claude Code stream-json protocol and resident-session types.
 *
 * These are data contracts only: no IO, no process spawning, no timers.
 */

/** A parsed JSON object, or `null` for anything that is not a JSON object. */
export type JsonObject = Record<string, unknown>;

/**
 * One decoded stdout line. `kind` is Dreamux's coarse classification, not the
 * CLI's `type` — it groups the wire types by how the runtime reacts.
 */
export type ParsedLine =
  | {
      kind: 'init';
      sessionId: string | null;
      model: string | null;
      raw: JsonObject;
    }
  | {
      kind: 'assistant';
      text: string;
      sessionId: string | null;
      raw: JsonObject;
    }
  | { kind: 'result'; outcome: ResultEnvelope; raw: JsonObject }
  | {
      kind: 'control_request';
      requestId: string | null;
      subtype: string | null;
      request: JsonObject;
      raw: JsonObject;
    }
  | {
      kind: 'control_response';
      requestId: string | null;
      ok: boolean;
      response: JsonObject | null;
      error: string | null;
      raw: JsonObject;
    }
  | { kind: 'other'; type: string | null; subtype: string | null; raw: JsonObject }
  | { kind: 'parse_error'; raw: string };

/** The terminal `result` envelope, reduced to what the runtime records per turn. */
export interface ResultEnvelope {
  /** `success` or one of the `error_*` subtypes. Unknown subtypes pass through. */
  readonly subtype: string | null;
  readonly isError: boolean;
  /** The success-path final text (`result`); `null` for error subtypes. */
  readonly text: string | null;
  readonly sessionId: string | null;
  /** Error subtypes may carry a message list; empty otherwise. */
  readonly errors: readonly string[];
}

/**
 * Per-turn stdin delivery options. The default (an absent object) produces a
 * plain human-equivalent user turn; completion delivery opts into the native
 * notification idiom.
 */
export interface TurnSubmitOptions {
  /**
   * Mark the stdin user message synthetic. claude-code maps this to its
   * internal `isMeta`: hidden in the TUI transcript but model-visible and sent
   * to the API like a normal user turn — the native channel for a background /
   * sub-agent completion notification. Never set on human channel turns.
   */
  isSynthetic?: boolean;
  /** Optional stdin delivery priority (claude-code `priority`). */
  priority?: 'now' | 'next' | 'later';
}

/** The reduced outcome of one assistant turn, terminated by a `result`. */
export interface TurnOutcome {
  readonly isError: boolean;
  /** Final reply text: the `result.result`, falling back to the last assistant snapshot. */
  readonly text: string;
  readonly sessionId: string | null;
  readonly subtype: string | null;
  readonly errors: readonly string[];
}

/** Everything needed to spawn one resident `claude` stream-json child. */
export interface ClaudeCodeSessionSpec {
  bin: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  /** Where to append the child's stderr (its stdout is the in-process data plane). */
  stderrLogPath: string;
  /**
   * Per-turn deadline (ms). If the still-alive child never emits a terminal
   * `result` within this window, the turn is failed and the child is reaped so
   * the serial turn queue (and TeamMate completion delivery behind it) cannot
   * wedge forever. Must be > 0.
   */
  turnTimeoutMs: number;
  /**
   * Enable Claude Code Remote Control for this resident session at startup.
   * Implemented as a stream-json control request, not as a user turn.
   */
  remoteControl: boolean;
  /** Surface the local-only Remote Control URL when Claude returns one. */
  onRemoteControlUrl?: (url: string) => void;
  /** Diagnostic logger for protocol-level events (parse errors, control answers). */
  log?: (level: 'info' | 'warn' | 'error', msg: string, err?: unknown) => void;
}

/**
 * A resident Claude Code session. Full turns are serialized by the caller;
 * `steerTurn` is the one allowed concurrent write, used to steer the active
 * turn without creating a second completion subscription.
 */
export interface ClaudeCodeSession {
  /** Spawn the child and resolve once it is up (reject on spawn error). */
  start(): Promise<void>;
  /** Submit one user turn; resolve with the outcome when `result` lands. */
  submitTurn(prompt: string, options?: TurnSubmitOptions): Promise<TurnOutcome>;
  /** Send a user message into the active turn without awaiting a separate result. */
  steerTurn(prompt: string, options?: TurnSubmitOptions): Promise<void>;
  /** Whether the child is currently alive. */
  isAlive(): boolean;
  /**
   * Register a one-shot handler fired when the child exits unexpectedly (not via
   * {@link stop}). The runtime uses it to mark itself degraded and re-spawn on
   * the next turn. Register before {@link start}.
   */
  setOnExit(handler: () => void): void;
  /** Reap the child (SIGTERM -> SIGKILL group). Idempotent. */
  stop(): Promise<void>;
}

export type ClaudeCodeSessionFactory = (
  spec: ClaudeCodeSessionSpec,
) => ClaudeCodeSession;
