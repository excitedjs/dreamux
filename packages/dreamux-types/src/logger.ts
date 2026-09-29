/**
 * Public logger contract for provider packages.
 *
 * Deliberately pino-compatible (fields-first: `info(fields, message)`), so the
 * host's real pino logger satisfies this shape *structurally* — Dreamux core
 * injects its pino logger as-is, with no wrapper and no conversion at any
 * boundary. Core always supplies a logger, so every provider context field
 * that carries one is required, not optional.
 *
 * The dual call signature mirrors pino's two primary overloads: pass fields then
 * an optional message, or pass a bare message. A misplaced message-first call
 * (`info('msg', fields)`) matches neither overload and is a compile error — the
 * position where a stray fields object would otherwise skip the host's `redact`
 * policy and leak a secret.
 */
interface DreamuxLogFn {
  (fields: Record<string, unknown>, message?: string): void;
  (message: string): void;
}

export interface DreamuxLogger {
  error: DreamuxLogFn;
  warn: DreamuxLogFn;
  info: DreamuxLogFn;
  debug: DreamuxLogFn;
  trace: DreamuxLogFn;
  /**
   * Context-binding sub-logger. Every constructed `DreamuxLogger` already
   * provides it — pino's `child(bindings)` satisfies it directly.
   */
  child(bindings: Record<string, unknown>): DreamuxLogger;
}
