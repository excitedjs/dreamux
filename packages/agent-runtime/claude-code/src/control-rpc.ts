/** Claude Code stream-json control requests and their one pending reply. */
import { randomUUID } from 'node:crypto';
import type { Writable } from 'node:stream';

import {
  buildCanUseToolAllow,
  buildControlAck,
  buildInterruptRequest,
  buildRemoteControlEnable,
} from './stream.js';

interface PendingInterrupt {
  requestId: string;
  promise: Promise<boolean>;
  resolve: (accepted: boolean) => void;
  reject: (error: Error) => void;
}

export class ClaudeCodeControlRpc {
  private remoteControlRequestId: string | null = null;
  private pendingInterrupt: PendingInterrupt | null = null;

  constructor(
    private readonly stdin: Writable,
    private readonly options: {
      log?: (level: 'info' | 'warn' | 'error', msg: string, err?: unknown) => void;
      onRemoteControlUrl?: (url: string) => void;
    },
  ) {}

  /**
   * Ask claude to interrupt whatever it is doing, and answer when it replies.
   *
   * Which turn this belongs to is the caller's fact, not this class's: this
   * only correlates one control request with its `control_response`. A second
   * ask while one is outstanding joins it rather than sending a second request.
   */
  requestInterrupt(reason: string): Promise<boolean> {
    if (this.pendingInterrupt !== null) return this.pendingInterrupt.promise;
    const requestId = randomUUID();
    let resolve!: (accepted: boolean) => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<boolean>((resolvePromise, rejectPromise) => {
      resolve = resolvePromise;
      reject = rejectPromise;
    });
    const pending: PendingInterrupt = { requestId, promise, resolve, reject };
    this.pendingInterrupt = pending;
    this.stdin.write(`${buildInterruptRequest(requestId, reason)}\n`, (error) => {
      if (error != null && this.pendingInterrupt === pending) {
        this.pendingInterrupt = null;
        reject(error);
      }
    });
    return promise;
  }

  /**
   * Answer an outstanding interrupt from the turn's own ending instead.
   *
   * The turn can reach its terminal before claude answers the control request;
   * the caller, which owns the turn, decides that has happened and says how it
   * ended. A no-op when nothing is outstanding, because the ordinary path is
   * the `control_response` below.
   */
  settleInterrupt(failure?: Error, interrupted = false): void {
    const pending = this.pendingInterrupt;
    if (pending === null) return;
    this.pendingInterrupt = null;
    if (failure !== undefined) pending.reject(failure);
    else pending.resolve(interrupted);
  }

  enableRemoteControl(): void {
    if (!this.stdin.writable) return;
    this.remoteControlRequestId = randomUUID();
    this.stdin.write(`${buildRemoteControlEnable(this.remoteControlRequestId)}\n`);
  }

  onControlRequest(
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

  onControlResponse(
    requestId: string | null,
    ok: boolean,
    response: Record<string, unknown> | null,
    error: string | null,
  ): void {
    if (requestId === null) return;
    const interrupt = this.pendingInterrupt;
    if (interrupt !== null && requestId === interrupt.requestId) {
      this.pendingInterrupt = null;
      if (ok) interrupt.resolve(true);
      else interrupt.reject(new Error(error ?? 'claude interrupt request failed'));
      return;
    }
    if (requestId !== this.remoteControlRequestId) return;
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
