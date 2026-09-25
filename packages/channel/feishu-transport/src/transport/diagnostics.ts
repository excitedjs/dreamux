/**
 * Transport-owned diagnostics, behind one injectable logger seam.
 *
 * Every line the transport emits about its own health — the WebSocket
 * connection lifecycle and the best-effort failures of the doc-comment /
 * metadata / bot-info / socket-close paths — flows through the single
 * `TransportLogger` a host may inject via `FeishuTransportOptions.logger`.
 *
 * Two design rules hold this module together:
 *
 *   - **Instance-level, never a mutable global.** `createTransportDiagnostics`
 *     is called once per `createFeishuTransport`, so each transport instance
 *     derives its own connection/diagnostic sinks. Multiple dispatchers in one
 *     process never cross-write each other's logs.
 *   - **Byte-for-byte default.** With no injected logger the transport keeps
 *     exactly its historical stderr behavior: the `[feishu-transport] <ISO>
 *     <line>` connection lines and the `[feishu-transport] <message>`
 *     best-effort diagnostics — all to stderr via `console.error`, and never a
 *     byte to stdout (a host on an MCP stdio transport reserves stdout for the
 *     JSON-RPC stream).
 *
 * Safety boundary: the injected-logger path only ever forwards what the stderr
 * path already surfaces — connection-lifecycle wording and the ids/error
 * already present in a best-effort failure. It never attaches `appSecret`, raw
 * events, `rawContent`, parsed text, or reply/card bodies as structured
 * fields, so routing into a host's channel log neither widens the secret/body
 * exposure nor pollutes stdout.
 *
 * The Lark SDK's own client/dispatcher/WebSocket logging is not part of this
 * seam: `createFeishuTransport` hands each SDK constructor a shared no-op
 * logger (see `feishu.ts`) instead of wiring the SDK's diagnostic output
 * anywhere. The SDK reports HTTP failures by handing its logger a structured
 * error whose `config.data` is the outbound request body — and for the
 * app/tenant access-token calls that body is `{app_id, app_secret}` — so there
 * is no redaction-safe way to keep that log without re-deriving trust in every
 * field the SDK might pass it; suppressing it entirely is the boundary.
 */

/**
 * A minimal, structured logger a host can inject so the transport's own
 * diagnostics join the host's per-component log. Defined inside this package so
 * the transport never reverse-depends on a host's logger (dreamux's pino, etc.)
 * or on any host's types. The shape is deliberately pino-compatible
 * (fields-first: `error(fields, message)`), so a host's pino logger — or
 * Dreamux's neutral `DreamuxLogger`, which is itself pino-shaped — satisfies it
 * structurally and is injected AS-IS, with no per-boundary adapter.
 */
export interface TransportLogger {
  error(fields: Record<string, unknown>, message?: string): void
  warn(fields: Record<string, unknown>, message?: string): void
  info(fields: Record<string, unknown>, message?: string): void
  debug(fields: Record<string, unknown>, message?: string): void
  trace(fields: Record<string, unknown>, message?: string): void
}

/** Levels a connection-lifecycle line is routed at on the injected path. */
type ConnectionLevel = 'info' | 'error'

/**
 * Per-instance diagnostics sinks `createFeishuTransport` wires its own
 * failure paths into.
 */
export interface TransportDiagnostics {
  /**
   * A WebSocket connection-lifecycle line. Default path: stderr with an ISO
   * timestamp. Injected path: routed at `level` (default `info`; failures pass
   * `error`) with the host's own timestamp.
   */
  connection(line: string, level?: ConnectionLevel): void
  /**
   * A best-effort failure the transport degrades past (doc-comment / metadata
   * fetch, bot-info resolution, socket close). Default path: stderr, with `err`
   * passed as a trailing `console.error` arg so its stack still prints. Injected
   * path: routed at `warn` with `err` serialized into a structured field.
   */
  diagnostic(message: string, err?: unknown): void
}

/** Source tag stamped on injected WebSocket connection-lifecycle lines. */
const CONNECTION_SOURCE = 'feishu-transport-connection'
/** Source tag stamped on injected best-effort failure diagnostics (non-connection). */
const DIAGNOSTIC_SOURCE = 'feishu-transport-diagnostic'

/**
 * Build the per-instance diagnostics for a transport. With no `logger` the
 * returned sinks reproduce the historical stderr behavior byte-for-byte; with a
 * `logger` they route structured into it.
 */
export function createTransportDiagnostics(logger?: TransportLogger): TransportDiagnostics {
  if (logger === undefined) {
    return {
      connection: (line) => {
        console.error(`[feishu-transport] ${new Date().toISOString()} ${line}`)
      },
      diagnostic: (message, err) => {
        if (err !== undefined) console.error(`[feishu-transport] ${message}`, err)
        else console.error(`[feishu-transport] ${message}`)
      },
    }
  }

  return {
    connection: (line, level = 'info') => {
      logger[level]({ source: CONNECTION_SOURCE }, line)
    },
    diagnostic: (message, err) => {
      logger.warn(
        err !== undefined
          ? { source: DIAGNOSTIC_SOURCE, err: serializeErr(err) }
          : { source: DIAGNOSTIC_SOURCE },
        message,
      )
    },
  }
}

/** Serialize an error into a logger-safe field (message + stack when present). */
function serializeErr(err: unknown): { message: string; stack?: string } {
  if (err instanceof Error) {
    return err.stack !== undefined
      ? { message: err.message, stack: err.stack }
      : { message: err.message }
  }
  return { message: String(err) }
}
