/**
 * Minimal public logger contract for provider packages.
 *
 * Intentionally smaller than pino: a provider authored against
 * `@excitedjs/dreamux-types` depends only on this shape. Dreamux core adapts
 * its own logger to this contract; provider packages own their minimal console
 * fallback when core passes no logger. That fallback is implementation code and
 * does not belong in this declaration-only package.
 */
export interface DreamuxLogger {
  error(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  info(message: string, fields?: Record<string, unknown>): void;
  debug(message: string, fields?: Record<string, unknown>): void;
  trace(message: string, fields?: Record<string, unknown>): void;
  child?(fields: Record<string, unknown>): DreamuxLogger;
}
