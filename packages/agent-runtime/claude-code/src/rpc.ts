/**
 * Claude Code stream-json turn RPC.
 *
 * The supervisor owns the child process. This class owns one in-flight turn,
 * stdout line demux, turn aggregation, and defensive control-request replies.
 *
 * One Dreamux logical turn can span several CLI commands: a live steer folds
 * into the turn that is already running, and the CLI answers each command with
 * its own `result` envelope. Settlement therefore follows the same three
 * contracts the Codex runtime's active-turn slot already implements, keyed on
 * `result.user_message_uuid` instead of a native turn id: fold then wait, last
 * submission wins, and attribute-by-id-or-drop.
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
   * The command uuids folded into this logical turn, in submission order: the
   * initial command plus every live steer written into it. Claude Code emits
   * one `result` per consumed command, so a steered turn produces several —
   * seconds apart, in separate stdout flushes. This is the fold's waited-on
   * set (Codex's `acceptedTurnIds` / `pendingNativeTurnIds`); a command that
   * can never produce a `result` leaves it via {@link
   * ClaudeCodeStreamRpc.dropSubmittedCommand}.
   */
  submitted: string[];
  /**
   * Per-command outcome, captured from the aggregator at the moment that
   * command's `result` was accepted. The turn settles on the outcome of the
   * *last* entry of {@link submitted} — last submission wins, no concatenation.
   */
  results: Map<string, TurnOutcome>;
  /**
   * Why the most recent command left {@link submitted} without answering
   * (Codex's `lastSubmissionError`). Only read when the fold empties, to name
   * the cause in the turn's rejection.
   */
  lastDropReason: string | null;
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
        results: new Map(),
        lastDropReason: null,
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
    // The steer folds into this logical turn: from here on the turn settles
    // only once this command has produced its own `result` too, and — being
    // the newest submission — its outcome is the one the turn settles with.
    pending.submitted.push(commandUuid);
    return new Promise<void>((resolve, reject) => {
      pending.writeWaiters.set(commandUuid, { resolve, reject });
      const fail = (error: unknown): void => {
        // Reject the waiter first: dropping the command may settle the turn,
        // and settlement rejects surviving waiters with the generic
        // "turn ended before the steer write was confirmed" message.
        this.rejectWriteWaiter(pending, commandUuid, ambiguousWriteError(error));
        this.dropSubmittedCommand(pending, commandUuid, 'steer write failed');
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
   * Fold-then-wait settlement, ported from the Codex active-turn slot
   * (`finalizeSlotIfReady` in `@excitedjs/agent-runtime-codex`): the logical
   * turn settles only once *every* command folded into it has produced its
   * `result`, and it settles with the outcome of the last submitted command
   * (Codex's `accepted.at(-1)`) — not a concatenation.
   *
   * Waiting is what makes a steered turn correct: a `priority` steer does not
   * interrupt the running command, so Claude answers the original command
   * first and the steer's own `result` lands seconds later, in a later stdout
   * flush. Settling on the first result would return the pre-steer answer and
   * leave the real one to be dropped as a late result.
   *
   * Waiting has one terminal exception: if the fold empties (every command was
   * cancelled, discarded, or lost its steer write) nothing can ever answer this
   * turn, so it is failed here and now. Leaving it to the idle deadline would
   * be worse than slow — that path reaps the resident child, and any unrelated
   * stream line re-arms it, so a healthy session could be killed long after the
   * turn became unanswerable.
   */
  private settleIfFolded(pending: PendingTurn): void {
    if (this.pending !== pending) return;
    const finalUuid = pending.submitted.at(-1);
    if (finalUuid === undefined) {
      const error = new Error(
        'claude turn lost every submitted command before any result arrived ' +
          `(last: ${pending.lastDropReason ?? 'dropped from the turn'})`,
      );
      // Pass the cause into `settlePending` so surviving steer waiters get the
      // real reason instead of the generic write-unconfirmed message.
      this.settlePending(error)?.reject(error);
      return;
    }
    for (const commandUuid of pending.submitted) {
      if (!pending.results.has(commandUuid)) return;
    }
    // Guarded by the loop above: the final command has a recorded outcome.
    const outcome = pending.results.get(finalUuid)!;
    this.settlePending()?.resolve(outcome);
  }

  /**
   * Stop waiting on a command that can never produce a `result` — the CLI
   * reported it `cancelled`/`discarded`, or its steer write failed. Mirrors
   * Codex's `recordTurnStartFailure`: the submission leaves the fold and the
   * turn re-checks readiness with what did arrive, so a dropped steer cannot
   * reintroduce a hang. The drop is logged because the CLI gives no other
   * trace of a command it silently declined to run.
   *
   * Dropping never fails the turn on its own — the turn's other commands still
   * settle it normally. It only becomes terminal when it empties the fold, and
   * `settleIfFolded` owns that decision.
   */
  private dropSubmittedCommand(
    pending: PendingTurn,
    commandUuid: string,
    reason: string,
  ): void {
    if (pending.results.has(commandUuid)) return;
    const index = pending.submitted.indexOf(commandUuid);
    if (index < 0) return;
    pending.submitted.splice(index, 1);
    pending.lastDropReason = reason;
    this.options.log?.(
      'warn',
      `claude command ${commandUuid} ${reason}; it can no longer produce a ` +
        'result and is dropped from the pending turn',
    );
    this.settleIfFolded(pending);
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
        // `command_lifecycle` coordinates live-steer admission (writeWaiters)
        // and proves lifecycle capability; it is never a *positive* settlement
        // gate. `completed` in particular arrives after that command's
        // `result`, so the turn settles on `result` (see the `result` case).
        const newlySupported = this.lifecycleSupported === null;
        if (newlySupported) this.lifecycleSupported = true;
        this.resolveWriteWaiter(pending, line.commandUuid);
        if (newlySupported && this.pending === pending) {
          this.flushCapabilityWaiters(pending);
        }
        // The one settlement-relevant lifecycle fact: a cancelled/discarded
        // command is one the CLI will never answer. It must leave the fold or
        // the turn would wait on a `result` that is not coming. It does not
        // fail the turn — the turn's other commands still settle it normally,
        // and only an emptied fold is terminal (see `settleIfFolded`).
        if (line.state === 'cancelled' || line.state === 'discarded') {
          this.dropSubmittedCommand(
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
          // Attribute-by-id-or-drop (Codex looks native completions up by turn
          // id and drops the unmatched ones). A result for a command this turn
          // never submitted belongs to an already-settled turn; applying it
          // here would hand this turn someone else's answer. Drop it — and in
          // particular do not let it settle anything.
          this.options.log?.(
            'warn',
            `claude result envelope for unsubmitted command ${commandUuid}; ` +
              'ignored (it belongs to an already-settled turn)',
          );
          break;
        }
        // Accept every attributed result so session id and the assistant-text
        // fallback stay correct, and snapshot the outcome now: the aggregator
        // is last-result-wins, so a later result would overwrite it.
        pending.aggregator.accept(line);
        // Non-null by construction: the aggregator just took a `result`.
        const outcome = pending.aggregator.outcome()!;
        if (commandUuid === null) {
          // No attribution key (older CLI builds, and the fixtures). Waiting
          // for a fold that cannot be observed would hang the turn, so degrade
          // to settle-on-this-result. The runtime converts an error outcome
          // into a failed turn, so resolving here honors the send→return
          // contract either way.
          if (pending.submitted.length > 1) {
            // Degrading is lossy exactly here: this turn was steered, so the
            // answer it settles with is the pre-steer one. Say so rather than
            // let a stale reply look like a normal settlement.
            this.options.log?.(
              'warn',
              'claude result envelope carries no user_message_uuid; settling ' +
                `a turn of ${pending.submitted.length} commands on this ` +
                'result — later results will be dropped as late',
            );
          }
          this.settlePending()?.resolve(outcome);
          break;
        }
        pending.results.set(commandUuid, outcome);
        this.settleIfFolded(pending);
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
