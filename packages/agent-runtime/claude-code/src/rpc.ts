/**
 * Claude Code stream-json turn RPC.
 *
 * The supervisor owns the child process. This class owns one in-flight turn,
 * stdout line demux, turn aggregation, and defensive control-request replies.
 *
 * One Dreamux logical turn can span several CLI commands: a live steer is
 * written into the turn that is already running. How the CLI answers them is
 * not fixed, which is what makes settlement subtle (probed against a live
 * 2.1.231 resident session):
 *
 *  - **Commands fold.** A message that arrives while the in-flight turn is
 *    inside a tool call is absorbed into that turn at the next query-loop
 *    boundary. Several commands then share ONE `result` (3 → 1 observed), and
 *    a folded command's uuid never appears on any `result`. Folding does not
 *    depend on `priority`.
 *  - **Or they do not.** A command that arrives between turns runs on its own
 *    and gets its own `result`.
 *  - **`result.user_message_uuid` is not a completion ledger.** It is present
 *    only sometimes, is not reliably the first-submitted uuid of a fold, and
 *    is absent entirely on the `error_during_execution` artifact a
 *    `priority: 'now'` interrupt produces.
 *  - **`command_lifecycle` is the only 1:1 signal.** Every submitted uuid
 *    reaches a terminal state (`completed` or `cancelled`), folded ones
 *    included. Its ordering against `result` is not stable — terminal states
 *    have been observed both before and after the result.
 *
 * So the turn settles on lifecycle terminality, not on counting results: every
 * submitted command must have reached a terminal state, and at least one
 * `result` must have been seen. The outcome is the last result seen
 * (`TurnAggregator` is already last-result-wins). `user_message_uuid` survives
 * only as a cross-talk guard: a result naming a command this turn never
 * submitted belongs to an already-settled turn.
 */

import type { Writable } from 'node:stream';
import { randomUUID } from 'node:crypto';

import {
  buildCanUseToolAllow,
  buildControlAck,
  buildRemoteControlEnable,
  buildUserMessage,
  LineBuffer,
  parseLine,
  TurnAggregator,
} from './stream.js';
import type { ParsedLine, TurnOutcome, TurnSubmitOptions } from './types.js';

interface PendingTurn {
  resolve: (outcome: TurnOutcome) => void;
  reject: (err: Error) => void;
  aggregator: TurnAggregator;
  timer: NodeJS.Timeout | null;
  /**
   * Every command uuid written into this logical turn, in submission order:
   * the initial command plus each live steer. Commands never leave this list —
   * they only become terminal.
   */
  submitted: string[];
  /**
   * The subset of {@link submitted} that has reached a terminal
   * `command_lifecycle` state, meaning "this command will produce nothing
   * further". One rule covers both endings: a command answered inside a fold
   * (`completed`, its uuid never named by any `result`) and a command that is
   * never answered at all (`cancelled`/`discarded`, or a steer whose write
   * failed).
   */
  terminal: Set<string>;
  /** Whether any command reached `completed`, i.e. the CLI actually ran one. */
  ranAnyCommand: boolean;
  /** Whether a `result` envelope has been accepted into {@link aggregator}. */
  sawResult: boolean;
  /**
   * Why the most recent command ended *without* being run (Codex's
   * `lastSubmissionError`). Only read to name the cause when a turn ends with
   * nothing that could answer it.
   */
  lastAbnormalReason: string | null;
  capabilityWaiters: PendingSteer[];
  writeWaiters: Map<string, PendingWriteSteer>;
}

interface PendingSteer {
  prompt: string;
  options: TurnSubmitOptions;
  resolve: () => void;
  reject: (error: Error) => void;
}

interface PendingWriteSteer {
  resolve: () => void;
  reject: (error: Error) => void;
}

/** Provider-private admission classification; never crosses the neutral API. */
export class ClaudeSteerAdmissionError extends Error {
  constructor(
    readonly admission: 'failed' | 'ambiguous',
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'ClaudeSteerAdmissionError';
  }
}

export interface ClaudeCodeStreamRpcOptions {
  turnTimeoutMs: number;
  log?: (level: 'info' | 'warn' | 'error', msg: string, err?: unknown) => void;
  reapOnTimeout: () => void;
  onRemoteControlUrl?: (url: string) => void;
}

export class ClaudeCodeStreamRpc {
  private readonly lineBuf = new LineBuffer();
  private pending: PendingTurn | null = null;
  private lifecycleSupported: boolean | null = null;
  private remoteControlRequestId: string | null = null;

  constructor(
    private readonly stdin: Writable,
    private readonly options: ClaudeCodeStreamRpcOptions,
  ) {}

  async submitTurn(
    prompt: string,
    options: TurnSubmitOptions = {},
  ): Promise<TurnOutcome> {
    if (!this.stdin.writable) {
      return Promise.reject(new Error('claude resident child is not running'));
    }
    if (this.pending !== null) {
      return Promise.reject(
        new Error('claude resident session is already mid-turn'),
      );
    }
    return new Promise<TurnOutcome>((resolve, reject) => {
      const commandUuid = randomUUID();
      const pending: PendingTurn = {
        resolve,
        reject,
        aggregator: new TurnAggregator(),
        timer: null,
        submitted: [commandUuid],
        terminal: new Set(),
        ranAnyCommand: false,
        sawResult: false,
        lastAbnormalReason: null,
        capabilityWaiters: [],
        writeWaiters: new Map(),
      };
      this.pending = pending;
      // Arm the idle deadline (reset on every inbound stream line in `onLine`).
      this.armIdleTimer(pending);
      try {
        this.stdin.write(
          `${buildUserMessage(prompt, options, commandUuid)}\n`,
          (err) => {
            if (err != null && this.pending === pending) {
              const error = asError(err);
              this.settlePending(error)?.reject(error);
            }
          },
        );
      } catch (error) {
        if (this.pending === pending) {
          const failure = asError(error);
          this.settlePending(failure)?.reject(failure);
        }
      }
    });
  }

  async steerTurn(
    prompt: string,
    options: TurnSubmitOptions = {},
  ): Promise<void> {
    if (!this.stdin.writable) {
      return Promise.reject(
        preAdmissionError('claude resident child is not running'),
      );
    }
    if (this.pending === null) {
      return Promise.reject(
        preAdmissionError('claude resident session has no active turn'),
      );
    }
    const pending = this.pending;
    if (this.lifecycleSupported === false) {
      return Promise.reject(lifecycleUnsupportedError());
    }
    if (this.lifecycleSupported === null) {
      return new Promise<void>((resolve, reject) => {
        pending.capabilityWaiters.push({ prompt, options, resolve, reject });
      });
    }
    return this.writeSteer(pending, prompt, options);
  }

  private writeSteer(
    pending: PendingTurn,
    prompt: string,
    options: TurnSubmitOptions,
  ): Promise<void> {
    if (this.pending !== pending) {
      return Promise.reject(capabilityUndecidedTurnEndedError());
    }
    if (!this.stdin.writable) {
      return Promise.reject(
        preAdmissionError('claude resident child is not running'),
      );
    }
    const commandUuid = randomUUID();
    // The steer joins this logical turn: from here on the turn cannot settle
    // until this command has also reached a terminal lifecycle state.
    pending.submitted.push(commandUuid);
    return new Promise<void>((resolve, reject) => {
      pending.writeWaiters.set(commandUuid, { resolve, reject });
      const fail = (error: unknown): void => {
        // A steer whose write failed will never reach the CLI, so no
        // `command_lifecycle` is coming for it: mark it terminal here or the
        // turn waits on a signal that cannot arrive. Reject the waiter first,
        // since marking may settle the turn and settlement rejects surviving
        // waiters with the generic write-unconfirmed message.
        this.rejectWriteWaiter(pending, commandUuid, ambiguousWriteError(error));
        this.markCommandTerminal(pending, commandUuid, 'steer write failed');
      };
      try {
        this.stdin.write(
          `${buildUserMessage(prompt, { priority: 'now', ...options }, commandUuid)}\n`,
          (err) => {
            if (err != null) {
              fail(err);
              return;
            }
            this.resolveWriteWaiter(pending, commandUuid);
          },
        );
      } catch (error) {
        fail(error);
      }
    });
  }

  onStdoutChunk(chunk: string): void {
    for (const line of this.lineBuf.push(chunk)) this.onLine(parseLine(line));
  }

  failPending(err: Error): void {
    this.settlePending(err)?.reject(err);
  }

  enableRemoteControl(): void {
    if (!this.stdin.writable) return;
    this.remoteControlRequestId = randomUUID();
    this.stdin.write(`${buildRemoteControlEnable(this.remoteControlRequestId)}\n`);
  }

  /**
   * Detach the in-flight turn: clear its deadline timer and null `pending`,
   * returning it so the caller can resolve or reject it exactly once.
   */
  private settlePending(failure?: Error): PendingTurn | null {
    const pending = this.pending;
    if (pending === null) return null;
    if (pending.timer !== null) clearTimeout(pending.timer);
    this.pending = null;
    // On an explicit failure (write error, stop, idle reap) both waiter kinds
    // get the real error. On a clean `result` settlement there is no error:
    // capability waiters never got a decision, while write waiters were written
    // but unconfirmed — distinct messages for distinct conditions.
    this.rejectCapabilityWaiters(
      pending,
      failure ?? capabilityUndecidedTurnEndedError(),
    );
    this.rejectWriteWaiters(pending, failure ?? steerWriteUnconfirmedError());
    return pending;
  }

  /**
   * Mark a submitted command as producing nothing further, then re-check
   * settlement. `abnormalReason` is `null` for the normal ending (`completed`)
   * and a short phrase for a command that never ran — those are logged,
   * because the CLI gives no other trace of a command it declined.
   *
   * A command ending abnormally never fails the turn by itself: the probe
   * shows a `cancelled` command coexisting with another that answers normally
   * (that is exactly what a `priority: 'now'` interrupt looks like), so
   * rejecting on `cancelled` — as the pre-#342 code did — is wrong.
   */
  private markCommandTerminal(
    pending: PendingTurn,
    commandUuid: string,
    abnormalReason: string | null,
  ): void {
    if (!pending.submitted.includes(commandUuid)) return;
    if (!pending.terminal.has(commandUuid)) {
      pending.terminal.add(commandUuid);
      if (abnormalReason === null) {
        pending.ranAnyCommand = true;
      } else {
        pending.lastAbnormalReason = abnormalReason;
        this.options.log?.(
          'warn',
          `claude command ${commandUuid} ${abnormalReason}; it will not ` +
            'produce further output for this turn',
        );
      }
    }
    this.settleIfReady(pending);
  }

  /**
   * The settlement gate: every submitted command has reached a terminal
   * lifecycle state AND at least one `result` has been seen. The outcome is
   * whatever the aggregator last took, since the CLI may answer several
   * commands with a single `result` and never name the folded uuids.
   *
   * Two escapes, both anti-hang:
   *
   *  - no lifecycle signal at all (`msg_lifecycle_v1` absent, so no
   *    `command_lifecycle` will ever arrive) — the `result` is then the only
   *    terminal event there is, so settle on it;
   *  - every command terminal, none of them ever ran, and no result — nothing
   *    can answer this turn, so fail it loudly. The idle deadline is not an
   *    acceptable backstop here: it reaps the resident child, and any inbound
   *    line re-arms it, so a healthy session could be killed long after the
   *    turn became unanswerable.
   *
   * When a command *did* run but no result has arrived yet, this waits: the
   * probe shows terminal lifecycle states arriving both before and after the
   * result they belong to, so "terminal, therefore no result is coming" is not
   * a sound inference.
   */
  private settleIfReady(pending: PendingTurn): void {
    if (this.pending !== pending) return;
    if (pending.sawResult && this.lifecycleSupported !== true) {
      this.settleWithAggregatedResult(pending);
      return;
    }
    for (const commandUuid of pending.submitted) {
      if (!pending.terminal.has(commandUuid)) return;
    }
    if (pending.sawResult) {
      this.settleWithAggregatedResult(pending);
      return;
    }
    if (pending.ranAnyCommand) return;
    const error = new Error(
      'claude turn ended without running any of its commands ' +
        `(last: ${pending.lastAbnormalReason ?? 'no command reached the CLI'})`,
    );
    // Pass the cause into `settlePending` so surviving steer waiters get the
    // real reason instead of the generic write-unconfirmed message.
    this.settlePending(error)?.reject(error);
  }

  /** Settle with the last `result` the aggregator took (last result wins). */
  private settleWithAggregatedResult(pending: PendingTurn): void {
    // Non-null by construction: `sawResult` is only set after the aggregator
    // accepted a `result`, and the runtime turns an error outcome into a
    // failed turn, so resolving is right for both success and error subtypes.
    const outcome = pending.aggregator.outcome()!;
    this.settlePending()?.resolve(outcome);
  }

  /**
   * (Re)arm the per-turn idle deadline. `turnTimeoutMs` is a *max-idle* window,
   * not a total-turn cap: any inbound stream line for this turn pushes it out
   * (see `onLine`). A genuinely wedged child (no stream activity for the whole
   * window) is still reaped — preserving the #120 anti-hang intent — but a long
   * but continuously-streaming turn never trips the deadline (#156).
   */
  private armIdleTimer(pending: PendingTurn): void {
    if (pending.timer !== null) clearTimeout(pending.timer);
    pending.timer = setTimeout(() => {
      if (this.pending !== pending) return;
      const error = new Error(
        `claude resident turn stalled: no stream activity for ${this.options.turnTimeoutMs}ms`,
      );
      const stalled = this.settlePending(error);
      if (stalled === null) return;
      this.options.log?.(
        'error',
        `claude turn stalled: no stream activity for ${this.options.turnTimeoutMs}ms; reaping resident child`,
      );
      stalled.reject(error);
      this.options.reapOnTimeout();
    }, this.options.turnTimeoutMs);
  }

  private onLine(line: ParsedLine): void {
    // Idle-timeout reset: any inbound stream line for the pending turn is
    // activity, so push the deadline out. The terminal `result` clears the
    // timer via `settlePending` below.
    if (this.pending !== null) this.armIdleTimer(this.pending);
    switch (line.kind) {
      case 'init':
        this.decideLifecycleSupport(
          line.capabilities.includes('msg_lifecycle_v1'),
        );
        this.pending?.aggregator.accept(line);
        break;
      case 'assistant':
        this.pending?.aggregator.accept(line);
        break;
      case 'command_lifecycle': {
        const pending = this.pending;
        if (pending === null || line.commandUuid === null) break;
        // `command_lifecycle` does double duty: it coordinates live-steer
        // admission (writeWaiters) and proves lifecycle capability, and its
        // terminal states are the settlement gate — the only signal that stays
        // 1:1 with submitted commands when the CLI folds several of them into
        // one `result`.
        const newlySupported = this.lifecycleSupported === null;
        if (newlySupported) this.lifecycleSupported = true;
        this.resolveWriteWaiter(pending, line.commandUuid);
        if (newlySupported && this.pending === pending) {
          this.flushCapabilityWaiters(pending);
        }
        if (this.pending !== pending) break;
        if (line.state === 'completed') {
          this.markCommandTerminal(pending, line.commandUuid, null);
        } else if (line.state === 'cancelled' || line.state === 'discarded') {
          this.markCommandTerminal(
            pending,
            line.commandUuid,
            `was ${line.state} by claude`,
          );
        }
        break;
      }
      case 'result': {
        const pending = this.pending;
        if (pending === null) {
          // A late result (e.g. a steered command draining in a later stdout
          // flush after the turn already settled) has no turn to settle. Log
          // it so the drop is diagnosable rather than silent.
          this.options.log?.(
            'warn',
            'claude result envelope arrived with no pending turn; ignored',
          );
          break;
        }
        const commandUuid = line.outcome.userMessageUuid;
        if (commandUuid !== null && !pending.submitted.includes(commandUuid)) {
          // Cross-talk guard: a result naming a command this turn never
          // submitted belongs to an already-settled turn, and applying it here
          // would hand this turn someone else's answer.
          this.options.log?.(
            'warn',
            `claude result envelope for unsubmitted command ${commandUuid}; ` +
              'ignored (it belongs to an already-settled turn)',
          );
          break;
        }
        // A result with no `user_message_uuid` is kept, not treated as a
        // settlement trigger: the interrupt artifact (`error_during_execution`
        // with no `result` key) has no uuid, and so does a plain older-build
        // result. Whether the turn is done is decided by lifecycle terminality
        // alone.
        pending.aggregator.accept(line);
        pending.sawResult = true;
        this.settleIfReady(pending);
        break;
      }
      case 'control_request':
        this.onControlRequest(line.requestId, line.subtype, line.request);
        break;
      case 'control_response':
        this.onControlResponse(line.requestId, line.ok, line.response, line.error);
        break;
      case 'parse_error':
        this.options.log?.(
          'warn',
          `claude stream-json parse error: ${line.raw}`,
        );
        break;
      default:
        break;
    }
  }

  private decideLifecycleSupport(supported: boolean): void {
    if (this.lifecycleSupported !== null) return;
    this.lifecycleSupported = supported;
    const pending = this.pending;
    if (pending === null) return;
    if (supported) {
      this.flushCapabilityWaiters(pending);
      return;
    }
    this.rejectCapabilityWaiters(pending, lifecycleUnsupportedError());
  }

  private flushCapabilityWaiters(pending: PendingTurn): void {
    const waiters = pending.capabilityWaiters.splice(0);
    for (const waiter of waiters) {
      void this.writeSteer(pending, waiter.prompt, waiter.options).then(
        waiter.resolve,
        waiter.reject,
      );
    }
  }

  private rejectCapabilityWaiters(pending: PendingTurn, error: Error): void {
    const waiters = pending.capabilityWaiters.splice(0);
    const failure = error instanceof ClaudeSteerAdmissionError
      ? error
      : preAdmissionError(error.message, error);
    for (const waiter of waiters) waiter.reject(failure);
  }

  private resolveWriteWaiter(pending: PendingTurn, commandUuid: string): void {
    const waiter = pending.writeWaiters.get(commandUuid);
    if (waiter === undefined) return;
    pending.writeWaiters.delete(commandUuid);
    waiter.resolve();
  }

  private rejectWriteWaiter(
    pending: PendingTurn,
    commandUuid: string,
    error: Error,
  ): void {
    const waiter = pending.writeWaiters.get(commandUuid);
    if (waiter === undefined) return;
    pending.writeWaiters.delete(commandUuid);
    waiter.reject(error);
  }

  private rejectWriteWaiters(pending: PendingTurn, error: Error): void {
    const failure = error instanceof ClaudeSteerAdmissionError &&
      error.admission === 'ambiguous'
      ? error
      : ambiguousWriteError(error);
    const waiters = [...pending.writeWaiters.values()];
    pending.writeWaiters.clear();
    for (const waiter of waiters) waiter.reject(failure);
  }

  private onControlRequest(
    requestId: string | null,
    subtype: string | null,
    request: Record<string, unknown>,
  ): void {
    if (requestId === null || !this.stdin.writable) return;
    // Unattended posture: answer permission callbacks so a turn never wedges
    // waiting on a human.
    let reply: string;
    if (subtype === 'can_use_tool') {
      const rawInput = request['input'];
      const input =
        typeof rawInput === 'object' &&
        rawInput !== null &&
        !Array.isArray(rawInput)
          ? (rawInput as Record<string, unknown>)
          : {};
      reply = buildCanUseToolAllow(requestId, input);
    } else {
      reply = buildControlAck(requestId);
    }
    this.stdin.write(`${reply}\n`);
  }

  private onControlResponse(
    requestId: string | null,
    ok: boolean,
    response: Record<string, unknown> | null,
    error: string | null,
  ): void {
    if (requestId === null || requestId !== this.remoteControlRequestId) return;
    this.remoteControlRequestId = null;
    if (ok && response !== null) {
      const url = response['session_url'] ?? response['connect_url'];
      if (typeof url === 'string') {
        this.options.onRemoteControlUrl?.(url);
      } else {
        this.options.log?.(
          'warn',
          'claude remote control enable succeeded without a URL',
        );
      }
      return;
    }
    this.options.log?.(
      'warn',
      `claude remote control enable failed${error !== null ? `: ${error}` : ''}`,
    );
  }
}

function lifecycleUnsupportedError(): Error {
  return preAdmissionError(
    'claude resident session cannot prove live-steer lifecycle: ' +
      'msg_lifecycle_v1 is unavailable',
  );
}

function capabilityUndecidedTurnEndedError(): Error {
  return preAdmissionError(
    'claude resident turn ended before live-steer capability was decided',
  );
}

function steerWriteUnconfirmedError(): Error {
  return new ClaudeSteerAdmissionError(
    'ambiguous',
    'claude resident turn ended before the steer write was confirmed',
  );
}

function preAdmissionError(message: string, cause?: Error): Error {
  return new ClaudeSteerAdmissionError(
    'failed',
    message,
    cause === undefined ? undefined : { cause },
  );
}

function ambiguousWriteError(error: unknown): Error {
  const cause = asError(error);
  return new ClaudeSteerAdmissionError('ambiguous', cause.message, { cause });
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
