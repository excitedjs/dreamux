/**
 * Bounded native-activity scan primitives (activity-scan.ts): digesting,
 * digest-shape recognition, budget enforcement (entry count and elapsed time),
 * chunked positional reads, and path containment.
 */
import { describe, it, expect } from 'vitest';

import {
  SCAN_DISCOVERY_MAX_ENTRIES,
  SCAN_DISCOVERY_MAX_ELAPSED_MS,
  scanDigest,
  isScanDigest,
  createScanBudget,
  readBytesAt,
  isPathWithin,
  type PositionalReader,
} from '../src/activity-scan.js';

describe('exported budget constants', () => {
  it('documents the discovery budget defaults', () => {
    expect(SCAN_DISCOVERY_MAX_ENTRIES).toBe(20_000);
    expect(SCAN_DISCOVERY_MAX_ELAPSED_MS).toBe(2_000);
  });
});

describe('scanDigest / isScanDigest', () => {
  it('is deterministic for the same input', () => {
    expect(scanDigest('hello')).toBe(scanDigest('hello'));
  });

  it('differs for different input', () => {
    expect(scanDigest('hello')).not.toBe(scanDigest('world'));
  });

  it('produces a digest that isScanDigest recognizes', () => {
    const digest = scanDigest('anything');
    expect(isScanDigest(digest)).toBe(true);
  });

  it('accepts a Uint8Array input the same as an equivalent string', () => {
    const bytes = new TextEncoder().encode('hello');
    expect(scanDigest(bytes)).toBe(scanDigest('hello'));
  });

  it('isScanDigest rejects non-digest strings and non-strings', () => {
    expect(isScanDigest('too-short')).toBe(false);
    expect(isScanDigest('a'.repeat(44))).toBe(false); // one char too long
    expect(isScanDigest('a'.repeat(42))).toBe(false); // one char too short
    expect(isScanDigest('!'.repeat(43))).toBe(false); // right length, bad alphabet
    expect(isScanDigest(123)).toBe(false);
    expect(isScanDigest(null)).toBe(false);
    expect(isScanDigest(undefined)).toBe(false);
  });
});

describe('createScanBudget', () => {
  it('does not throw while under both the entry and elapsed budgets', () => {
    const budget = createScanBudget({
      maxEntries: 10,
      maxElapsedMs: 10_000,
      now: () => 0,
      limitError: () => new Error('scan limit exceeded'),
    });
    expect(() => budget.inspect(5)).not.toThrow();
    expect(() => budget.inspect(4)).not.toThrow();
  });

  it('throws the caller-supplied error once the entry count is exceeded', () => {
    const budget = createScanBudget({
      maxEntries: 10,
      now: () => 0,
      limitError: () => new Error('too many entries'),
    });
    budget.inspect(10); // exactly at the limit: allowed
    expect(() => budget.inspect(1)).toThrowError('too many entries');
  });

  it('throws once the injected clock passes the elapsed deadline', () => {
    let clock = 0;
    const budget = createScanBudget({
      maxElapsedMs: 100,
      now: () => clock,
      limitError: () => new Error('scan timed out'),
    });
    budget.inspect(1); // clock still at 0, well under deadline
    clock = 200; // now past the 100ms deadline
    expect(() => budget.inspect(1)).toThrowError('scan timed out');
  });

  it('defaults entries-per-inspect to 1 when omitted', () => {
    const budget = createScanBudget({
      maxEntries: 2,
      now: () => 0,
      limitError: () => new Error('limit'),
    });
    budget.inspect();
    budget.inspect();
    expect(() => budget.inspect()).toThrowError('limit');
  });
});

function fakeReader(data: Buffer): PositionalReader {
  return {
    async read(buffer, offset, length, position) {
      const available = Math.max(0, data.length - position);
      const toCopy = Math.min(length, available);
      data.copy(buffer, offset, position, position + toCopy);
      return { bytesRead: toCopy };
    },
  };
}

describe('readBytesAt', () => {
  it('reads an exact byte range from the given position', async () => {
    const data = Buffer.from('0123456789');
    const result = await readBytesAt(fakeReader(data), 3, 4);
    expect(result.toString('utf8')).toBe('3456');
  });

  it('assembles a read that requires multiple chunks', async () => {
    const data = Buffer.from('abcdefghij');
    const result = await readBytesAt(fakeReader(data), 0, 10, { maxChunkBytes: 3 });
    expect(result.toString('utf8')).toBe('abcdefghij');
  });

  it('returns fewer bytes than requested when the source is short (EOF), not padding', async () => {
    const data = Buffer.from('abc');
    const result = await readBytesAt(fakeReader(data), 0, 10);
    expect(result.toString('utf8')).toBe('abc');
    expect(result.length).toBe(3);
  });

  it('returns an empty buffer for a zero-length read', async () => {
    const data = Buffer.from('abc');
    const result = await readBytesAt(fakeReader(data), 0, 0);
    expect(result.length).toBe(0);
  });

  it('rejects a negative position or length', async () => {
    const data = Buffer.from('abc');
    await expect(readBytesAt(fakeReader(data), -1, 1)).rejects.toThrow(RangeError);
    await expect(readBytesAt(fakeReader(data), 0, -1)).rejects.toThrow(RangeError);
  });

  it('rejects a non-positive maxChunkBytes when length is non-zero', async () => {
    const data = Buffer.from('abc');
    await expect(readBytesAt(fakeReader(data), 0, 3, { maxChunkBytes: 0 })).rejects.toThrow(
      RangeError,
    );
  });

  it('rejects a reader that reports more bytesRead than requested', async () => {
    const dishonestReader: PositionalReader = {
      async read(_buffer, _offset, length) {
        return { bytesRead: length + 1 };
      },
    };
    await expect(readBytesAt(dishonestReader, 0, 4)).rejects.toThrow(
      'positional reader returned an invalid byte count',
    );
  });

  it('rejects a reader that reports a negative bytesRead', async () => {
    const dishonestReader: PositionalReader = {
      async read() {
        return { bytesRead: -1 };
      },
    };
    await expect(readBytesAt(dishonestReader, 0, 4)).rejects.toThrow(
      'positional reader returned an invalid byte count',
    );
  });
});

describe('isPathWithin', () => {
  it('is true for the root itself', () => {
    expect(isPathWithin('/a/b', '/a/b')).toBe(true);
  });

  it('is true for a nested descendant', () => {
    expect(isPathWithin('/a/b', '/a/b/c/d.txt')).toBe(true);
  });

  it('is false for a sibling directory that merely shares a string prefix', () => {
    // Regression guard for naive `startsWith` containment checks: "/a/bee" is
    // NOT inside "/a/b" even though the string "/a/b" is a textual prefix.
    expect(isPathWithin('/a/b', '/a/bee')).toBe(false);
  });

  it('is false for a path that escapes via ../', () => {
    expect(isPathWithin('/a/b', '/a/b/../c')).toBe(false);
  });

  it('is false for an unrelated absolute path', () => {
    expect(isPathWithin('/a/b', '/x/y')).toBe(false);
  });
});
