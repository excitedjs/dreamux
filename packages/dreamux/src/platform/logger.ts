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
 *   - File loggers require awaited file preparation before use. It creates
 *     private files with current-user ownership, including under elevated
 *     Windows tokens. Pino then writes synchronously, preserving immediate-exit
 *     logs without an asynchronous write buffer.
 *   - Credentials are removed by a provider-agnostic recursive key sanitizer.
 *     Message *bodies* are NOT redacted — they are simply never passed to the
 *     logger (callers log ids, never turn `text` / `rawContent` / reply text).
 *   - The factory takes an explicit destination. Tests inject a tmp
 *     `filePath`; they must not expect `createLogger` to honor `DREAMUX_ROOT`
 *     for log paths either, since the factory takes its destination
 *     explicitly and never calls `logsRoot()` itself.
 */

import { readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import type { DreamuxLogger } from '@excitedjs/dreamux-types';
import {
  ensureOwnerOnlyDir,
  ensureOwnerOnlyFile,
  errorInfo,
  isSecretKeyName,
  publishFileExclusive,
} from '@excitedjs/dreamux-utils';
import pino, { type DestinationStream, type LoggerOptions } from 'pino';

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
   * Absolute path already prepared by `prepareLogFile`.
   * When omitted the logger writes to stderr
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

function resolveLevel(level?: pino.Level): pino.Level {
  if (level !== undefined) return level;
  const fromEnv = process.env['DREAMUX_LOG_LEVEL'];
  if (fromEnv !== undefined && fromEnv !== '') return fromEnv as pino.Level;
  return 'info';
}

/**
 * Prepare before constructing any file logger. Existing log files are
 * tightened before more data can be appended. Individual new destinations are
 * prepared by prepareLogFile; ACL inheritance alone does not set their owner.
 */
export async function prepareLogDirectory(path: string): Promise<void> {
  await ensureOwnerOnlyDir(path);
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const child = join(path, entry.name);
    if (entry.isSymbolicLink()) {
      throw new Error(
        `refusing to use Dreamux log entry ${child}: it is a symlink`,
      );
    }
    if (entry.isDirectory()) await prepareLogDirectory(child);
    else await ensureOwnerOnlyFile(child);
  }
}

/** Prepare a private append destination without replacing existing log content. */
export async function prepareLogFile(path: string): Promise<void> {
  await ensureOwnerOnlyDir(dirname(path));
  await publishFileExclusive(path, '');
  await ensureOwnerOnlyFile(path);
}

function openLogFileStream(path: string): DestinationStream {
  return pino.destination({
    dest: path,
    mode: 0o600,
    sync: true,
  });
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
    out[key] = isSecretKeyName(key)
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
