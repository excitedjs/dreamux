import {
  isTranscriptDigest,
  transcriptDigest,
} from '@excitedjs/dreamux-utils';

import { CodexTranscriptError } from './error.js';

export interface CodexCursorPosition {
  segment: number;
  offset: number;
}

interface CodexCursorEnvelope {
  v: 1;
  p: 'codex';
  fp: string;
  gen: string;
  pos: CodexCursorPosition;
  bd: string;
}

export function codexQueryFingerprint(includeTools: boolean): string {
  return transcriptDigest(JSON.stringify({ include_tools: includeTools }));
}

export function encodeCodexCursor(input: {
  fingerprint: string;
  generation: string;
  position: CodexCursorPosition;
  boundaryDigest: string;
}): string {
  const envelope: CodexCursorEnvelope = {
    v: 1,
    p: 'codex',
    fp: input.fingerprint,
    gen: input.generation,
    pos: input.position,
    bd: input.boundaryDigest,
  };
  return Buffer.from(JSON.stringify(envelope), 'utf8').toString('base64url');
}

export function decodeCodexCursor(
  cursor: string,
  expectedFingerprint: string,
): CodexCursorEnvelope {
  let value: unknown;
  try {
    const decoded = Buffer.from(cursor, 'base64url');
    if (decoded.length === 0 || decoded.length > 3072) throw new Error('size');
    value = JSON.parse(decoded.toString('utf8'));
  } catch (error) {
    throw new CodexTranscriptError(
      'cursor_invalid',
      'Codex transcript cursor is invalid',
      { cause: error },
    );
  }
  if (!isCursorEnvelope(value)) {
    throw new CodexTranscriptError(
      'cursor_invalid',
      'Codex transcript cursor is invalid',
    );
  }
  if (value.fp !== expectedFingerprint) {
    throw new CodexTranscriptError(
      'cursor_query_mismatch',
      'Codex transcript cursor belongs to a different query',
    );
  }
  return value;
}

function isCursorEnvelope(value: unknown): value is CodexCursorEnvelope {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  const position = record['pos'];
  return (
    Object.keys(record).length === 6 &&
    record['v'] === 1 &&
    record['p'] === 'codex' &&
    isTranscriptDigest(record['fp']) &&
    isTranscriptDigest(record['gen']) &&
    isTranscriptDigest(record['bd']) &&
    position !== null &&
    typeof position === 'object' &&
    !Array.isArray(position) &&
    Number.isInteger((position as Record<string, unknown>)['segment']) &&
    ((position as Record<string, unknown>)['segment'] as number) >= 0 &&
    Number.isSafeInteger((position as Record<string, unknown>)['offset']) &&
    ((position as Record<string, unknown>)['offset'] as number) >= 0
  );
}

export { transcriptDigest as digest };
