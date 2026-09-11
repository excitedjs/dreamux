import type * as lark from '@larksuiteoapi/node-sdk'

import type { OutboundTarget } from '../contract/outbound.js'

/** The message types this transport sends: native rich text, and raw cards. */
export type FeishuMessageType = 'post' | 'interactive'

export interface MessageSendResponse {
  code?: number
  msg?: string
  data?: { message_id?: string }
  error?: { log_id?: string }
}

/**
 * Send one already-serialized message body.
 *
 * Create versus reply is the only addressing distinction the platform makes
 * here, so it is the only branch: an AbortSignal rides along with either.
 *
 * A rejection carrying a Feishu response envelope, and a resolved body with a
 * nonzero business code, are both failed sends. Both are rethrown as one
 * description naming the operation and the platform's own status / code /
 * reason / log id, because everything above this boundary — channel logs,
 * MCP results, Core's failure text — projects an error to its message alone.
 * Errors without such an envelope (cancellation, network) keep their identity.
 */
export async function sendFeishuMessage(
  client: lark.Client,
  target: OutboundTarget,
  msgType: FeishuMessageType,
  content: string,
  signal?: AbortSignal,
): Promise<MessageSendResponse> {
  const replyTo = target.replyToMessageId
  const operation = replyTo === undefined ? 'message.create' : 'message.reply'
  const payload = replyTo === undefined
    ? {
      url: '/open-apis/im/v1/messages',
      method: 'POST' as const,
      params: { receive_id_type: 'chat_id' },
      data: { receive_id: target.chatId, msg_type: msgType, content },
    }
    : {
      url: `/open-apis/im/v1/messages/${encodeURIComponent(replyTo)}/reply`,
      method: 'POST' as const,
      data: { msg_type: msgType, content },
    }

  let res: MessageSendResponse
  try {
    res = await client.request<MessageSendResponse>({
      ...payload,
      ...(signal !== undefined ? { signal } : {}),
    })
  } catch (err) {
    const response = feishuErrorResponse(err)
    if (response === undefined) throw err
    throw new Error(
      describeSendFailure(operation, response.status, response.body),
      { cause: err },
    )
  }
  if (typeof res.code === 'number' && res.code !== 0) {
    throw new Error(describeSendFailure(operation, undefined, res))
  }
  return res
}

interface FeishuErrorResponse {
  status: number | undefined
  body: MessageSendResponse
}

/**
 * The SDK rethrows the underlying HTTP rejection unchanged, so a platform
 * refusal arrives as an error carrying `response.status` and the Feishu body.
 *
 * The business `code` is what identifies that body as Feishu's own answer. A
 * rejection carrying something else under `response` — a gateway's HTML error
 * page, a library that names its own field that way — is not a refusal this
 * boundary can describe, and keeps the message its author wrote.
 */
function feishuErrorResponse(err: unknown): FeishuErrorResponse | undefined {
  const response = asRecord(asRecord(err)?.response)
  if (response === undefined) return undefined
  const body = asRecord(response.data)
  if (body === undefined || typeof body.code !== 'number') return undefined
  const status = typeof response.status === 'number' ? response.status : undefined
  return { status, body: body as MessageSendResponse }
}

function describeSendFailure(
  operation: string,
  status: number | undefined,
  body: MessageSendResponse,
): string {
  const logId = asRecord(body.error)?.['log_id']
  const facts = [
    status === undefined ? undefined : `HTTP ${status}`,
    typeof body.code === 'number' ? `code ${body.code}` : undefined,
    typeof logId === 'string' && logId !== '' ? `log_id=${logId}` : undefined,
  ].filter((fact): fact is string => fact !== undefined)
  const detail = facts.length === 0 ? '' : ` (${facts.join(', ')})`
  const reason = typeof body.msg === 'string' && body.msg !== ''
    ? `: ${body.msg}`
    : ''
  return `Feishu ${operation} failed${detail}${reason}`
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}
