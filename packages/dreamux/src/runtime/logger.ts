/**
 * Persistent structured logging for the dreamux host (issue #70).
 *
 * One small factory builds every logger; `paths.ts` owns *where* logs go, this
 * module owns *how* they are constructed. The host had no durable log of its
 * own decisions — gate deliver/drop, `/introduce`, inbound/outbound, dispatcher
 * lifecycle — only `console.error` that a daemonized `serve` could not surface
 * in a structured, per-component file. This factory closes that gap.
 *
 * Design (settled in the issue #70 decision record):
 *   - `pino` with `pino.multistream`, never the worker-thread transport: robust
 *     for the short-lived `feishu-mcp` stdio shim and for vitest.
 *   - Dual output. When `filePath` is given we write JSON to BOTH the file and
 *     stderr, so a foreground `serve` never goes dark. Format is structured on
 *     both streams (a deliberate v1 UX choice — no `pino-pretty`, no fragile
 *     reparsing stream).
 *   - `sync: true` everywhere. The shim and tests need synchronous writes; the
 *     server avoids a flush-on-shutdown lifecycle. No log line is lost on exit.
 *   - Files are opened `0o600` (mkdir + open + chmod), matching the Codex
 *     supervisor and the `0600` posture of `config.json` / state files.
 *   - Credentials are removed declaratively via pino `redact`. Message *bodies*
 *     are NOT redacted — they are simply never passed to the logger (callers
 *     log ids, never `parsed_text` / `rawContent` / reply text).
 *   - The factory takes an explicit destination. `paths.ts` `dreamuxRoot()`
 *     hardcodes `homedir()` and does not honor `DREAMUX_CONFIG_DIR`, so tests
 *     inject a tmp `filePath`; they must not expect an env var to move logs.
 */

import { chmodSync, mkdirSync, openSync } from 'node:fs';
import { dirname } from 'node:path';

import type { TransportLogger } from '@excitedjs/feishu-transport';
import pino, {
  type DestinationStream,
  type Logger,
  type LoggerOptions,
} from 'pino';

export type DreamuxLogger = Logger;

export interface CreateLoggerOptions {
  /**
   * Component name stamped on every line (`server`, `channel/<id>`,
   * `feishu-mcp/<id>`). Surfaces in the structured output and the stderr line.
   */
  name?: string;
  /**
   * Absolute path of the log file. When omitted the logger writes to stderr
   * only — the safe default for tests and any `Server` constructed without an
   * injected file-backed logger (it opens zero files).
   */
  filePath?: string;
  /**
   * Also mirror to stderr so a foreground `serve` stays visible. Defaults to
   * `true`. Always `false`-irrelevant when `filePath` is unset (stderr is then
   * the only stream).
   */
  stderr?: boolean;
  /** Minimum level. Defaults to `DREAMUX_LOG_LEVEL`, then `info`. */
  level?: pino.Level;
  /**
   * Test seam: an explicit destination stream that replaces both the file and
   * stderr. When set, `filePath`/`stderr` are ignored. Lets a test capture
   * output in-memory without touching the filesystem.
   */
  destination?: DestinationStream;
}

/**
 * Paths whose values are redacted from every log line. Covers the Feishu
 * `app_secret` wherever it might be nested (config snapshot, dispatcher row,
 * credentials object) plus a generic `*.secret` catch.
 */
const REDACT_PATHS = [
  'app_secret',
  '*.app_secret',
  'appSecret',
  '*.appSecret',
  'secret',
  '*.secret',
  'feishu.app_secret',
  '*.feishu.app_secret',
] as const;

function resolveLevel(level?: pino.Level): pino.Level {
  if (level !== undefined) return level;
  const fromEnv = process.env['DREAMUX_LOG_LEVEL'];
  if (fromEnv !== undefined && fromEnv !== '') return fromEnv as pino.Level;
  return 'info';
}

/**
 * Open a log file at `path` with owner-only permissions. Creates the parent
 * directory, appends, and chmods to `0o600` so a pre-existing wider-permission
 * file is tightened rather than trusted.
 */
function openLogFileStream(path: string): DestinationStream {
  mkdirSync(dirname(path), { recursive: true });
  const fd = openSync(path, 'a', 0o600);
  chmodSync(path, 0o600);
  return pino.destination({ fd, sync: true });
}

export function createLogger(opts: CreateLoggerOptions = {}): DreamuxLogger {
  const level = resolveLevel(opts.level);
  const base: LoggerOptions = {
    level,
    base: opts.name !== undefined ? { name: opts.name } : {},
    redact: { paths: [...REDACT_PATHS], censor: '[REDACTED]' },
  };

  if (opts.destination !== undefined) {
    return pino(base, opts.destination);
  }

  const streams: pino.StreamEntry[] = [];
  if (opts.filePath !== undefined) {
    streams.push({ level, stream: openLogFileStream(opts.filePath) });
  }
  if (opts.filePath === undefined || opts.stderr !== false) {
    streams.push({ level, stream: pino.destination({ fd: 2, sync: true }) });
  }

  return pino(base, pino.multistream(streams, { dedupe: false }));
}

/**
 * Adapt a `DreamuxLogger` to the `(level, msg, err?)` seam that
 * `DispatcherRuntime` and `TurnManager` already accept, so dispatcher lifecycle
 * lands in the per-dispatcher channel log without changing their call sites.
 */
export function loggerToLevelFn(
  logger: DreamuxLogger,
): (level: 'info' | 'warn' | 'error', msg: string, err?: unknown) => void {
  return (level, msg, err) => {
    if (err !== undefined) logger[level]({ err: serializeErr(err) }, msg);
    else logger[level](msg);
  };
}

function serializeErr(err: unknown): { message: string; stack?: string } {
  if (err instanceof Error) {
    return err.stack !== undefined
      ? { message: err.message, stack: err.stack }
      : { message: err.message };
  }
  return { message: String(err) };
}

/**
 * Adapt a `DreamuxLogger` (pino) to the `@excitedjs/feishu-transport`
 * `TransportLogger` seam, so the transport's own SDK / connection diagnostics
 * fold into the same per-dispatcher channel log as the host's channel
 * decisions. pino takes `(mergingObject, message)`, the transport seam emits
 * `(message, fields?)` — this flips the argument order and supplies an empty
 * object when the transport carried no fields.
 *
 * The transport only ever passes its own diagnostic source fields (an SDK/
 * connection `source` tag and a serialized `err`); it never hands message
 * bodies or credentials to the logger, so this adapter forwards `fields`
 * verbatim without re-redacting (the pino `redact` config still applies).
 */
export function pinoToTransportLogger(logger: DreamuxLogger): TransportLogger {
  return {
    error: (message, fields) => logger.error(fields ?? {}, message),
    warn: (message, fields) => logger.warn(fields ?? {}, message),
    info: (message, fields) => logger.info(fields ?? {}, message),
    debug: (message, fields) => logger.debug(fields ?? {}, message),
    trace: (message, fields) => logger.trace(fields ?? {}, message),
  };
}
