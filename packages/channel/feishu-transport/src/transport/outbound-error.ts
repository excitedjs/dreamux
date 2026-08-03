const OUTBOUND_ERROR_MESSAGE_MAX = 512
const OUTBOUND_ERROR_LOG_ID_MAX = 256

export interface FeishuOutboundErrorDetails {
  code?: number
  message: string
  logId?: string
}

/**
 * Public-safe failure from a Feishu outbound SDK request.
 *
 * The transport deliberately retains no SDK/Axios error, cause, response,
 * request config, body, headers, or credentials. Downstream packages may make
 * decisions only from these bounded upstream fields.
 */
export class FeishuOutboundError extends Error {
  readonly code?: number
  readonly logId?: string

  constructor(details: FeishuOutboundErrorDetails) {
    super(boundedText(details.message, OUTBOUND_ERROR_MESSAGE_MAX))
    this.name = 'FeishuOutboundError'
    const code = boundedCode(details.code)
    if (code !== undefined) this.code = code
    if (details.logId !== undefined) {
      this.logId = boundedText(details.logId, OUTBOUND_ERROR_LOG_ID_MAX)
    }
  }
}

export function isFeishuOutboundError(
  error: unknown,
): error is FeishuOutboundError {
  return error instanceof FeishuOutboundError
}

/** Transport-internal SDK boundary. Never attach the caught value to the result. */
export async function runFeishuOutboundRequest<T>(
  operation: () => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  try {
    return await operation()
  } catch (error) {
    if (signal?.aborted === true && error === signal.reason) throw error
    if (isFeishuOutboundError(error)) throw error
    throw safeOutboundError(error)
  }
}

function safeOutboundError(error: unknown): FeishuOutboundError {
  const candidates = errorCandidates(error)
  const code = firstCode(candidates)
  const message = firstText(candidates, ['msg', 'message']) ??
    (code !== undefined && error instanceof Error ? error.message : undefined) ??
    'Feishu outbound request failed'
  const logId = firstLogId(candidates)
  return new FeishuOutboundError({
    message,
    ...(code !== undefined ? { code } : {}),
    ...(logId !== undefined ? { logId } : {}),
  })
}

function errorCandidates(error: unknown): Record<string, unknown>[] {
  const root = asRecord(error)
  if (root === undefined) return []
  const response = asRecord(root['response'])
  const responseData = asRecord(response?.['data'])
  const data = asRecord(root['data'])
  return [responseData, data, root].filter(
    (value): value is Record<string, unknown> => value !== undefined,
  )
}

function firstCode(candidates: Record<string, unknown>[]): number | undefined {
  for (const candidate of candidates) {
    const code = boundedCode(candidate['code'])
    if (code !== undefined) return code
  }
  return undefined
}

function boundedCode(value: unknown): number | undefined {
  const number = typeof value === 'string' && /^\d+$/.test(value)
    ? Number(value)
    : value
  return typeof number === 'number' &&
      Number.isSafeInteger(number) &&
      number >= 0
    ? number
    : undefined
}

function firstLogId(
  candidates: Record<string, unknown>[],
): string | undefined {
  for (const candidate of candidates) {
    const nested = asRecord(candidate['error'])
    const value = firstText(
      nested === undefined ? [candidate] : [candidate, nested],
      ['log_id', 'logId'],
    )
    if (value !== undefined) return value
  }
  return undefined
}

function firstText(
  candidates: Record<string, unknown>[],
  keys: readonly string[],
): string | undefined {
  for (const candidate of candidates) {
    for (const key of keys) {
      const value = candidate[key]
      if (typeof value === 'string' && value !== '') return value
    }
  }
  return undefined
}

function boundedText(value: string, max: number): string {
  return value.replace(/[\u0000-\u001f\u007f]+/g, ' ').slice(0, max)
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}
