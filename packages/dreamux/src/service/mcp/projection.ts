/**
 * What a delegate hands back when its tool body succeeds.
 *
 * Deciding what a model may read about a *failure* is no longer anyone's job
 * here: a domain states its own failures as `StatedFailure` subclasses, and the
 * single admission boundary every delegate is reached through
 * (`McpLeaseRegistry.invoke`) renders them — with the next step when they
 * stated one, and under their own code and message when Core does not own them.
 * A delegate therefore throws its failures like any other code and never
 * carries a list of which ones a model may see.
 *
 * What is still checked here is the *envelope*: a result that satisfies neither
 * published shape is a defect in the delegate, and it must fail the Command
 * rather than reach a caller as a successful one.
 */
import type { McpDelegateResult } from './types.js';

/** What a tool body produces when it succeeds. */
export interface McpToolSuccess {
  structured: unknown;
  /** Optional model-facing text this operation chose to say. */
  text?: string;
}

/**
 * Run one tool body and publish its value.
 *
 * Only the success shape is built here. A failure is thrown, which is what
 * carries it to the admission boundary that owns rendering and logging.
 */
export async function runDelegateTool(
  body: () => Promise<McpToolSuccess>,
): Promise<McpDelegateResult> {
  const success = await body();
  return {
    ok: true,
    structured: success.structured,
    ...(success.text !== undefined ? { text: success.text } : {}),
  };
}

/**
 * A tool this delegate does not serve.
 *
 * It is settled here on purpose: a client that asks for a tool outside the
 * advertised catalog is told the name it asked for and the names it may ask
 * for, exactly as the caller-scoped shims used to answer a tool the caller kind
 * could not see.
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

/**
 * Prove one delegate result is one of the two shapes `McpDelegateResult`
 * publishes, before a caller can observe it as an answer.
 *
 * The type says `{ok: true, structured, text?} | {ok: false, message}`, and a
 * delegate can be wrong about it — an in-process Core delegate through a defect,
 * an external Channel provider through anything at all. A success with no value
 * and a refusal with no words are both malformed, and a caller that received
 * either would be told a call settled when nothing about it is known. Throwing
 * here fails the Command instead, which is the honest answer.
 */
export function assertDelegateResult(
  result: McpDelegateResult,
  tool: string,
): McpDelegateResult {
  if (result.ok) {
    const { structured } = result;
    if (
      structured === null ||
      typeof structured !== 'object' ||
      Array.isArray(structured)
    ) {
      throw new Error(
        `tool '${tool}' returned a success without an object value`,
      );
    }
    if (result.text !== undefined && typeof result.text !== 'string') {
      throw new Error(`tool '${tool}' returned a success with non-string text`);
    }
    return result;
  }
  if (typeof result.message !== 'string' || result.message.trim() === '') {
    throw new Error(`tool '${tool}' refused the call without stating a reason`);
  }
  return result;
}
