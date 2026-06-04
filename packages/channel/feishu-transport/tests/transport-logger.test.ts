/**
 * Wiring tests for the #74 logger seam inside `createFeishuTransport`.
 *
 * The Lark SDK is mocked so these run with no live connection. Two claims are
 * proven here (formatting is covered by `diagnostics.test.ts`, not re-checked):
 *
 *   1. `lark.Client`, `lark.EventDispatcher`, and `lark.WSClient` are all handed
 *      the *same* instance-derived SDK logger object — so several dispatchers in
 *      one process cannot cross-write each other's SDK logs.
 *   2. Invoking the WebSocket lifecycle callbacks (`onReady` / `onReconnecting`
 *      / `onReconnected` / `onError`) and hitting the startup-timeout path routes
 *      a connection line to the injected `TransportLogger`.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

const captured = vi.hoisted(() => ({
  clientLoggers: [] as unknown[],
  wsLoggers: [] as unknown[],
  dispatcherLoggers: [] as unknown[],
  wsOptions: [] as Array<Record<string, () => void>>,
  control: { autoReady: true },
}))

vi.mock('@larksuiteoapi/node-sdk', () => {
  class Client {
    request = async (): Promise<{ bot: { open_id: string } }> => ({
      bot: { open_id: 'ou_self' },
    })
    constructor(opts: { logger?: unknown }) {
      captured.clientLoggers.push(opts.logger)
    }
  }
  class EventDispatcher {
    constructor(opts: { logger?: unknown }) {
      captured.dispatcherLoggers.push(opts.logger)
    }
    register(): this {
      return this
    }
  }
  class WSClient {
    private readonly opts: Record<string, () => void>
    constructor(opts: Record<string, () => void> & { logger?: unknown }) {
      captured.wsLoggers.push(opts.logger)
      captured.wsOptions.push(opts)
      this.opts = opts
    }
    async start(): Promise<void> {
      // The success path marks the connection ready so `start()` resolves; the
      // startup-timeout test flips `autoReady` off to leave it pending.
      if (captured.control.autoReady) this.opts['onReady']?.()
    }
    close(): void {}
    getConnectionStatus(): { state: string } {
      return { state: 'connected' }
    }
  }
  return { Client, EventDispatcher, WSClient }
})

// Imported after the mock is registered (vi.mock is hoisted above the imports).
const { createFeishuTransport } = await import('../src/transport/feishu')
import type { TransportLogger } from '../src/transport/diagnostics'

/** Records connection-level routing so a test can assert what the logger saw. */
function spyLogger() {
  const calls: Array<{ level: keyof TransportLogger; message: string }> = []
  const make =
    (level: keyof TransportLogger) =>
    (message: string) => {
      calls.push({ level, message })
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

beforeEach(() => {
  captured.clientLoggers.length = 0
  captured.wsLoggers.length = 0
  captured.dispatcherLoggers.length = 0
  captured.wsOptions.length = 0
  captured.control.autoReady = true
})

afterEach(() => {
  vi.useRealTimers()
})

describe('createFeishuTransport — SDK logger is one instance-derived object', () => {
  test('Client, EventDispatcher, and WSClient all receive the same SDK logger', async () => {
    const { logger } = spyLogger()
    const transport = createFeishuTransport(
      { appId: 'app', appSecret: 'secret' },
      { logger },
    )

    await transport.start({})

    const clientLogger = captured.clientLoggers[0]
    expect(clientLogger).toBeDefined()
    expect(captured.dispatcherLoggers[0]).toBe(clientLogger)
    expect(captured.wsLoggers[0]).toBe(clientLogger)
  })
})

describe('createFeishuTransport — connection events reach the injected logger', () => {
  test('onReady / onReconnecting / onReconnected route info, onError routes error', async () => {
    const { logger, calls } = spyLogger()
    const transport = createFeishuTransport(
      { appId: 'app', appSecret: 'secret' },
      { logger },
    )

    await transport.start({})
    // start() already fired onReady; drive the remaining lifecycle callbacks.
    const ws = captured.wsOptions[0]
    expect(ws).toBeDefined()
    ws?.['onReconnecting']?.()
    ws?.['onReconnected']?.()
    ;(ws?.['onError'] as unknown as (e: unknown) => void)?.(new Error('socket lost'))

    const ready = calls.find((c) => c.message.includes('connection is ready'))
    expect(ready?.level).toBe('info')
    expect(calls.some((c) => c.level === 'info' && c.message.includes('reconnecting'))).toBe(true)
    expect(calls.some((c) => c.level === 'info' && c.message.includes('re-established'))).toBe(true)
    const errLine = calls.find((c) => c.level === 'error')
    expect(errLine?.message).toContain('stopped retrying')
  })

  test('the startup-timeout path routes an error connection line and rejects', async () => {
    vi.useFakeTimers()
    captured.control.autoReady = false
    const { logger, calls } = spyLogger()
    const transport = createFeishuTransport(
      { appId: 'app', appSecret: 'secret' },
      { logger },
    )

    const settled = transport.start({}).then(
      () => 'resolved',
      (err: unknown) => err,
    )
    // Advance past the 30s startup grace window so the watchdog fires.
    await vi.advanceTimersByTimeAsync(31_000)
    const result = await settled

    expect(result).toBeInstanceOf(Error)
    const errLine = calls.find((c) => c.level === 'error')
    expect(errLine?.message).toContain('did not come up within')
  })
})
