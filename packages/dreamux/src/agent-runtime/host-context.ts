/**
 * Host adapters that bridge Dreamux's own contracts onto the neutral
 * `@excitedjs/dreamux-types` create context (issue #209 cleanup): the
 * dispatcher-store-backed state sink and the level/msg/err log callback the
 * launcher threads. They live here, in core, because they reference host types
 * (`DispatcherStore`) the runtime packages must never see — the packages only
 * ever receive the neutral `AgentRuntimeStateCallbacks` / `DreamuxLogger`.
 */
import type {
  AgentRuntimeStateCallbacks,
  DreamuxLogger,
} from '@excitedjs/dreamux-types';

import type { DispatcherStore } from '../state/dispatcher-store.js';
import type { DreamuxLogger as HostLogger } from '../platform/logger.js';

/**
 * The host's neutral process-env injection seam (settled env-boundary decision,
 * issue #209). Core merges these entries into every runtime's spawn env after
 * `process.env` and before the provider's own `config.extra_env`. It is empty
 * today — the dreamux host injects nothing — but is the single, discoverable
 * place to add a host-owned env entry should one ever be needed, so providers
 * never reach back into core for it. A provider's `extra_env` is its OWN config
 * and is never routed through here.
 */
export const HOST_INJECT_ENV: Record<string, string> = {};

/**
 * Adapt the host dispatcher store to the neutral state sink a runtime writes
 * status/thread transitions to. `AgentRuntimeStatus` is the same string union as
 * the host `DispatcherStatus`, so the values forward without translation.
 */
export function hostStateCallbacks(
  dispatchers: DispatcherStore,
): AgentRuntimeStateCallbacks {
  return {
    setStatus: (id, status, extras) => dispatchers.setStatus(id, status, extras),
    setThreadId: (id, threadId) => dispatchers.setThreadId(id, threadId),
    recordLostThread: (id, lostThreadId, newThreadId, error) =>
      dispatchers.recordLostThread(id, lostThreadId, newThreadId, error),
  };
}

/**
 * Adapt a launcher's `(level, msg, err?)` log callback to the neutral structured
 * logger the runtime packages consume — for a caller that holds only a callback,
 * not a full pino logger (e.g. a test capturing log messages). The host log has
 * no debug/trace sink, so those levels are intentional no-ops; an `err` rides
 * through the structured `fields.err` slot. A caller that already holds a pino
 * logger should use {@link neutralLoggerFromHostLogger} instead — it preserves
 * the full structured-field set rather than only `err`.
 */
export function loggerFromHostLog(
  log: (level: 'info' | 'warn' | 'error', msg: string, err?: unknown) => void,
): DreamuxLogger {
  const forward =
    (lvl: 'info' | 'warn' | 'error') =>
    (msg: string, fields?: Record<string, unknown>) =>
      log(lvl, msg, fields?.['err']);
  return {
    error: forward('error'),
    warn: forward('warn'),
    info: forward('info'),
    debug: () => {},
    trace: () => {},
  };
}

/**
 * Adapt the host's pino logger (fields-first: `info(fields, msg)`) to the neutral
 * message-first {@link DreamuxLogger} contract (`info(msg, fields?)`) the
 * provider packages author against, preserving the full structured-field set
 * (not just `err`). This is the single boundary where core hands its own logger
 * to a runtime or channel provider, so a provider's `logger.info('x', { id })`
 * lands as a real structured field on the host log line.
 */
export function neutralLoggerFromHostLogger(host: HostLogger): DreamuxLogger {
  const forward =
    (lvl: 'error' | 'warn' | 'info' | 'debug' | 'trace') =>
    (msg: string, fields?: Record<string, unknown>): void => {
      if (fields !== undefined) host[lvl](fields, msg);
      else host[lvl](msg);
    };
  const neutral: DreamuxLogger = {
    error: forward('error'),
    warn: forward('warn'),
    info: forward('info'),
    debug: forward('debug'),
    trace: forward('trace'),
    child: (fields) => neutralLoggerFromHostLogger(host.child(fields)),
  };
  return neutral;
}
