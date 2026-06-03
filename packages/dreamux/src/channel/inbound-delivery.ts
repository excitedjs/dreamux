import type { InboundOutboundSource } from './outbound.js';

export const DEFAULT_CHANNEL_JITTER_MS = 1000;
export const DEFAULT_CHANNEL_RATE_LIMIT_WINDOW_MS = 10_000;
export const DEFAULT_CHANNEL_RATE_LIMIT_MAX_MESSAGES = 10;
export const DEFAULT_CHANNEL_MESSAGE_ID_DEDUPE_WINDOW = 1024;

export interface ChannelInboundDeliveryInput extends InboundOutboundSource {
  parsed_text: string;
}

export interface ChannelInboundDeliveryBufferOptions {
  /** Human-readable delivery thread id; for dreamux this is the dispatcher id. */
  deliveryThreadId: string;
  deliver(batch: ChannelInboundDeliveryInput[]): Promise<void>;
  jitterMs?: number;
  rateLimitWindowMs?: number;
  rateLimitMaxMessages?: number;
  messageIdDedupeWindow?: number;
  now?: () => number;
  log?: (level: 'info' | 'warn' | 'error', msg: string, err?: unknown) => void;
}

export interface ChannelInboundDeliveryAcceptResult {
  accepted: boolean;
  reason?: string;
}

/**
 * Channel-side ingress buffer for one Codex delivery thread.
 *
 * It bounds what reaches the dispatcher runtime by applying process-local
 * message_id dedupe, a sliding-window ingress rate limit, and a short jitter
 * window that batches bursty chat messages before delivery.
 */
export class ChannelInboundDeliveryBuffer {
  private readonly pending: ChannelInboundDeliveryInput[] = [];
  private readonly acceptedAtMs: number[] = [];
  private readonly seenMessageIds = new Set<string>();
  private readonly seenMessageIdOrder: string[] = [];
  private readonly jitterMs: number;
  private readonly rateLimitWindowMs: number;
  private readonly rateLimitMaxMessages: number;
  private readonly messageIdDedupeWindow: number;
  private readonly now: () => number;
  private readonly log: NonNullable<ChannelInboundDeliveryBufferOptions['log']>;
  private timer: NodeJS.Timeout | null = null;
  private stopped = false;

  constructor(private readonly opts: ChannelInboundDeliveryBufferOptions) {
    this.jitterMs = Math.max(0, opts.jitterMs ?? DEFAULT_CHANNEL_JITTER_MS);
    this.rateLimitWindowMs = Math.max(
      0,
      opts.rateLimitWindowMs ?? DEFAULT_CHANNEL_RATE_LIMIT_WINDOW_MS,
    );
    this.rateLimitMaxMessages = Math.max(
      0,
      opts.rateLimitMaxMessages ?? DEFAULT_CHANNEL_RATE_LIMIT_MAX_MESSAGES,
    );
    this.messageIdDedupeWindow = Math.max(
      0,
      opts.messageIdDedupeWindow ?? DEFAULT_CHANNEL_MESSAGE_ID_DEDUPE_WINDOW,
    );
    this.now = opts.now ?? (() => Date.now());
    this.log = opts.log ?? ((level, msg, err) => {
      const prefix = `[channel delivery ${opts.deliveryThreadId}] ${level}`;
      if (err !== undefined) console.error(prefix, msg, err);
      else console.error(prefix, msg);
    });
  }

  accept(input: ChannelInboundDeliveryInput): ChannelInboundDeliveryAcceptResult {
    if (this.stopped) {
      return this.reject('delivery thread is stopped', input);
    }
    if (!this.rememberMessageId(input.source_message_id)) {
      return this.reject('duplicate message_id within process window', input);
    }
    if (!this.allowByRateLimit(input)) {
      return { accepted: false, reason: 'rate limit exceeded' };
    }

    this.pending.push(input);
    this.ensureTimer();
    return { accepted: true };
  }

  async flushNow(): Promise<void> {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.pending.length === 0) return;
    const batch = this.pending.splice(0, this.pending.length);
    try {
      await this.opts.deliver(batch);
    } catch (err) {
      this.log(
        'error',
        `failed to deliver ${batch.length} inbound message(s)`,
        err,
      );
    }
  }

  stop(): void {
    this.stopped = true;
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.pending.length > 0) {
      this.log(
        'warn',
        `dropping ${this.pending.length} pending inbound message(s) on stop`,
      );
      this.pending.length = 0;
    }
  }

  private ensureTimer(): void {
    if (this.timer !== null) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flushNow();
    }, this.jitterMs);
  }

  private allowByRateLimit(input: ChannelInboundDeliveryInput): boolean {
    const now = this.now();
    const cutoff = now - this.rateLimitWindowMs;
    while (this.acceptedAtMs.length > 0 && this.acceptedAtMs[0]! <= cutoff) {
      this.acceptedAtMs.shift();
    }
    if (this.acceptedAtMs.length >= this.rateLimitMaxMessages) {
      const messageId = input.source_message_id ?? '<missing>';
      this.log(
        'warn',
        `rejected inbound message ${messageId}: rate limit exceeded for delivery thread ${this.opts.deliveryThreadId} (${this.rateLimitMaxMessages} messages per ${this.rateLimitWindowMs}ms)`,
      );
      return false;
    }
    this.acceptedAtMs.push(now);
    return true;
  }

  private rememberMessageId(messageId: string | null): boolean {
    if (messageId === null || messageId === '') return true;
    if (this.seenMessageIds.has(messageId)) return false;
    this.seenMessageIds.add(messageId);
    this.seenMessageIdOrder.push(messageId);
    while (this.seenMessageIdOrder.length > this.messageIdDedupeWindow) {
      const evicted = this.seenMessageIdOrder.shift();
      if (evicted !== undefined) this.seenMessageIds.delete(evicted);
    }
    return true;
  }

  private reject(
    reason: string,
    input: ChannelInboundDeliveryInput,
  ): ChannelInboundDeliveryAcceptResult {
    const messageId = input.source_message_id ?? '<missing>';
    this.log('warn', `rejected inbound message ${messageId}: ${reason}`);
    return { accepted: false, reason };
  }
}
