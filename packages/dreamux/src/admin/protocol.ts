/**
 * NDJSON Unix-socket transport framing for Core Commands (issue #2 §"管理接口").
 *
 * One line in / one line out. Permissions on the socket are 0600 (only the
 * owner). `method` is a Core Command name and `params` its payload; the
 * envelope carries no meaning of its own. Command names use dotted lowercase;
 * error codes use SCREAMING_SNAKE_CASE.
 */

export interface AdminRequest {
  id: string;
  method: string;
  params?: Record<string, unknown>;
}

export interface AdminOkResponse {
  id: string;
  ok: true;
  result: unknown;
}

export interface AdminErrorResponse {
  id: string;
  ok: false;
  /**
   * `action` is present when the failure stated its own next step. It is
   * additive: a reader that ignores it sees exactly the envelope it always saw,
   * and a reader that renders a failure for an agent has the sentence the
   * domain wrote instead of having to invent one per code.
   */
  error: { code: string; message: string; action?: string };
}

export type AdminResponse = AdminOkResponse | AdminErrorResponse;
