import {
  isScanDigest,
  scanDigest,
} from '@excitedjs/dreamux-utils';

import { ClaudeActivityError } from './error.js';

interface ClaudeCursorEnvelope {
  v: 1;
  p: 'claude';
  fp: string;
  gen: string;
  pos: number;
  bd: string;
  rw: number;
  rp: number | null;
  rd: string | null;
}

export function claudeQueryFingerprint(includeTools: boolean): string {
  return scanDigest(JSON.stringify({ include_tools: includeTools }));
}

export function encodeClaudeCursor(input: {
  fingerprint: string;
  generation: string;
  position: number;
  boundaryDigest: string;
  rewriteWatermark: number;
  rewritePosition: number | null;
  rewriteDigest: string | null;
}): string {
  const envelope: ClaudeCursorEnvelope = {
    v: 1,
    p: 'claude',
    fp: input.fingerprint,
    gen: input.generation,
    pos: input.position,
    bd: input.boundaryDigest,
    rw: input.rewriteWatermark,
    rp: input.rewritePosition,
    rd: input.rewriteDigest,
  };
  return Buffer.from(JSON.stringify(envelope), 'utf8').toString('base64url');
}

export function decodeClaudeCursor(
  cursor: string,
  expectedFingerprint: string,
): ClaudeCursorEnvelope {
  let value: unknown;
  try {
    const decoded = Buffer.from(cursor, 'base64url');
    if (decoded.length === 0 || decoded.length > 3072) throw new Error('size');
    value = JSON.parse(decoded.toString('utf8'));
  } catch (error) {
    throw new ClaudeActivityError(
      'cursor_invalid',
      'Claude Code activity cursor is invalid',
      { cause: error },
    );
  }
  if (!isEnvelope(value)) {
    throw new ClaudeActivityError(
      'cursor_invalid',
      'Claude Code activity cursor is invalid',
    );
  }
  if (value.fp !== expectedFingerprint) {
    throw new ClaudeActivityError(
      'cursor_query_mismatch',
      'Claude Code activity cursor belongs to a different query',
    );
  }
  return value;
}

function isEnvelope(value: unknown): value is ClaudeCursorEnvelope {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    Object.keys(record).length === 9 &&
    record['v'] === 1 &&
    record['p'] === 'claude' &&
    isScanDigest(record['fp']) &&
    isScanDigest(record['gen']) &&
    Number.isSafeInteger(record['pos']) &&
    (record['pos'] as number) >= 0 &&
    isScanDigest(record['bd']) &&
    Number.isSafeInteger(record['rw']) &&
    (record['rw'] as number) >= 0 &&
    (record['rp'] === null ||
      (Number.isSafeInteger(record['rp']) &&
        (record['rp'] as number) >= 0)) &&
    (record['rd'] === null || isScanDigest(record['rd'])) &&
    ((record['rp'] === null && record['rd'] === null) ||
      (record['rp'] !== null && record['rd'] !== null))
  );
}

export { scanDigest as digest };
