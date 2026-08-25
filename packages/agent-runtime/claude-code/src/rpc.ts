/**
 * Claude Code stream-json turn RPC.
 *
 * The supervisor owns the child process. This class owns one in-flight command
 * group, stdout line demux, command drainage, and defensive control replies.
 *
 * One resident CLI execution window can span several submitted commands: a
 * live steer is written while the CLI is already running. How the CLI answers them is
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
 *  - **`command_lifecycle` is the attribution signal.** Started commands identify
 *    the submissions represented by the next native `result`; terminal states
 *    drain the resident execution window. Its ordering against `result` is not
 *    stable.
 *
 * Every valid `result` is forwarded immediately as its own native completion
 * boundary. Lifecycle terminality only decides when the command group has
 * drained and the resident session may accept a new initial command; it never
 * aggregates several results into one completion.
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
import type { ParsedLine, TurnSubmitOptions } from './types.js';

interface PendingTurn {
  resolve: () => void;
  reject: (err: Error) => void;
  aggregator: TurnAggregator;
  timer: NodeJS.Timeout | null;
  /**
   * Every command uuid written into this resident execution window, in submission order:
   * the initial command plus each live steer. Commands never leave this list —
   * they only become terminal.
   */
  submitted: string[];
  /**
   * The subset of {@link submitted} that has reached a terminal
   * `command_lifecycle` state, meaning "this command will produce nothing
   * further". One rule covers both endings: a command represented by a shared
   * result (`completed`, its uuid may never be named by that `result`) and one that is
   * never answered at all (`cancelled`/`discarded`, or a steer whose write
   * failed).
   */
  terminal: Set<string>;
  /** Commands started since the last result boundary, retained through terminal lifecycle. */
  startedSinceResult: Set<string>;
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
  commandUuid: string;
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
  onProtocolEvent?: import('./types.js').ClaudeCodeSessionSpec['onProtocolEvent'];
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
    commandUuid: string = randomUUID(),
  ): Promise<void> {
    if (!this.stdin.writable) {
      return Promise.reject(new Error('claude resident child is not running'));
    }
    if (this.pending !== null) {
      return Promise.reject(
        new Error('claude resident session is already mid-turn'),
      );
    }
    return new Promise<void>((resolve, reject) => {
      const pending: PendingTurn = {
        resolve,
        reject,
        aggregator: new TurnAggregator(),
        timer: null,
        submitted: [commandUuid],
        terminal: new Set(),
        startedSinceResult: new Set(),
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
    commandUuid: string = randomUUID(),
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
        pending.capabilityWaiters.push({ prompt, options, commandUuid, resolve, reject });
      });
    }
    return this.writeSteer(pending, prompt, options, commandUuid);
  }

  private writeSteer(
    pending: PendingTurn,
    prompt: string,
    options: TurnSubmitOptions,
    commandUuid: string = randomUUID(),
  ): Promise<void> {
    if (this.pending !== pending) {
      return Promise.reject(capabilityUndecidedTurnEndedError());
    }
    if (!this.stdin.writable) {
      return Promise.reject(
        preAdmissionError('claude resident child is not running'),
      );
    }
    // The steer joins this resident execution window: from here on it cannot drain
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
   * The drainage gate: every submitted command has reached a terminal
   * lifecycle state AND at least one valid `result` has been seen. Result
   * identity and settlement have already been forwarded one-by-one.
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
      this.settlePending()?.resolve();
      return;
    }
    if (pending.startedSinceResult.size > 0) return;
    for (const commandUuid of pending.submitted) {
      if (!pending.terminal.has(commandUuid)) return;
    }
    if (pending.sawResult) {
      this.settlePending()?.resolve();
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
        this.options.onProtocolEvent?.({ kind: 'stream', line });
        break;
      case 'command_lifecycle': {
        const pending = this.pending;
        if (pending === null || line.commandUuid === null) break;
        if (line.state !== null) {
          this.options.onProtocolEvent?.({
            kind: 'command_lifecycle',
            commandUuid: line.commandUuid,
            state: line.state,
          });
        }
        if (line.state === 'started') pending.startedSinceResult.add(line.commandUuid);
        // `command_lifecycle` does double duty: it coordinates live-steer
        // admission (writeWaiters) and proves lifecycle capability, and its
        // terminal states are the drainage gate when the CLI represents several
        // started commands with one `result`.
        const newlySupported = this.lifecycleSupported === null;
        if (newlySupported) this.lifecycleSupported = true;
        this.resolveWriteWaiter(pending, line.commandUuid);
        if (newlySupported && this.pending === pending) {
          this.flushCapabilityWaiters(pending);
        }
        if (this.pending !== pending) break;
        if (line.state === 'completed') {
          this.markCommandTerminal(pending, line.commandUuid, null);
        } else if (line.state === 'cancelled' || line.state === 'discarded' || line.state === 'refused') {
          pending.startedSinceResult.delete(line.commandUuid);
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
          const error = new Error(
            'claude result envelope arrived without an attributable command group',
          );
          this.options.log?.('error', error.message, error);
          this.options.reapOnTimeout();
          break;
        }
        const commandUuid = line.outcome.userMessageUuid;
        if (commandUuid !== null && !pending.submitted.includes(commandUuid)) {
          const error = new Error(
            `claude result envelope for unsubmitted command ${commandUuid}; ` +
              'native completion ownership is ambiguous',
          );
          this.options.log?.('error', error.message, error);
          this.settlePending(error)?.reject(error);
          this.options.reapOnTimeout();
          break;
        }
        // The interrupt artifact (`error_during_execution` with no result) is
        // not a native answer boundary. Older valid results may omit the uuid.
        if (
          line.outcome.subtype === 'error_during_execution' &&
          line.outcome.userMessageUuid === null &&
          line.outcome.text === null
        ) {
          this.options.log?.('warn', 'claude interrupt result artifact ignored');
          break;
        }
        pending.aggregator.accept(line);
        const outcome = pending.aggregator.takeOutcome()!;
        pending.startedSinceResult.clear();
        pending.sawResult = true;
        this.options.onProtocolEvent?.({
          kind: 'result',
          outcome,
        });
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
        this.options.onProtocolEvent?.({ kind: 'stream', line });
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
      void this.writeSteer(
        pending,
        waiter.prompt,
        waiter.options,
        waiter.commandUuid,
      ).then(
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
