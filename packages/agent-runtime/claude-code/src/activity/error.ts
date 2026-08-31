import type { AgentActivityError } from '@excitedjs/dreamux-types';

/**
 * Why a Claude Code activity read failed, at native granularity. This is
 * internal control-flow vocabulary: only the public
 * {@link AgentActivityError.reason} it projects crosses the provider seam.
 */
export type ClaudeActivityDetail =
  | 'not_found'
  | 'session_mismatch'
  | 'locator_outside_root'
  | 'unreadable'
  | 'invalid'
  | 'scan_unsupported'
  | 'cursor_invalid'
  | 'cursor_query_mismatch'
  | 'cursor_stale';

const PUBLIC_REASON: Record<
  ClaudeActivityDetail,
  AgentActivityError['reason']
> = {
  not_found: 'session_unavailable',
  session_mismatch: 'session_unavailable',
  locator_outside_root: 'session_unavailable',
  unreadable: 'session_unavailable',
  invalid: 'activity_corrupt',
  scan_unsupported: 'provider_failure',
  cursor_invalid: 'cursor_invalid',
  cursor_query_mismatch: 'cursor_invalid',
  cursor_stale: 'cursor_invalid',
};

export class ClaudeActivityError extends Error implements AgentActivityError {
  readonly name = 'AgentActivityError';

  readonly reason: AgentActivityError['reason'];

  constructor(
    readonly detail: ClaudeActivityDetail,
    message: string,
    options: { cause?: unknown } = {},
  ) {
    super(message, options);
    this.reason = PUBLIC_REASON[detail];
  }
}
