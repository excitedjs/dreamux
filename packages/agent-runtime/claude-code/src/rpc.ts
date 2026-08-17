/**
 * Claude Code stream-json turn RPC.
 *
 * The supervisor owns the child process. This class owns one in-flight turn,
 * stdout line demux, turn aggregation, and defensive control-request replies.
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
   * Set once a live steer has been written into this turn. A `priority` steer
   * can make Claude Code close the interrupted run and drain the queued steer
   * in the same stdout flush, emitting more than one `result` for one Dreamux
   * logical turn. When steered, settlement is deferred one tick so those
   * follow-up results fold into the same turn (last result wins) instead of
   * the first becoming a silent late result.
   */
  steered: boolean;
  settleImmediate: NodeJS.Immediate | null;
  deferredOutcome: TurnOutcome | null;
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
      const pending: PendingTurn = {
        resolve,
        reject,
        aggregator: new TurnAggregator(),
        timer: null,
        steered: false,
        settleImmediate: null,
        deferredOutcome: null,
        capabilityWaiters: [],
        writeWaiters: new Map(),
      };
      const commandUuid = randomUUID();
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
    pending.steered = true;
    return new Promise<void>((resolve, reject) => {
      pending.writeWaiters.set(commandUuid, { resolve, reject });
      const fail = (error: unknown): void =>
        this.rejectWriteWaiter(pending, commandUuid, ambiguousWriteError(error));
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
    if (pending.settleImmediate !== null) clearImmediate(pending.settleImmediate);
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
   * Fold a steered turn's results into one settlement. A `priority` steer can
   * make Claude Code close the interrupted run and immediately drain the queued
   * steer in the same stdout flush, emitting more than one `result` for one
   * Dreamux logical turn. Defer settlement to the next tick so those follow-up
   * results are still folded into this turn (last result wins) instead of the
   * first becoming a silent late result.
   */
  private deferSteeredResult(
    pending: PendingTurn,
    outcome: TurnOutcome | null,
  ): void {
    pending.deferredOutcome = outcome;
    if (pending.settleImmediate !== null) return;
    pending.settleImmediate = setImmediate(() => {
      if (this.pending !== pending) return;
      const finalOutcome = pending.deferredOutcome;
      const settled = this.settlePending();
      if (settled === null) return;
      if (finalOutcome !== null) settled.resolve(finalOutcome);
      else settled.reject(new Error('claude turn ended without a result'));
    });
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
        // and proves lifecycle capability only; it is never a settlement gate.
        // The turn settles on the `result` envelope (see the `result` case).
        const newlySupported = this.lifecycleSupported === null;
        if (newlySupported) this.lifecycleSupported = true;
        this.resolveWriteWaiter(pending, line.commandUuid);
        if (newlySupported && this.pending === pending) {
          this.flushCapabilityWaiters(pending);
        }
        break;
      }
      case 'result': {
        if (this.pending === null) {
          // A late result (e.g. a steered command draining in a later stdout
          // flush after the turn already settled) has no turn to settle. Log
          // it so the drop is diagnosable rather than silent.
          this.options.log?.(
            'warn',
            'claude result envelope arrived with no pending turn; ignored',
          );
          break;
        }
        this.pending.aggregator.accept(line);
        const outcome = this.pending.aggregator.outcome();
        if (this.pending.steered) {
          this.deferSteeredResult(this.pending, outcome);
          break;
        }
        // The `result` envelope is the terminal event for an unsteered turn:
        // settle on it. The runtime converts an error outcome into a failed
        // turn, so resolving here honors the send→return contract without
        // depending on lifecycle envelopes the resident CLI may emit in a
        // shape we do not parse.
        const pending = this.settlePending();
        if (pending === null) break;
        if (outcome !== null) pending.resolve(outcome);
        else pending.reject(new Error('claude turn ended without a result'));
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
