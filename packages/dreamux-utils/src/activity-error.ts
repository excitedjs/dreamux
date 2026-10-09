/**
 * The error a provider-owned Activity reader throws and catches for its own
 * internal control flow. `detail` is native-granularity vocabulary private to
 * one reader; `reason` is the neutral projection that crosses the provider
 * seam.
 *
 * The `reason` values duplicate `AgentActivityError['reason']` from
 * `@excitedjs/dreamux-types` by value, not by type reference: this package
 * depends on nothing, including `@excitedjs/dreamux-types`, so it cannot
 * import that type. Core's Activity reader recognizes this shape structurally
 * (`error.name === 'AgentActivityError'` plus a known `reason` string), not
 * via `instanceof`, so this class needs no compile-time link to that
 * interface — only value-sync with the four reasons `dreamux-types` declares.
 */
export type ActivityErrorDetail =
  | 'not_found'
  | 'session_mismatch'
  | 'locator_outside_root'
  | 'unreadable'
  | 'invalid'
  | 'scan_unsupported'
  | 'cursor_invalid'
  | 'cursor_query_mismatch'
  | 'cursor_stale';

export type ActivityErrorReason =
  | 'session_unavailable'
  | 'cursor_invalid'
  | 'activity_corrupt'
  | 'provider_failure';

const PUBLIC_REASON: Record<ActivityErrorDetail, ActivityErrorReason> = {
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

export class ActivityError extends Error {
  readonly name = 'AgentActivityError';

  readonly reason: ActivityErrorReason;

  constructor(
    readonly detail: ActivityErrorDetail,
    message: string,
    options: { cause?: unknown } = {},
  ) {
    super(message, options);
    this.reason = PUBLIC_REASON[detail];
  }
}
