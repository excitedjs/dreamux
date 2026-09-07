/** Resident Claude input admission, request settlement and native stream handling. */
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
import { completionFromTurnOutcome } from './runtime-session.js';
import type { ParsedLine, TurnSubmitOptions } from './types.js';
import type {
  RuntimeAdmission,
  RuntimeSubmission,
  RuntimeSubmissionSettlement,
} from '@excitedjs/dreamux-types';

interface PendingRequest {
  submission: RuntimeSubmission;
  settle: (settlement: RuntimeSubmissionSettlement) => void;
  /** Null after native write acknowledgement or positive protocol evidence. */
  admit: ((admission: RuntimeAdmission) => void) | null;
  /** Non-null only while waiting for concurrent-input capability before writing. */
  write: (() => void) | null;
}

export interface ClaudeCodeStreamRpcOptions {
  sessionId: string | null;
  outputSchemaEnabled?: boolean;
  turnTimeoutMs: number;
  log?: (level: 'info' | 'warn' | 'error', msg: string, err?: unknown) => void;
  reapOnTimeout: (error: Error) => void;
  onRemoteControlUrl?: (url: string) => void;
  onProtocolEvent?: import('./types.js').ClaudeCodeSessionSpec['onProtocolEvent'];
}

/**
 * One resident transport, one association from UUID to unanswered request.
 * Native results consume requests directly; no aggregate execution window waits
 * for terminal lifecycle frames. The consumed set also includes native internal
 * commands so cancellation is scoped to work that actually entered a turn.
 */
export class ClaudeCodeStreamRpc {
  private readonly lineBuf = new LineBuffer();
  private readonly aggregator = new TurnAggregator();
  private readonly requests = new Map<string, PendingRequest>();
  private readonly consumed = new Set<string>();
  private lifecycleSupported: boolean | null = null;
  private timer: NodeJS.Timeout | null = null;
  private closed = false;
  private remoteControlRequestId: string | null = null;

  constructor(
    private readonly stdin: Writable,
    private readonly options: ClaudeCodeStreamRpcOptions,
  ) {}

  submit(
    prompt: string,
    options: TurnSubmitOptions = {},
    commandUuid: string = randomUUID(),
  ): Promise<RuntimeAdmission> {
    if (this.closed || !this.stdin.writable) {
      return Promise.resolve({ status: 'failed', error: new Error('claude resident child is not running') });
    }
    const concurrent = this.requests.size > 0;
    if (concurrent && this.lifecycleSupported === false) {
      return Promise.resolve({ status: 'failed', error: lifecycleUnsupportedError() });
    }
    let settle!: PendingRequest['settle'];
    const submission = Object.freeze({
      settled: new Promise<RuntimeSubmissionSettlement>((resolve) => { settle = resolve; }),
    });
    return new Promise<RuntimeAdmission>((admit) => {
      const request: PendingRequest = {
        submission,
        settle,
        admit,
        write: () => {
          request.write = null;
          this.armIdleTimer();
          try {
            this.stdin.write(`${buildUserMessage(prompt, options, commandUuid)}\n`, (error) => {
              if (error != null) this.failWrite(commandUuid, request, error);
              else this.acceptRequest(request);
            });
          } catch (error) {
            this.failWrite(commandUuid, request, asError(error));
          }
        },
      };
      // Registration precedes writing: a transport may synchronously acknowledge
      // or answer this message before write() returns or invokes its callback.
      this.requests.set(commandUuid, request);
      if (this.lifecycleSupported === true) {
        // Reentrant input must not overtake older requests waiting on init.
        for (const pending of this.requests.values()) pending.write?.();
      } else if (!concurrent) request.write!();
    });
  }

  private acceptRequest(request: PendingRequest): void {
    request.admit?.({ status: 'submitted', submission: request.submission });
    request.admit = null;
  }

  private failWrite(uuid: string, request: PendingRequest, error: Error): void {
    if (this.requests.get(uuid) !== request || request.admit === null) return;
    this.requests.delete(uuid);
    this.consumed.delete(uuid);
    request.admit({ status: 'ambiguous', error });
    request.admit = null;
    request.settle({ kind: 'failed', error });
    this.clearIdleIfEmpty();
  }

  onStdoutChunk(chunk: string): void {
    if (this.closed) return;
    for (const line of this.lineBuf.push(chunk)) {
      if (this.closed) break;
      this.onLine(parseLine(line));
    }
  }

  /** Actual transport loss fails each outstanding request, without a completion. */
  fail(error: Error): void {
    this.close({ kind: 'failed', error });
  }

  /** Explicit teardown stops requests and converges unconfirmed admissions. */
  stop(): void {
    this.close({ kind: 'stopped' });
  }

  private close(settlement: Exclude<RuntimeSubmissionSettlement, { kind: 'completion' }>): void {
    this.closed = true;
    const error = settlement.kind === 'failed'
      ? settlement.error
      : new Error('claude resident session stopped before write acknowledgement');
    for (const request of this.requests.values()) {
      request.admit?.(request.write === null
        ? { status: 'ambiguous', error }
        : settlement.kind === 'stopped' ? { status: 'stopped' } : { status: 'failed', error });
      request.admit = null;
      request.settle(settlement);
    }
    this.requests.clear();
    this.consumed.clear();
    this.aggregator.discard();
    this.clearIdleIfEmpty();
  }

  enableRemoteControl(): void {
    if (this.closed || !this.stdin.writable) return;
    this.remoteControlRequestId = randomUUID();
    this.stdin.write(`${buildRemoteControlEnable(this.remoteControlRequestId)}\n`);
  }

  private clearIdleIfEmpty(): void {
    if (this.requests.size === 0 && this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  /** Outstanding work has a max-idle deadline; pure background work has none. */
  private armIdleTimer(): void {
    if (this.requests.size === 0) return;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      const error = new Error(
        `claude resident requests stalled: no stream activity for ${this.options.turnTimeoutMs}ms`,
      );
      this.options.log?.('error', `${error.message}; reaping resident child`);
      this.fail(error);
      this.options.reapOnTimeout(error);
    }, this.options.turnTimeoutMs);
  }

  private onLine(line: ParsedLine): void {
    this.armIdleTimer();
    switch (line.kind) {
      case 'init':
        this.aggregator.accept(line);
        this.decideLifecycleSupport(line.capabilities.includes('msg_lifecycle_v1'));
        break;
      case 'assistant':
        this.aggregator.accept(line);
        this.options.onProtocolEvent?.({ kind: 'stream', line });
        break;
      case 'user':
      case 'compact_boundary':
        this.options.onProtocolEvent?.({ kind: 'stream', line });
        break;
      case 'command_lifecycle': {
        const { commandUuid, state } = line;
        if (commandUuid === null || state === null) break;
        if (state === 'started') this.consumed.add(commandUuid);
        const request = this.requests.get(commandUuid);
        if (request?.write === null) {
          this.acceptRequest(request);
          // Consumed commands can report cancelled before their failure result.
          // Keep the result's members; lifecycle alone cannot supply its outcome.
          if (state === 'discarded' || state === 'refused' ||
              (state === 'cancelled' && !this.consumed.has(commandUuid))) {
            this.requests.delete(commandUuid);
            request.settle({ kind: 'failed', error: new Error(`claude command was ${state}`) });
            this.clearIdleIfEmpty();
          }
        }
        // An unconsumed command's cancellation cannot discard generating text.
        if (state === 'cancelled' && this.consumed.has(commandUuid)) this.aggregator.discard();
        this.options.onProtocolEvent?.({ kind: 'command_lifecycle', commandUuid, state });
        this.decideLifecycleSupport(true);
        break;
      }
      case 'result': {
        this.aggregator.accept(line);
        const outcome = this.aggregator.takeOutcome()!;
        const commandUuids = new Set(this.consumed);
        this.consumed.clear();
        const uuid = line.outcome.userMessageUuid;
        if (uuid !== null) commandUuids.add(uuid);
        if (this.lifecycleSupported !== true && uuid === null) {
          for (const [id, request] of this.requests) {
            if (request.write === null) commandUuids.add(id);
          }
        }
        const answered: PendingRequest[] = [];
        const submittedUuids: string[] = [];
        for (const id of commandUuids) {
          const request = this.requests.get(id);
          if (request === undefined || request.write !== null) continue;
          this.requests.delete(id);
          answered.push(request);
          submittedUuids.push(id);
        }
        this.clearIdleIfEmpty();
        const completion = answered.length === 0 ? null : completionFromTurnOutcome(
          outcome, this.options.sessionId, this.options.outputSchemaEnabled === true,
        );
        // Remove the answered requests before callbacks can admit or stop work.
        // Native end is still delivered before these submissions settle.
        this.options.onProtocolEvent?.({ kind: 'result', outcome, commandUuids: submittedUuids });
        for (const request of answered) {
          this.acceptRequest(request);
          request.settle({ kind: 'completion', completion: completion! });
        }
        if (this.lifecycleSupported !== true) this.rejectWaitingRequests();
        break;
      }
      case 'control_request':
        this.onControlRequest(line.requestId, line.subtype, line.request);
        break;
      case 'control_response':
        this.onControlResponse(line.requestId, line.ok, line.response, line.error);
        break;
      case 'parse_error':
        this.options.log?.('warn', `claude stream-json parse error: ${line.raw}`);
        break;
      default:
        break;
    }
  }

  private decideLifecycleSupport(supported: boolean): void {
    if (this.lifecycleSupported === true) return;
    if (!supported && this.lifecycleSupported !== null) return;
    this.lifecycleSupported = supported;
    if (!supported) {
      this.rejectWaitingRequests();
      return;
    }
    for (const request of this.requests.values()) request.write?.();
  }

  private rejectWaitingRequests(): void {
    const error = this.lifecycleSupported === false ? lifecycleUnsupportedError()
      : new Error('claude result arrived before concurrent-input capability was decided');
    for (const [uuid, request] of this.requests) {
      if (request.write === null) continue;
      this.requests.delete(uuid);
      request.admit?.({ status: 'failed', error });
      request.admit = null;
      request.settle({ kind: 'failed', error });
    }
    this.clearIdleIfEmpty();
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
  return new Error('claude resident session cannot attribute concurrent inputs: msg_lifecycle_v1 is unavailable');
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
