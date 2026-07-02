import type { DreamuxLogger } from '@excitedjs/dreamux-types';

/**
 * Minimal `console.error`-backed logger the runtime falls back to when the host
 * passes none. Owned here, never in `@excitedjs/dreamux-types`.
 */
export function consoleFallbackLogger(runtimeId: string): DreamuxLogger {
  const sink =
    (level: string) =>
    (fields: Record<string, unknown> | string, message?: string): void => {
      const prefix = `[claude-code ${runtimeId}] ${level}`;
      if (typeof fields === 'string') {
        console.error(prefix, fields);
        return;
      }
      const err = fields['err'];
      if (err !== undefined) console.error(prefix, message ?? '', err);
      else console.error(prefix, message ?? '');
    };
  return {
    error: sink('error'),
    warn: sink('warn'),
    info: sink('info'),
    debug: () => {},
    trace: () => {},
  };
}
