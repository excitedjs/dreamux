/**
 * How a delegate decides what a model may read about a failure.
 *
 * The rule is the same one the MCP shims used to apply against admin error
 * codes, moved to where the failure actually happens. A delegate names the
 * codes whose message is safe and actionable for *this* tool; that message goes
 * back verbatim. Anything else is rethrown, which fails the `mcp.toolcall`
 * Command, gets logged in full by Core, and reaches the model as the fixed
 * sanitized tool error. `INTERNAL`, every catch-all `*_FAILED`, and every
 * unlisted code stay unsurfaced by construction, because surfacing requires an
 * explicit listing rather than an explicit suppression.
 *
 * Two rules that used to live in the shims are gone rather than moved:
 * `TRANSPORT_ERROR`, which only the shim can observe now that the delegate runs
 * in-process, and `DISPATCHER_NOT_FOUND`, which cannot occur when the delegate
 * already holds its dispatcher.
 */
import { DreamuxError } from '../../platform/errors.js';
import type { McpDelegateResult } from './types.js';

/** What a tool body produces when it succeeds. */
export interface McpToolSuccess {
  structured: unknown;
  /** Optional model-facing text this operation chose to say. */
  text?: string;
}

/**
 * Run one tool body and project its outcome.
 *
 * `publicCodes` is the allowlist for the single tool being served, not for the
 * delegate: `dissolve` may surface a blocked reason that `list` never can.
 */
export async function runDelegateTool(
  publicCodes: readonly string[],
  body: () => Promise<McpToolSuccess>,
): Promise<McpDelegateResult> {
  return runDelegateCall(publicCodes, async () => {
    const success = await body();
    return {
      ok: true,
      structured: success.structured,
      ...(success.text !== undefined ? { text: success.text } : {}),
    };
  });
}

/**
 * The same projection, for a body that already settles its own outcome.
 *
 * A delegate whose work is done by an external implementation does not raise
 * that implementation's refusals — they arrive as results. What it still has to
 * project is the typed domain failure raised on the way in, by the lease or
 * admission the call passes through before reaching anything.
 */
export async function runDelegateCall(
  publicCodes: readonly string[],
  body: () => Promise<McpDelegateResult>,
): Promise<McpDelegateResult> {
  try {
    return await body();
  } catch (error) {
    if (error instanceof DreamuxError && publicCodes.includes(error.code)) {
      return { ok: false, message: error.message };
    }
    throw error;
  }
}

/**
 * A tool this delegate does not serve.
 *
 * It is a public failure on purpose: a client that asks for a tool outside the
 * advertised catalog gets told so, exactly as the caller-scoped shims used to
 * answer a tool the caller kind could not see.
 */
export function unknownToolResult(
  serverName: string,
  name: string,
  available: readonly string[],
): McpDelegateResult {
  return {
    ok: false,
    message:
      `Tool '${name}' is not available on the Dreamux ${serverName} server. ` +
      `Available tools: ${available.join(', ')}.`,
  };
}
