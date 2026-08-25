import type * as lark from '@larksuiteoapi/node-sdk'

/**
 * Feishu COT (chain-of-thought) message HTTP operations.
 *
 * This module is a thin, stateless wrapper over the three official endpoints,
 * their request envelope, and their response validation. It knows nothing about
 * Teams, channel origins, reply/react, presentation lifecycle, or AG-UI
 * semantics — the caller hands over an event type plus an already-built content
 * object and this module owns turning that into the official wire event.
 *
 * The wire event is built in exactly one private place, so a caller can never
 * mistake the inner AG-UI *content object* for the outer
 * `{event_type, content, timestamp}` envelope Feishu actually accepts.
 */

/** Per the official contract, one append carries 1..50 COT events. */
export const FEISHU_COT_APPEND_MAX_EVENTS = 50
const FEISHU_COT_APPEND_MIN_EVENTS = 1

/** Terminal reasons the complete endpoint accepts. */
export type FeishuCotCompleteReason = 'done' | 'error' | 'timeout'

type CotOperation = 'create' | 'append' | 'complete'

/**
 * A COT call the platform rejected, carrying Feishu's own business `code` so a
 * caller can log a precise error *category* without ever logging a free-form
 * message, which could echo a host path or payload. `code` is `null` when the
 * call succeeded at the HTTP level but the response was unusable.
 */
export class FeishuCotApiError extends Error {
  constructor(
    readonly code: number | null,
    message: string,
  ) {
    super(message)
    this.name = 'FeishuCotApiError'
  }
}

/**
 * One COT event as the caller supplies it: the official `event_type` plus the
 * structured content object for that type. Serialization and timestamping are
 * this module's job, never the caller's.
 */
export interface FeishuCotEventInput {
  readonly eventType: string
  readonly content: Record<string, unknown>
}

/**
 * The exact per-event object Feishu accepts inside the append `events` array.
 * Module-private: it is the shape of one field of one request body, never a
 * value that crosses the package boundary, so nothing outside names it.
 */
interface FeishuCotWireEvent {
  readonly event_type: string
  /** JSON-serialized {@link FeishuCotEventInput.content}. */
  readonly content: string
  /** Millisecond timestamp. */
  readonly timestamp: number
}

export interface FeishuCotCreateInput {
  /** The chat the COT is created in (`receive_id_type=chat_id`). */
  chatId: string
  /** Source message the COT is anchored to. */
  originMessageId?: string
  /** Let Feishu place the COT in the source message's thread. */
  replyInThread?: boolean
  /** Official display switches; all default to `false`. */
  cotHidden?: boolean
  enableBadge?: boolean
  updateFeedRank?: boolean
}

export interface FeishuCotCreateResult {
  cotId: string
  messageId: string
}

export interface FeishuCotAppendInput {
  /** `cot_id` from the create response. */
  cotId: string
  /** `message_id` from the create response; the append endpoint requires it. */
  messageId: string
  /** 1..50 events for this batch, wrapped and serialized by this module. */
  events: readonly FeishuCotEventInput[]
}

export interface FeishuCotCompleteInput {
  /** `cot_id` from the create response; it is a path segment. */
  cotId: string
  /** `message_id` from the create response; the endpoint requires it. */
  messageId: string
  reason: FeishuCotCompleteReason
}

/**
 * The COT capability surface. Optional on a transport/bot so an older or
 * externally supplied implementation simply has no COT and callers degrade to
 * no presentation rather than failing.
 */
export interface FeishuCotClient {
  createCot(input: FeishuCotCreateInput): Promise<FeishuCotCreateResult>
  appendCot(input: FeishuCotAppendInput): Promise<void>
  completeCot(input: FeishuCotCompleteInput): Promise<void>
}

export interface FeishuCotClientOptions {
  /** Millisecond clock for event timestamps. Injectable for deterministic tests. */
  now?: () => number
}

/** The single place the official append envelope is constructed. */
function toWireEvent(
  event: FeishuCotEventInput,
  now: () => number,
): FeishuCotWireEvent {
  return {
    event_type: event.eventType,
    content: JSON.stringify(event.content),
    timestamp: now(),
  }
}

interface FeishuApiEnvelope {
  code?: number
  msg?: string
}

interface FeishuCotCreateResponse extends FeishuApiEnvelope {
  data?: { cot_id?: string; message_id?: string }
}

type FeishuRequestClient = Pick<lark.Client, 'request'>

export function createFeishuCotClient(
  client: FeishuRequestClient,
  options: FeishuCotClientOptions = {},
): FeishuCotClient {
  const now = options.now ?? Date.now
  return {
    async createCot(input: FeishuCotCreateInput): Promise<FeishuCotCreateResult> {
      if (input.chatId === '') {
        throw new Error('Feishu COT create requires a non-empty chat id')
      }
      const response = await client.request<FeishuCotCreateResponse>({
        method: 'POST',
        url: '/open-apis/im/v1/message_cot',
        params: { receive_id_type: 'chat_id' },
        data: {
          receive_id: input.chatId,
          ...(input.originMessageId !== undefined && input.originMessageId !== ''
            ? { origin_message_id: input.originMessageId }
            : {}),
          ...(typeof input.replyInThread === 'boolean'
            ? { reply_in_thread: input.replyInThread }
            : {}),
          cot_hidden: input.cotHidden ?? false,
          enable_badge: input.enableBadge ?? false,
          update_feed_rank: input.updateFeedRank ?? false,
        },
      })
      assertApiOk(response, 'create')
      const cotId = response?.data?.cot_id
      const messageId = response?.data?.message_id
      if (typeof cotId !== 'string' || cotId === '') {
        throw new FeishuCotApiError(null, 'Feishu COT create returned no cot_id')
      }
      if (typeof messageId !== 'string' || messageId === '') {
        throw new FeishuCotApiError(
          null,
          'Feishu COT create returned no message_id',
        )
      }
      return { cotId, messageId }
    },

    async appendCot(input: FeishuCotAppendInput): Promise<void> {
      if (input.cotId === '' || input.messageId === '') {
        throw new Error(
          'Feishu COT append requires the cot id and message id from create',
        )
      }
      if (
        input.events.length < FEISHU_COT_APPEND_MIN_EVENTS ||
        input.events.length > FEISHU_COT_APPEND_MAX_EVENTS
      ) {
        throw new Error(
          `Feishu COT append takes ${FEISHU_COT_APPEND_MIN_EVENTS}-${FEISHU_COT_APPEND_MAX_EVENTS} events, got ${input.events.length}`,
        )
      }
      const response = await client.request<FeishuApiEnvelope>({
        method: 'PUT',
        url: '/open-apis/im/v1/message_cot',
        data: {
          events: input.events.map((event) => toWireEvent(event, now)),
          message_id: input.messageId,
          cot_id: input.cotId,
        },
      })
      assertApiOk(response, 'append')
    },

    async completeCot(input: FeishuCotCompleteInput): Promise<void> {
      if (input.cotId === '' || input.messageId === '') {
        throw new Error(
          'Feishu COT complete requires the cot id and message id from create',
        )
      }
      const response = await client.request<FeishuApiEnvelope>({
        method: 'POST',
        url: `/open-apis/im/v1/message_cot/complete/${encodeURIComponent(input.cotId)}`,
        params: { message_id: input.messageId, reason: input.reason },
      })
      assertApiOk(response, 'complete')
    },
  }
}

/**
 * Feishu answers 2xx with a business `code`; a non-zero one is a failure the
 * SDK does not throw for. Only the platform's own code/msg is surfaced, never
 * request data, so a COT diagnostic can never carry credentials or content.
 */
function assertApiOk(
  response: FeishuApiEnvelope | undefined,
  operation: CotOperation,
): void {
  const code = response?.code
  if (typeof code === 'number' && code !== 0) {
    const msg = response?.msg
    throw new FeishuCotApiError(
      code,
      `Feishu COT ${operation} failed with code ${code}${
        typeof msg === 'string' && msg !== '' ? `: ${msg}` : ''
      }`,
    )
  }
}
