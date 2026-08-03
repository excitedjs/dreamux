const OUTBOUND_ERROR_MESSAGE_MAX = 512
const OUTBOUND_ERROR_LOG_ID_MAX = 256

/** Public-safe, bounded fields for structured outbound failure logs. */
export interface FeishuOutboundErrorLogProjection {
  readonly code?: number
  readonly msg?: string
  readonly log_id?: string
}

/**
 * Project a Feishu SDK/Axios failure into a detached logging value.
 *
 * The returned object contains primitives only. It never retains the raw error,
 * response, request config, body, headers, credentials, or cause. Unknown error
 * shapes return `null` so callers can preserve their existing generic logging.
 */
export function projectFeishuOutboundErrorLog(
  error: unknown,
): FeishuOutboundErrorLogProjection | null {
  try {
    return projectOutboundErrorLog(error)
  } catch {
    return null
  }
}

function projectOutboundErrorLog(
  error: unknown,
): FeishuOutboundErrorLogProjection | null {
  const root = asRecord(error)
  if (root === undefined) return null

  const response = asRecord(root['response'])
  const candidates = [
    providerFields(asRecord(response?.['data']), true),
    providerFields(asRecord(root['data']), true),
    providerFields(root, false),
  ].filter((value): value is FeishuOutboundErrorLogProjection => value !== null)

  const code = firstDefined(candidates, 'code')
  const logId = firstDefined(candidates, 'log_id')
  const candidateMessage = firstDefined(candidates, 'msg')
  const fallbackMessage = code !== undefined || logId !== undefined
    ? boundedText(root['message'], OUTBOUND_ERROR_MESSAGE_MAX)
    : undefined
  const msg = candidateMessage ?? fallbackMessage
  if (code === undefined && msg === undefined && logId === undefined) return null

  return Object.freeze({
    ...(code !== undefined ? { code } : {}),
    ...(msg !== undefined ? { msg } : {}),
    ...(logId !== undefined ? { log_id: logId } : {}),
  })
}

function providerFields(
  candidate: Record<string, unknown> | undefined,
  allowMessage: boolean,
): FeishuOutboundErrorLogProjection | null {
  if (candidate === undefined) return null
  const nestedError = asRecord(candidate['error'])
  const code = boundedCode(candidate['code'])
  const msg = boundedText(candidate['msg'], OUTBOUND_ERROR_MESSAGE_MAX) ??
    (allowMessage
      ? boundedText(candidate['message'], OUTBOUND_ERROR_MESSAGE_MAX)
      : undefined)
  const logId = boundedText(
    candidate['log_id'] ?? candidate['logId'] ??
      nestedError?.['log_id'] ?? nestedError?.['logId'],
    OUTBOUND_ERROR_LOG_ID_MAX,
  )
  return code === undefined && msg === undefined && logId === undefined
    ? null
    : {
        ...(code !== undefined ? { code } : {}),
        ...(msg !== undefined ? { msg } : {}),
        ...(logId !== undefined ? { log_id: logId } : {}),
      }
}

function firstDefined<
  K extends keyof FeishuOutboundErrorLogProjection,
>(
  candidates: readonly FeishuOutboundErrorLogProjection[],
  key: K,
): FeishuOutboundErrorLogProjection[K] | undefined {
  for (const candidate of candidates) {
    const value = candidate[key]
    if (value !== undefined) return value
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

function boundedText(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string' || value === '') return undefined
  const bounded = value.replace(/[\u0000-\u001f\u007f]+/g, ' ').slice(0, max)
  return bounded === '' ? undefined : bounded
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}
