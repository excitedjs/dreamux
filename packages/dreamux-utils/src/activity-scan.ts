import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { isAbsolute, relative, sep } from 'node:path';

/**
 * Neutral scan primitives shared by provider-owned Activity readers. This module
 * holds only mechanism — bounded positional reads, digests, path containment,
 * and a scan budget. It knows nothing about any native history layout, and it
 * owns no record shape: `AgentActivityRecord` is a public contract each provider
 * projects for itself.
 */

export const SCAN_DISCOVERY_MAX_ENTRIES = 20_000;
export const SCAN_DISCOVERY_MAX_ELAPSED_MS = 2_000;

export interface ScanBudget {
  inspect(entries?: number): void;
}

export interface PositionalReader {
  read(
    buffer: Buffer,
    offset: number,
    length: number,
    position: number,
  ): Promise<{ bytesRead: number }>;
}

export function scanDigest(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('base64url');
}

export function isScanDigest(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value);
}

export function createScanBudget(input: {
  maxEntries?: number;
  maxElapsedMs?: number;
  now?: () => number;
  limitError: () => Error;
}): ScanBudget {
  const maxEntries = input.maxEntries ?? SCAN_DISCOVERY_MAX_ENTRIES;
  const now = input.now ?? Date.now;
  const deadline = now() + (input.maxElapsedMs ?? SCAN_DISCOVERY_MAX_ELAPSED_MS);
  let inspected = 0;
  return {
    inspect(entries = 1): void {
      inspected += entries;
      if (inspected > maxEntries || now() > deadline) {
        throw input.limitError();
      }
    },
  };
}

export async function readBytesAt(
  reader: PositionalReader,
  position: number,
  length: number,
  options: { maxChunkBytes?: number } = {},
): Promise<Buffer> {
  if (
    !Number.isSafeInteger(position) ||
    position < 0 ||
    !Number.isSafeInteger(length) ||
    length < 0
  ) {
    throw new RangeError('positional read requires non-negative integers');
  }
  const maxChunkBytes = options.maxChunkBytes ?? length;
  if (!Number.isSafeInteger(maxChunkBytes) || maxChunkBytes <= 0) {
    if (length === 0) return Buffer.alloc(0);
    throw new RangeError('positional read chunk size must be positive');
  }
  const bytes = Buffer.alloc(length);
  let offset = 0;
  while (offset < length) {
    const requested = Math.min(length - offset, maxChunkBytes);
    const read = await reader.read(bytes, offset, requested, position + offset);
    if (
      !Number.isSafeInteger(read.bytesRead) ||
      read.bytesRead < 0 ||
      read.bytesRead > requested
    ) {
      throw new Error('positional reader returned an invalid byte count');
    }
    if (read.bytesRead === 0) break;
    offset += read.bytesRead;
  }
  return bytes.subarray(0, offset);
}

export function isPathWithin(root: string, candidate: string): boolean {
  const child = relative(root, candidate);
  return (
    child === '' ||
    (!child.startsWith(`..${sep}`) && child !== '..' && !isAbsolute(child))
  );
}
