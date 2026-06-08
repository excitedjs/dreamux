/**
 * Claude Code stream-json turn RPC.
 *
 * The supervisor owns the child process. This class owns one in-flight turn,
 * stdout line demux, turn aggregation, and defensive control-request replies.
 */

import type { Writable } from 'node:stream';

import {
  buildCanUseToolAllow,
  buildControlAck,
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
}

export interface ClaudeCodeStreamRpcOptions {
  turnTimeoutMs: number;
  log?: (level: 'info' | 'warn' | 'error', msg: string, err?: unknown) => void;
  reapOnTimeout: () => void;
}

export class ClaudeCodeStreamRpc {
  private readonly lineBuf = new LineBuffer();
  private pending: PendingTurn | null = null;

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
      };
      // Per-turn deadline: a still-alive child that never emits a terminal
      // `result` must not pend forever. The supervisor reaps the child, so the
      // next turn re-spawns a clean session.
      pending.timer = setTimeout(() => {
        if (this.pending !== pending) return;
        this.pending = null;
        this.options.log?.(
          'error',
          `claude turn timed out after ${this.options.turnTimeoutMs}ms; reaping resident child`,
        );
        reject(
          new Error(
            `claude resident turn timed out after ${this.options.turnTimeoutMs}ms without a result`,
          ),
        );
        this.options.reapOnTimeout();
      }, this.options.turnTimeoutMs);
      this.pending = pending;
      this.stdin.write(`${buildUserMessage(prompt, options)}\n`, (err) => {
        if (err != null && this.pending === pending) {
          this.settlePending()?.reject(
            err instanceof Error ? err : new Error(String(err)),
          );
        }
      });
    });
  }

  onStdoutChunk(chunk: string): void {
    for (const line of this.lineBuf.push(chunk)) this.onLine(parseLine(line));
  }

  failPending(err: Error): void {
    this.settlePending()?.reject(err);
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
        this.options.log?.(
          'warn',
          `claude stream-json parse error: ${line.raw}`,
        );
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
}
