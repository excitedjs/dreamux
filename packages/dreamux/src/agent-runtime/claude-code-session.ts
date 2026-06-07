/**
 * The resident Claude Code stream-json session (issue #120).
 *
 * This is the process-supervision seam for `builtin:claude-code`. It replaces
 * the retired one-shot `claude --print <prompt>` model — where every turn paid a
 * fresh process cold-start and there was no session continuity beyond
 * `--resume` — with a single long-lived `claude --print --input-format
 * stream-json` child that holds stdin/stdout open and serves many turns.
 *
 * Responsibilities (mirrors the role `codex/supervisor.ts` plays for Codex):
 *
 *  - **Spawn + hold.** `start()` spawns the child in its own process group
 *    (so a leaked grandchild can be group-killed on reap) and resolves once the
 *    child is up. The child does NOT emit `init` until the first user message
 *    arrives, so readiness must not wait on it — the session id is captured from
 *    the first turn's `init` / `result`.
 *  - **Serialize turns.** `submitTurn()` writes one `user` message line to
 *    stdin and resolves with the aggregated `TurnOutcome` when the terminal
 *    `result` lands. Callers MUST serialize (the runtime's turn queue does);
 *    a second concurrent `submitTurn` is rejected rather than interleaving two
 *    turns on one stdin.
 *  - **Demux stdout.** Each NDJSON line is parsed by the pure
 *    `runtime/claude-code-stream.ts` model; data-plane envelopes feed the
 *    in-flight aggregator, control requests are answered defensively so an
 *    unattended turn never wedges on a permission callback.
 *  - **Surface exit.** A child exit mid-turn rejects the in-flight turn; an
 *    exit at any time fires `onExit` so the runtime can mark itself degraded and
 *    re-spawn (with `--resume`) on the next turn.
 *
 * The seam is injectable ({@link ClaudeCodeSessionFactory}) so the runtime
 * lifecycle is unit-testable with a fake session and no live `claude` binary.
 */

import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { mkdir, open } from 'node:fs/promises';
import { dirname } from 'node:path';

import { isProcessAlive, killProcessGroup } from '../codex/supervisor.js';
import {
  buildCanUseToolAllow,
  buildControlAck,
  buildUserMessage,
  LineBuffer,
  parseLine,
  TurnAggregator,
  type ParsedLine,
  type TurnOutcome,
} from '../runtime/claude-code-stream.js';

export type { TurnOutcome } from '../runtime/claude-code-stream.js';

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
  /** Diagnostic logger for protocol-level events (parse errors, control answers). */
  log?: (level: 'info' | 'warn' | 'error', msg: string, err?: unknown) => void;
}

/**
 * A resident Claude Code session. Turns are serialized by the caller; the
 * session itself rejects a concurrent `submitTurn` defensively.
 */
export interface ClaudeCodeSession {
  /** Spawn the child and resolve once it is up (reject on spawn error). */
  start(): Promise<void>;
  /** Submit one user turn; resolve with the outcome when `result` lands. */
  submitTurn(prompt: string): Promise<TurnOutcome>;
  /** Whether the child is currently alive. */
  isAlive(): boolean;
  /**
   * Register a one-shot handler fired when the child exits unexpectedly (not via
   * {@link stop}). The runtime uses it to mark itself degraded and re-spawn on
   * the next turn. Register before {@link start}.
   */
  setOnExit(handler: () => void): void;
  /** Reap the child (SIGTERM → SIGKILL group). Idempotent. */
  stop(): Promise<void>;
}

export type ClaudeCodeSessionFactory = (
  spec: ClaudeCodeSessionSpec,
) => ClaudeCodeSession;

interface PendingTurn {
  resolve: (outcome: TurnOutcome) => void;
  reject: (err: Error) => void;
  aggregator: TurnAggregator;
  timer: NodeJS.Timeout | null;
}

/** The live session: spawns and supervises the real `claude` child. */
class LiveClaudeCodeSession implements ClaudeCodeSession {
  private child: ChildProcess | null = null;
  private pid: number | null = null;
  private exited = false;
  private stopped = false;
  private readonly lineBuf = new LineBuffer();
  private pending: PendingTurn | null = null;

  constructor(private readonly spec: ClaudeCodeSessionSpec) {}

  isAlive(): boolean {
    return this.child !== null && !this.exited;
  }

  async start(): Promise<void> {
    if (this.child !== null) {
      throw new Error('ClaudeCodeSession.start: already started');
    }
    await mkdir(this.spec.cwd, { recursive: true });
    await mkdir(dirname(this.spec.stderrLogPath), { recursive: true });
    // Open the stderr log as a FileHandle and hand its fd to the child. The
    // handle is closed once the child owns the inherited fd (the finally),
    // matching the timing discipline in codex/supervisor.ts.
    const stderrHandle = await open(this.spec.stderrLogPath, 'a', 0o600);
    const spawnOpts: SpawnOptions = {
      cwd: this.spec.cwd,
      env: this.spec.env,
      // Own process group so a leaked grandchild (the rust/node split a CLI may
      // fork) is group-killable on reap, never a leak.
      detached: true,
      stdio: ['pipe', 'pipe', stderrHandle.fd],
    };
    let child: ChildProcess;
    try {
      child = await new Promise<ChildProcess>((resolve, reject) => {
        let settled = false;
        const c = spawn(this.spec.bin, this.spec.args, spawnOpts);
        c.once('error', (e) => {
          if (settled) return;
          settled = true;
          reject(e instanceof Error ? e : new Error(String(e)));
        });
        c.once('spawn', () => {
          if (settled) return;
          settled = true;
          resolve(c);
        });
      });
    } finally {
      await stderrHandle.close();
    }
    if (child.pid === undefined) {
      throw new Error('claude resident child spawned without a pid');
    }
    this.child = child;
    this.pid = child.pid;
    // Post-spawn `error` must not crash the host event loop.
    child.on('error', (err) => {
      this.spec.log?.('warn', 'claude resident child error', err);
    });
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      for (const line of this.lineBuf.push(chunk)) this.onLine(parseLine(line));
    });
    child.once('exit', () => this.onChildExit());
  }

  async submitTurn(prompt: string): Promise<TurnOutcome> {
    if (this.stopped) {
      return Promise.reject(new Error('claude resident session is stopped'));
    }
    const stdin = this.child?.stdin;
    if (this.child === null || this.exited || stdin == null || !stdin.writable) {
      return Promise.reject(new Error('claude resident child is not running'));
    }
    if (this.pending !== null) {
      return Promise.reject(
        new Error('claude resident session is already mid-turn'),
      );
    }
    return new Promise<TurnOutcome>((resolve, reject) => {
      const pending: PendingTurn = {
        resolve,
        reject,
        aggregator: new TurnAggregator(),
        timer: null,
      };
      // Per-turn deadline: a still-alive child that never emits a terminal
      // `result` (e.g. it stalls waiting on input, or only streams
      // `init`/`assistant`/control envelopes) must not pend forever. On the
      // deadline, fail this turn and reap the child — `isAlive()` then goes
      // false, so the runtime re-spawns (with `--resume`) on the next turn
      // rather than reusing a child with half a turn's output buffered.
      pending.timer = setTimeout(() => {
        if (this.pending !== pending) return;
        this.pending = null;
        this.spec.log?.(
          'error',
          `claude turn timed out after ${this.spec.turnTimeoutMs}ms; reaping resident child`,
        );
        reject(
          new Error(
            `claude resident turn timed out after ${this.spec.turnTimeoutMs}ms without a result`,
          ),
        );
        // Reap is fire-and-forget: the turn has already been rejected, and the
        // next turn will re-spawn a fresh child.
        void this.stop().catch(() => {
          /* reap is best-effort */
        });
      }, this.spec.turnTimeoutMs);
      this.pending = pending;
      // A failed stdin write must fail the turn (and not leave it dangling).
      stdin.write(`${buildUserMessage(prompt)}\n`, (err) => {
        if (err != null && this.pending === pending) {
          this.settlePending()?.reject(
            err instanceof Error ? err : new Error(String(err)),
          );
        }
      });
    });
  }

  /**
   * Detach the in-flight turn: clear its deadline timer and null `pending`,
   * returning it so the caller can resolve or reject it exactly once.
   */
  private settlePending(): PendingTurn | null {
    const pending = this.pending;
    if (pending === null) return null;
    if (pending.timer !== null) clearTimeout(pending.timer);
    this.pending = null;
    return pending;
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    // Mark exited up front so the child's own `exit` event (fired by the kill
    // below) is treated as a deliberate stop, never an unexpected exit that
    // would fire `onExit` → degrade the runtime we are intentionally tearing
    // down.
    this.exited = true;
    this.failPending(new Error('claude resident session stopped mid-turn'));
    const pid = this.pid;
    if (pid !== null) {
      if (isProcessAlive(pid)) {
        killProcessGroup(pid, 'SIGTERM');
        const deadline = Date.now() + 1000;
        while (Date.now() < deadline) {
          if (!isProcessAlive(pid)) break;
          await new Promise<void>((r) => setTimeout(r, 25));
        }
      }
      // Always SIGKILL the group — a reparented grandchild outliving its leader
      // is the exact leak this guards against.
      killProcessGroup(pid, 'SIGKILL');
    }
    this.exited = true;
    this.child = null;
  }

  private onLine(line: ParsedLine): void {
    switch (line.kind) {
      case 'init':
      case 'assistant':
        this.pending?.aggregator.accept(line);
        break;
      case 'result': {
        if (this.pending === null) break;
        this.pending.aggregator.accept(line);
        const outcome = this.pending.aggregator.outcome();
        const pending = this.settlePending();
        if (pending === null) break;
        if (outcome !== null) pending.resolve(outcome);
        else pending.reject(new Error('claude turn ended without a result'));
        break;
      }
      case 'control_request':
        this.onControlRequest(line.requestId, line.subtype, line.request);
        break;
      case 'parse_error':
        this.spec.log?.('warn', `claude stream-json parse error: ${line.raw}`);
        break;
      default:
        break;
    }
  }

  private onControlRequest(
    requestId: string | null,
    subtype: string | null,
    request: Record<string, unknown>,
  ): void {
    const stdin = this.child?.stdin;
    if (requestId === null || stdin == null || !stdin.writable) return;
    // Unattended posture: answer permission callbacks so a turn never wedges
    // waiting on a human. Under a bypassing permission mode the CLI does not
    // ask, but answering defensively is harmless and crash-proof.
    let reply: string;
    if (subtype === 'can_use_tool') {
      const rawInput = request['input'];
      const input =
        typeof rawInput === 'object' && rawInput !== null && !Array.isArray(rawInput)
          ? (rawInput as Record<string, unknown>)
          : {};
      reply = buildCanUseToolAllow(requestId, input);
    } else {
      reply = buildControlAck(requestId);
    }
    stdin.write(`${reply}\n`);
  }

  private onChildExit(): void {
    if (this.exited) return;
    this.exited = true;
    this.failPending(new Error('claude resident child exited mid-turn'));
    this.onExitHandler?.();
  }

  private failPending(err: Error): void {
    this.settlePending()?.reject(err);
  }

  private onExitHandler: (() => void) | null = null;

  setOnExit(handler: () => void): void {
    this.onExitHandler = handler;
  }
}

/**
 * The default factory: spawns the real `claude` binary. The returned session
 * exposes a `setOnExit` registration the runtime uses to react to an unexpected
 * child death (degrade + re-spawn next turn).
 */
export function createDefaultClaudeCodeSession(
  spec: ClaudeCodeSessionSpec,
): ClaudeCodeSession {
  return new LiveClaudeCodeSession(spec);
}
