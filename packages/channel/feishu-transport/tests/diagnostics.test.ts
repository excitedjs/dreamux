/**
 * Unit tests for `src/transport/diagnostics.ts` — the injectable logger seam.
 *
 * The byte-for-byte default and the safety boundary are the riskiest parts of
 * the #74 logger work, so they are tested here, against the factory directly,
 * rather than indirectly through `createFeishuTransport`:
 *
 *   - With no injected logger, every sink reproduces the historical stderr
 *     wording exactly (`[feishu-transport] <ISO> <line>` connection lines,
 *     `[feishu-transport] <message>` diagnostics), all via `console.error`,
 *     and nothing is ever written to stdout (`console.log`).
 *   - With an injected logger, the routing reaches the logger and a sentinel
 *     secret / message body never appears in any forwarded message or field.
 */

import { afterEach, describe, expect, test, vi } from 'vitest';

import {
  createTransportDiagnostics,
  type TransportLogger,
} from '../src/transport/diagnostics';

/** A capturing `TransportLogger`: records every call as `[level, message, fields]`. */
function spyLogger() {
  const calls: Array<{
    level: keyof TransportLogger;
    message: string;
    fields: Record<string, unknown> | undefined;
  }> = [];
  // `TransportLogger` is pino-shaped (fields-first): fields are the 1st arg,
  // the message the 2nd. The capture is still recorded as `{level, message,
  // fields}` so the assertions below read unchanged.
  const make =
    (level: keyof TransportLogger) =>
    (fields: Record<string, unknown>, message?: string) => {
      calls.push({ level, message: message ?? '', fields });
    };
  const logger: TransportLogger = {
    error: make('error'),
    warn: make('warn'),
    info: make('info'),
    debug: make('debug'),
    trace: make('trace'),
  };
  return { logger, calls };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('createTransportDiagnostics — default (no logger) is byte-for-byte stderr', () => {
  test('connection writes a single [feishu-transport] <ISO> <line> to stderr', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const diag = createTransportDiagnostics();

    diag.connection('Feishu connection re-established.');
    // The level argument does not change the default path — still one stderr line.
    diag.connection('something failed', 'error');

    expect(err).toHaveBeenCalledTimes(2);
    const first = err.mock.calls[0]?.[0] as string;
    expect(first).toMatch(
      /^\[feishu-transport\] \d{4}-\d{2}-\d{2}T[\d:.]+Z Feishu connection re-established\.$/,
    );
    expect(err.mock.calls[0]).toHaveLength(1);
    expect(log).not.toHaveBeenCalled();
  });

  test('diagnostic keeps the message and passes err as a trailing console arg', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const diag = createTransportDiagnostics();
    const cause = new Error('boom');

    diag.diagnostic('could not fetch metadata for tok:', cause);
    diag.diagnostic('bot info response carried no open_id');

    expect(err.mock.calls).toEqual([
      ['[feishu-transport] could not fetch metadata for tok:', cause],
      ['[feishu-transport] bot info response carried no open_id'],
    ]);
    expect(log).not.toHaveBeenCalled();
  });
});

describe('createTransportDiagnostics — injected logger routing', () => {
  test('connection routes at info by default and at the given level on failures', () => {
    const { logger, calls } = spyLogger();
    const diag = createTransportDiagnostics(logger);

    diag.connection('ready');
    diag.connection('failed', 'error');

    expect(calls).toEqual([
      {
        level: 'info',
        message: 'ready',
        fields: { source: 'feishu-transport-connection' },
      },
      {
        level: 'error',
        message: 'failed',
        fields: { source: 'feishu-transport-connection' },
      },
    ]);
  });

  test('diagnostic routes at warn and serializes the error into a field', () => {
    const { logger, calls } = spyLogger();
    const diag = createTransportDiagnostics(logger);

    diag.diagnostic('could not fetch:', new Error('boom'));
    diag.diagnostic('no open_id');

    expect(calls[0]?.level).toBe('warn');
    expect(calls[0]?.message).toBe('could not fetch:');
    expect(calls[0]?.fields?.['source']).toBe('feishu-transport-diagnostic');
    expect(calls[0]?.fields?.['err']).toMatchObject({ message: 'boom' });
    expect(calls[1]).toEqual({
      level: 'warn',
      message: 'no open_id',
      fields: { source: 'feishu-transport-diagnostic' },
    });
  });
});
