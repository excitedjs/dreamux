import { describe, expect, test } from 'vitest'
import {
  connectionErrorLogLine,
  reconnectedLogLine,
  reconnectingLogLine,
  startupTimeoutLogLine,
} from '../src/transport/connection'

describe('reconnectingLogLine / reconnectedLogLine', () => {
  test('reconnecting names the loss and the reconnect', () => {
    expect(reconnectingLogLine().toLowerCase()).toContain('reconnect')
  })

  test('reconnected reports the connection is back', () => {
    expect(reconnectedLogLine().toLowerCase()).toContain('re-established')
  })
})

describe('connectionErrorLogLine', () => {
  test('an Error contributes its message', () => {
    const line = connectionErrorLogLine(new Error('pullConnectConfig failed: code=400'))
    expect(line).toContain('pullConnectConfig failed: code=400')
    expect(line.toLowerCase()).toContain('stopped retrying')
  })

  test('a string error is included verbatim', () => {
    expect(connectionErrorLogLine('socket hang up')).toContain('socket hang up')
  })

  test('a non-error, non-string value is stringified', () => {
    expect(connectionErrorLogLine({ code: 500 })).toContain('[object Object]')
  })
})

describe('startupTimeoutLogLine', () => {
  test('reports the grace window in seconds', () => {
    expect(startupTimeoutLogLine(30_000, false)).toContain('30s')
  })

  test('still-looping wording when the SDK has not given up', () => {
    const line = startupTimeoutLogLine(30_000, false)
    expect(line).toContain('tight loop')
    expect(line).toContain('restarted')
  })

  test('gave-up wording when the SDK already stopped on its own', () => {
    const line = startupTimeoutLogLine(30_000, true)
    expect(line).toContain('stopped retrying')
    expect(line).not.toContain('tight loop')
  })
})
