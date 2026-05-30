/**
 * Pure log-line builders for the Feishu WebSocket connection lifecycle.
 *
 * `createFeishuTransport` wires the SDK's connection callbacks to these, so a
 * dropped or failed connection is always surfaced on the host's stderr instead
 * of disappearing into the SDK's reconnect loop. The wording lives here — pure
 * and free of any SDK dependency — so it is unit-testable. Ported verbatim from
 * claudemux.
 */

/** Extract a human-readable detail from an unknown thrown value. */
function detail(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** The connection dropped and the SDK has begun a reconnect cycle. */
export function reconnectingLogLine(): string {
  return 'Feishu connection lost — the SDK is reconnecting.'
}

/** The reconnect cycle restored the connection. */
export function reconnectedLogLine(): string {
  return 'Feishu connection re-established.'
}

/**
 * The SDK reported a connection error and stopped — a non-recoverable error,
 * or an exhausted retry budget. The channel needs a restart to reconnect.
 */
export function connectionErrorLogLine(err: unknown): string {
  return `Feishu connection failed and the SDK stopped retrying: ${detail(err)}`
}

/**
 * The initial connection never came up within the startup grace window.
 * `sdkGaveUp` is true when the SDK has already stopped retrying on its own,
 * false when it is still looping and the channel is the one stopping it.
 */
export function startupTimeoutLogLine(graceMs: number, sdkGaveUp: boolean): string {
  const secs = Math.round(graceMs / 1000)
  const tail = sdkGaveUp
    ? 'the SDK has stopped retrying'
    : 'stopping the connection attempt so it does not retry in a tight loop'
  return (
    `Feishu connection did not come up within ${secs}s of startup; ${tail}. ` +
    'Inbound events will not arrive until the channel is restarted.'
  )
}
