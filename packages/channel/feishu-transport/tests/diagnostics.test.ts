/**
 * Unit tests for `src/transport/diagnostics.ts` — the injectable logger seam.
 *
 * The byte-for-byte default and the safety boundary are the riskiest parts of
 * the #74 logger work, so they are tested here, against the factory directly,
 * rather than indirectly through `createFeishuTransport`:
 *
 *   - With no injected logger, every sink reproduces the historical stderr
 *     wording exactly (`[feishu-sdk]` prefix, `[feishu-transport] <ISO> <line>`
 *     connection lines, `[feishu-transport] <message>` diagnostics), all via
 *     `console.error`, and nothing is ever written to stdout (`console.log`).
 *   - With an injected logger, the routing reaches the logger and a sentinel
 *     secret / message body never appears in any forwarded message or field.
 */

import { afterEach, describe, expect, test, vi } from 'vitest'

import {
  createTransportDiagnostics,
  type TransportLogger,
} from '../src/transport/diagnostics'

/** A capturing `TransportLogger`: records every call as `[level, message, fields]`. */
function spyLogger() {
  const calls: Array<{
    level: keyof TransportLogger
    message: string
    fields: Record<string, unknown> | undefined
  }> = []
  const make =
    (level: keyof TransportLogger) =>
    (message: string, fields?: Record<string, unknown>) => {
      calls.push({ level, message, fields })
    }
  const logger: TransportLogger = {
    error: make('error'),
    warn: make('warn'),
    info: make('info'),
    debug: make('debug'),
    trace: make('trace'),
  }
  return { logger, calls }
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('createTransportDiagnostics — default (no logger) is byte-for-byte stderr', () => {
  test('sdkLogger prefixes [feishu-sdk] on every level and writes only to stderr', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const diag = createTransportDiagnostics()

    diag.sdkLogger.error('e', 1)
    diag.sdkLogger.warn('w')
    diag.sdkLogger.info('i')
    diag.sdkLogger.debug('d')
    diag.sdkLogger.trace('t')

    expect(err.mock.calls).toEqual([
      ['[feishu-sdk]', 'e', 1],
      ['[feishu-sdk]', 'w'],
      ['[feishu-sdk]', 'i'],
      ['[feishu-sdk]', 'd'],
      ['[feishu-sdk]', 't'],
    ])
    expect(log).not.toHaveBeenCalled()
  })

  test('connection writes a single [feishu-transport] <ISO> <line> to stderr', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const diag = createTransportDiagnostics()

    diag.connection('Feishu connection re-established.')
    // The level argument does not change the default path — still one stderr line.
    diag.connection('something failed', 'error')

    expect(err).toHaveBeenCalledTimes(2)
    const first = err.mock.calls[0]?.[0] as string
    expect(first).toMatch(
      /^\[feishu-transport\] \d{4}-\d{2}-\d{2}T[\d:.]+Z Feishu connection re-established\.$/,
    )
    expect(err.mock.calls[0]).toHaveLength(1)
    expect(log).not.toHaveBeenCalled()
  })

  test('diagnostic keeps the message and passes err as a trailing console arg', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const diag = createTransportDiagnostics()
    const cause = new Error('boom')

    diag.diagnostic('could not fetch metadata for tok:', cause)
    diag.diagnostic('bot info response carried no open_id')

    expect(err.mock.calls).toEqual([
      ['[feishu-transport] could not fetch metadata for tok:', cause],
      ['[feishu-transport] bot info response carried no open_id'],
    ])
    expect(log).not.toHaveBeenCalled()
  })
})

describe('createTransportDiagnostics — injected logger routing', () => {
  test('sdkLogger routes each level to the matching logger method with a source field', () => {
    const { logger, calls } = spyLogger()
    const diag = createTransportDiagnostics(logger)

    diag.sdkLogger.error('e', 1)
    diag.sdkLogger.info('i')

    expect(calls).toEqual([
      { level: 'error', message: 'e 1', fields: { source: 'feishu-sdk' } },
      { level: 'info', message: 'i', fields: { source: 'feishu-sdk' } },
    ])
  })

  test('connection routes at info by default and at the given level on failures', () => {
    const { logger, calls } = spyLogger()
    const diag = createTransportDiagnostics(logger)

    diag.connection('ready')
    diag.connection('failed', 'error')

    expect(calls).toEqual([
      { level: 'info', message: 'ready', fields: { source: 'feishu-transport-connection' } },
      { level: 'error', message: 'failed', fields: { source: 'feishu-transport-connection' } },
    ])
  })

  test('diagnostic routes at warn and serializes the error into a field', () => {
    const { logger, calls } = spyLogger()
    const diag = createTransportDiagnostics(logger)

    diag.diagnostic('could not fetch:', new Error('boom'))
    diag.diagnostic('no open_id')

    expect(calls[0]?.level).toBe('warn')
    expect(calls[0]?.message).toBe('could not fetch:')
    expect(calls[0]?.fields?.['source']).toBe('feishu-transport-diagnostic')
    expect(calls[0]?.fields?.['err']).toMatchObject({ message: 'boom' })
    expect(calls[1]).toEqual({
      level: 'warn',
      message: 'no open_id',
      fields: { source: 'feishu-transport-diagnostic' },
    })
  })

  test('safety: a sentinel secret / body never reaches the injected logger', () => {
    const { logger, calls } = spyLogger()
    const diag = createTransportDiagnostics(logger)
    const SECRET = 'fake-not-a-real-secret'
    const BODY = 'do-not-log-body'

    // Drive every sink the transport uses. None of them is given the secret or
    // a message body, so neither sentinel should appear in the forwarded output.
    diag.sdkLogger.info('sdk diagnostic line')
    diag.connection('Feishu connection re-established.')
    diag.connection('Feishu connection failed and the SDK stopped retrying: timeout', 'error')
    diag.diagnostic('could not fetch comment cmt_1 on tok_1:', new Error('network down'))

    const haystack = JSON.stringify(calls)
    expect(haystack).not.toContain(SECRET)
    expect(haystack).not.toContain(BODY)
  })
})
