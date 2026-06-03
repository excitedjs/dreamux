/**
 * Approval handler for Codex server→client requests.
 *
 * Issue #2 §"信任模型" + §"实现陷阱":
 *   - MVP runs Codex with approval-policy=never (or auto-approve).
 *   - If a server-request still arrives (e.g. because policy was misconfigured
 *     or codex escalates anyway), fail loudly — never return null. Silent null
 *     is the trap that hangs the daemon.
 *
 * `onReject` is an observer hook for logs or metrics. Feishu user-visible
 * output is MCP reply-only, so this handler must not send channel messages.
 */

import type { ServerRequest } from '../codex/types.js';

export interface ApprovalHandlerOptions {
  /**
   * Called when a server-request is rejected. Errors thrown here are swallowed
   * because the rejection itself still propagates to codex.
   */
  onReject?: (req: ServerRequest) => void | Promise<void>;
}

/** A method name like `exec_command_approval`, `apply_patch_approval`, etc. */
const APPROVAL_METHOD_HINTS = ['approval', 'approve', 'confirm', 'review'];

export function looksLikeApprovalRequest(method: string): boolean {
  const m = method.toLowerCase();
  return APPROVAL_METHOD_HINTS.some((h) => m.includes(h));
}

/**
 * Build a fail-fast server-request handler.
 *
 * The handler always throws — i.e. every server-request becomes an `error`
 * response on the wire — but it tags approval-related methods with a
 * user-readable message and notifies `onReject`.
 */
export function createFailFastApprovalHandler(
  opts: ApprovalHandlerOptions = {},
) {
  return async (req: ServerRequest): Promise<unknown> => {
    if (opts.onReject !== undefined) {
      try {
        await opts.onReject(req);
      } catch {
        /* observer hook, must not mask the rejection itself */
      }
    }
    if (looksLikeApprovalRequest(req.method)) {
      throw new Error(
        `当前版本不支持审批（${req.method}）。请配置 codex approval-policy=never 或将本 dispatcher 部署在 trusted-local 环境。`,
      );
    }
    throw new Error(
      `dispatcher 收到未支持的 codex server-request：${req.method}（id=${req.id}）`,
    );
  };
}
