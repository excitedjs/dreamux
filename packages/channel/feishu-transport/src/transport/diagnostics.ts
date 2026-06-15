/**
 * Transport-owned diagnostics, behind one injectable logger seam.
 *
 * Every line the transport emits about its own health — the Lark SDK's logging,
 * the WebSocket connection lifecycle, and the best-effort failures of the
 * doc-comment / metadata / bot-info / socket-close paths — flows through the
 * single `TransportLogger` a host may inject via `FeishuTransportOptions.logger`.
 *
 * Two design rules hold this module together:
 *
 *   - **Instance-level, never a mutable global.** `createTransportDiagnostics`
 *     is called once per `createFeishuTransport`, so each transport instance
 *     derives its own SDK logger and connection/diagnostic sinks. Multiple
 *     dispatchers in one process never cross-write each other's logs.
 *   - **Byte-for-byte default.** With no injected logger the transport keeps
 *     exactly its historical stderr behavior: the `[feishu-sdk]` prefix on SDK
 *     lines, the `[feishu-transport] <ISO> <line>` connection lines, the
 *     `[feishu-transport] <message>` best-effort diagnostics — all to stderr via
 *     `console.error`, and never a byte to stdout (a host on an MCP stdio
 *     transport reserves stdout for the JSON-RPC stream).
 *
 * Safety boundary: the injected-logger path only ever forwards what the stderr
 * path already surfaces — SDK diagnostic args, connection-lifecycle wording, and
 * the ids/error already present in a best-effort failure. It never attaches
 * `appSecret`, raw events, `rawContent`, parsed text, or reply/card bodies as
 * structured fields, so routing into a host's channel log neither widens the
 * secret/body exposure nor pollutes stdout.
 *
 * Secret boundary: the Lark SDK logs HTTP failures by handing its logger a
 * structured error whose `config.data` is the *outbound request body* — and for
 * the app/tenant access-token calls that body is `{app_id, app_secret}`. Both
 * sink paths therefore run every SDK arg through {@link redactForLog} first, so
 * the credential never reaches stderr or the host log. This is the one place the
 * "byte-for-byte default" rule yields: secret-bearing args are scrubbed, all
 * other args pass through unchanged.
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

/**
 * The Lark SDK's logger shape: five levels, each variadic. `lark.Client`,
 * `lark.EventDispatcher`, and `lark.WSClient` all accept this. The transport
 * derives one of these per instance and hands the *same* object to all three.
 */
export interface SdkLogger {
  error(...msg: unknown[]): void
  warn(...msg: unknown[]): void
  info(...msg: unknown[]): void
  debug(...msg: unknown[]): void
  trace(...msg: unknown[]): void
}

/** Levels a connection-lifecycle line is routed at on the injected path. */
type ConnectionLevel = 'info' | 'error'

/**
 * Per-instance diagnostics sinks `createFeishuTransport` wires its SDK clients
 * and its own failure paths into.
 */
export interface TransportDiagnostics {
  /** The Lark SDK logger — pass to `Client` / `EventDispatcher` / `WSClient`. */
  readonly sdkLogger: SdkLogger
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

/** Source tag stamped on injected SDK lines, mirroring the stderr `[feishu-sdk]` prefix. */
const SDK_SOURCE = 'feishu-sdk'
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
      sdkLogger: {
        error: (...msg) => console.error('[feishu-sdk]', ...sanitizeSdkArgs(msg)),
        warn: (...msg) => console.error('[feishu-sdk]', ...sanitizeSdkArgs(msg)),
        info: (...msg) => console.error('[feishu-sdk]', ...sanitizeSdkArgs(msg)),
        debug: (...msg) => console.error('[feishu-sdk]', ...sanitizeSdkArgs(msg)),
        trace: (...msg) => console.error('[feishu-sdk]', ...sanitizeSdkArgs(msg)),
      },
      connection: (line) => {
        console.error(`[feishu-transport] ${new Date().toISOString()} ${line}`)
      },
      diagnostic: (message, err) => {
        if (err !== undefined) console.error(`[feishu-transport] ${message}`, err)
        else console.error(`[feishu-transport] ${message}`)
      },
    }
  }

  const sdkLevel =
    (level: keyof TransportLogger) =>
    (...msg: unknown[]) =>
      logger[level]({ source: SDK_SOURCE }, formatSdkArgs(sanitizeSdkArgs(msg)))

  return {
    sdkLogger: {
      error: sdkLevel('error'),
      warn: sdkLevel('warn'),
      info: sdkLevel('info'),
      debug: sdkLevel('debug'),
      trace: sdkLevel('trace'),
    },
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

/**
 * Flatten the SDK's variadic log args into one message string for the injected
 * path — the structured logger takes a single message, where the stderr path
 * relied on `console.error`'s native multi-arg join. Errors render as their
 * stack (or message); other non-strings are JSON-stringified, falling back to
 * `String()` for anything circular. Only the SDK's own diagnostic args reach
 * here — never a message body — so flattening cannot widen body exposure.
 *
 * Args are expected to have already been run through {@link sanitizeSdkArgs}.
 */
function formatSdkArgs(args: unknown[]): string {
  return args.map(stringifyArg).join(' ')
}

/** Keys whose value is a credential and must never reach a log sink. */
const SECRET_KEY = /(secret|password|passwd|token|authorization|cookie|credential)/i
/** Fields of an axios-style request config that carry the raw request payload. */
const AXIOS_PAYLOAD_FIELD = new Set(['data', 'headers', 'auth'])
const REDACTED = '[redacted]'
/** Bound on recursion so a pathological/deep SDK arg cannot stall the log path. */
const MAX_REDACT_DEPTH = 8

/**
 * Scrub every SDK log arg before it reaches stderr or the injected logger.
 *
 * The Lark SDK reports HTTP failures by handing its logger a structured error
 * (`formatErrors`) whose `config.data` is the *outbound request body* — and the
 * app/tenant access-token calls POST `{app_id, app_secret}`, so that body is a
 * live credential. `config.data` is a JSON *string*, so key-name scanning alone
 * never sees the embedded secret; {@link redactForLog} therefore blanks the
 * whole `data`/`headers`/`auth` of anything axios-config-shaped, on top of a
 * generic credential-key redact for secrets that surface anywhere else.
 */
function sanitizeSdkArgs(args: unknown[]): unknown[] {
  return args.map((arg) => redactForLog(arg))
}

/**
 * Return a redacted, log-safe view of `value`: a deep copy with credential keys
 * and axios request payloads blanked. Strings/numbers/etc. pass through; a plain
 * `Error` with no enumerable own props is returned as-is so {@link stringifyArg}
 * can still render its clean stack, while an axios-style error (which hangs
 * `config`/`request`/`response` as enumerable own props) is expanded and
 * scrubbed. Depth- and cycle-bounded.
 */
function redactForLog(value: unknown, depth = 0, seen = new WeakSet<object>()): unknown {
  if (value === null || typeof value !== 'object') return value
  if (depth >= MAX_REDACT_DEPTH) return '[truncated]'
  if (seen.has(value)) return '[circular]'
  seen.add(value)

  if (value instanceof Error) {
    const extra = redactForLog({ ...value }, depth + 1, seen) as Record<string, unknown>
    if (Object.keys(extra).length === 0) return value
    return { name: value.name, message: value.message, stack: value.stack, ...extra }
  }

  if (Array.isArray(value)) return value.map((item) => redactForLog(item, depth + 1, seen))

  const isAxiosConfig = 'url' in value || 'method' in value || 'baseURL' in value
  const out: Record<string, unknown> = {}
  for (const [key, child] of Object.entries(value)) {
    if (SECRET_KEY.test(key) || (isAxiosConfig && AXIOS_PAYLOAD_FIELD.has(key))) {
      out[key] = REDACTED
    } else {
      out[key] = redactForLog(child, depth + 1, seen)
    }
  }
  return out
}

function stringifyArg(arg: unknown): string {
  if (typeof arg === 'string') return arg
  if (arg instanceof Error) return arg.stack ?? arg.message
  try {
    return JSON.stringify(arg)
  } catch {
    return String(arg)
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
