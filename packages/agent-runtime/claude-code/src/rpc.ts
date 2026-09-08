/** Resident Claude input admission, request settlement and native stream handling. */
import type { Writable } from 'node:stream';
import { randomUUID } from 'node:crypto';

import {
  buildUserMessage,
  LineBuffer,
  parseLine,
  TurnAggregator,
} from './stream.js';
import { ClaudeCodeControlRpc } from './control-rpc.js';
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
/**
 * The two `terminal_reason` values that mean the turn was aborted rather than
 * answered, from the Agent SDK's documented set. The other reasons all name a
 * failure or a limit, so this is the whole of what an interrupt looks like on
 * the wire. Under this dispatcher's unattended posture the only cause is our
 * own `interrupt` control request: the other documented cause, a permission
 * callback denying with `interrupt`, cannot happen where every callback allows.
 */
const INTERRUPT_TERMINAL_REASONS = new Set(['aborted_streaming', 'aborted_tools']);

export class ClaudeCodeStreamRpc {
  private readonly lineBuf = new LineBuffer();
  private readonly aggregator = new TurnAggregator();
  private readonly requests = new Map<string, PendingRequest>();
  private readonly consumed = new Set<string>();
  private lifecycleSupported: boolean | null = null;
  private timer: NodeJS.Timeout | null = null;
  private closed = false;
  private readonly control: ClaudeCodeControlRpc;
  /**
   * An interrupt this session asked for has not been answered yet.
   *
   * It is the session's fact, not a request's: claude interrupts whatever it is
   * doing, and the artifact it leaves behind names the command it was in the
   * middle of. This only decides who is still waiting for an answer — what
   * ended the work is read from the result itself.
   */
  private interruptRequested = false;

  constructor(
    private readonly stdin: Writable,
    private readonly options: ClaudeCodeStreamRpcOptions,
  ) {
    this.control = new ClaudeCodeControlRpc(stdin, options);
  }

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
    // The session ended before claude answered the ask, so the ask is answered
    // here instead: teardown interrupted the work, a transport loss did not.
    if (this.interruptRequested) {
      this.interruptRequested = false;
      this.control.settleInterrupt(
        settlement.kind === 'failed' ? settlement.error : undefined,
        settlement.kind === 'stopped',
      );
    }
  }

  /**
   * Ask claude to interrupt whatever it is doing.
   *
   * Answers false when no request is outstanding: there is then nothing this
   * session was asked to do, and `/stop` says so rather than interrupting the
   * agent's own background work.
   */
  async interrupt(reason: string): Promise<boolean> {
    if (this.closed || this.requests.size === 0) return false;
    this.interruptRequested = true;
    try {
      return await this.control.requestInterrupt(reason);
    } catch (error) {
      this.interruptRequested = false;
      throw error;
    }
  }

  enableRemoteControl(): void {
    if (this.closed || !this.stdin.writable) return;
    this.control.enableRemoteControl();
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
        // What ended this turn is the turn's own fact. An aborted turn reports
        // one of the two `terminal_reason` values the Agent SDK documents for
        // it, distinct from every failure reason, so an interrupt is read here
        // rather than inferred from whether we happened to ask for one. The
        // artifact answers the requests it names, but with nothing said rather
        // than a completion, so they settle `stopped`.
        const interrupted = INTERRUPT_TERMINAL_REASONS.has(
          line.outcome.terminalReason ?? '',
        );
        // Our own ask is answered by the first result after it, whatever that
        // result turned out to be. The receipt normally comes back on the
        // control channel first; this covers a session that never answers it.
        if (this.interruptRequested) {
          this.interruptRequested = false;
          this.control.settleInterrupt(undefined, interrupted);
        }
        const completion = interrupted || answered.length === 0 ? null : completionFromTurnOutcome(
          outcome, this.options.sessionId, this.options.outputSchemaEnabled === true,
        );
        // Remove the answered requests before callbacks can admit or stop work.
        // Native end is still delivered before these submissions settle.
        this.options.onProtocolEvent?.(interrupted
          ? { kind: 'interrupted' }
          : { kind: 'result', outcome, commandUuids: submittedUuids });
        for (const request of answered) {
          this.acceptRequest(request);
          request.settle(interrupted ? { kind: 'stopped' } : { kind: 'completion', completion: completion! });
        }
        if (this.lifecycleSupported !== true) this.rejectWaitingRequests();
        break;
      }
      case 'control_request':
        this.control.onControlRequest(line.requestId, line.subtype, line.request);
        break;
      case 'control_response':
        this.control.onControlResponse(line.requestId, line.ok, line.response, line.error);
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
}

function lifecycleUnsupportedError(): Error {
  return new Error('claude resident session cannot attribute concurrent inputs: msg_lifecycle_v1 is unavailable');
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
