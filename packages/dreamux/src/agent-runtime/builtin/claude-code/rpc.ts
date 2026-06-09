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
  settleImmediate: NodeJS.Immediate | null;
  steered: boolean;
  deferredOutcome: TurnOutcome | null;
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
        settleImmediate: null,
        steered: false,
        deferredOutcome: null,
      };
      this.pending = pending;
      // Arm the idle deadline (reset on every inbound stream line in `onLine`).
      this.armIdleTimer(pending);
      this.stdin.write(`${buildUserMessage(prompt, options)}\n`, (err) => {
        if (err != null && this.pending === pending) {
          this.settlePending()?.reject(
            err instanceof Error ? err : new Error(String(err)),
          );
        }
      });
    });
  }

  async steerTurn(
    prompt: string,
    options: TurnSubmitOptions = {},
  ): Promise<void> {
    if (!this.stdin.writable) {
      return Promise.reject(new Error('claude resident child is not running'));
    }
    if (this.pending === null) {
      return Promise.reject(new Error('claude resident session has no active turn'));
    }
    const pending = this.pending;
    pending.steered = true;
    return new Promise<void>((resolve, reject) => {
      this.stdin.write(
        `${buildUserMessage(prompt, { priority: 'now', ...options })}\n`,
        (err) => {
          if (err != null) {
            reject(err instanceof Error ? err : new Error(String(err)));
            return;
          }
          resolve();
        },
      );
    });
  }

  onStdoutChunk(chunk: string): void {
    for (const line of this.lineBuf.push(chunk)) this.onLine(parseLine(line));
  }

  failPending(err: Error): void {
    this.settlePending()?.reject(err);
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
  private settlePending(): PendingTurn | null {
    const pending = this.pending;
    if (pending === null) return null;
    if (pending.timer !== null) clearTimeout(pending.timer);
    if (pending.settleImmediate !== null) clearImmediate(pending.settleImmediate);
    this.pending = null;
    return pending;
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
      this.pending = null;
      this.options.log?.(
        'error',
        `claude turn stalled: no stream activity for ${this.options.turnTimeoutMs}ms; reaping resident child`,
      );
      pending.reject(
        new Error(
          `claude resident turn stalled: no stream activity for ${this.options.turnTimeoutMs}ms`,
        ),
      );
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
      case 'assistant':
        this.pending?.aggregator.accept(line);
        break;
      case 'result': {
        if (this.pending === null) break;
        this.pending.aggregator.accept(line);
        const outcome = this.pending.aggregator.outcome();
        if (this.pending.steered) {
          this.deferSteeredResult(this.pending, outcome);
          break;
        }
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

  private deferSteeredResult(
    pending: PendingTurn,
    outcome: TurnOutcome | null,
  ): void {
    pending.deferredOutcome = outcome;
    if (pending.settleImmediate !== null) return;
    // A stream-json `priority` steer can cause Claude Code to close the
    // interrupted run and immediately drain the queued steer in the same stdout
    // flush. Resolve on the next tick so those follow-up lines are still folded
    // into this one Dreamux logical turn instead of becoming a silent late result.
    pending.settleImmediate = setImmediate(() => {
      if (this.pending !== pending) return;
      const finalOutcome = pending.deferredOutcome;
      const settled = this.settlePending();
      if (settled === null) return;
      if (finalOutcome !== null) settled.resolve(finalOutcome);
      else settled.reject(new Error('claude turn ended without a result'));
    });
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
