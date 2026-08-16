import type { AgentRuntimeTranscriptError } from '@excitedjs/dreamux-types';

import { AgentTranscriptReadError } from '../service/agent-entity/transcript-reader.js';
import { AdminError } from './protocol.js';

export const TRANSCRIPT_PUBLIC_ERRORS = [
  {
    reason: 'checkpoint_missing',
    code: 'TRANSCRIPT_CHECKPOINT_MISSING',
    message:
      'No runtime transcript is available before a session is established.',
  },
  {
    reason: 'not_found',
    code: 'TRANSCRIPT_NOT_FOUND',
    message: 'The runtime transcript is not available.',
  },
  {
    reason: 'unreadable',
    code: 'TRANSCRIPT_UNREADABLE',
    message: 'The runtime transcript cannot be read.',
  },
  {
    reason: 'invalid',
    code: 'TRANSCRIPT_INVALID',
    message: 'The runtime transcript is invalid.',
  },
  {
    reason: 'locator_outside_root',
    code: 'TRANSCRIPT_LOCATOR_OUTSIDE_ROOT',
    message:
      'The runtime transcript locator is outside the provider-owned transcript root.',
  },
  {
    reason: 'session_mismatch',
    code: 'TRANSCRIPT_SESSION_MISMATCH',
    message: 'The runtime transcript does not match this TeamMate session.',
  },
  {
    reason: 'cursor_invalid',
    code: 'TRANSCRIPT_CURSOR_INVALID',
    message: 'The transcript cursor is invalid.',
  },
  {
    reason: 'cursor_query_mismatch',
    code: 'TRANSCRIPT_CURSOR_QUERY_MISMATCH',
    message: 'The transcript cursor belongs to a different query.',
  },
  {
    reason: 'cursor_stale',
    code: 'TRANSCRIPT_CURSOR_STALE',
    message: 'The transcript cursor is stale.',
  },
  {
    reason: 'scan_unsupported',
    code: 'TRANSCRIPT_SCAN_UNSUPPORTED',
    message:
      'The runtime transcript cannot be paged safely within the fixed scan limit.',
  },
] as const satisfies readonly {
  reason: AgentRuntimeTranscriptError['reason'];
  code: string;
  message: string;
}[];

export const TRANSCRIPT_INTERNAL_ERROR_MESSAGE =
  'The runtime transcript could not be read because of an internal error.';

export function mapAgentTranscriptAdminError(error: unknown): never {
  if (!(error instanceof AgentTranscriptReadError)) throw error;
  if (error.reason === null) {
    throw new AdminError('INTERNAL', TRANSCRIPT_INTERNAL_ERROR_MESSAGE);
  }
  const mapped = TRANSCRIPT_PUBLIC_ERRORS.find(
    (entry) => entry.reason === error.reason,
  );
  if (mapped === undefined) {
    throw new AdminError('INTERNAL', TRANSCRIPT_INTERNAL_ERROR_MESSAGE);
  }
  throw new AdminError(mapped.code, mapped.message);
}
