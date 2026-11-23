import {
  ActivityError,
  isScanDigest,
  scanDigest,
} from '@excitedjs/dreamux-utils';

/**
 * Opaque pagination anchor for one Antigravity full transcript.
 *
 * The full transcript is a single append-only JSONL file: it has neither the
 * rollout lineage Codex cursors describe nor the rewrite/compaction evidence
 * Claude cursors carry, so the envelope holds exactly the facts that stabilize
 * a page walk — the query fingerprint, the boundary record's byte offset and
 * digest, and the projection ordinal inside that record. The digest rejects a
 * boundary whose bytes changed; appends after the boundary never touch it.
 */
export interface AntigravityCursorPosition {
  /** Byte offset where the boundary native record's line starts. */
  offset: number;
  /** Projection ordinal of the anchor within that one native record. */
  ordinal: number;
}

interface AntigravityCursorEnvelope {
  v: 1;
  p: 'antigravity';
  fp: string;
  pos: number;
  ord: number;
  bd: string;
}

export function encodeAntigravityCursor(input: {
  fingerprint: string;
  position: AntigravityCursorPosition;
  boundaryDigest: string;
}): string {
  const envelope: AntigravityCursorEnvelope = {
    v: 1,
    p: 'antigravity',
    fp: input.fingerprint,
    pos: input.position.offset,
    ord: input.position.ordinal,
    bd: input.boundaryDigest,
  };
  return Buffer.from(JSON.stringify(envelope), 'utf8').toString('base64url');
}

export function decodeAntigravityCursor(
  cursor: string,
  expectedFingerprint: string,
): AntigravityCursorEnvelope {
  let value: unknown;
  try {
    const decoded = Buffer.from(cursor, 'base64url');
    if (decoded.length === 0 || decoded.length > 3072) throw new Error('size');
    value = JSON.parse(decoded.toString('utf8'));
  } catch (error) {
    throw new ActivityError(
      'cursor_invalid',
      'Antigravity activity cursor is invalid',
      { cause: error },
    );
  }
  if (!isCursorEnvelope(value)) {
    throw new ActivityError(
      'cursor_invalid',
      'Antigravity activity cursor is invalid',
    );
  }
  if (value.fp !== expectedFingerprint) {
    throw new ActivityError(
      'cursor_query_mismatch',
      'Antigravity activity cursor belongs to a different query',
    );
  }
  return value;
}

function isCursorEnvelope(value: unknown): value is AntigravityCursorEnvelope {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    Object.keys(record).length === 6 &&
    record['v'] === 1 &&
    record['p'] === 'antigravity' &&
    isScanDigest(record['fp']) &&
    Number.isSafeInteger(record['pos']) &&
    (record['pos'] as number) >= 0 &&
    Number.isSafeInteger(record['ord']) &&
    (record['ord'] as number) >= 0 &&
    isScanDigest(record['bd'])
  );
}

export { scanDigest as digest };
