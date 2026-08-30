/**
 * Unix-domain socket path-budget primitives (socket-budget.ts). Pure functions,
 * no IO: exact arithmetic at, below, and above the 103-safe-byte budget,
 * including the UTF-8 multi-byte edge case that byte length (not `.length`
 * character count) is what's actually enforced.
 */
import { describe, it, expect } from 'vitest';

import {
  DREAMUX_UNIX_SOCKET_PATH_MAX_BYTES,
  unixSocketPathFitsBudget,
  assertUnixSocketPathBudget,
} from '../src/socket-budget.js';

describe('DREAMUX_UNIX_SOCKET_PATH_MAX_BYTES', () => {
  it('is the documented cross-platform safe budget of 103 bytes', () => {
    expect(DREAMUX_UNIX_SOCKET_PATH_MAX_BYTES).toBe(103);
  });
});

describe('unixSocketPathFitsBudget', () => {
  it('fits a path exactly at the byte budget', () => {
    const path = 'a'.repeat(DREAMUX_UNIX_SOCKET_PATH_MAX_BYTES);
    expect(path.length).toBe(103);
    expect(unixSocketPathFitsBudget(path)).toBe(true);
  });

  it('does not fit a path one byte over the budget', () => {
    const path = 'a'.repeat(DREAMUX_UNIX_SOCKET_PATH_MAX_BYTES + 1);
    expect(unixSocketPathFitsBudget(path)).toBe(false);
  });

  it('fits a short path comfortably under the budget', () => {
    expect(unixSocketPathFitsBudget('/tmp/dreamux.sock')).toBe(true);
  });

  it('counts UTF-8 bytes, not JS string length, for multi-byte characters', () => {
    // Each '中' is 3 bytes in UTF-8 but 1 UTF-16 code unit in JS string length.
    // 34 repeats -> 34 chars but 102 bytes, so appending one ASCII byte lands
    // exactly at the 103-byte budget.
    const cjk = '中'.repeat(34);
    expect(cjk.length).toBe(34);
    expect(Buffer.byteLength(cjk, 'utf8')).toBe(102);
    expect(unixSocketPathFitsBudget(cjk)).toBe(true);
    expect(unixSocketPathFitsBudget(cjk + 'a')).toBe(true); // exactly 103 bytes
    expect(unixSocketPathFitsBudget(cjk + 'ab')).toBe(false); // 104 bytes
  });

  it('fits the empty path', () => {
    expect(unixSocketPathFitsBudget('')).toBe(true);
  });
});

describe('assertUnixSocketPathBudget', () => {
  it('returns the path unchanged when it fits', () => {
    const path = '/tmp/short.sock';
    expect(assertUnixSocketPathBudget(path, 'codex app-server socket')).toBe(path);
  });

  it('throws naming the label, byte count, and offending path when it does not fit', () => {
    const path = '/tmp/' + 'x'.repeat(200) + '.sock';
    const bytes = Buffer.byteLength(path, 'utf8');
    expect(() => assertUnixSocketPathBudget(path, 'codex app-server socket')).toThrowError(
      new RegExp(
        `codex app-server socket is too long for Unix sockets \\(${bytes} bytes > 103 safe bytes\\): ${path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`,
      ),
    );
  });
});
