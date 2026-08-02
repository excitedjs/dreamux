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
 *     for the short-lived `channel-mcp` stdio shim and for vitest.
 *   - Dual output. When `filePath` is given we write JSON to BOTH the file and
 *     stderr, so a foreground `serve` never goes dark. Format is structured on
 *     both streams (a deliberate v1 UX choice — no `pino-pretty`, no fragile
 *     reparsing stream).
 *   - `sync: true` everywhere. The shim and tests need synchronous writes; the
 *     server avoids a flush-on-shutdown lifecycle. No log line is lost on exit.
 *     This is a deliberate, kept design choice (issue #85): `pino.destination`'s
 *     `sync` is a config flag, not a `*Sync` call, so it is outside the
 *     synchronous-blocking-IO lint gate, and switching to an async destination
 *     would force a `flushSync()` in a `process.on('exit')` handler — re-adding
 *     unavoidable sync IO in the one truly sync-only context, plus a log-tail
 *     loss risk in the short-lived `channel-mcp` shim.
 *   - Files are created `0o600` and their parent directory `mkdir`-ed by
 *     `pino.destination` itself (`{ mkdir: true, mode: 0o600 }`). That open is
 *     internal to pino/SonicBoom, not application sync IO, so `createLogger`
 *     stays synchronous (the `Server` constructor builds loggers synchronously)
 *     while our own code holds no `fs.*Sync` calls. Matches the `0600` posture
 *     of `config.json` / state files.
 *   - Credentials are removed by a provider-agnostic recursive key sanitizer.
 *     Message *bodies* are NOT redacted — they are simply never passed to the
 *     logger (callers log ids, never turn `text` / `rawContent` / reply text).
 *   - The factory takes an explicit destination. `paths.ts` `dreamuxRoot()`
 *     hardcodes `homedir()` and does not honor `DREAMUX_CONFIG_DIR`, so tests
 *     inject a tmp `filePath`; they must not expect an env var to move logs.
 */

import { chmod } from 'node:fs/promises';

import type { DreamuxLogger } from '@excitedjs/dreamux-types';
import pino, {
  type DestinationStream,
  type LoggerOptions,
} from 'pino';

import { errorInfo } from './error-info.js';

/**
 * The neutral `DreamuxLogger` contract is pino-compatible (fields-first), so a
 * pino logger satisfies it structurally. This compile-time probe is the
 * load-bearing assertion of the whole logging design: core constructs a full
 * pino logger and injects it AS-IS into every provider package — no wrapper, no
 * boundary adapter, no fields/message flip anywhere. If pino ever drifts from
 * the contract this line fails to compile, which is the signal to fix the
 * `@excitedjs/dreamux-types` shape rather than re-introduce a converter.
 */
const _pinoSatisfiesContract: DreamuxLogger = pino();
void _pinoSatisfiesContract;

export interface CreateLoggerOptions {
  /**
   * Component name stamped on every line (`server`, `channel/<id>`,
   * `channel-mcp/<id>`). Surfaces in the structured output and the stderr line.
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

const REDACTED_VALUE = '[REDACTED]';
const SECRET_KEY_RE = /(secret|password|passwd|token|authorization|cookie|credential)/i;

function resolveLevel(level?: pino.Level): pino.Level {
  if (level !== undefined) return level;
  const fromEnv = process.env['DREAMUX_LOG_LEVEL'];
  if (fromEnv !== undefined && fromEnv !== '') return fromEnv as pino.Level;
  return 'info';
}

/**
 * Open a log file at `path` with owner-only permissions. pino/SonicBoom creates
 * the parent directory (`mkdir: true`) and the append-mode file with `0o600`
 * (`mode`) itself; that open is internal to pino, not application sync IO, so
 * this stays a synchronous factory with no `fs.*Sync` of our own (issue #85).
 *
 * `mode` is applied only when SonicBoom *creates* the file; a pre-existing
 * wider-permission log (an older build, or manual tampering) would otherwise
 * keep its looser bits. We tighten it to 0600 defensively with a fire-and-forget
 * async `chmod`: `createLogger` stays synchronous (the `Server` constructor
 * builds loggers synchronously), and async `chmod` is not a `*Sync` call, so the
 * issue #85 gate holds while the `0600` posture of `config.json` / state files
 * is preserved. Errors are swallowed — the create-time `mode` already covers the
 * common (new-file) path.
 */
function openLogFileStream(path: string): DestinationStream {
  const stream = pino.destination({
    dest: path,
    mkdir: true,
    mode: 0o600,
    sync: true,
  });
  void chmod(path, 0o600).catch(() => {
    /* best-effort hardening of a pre-existing wider-permission file */
  });
  return stream;
}

export function createLogger(opts: CreateLoggerOptions = {}): DreamuxLogger {
  const level = resolveLevel(opts.level);
  const base: LoggerOptions = {
    level,
    base: opts.name !== undefined ? { name: opts.name } : {},
    formatters: {
      log(object) {
        return redactLogValue(object) as Record<string, unknown>;
      },
    },
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

function redactLogValue(value: unknown, seen = new WeakSet<object>()): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => redactLogValue(entry, seen));
  }
  if (!isPlainLogObject(value)) return value;
  if (seen.has(value)) return '[Circular]';
  seen.add(value);
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    out[key] = SECRET_KEY_RE.test(key)
      ? REDACTED_VALUE
      : redactLogValue(entry, seen);
  }
  return out;
}

function isPlainLogObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object') return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * Adapt a `DreamuxLogger` to the `(level, msg, err?)` seam that
 * `CodexRuntime` and `TurnManager` already accept, so dispatcher lifecycle
 * lands in the per-dispatcher channel log without changing their call sites.
 */
export function loggerToLevelFn(
  logger: DreamuxLogger,
): (level: 'info' | 'warn' | 'error', msg: string, err?: unknown) => void {
  return (level, msg, err) => {
    if (err !== undefined) logger[level]({ err: errorInfo(err) }, msg);
    else logger[level](msg);
  };
}
