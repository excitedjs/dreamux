/**
 * NDJSON Unix-socket protocol for admin commands (issue #2 §"管理接口").
 *
 * One line in / one line out. Permissions on the socket are 0600 (only the
 * owner). Method names use dotted lowercase; error codes use SCREAMING_SNAKE_CASE.
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
  error: { code: string; message: string };
}

export type AdminResponse = AdminOkResponse | AdminErrorResponse;

export class AdminError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'AdminError';
  }
}
