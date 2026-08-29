/**
 * The failure boundary for a one-request/one-result JSON invocation.
 *
 * A `JsonInvokeResult` needs a producing side, and this is all of it: a marker
 * a deep implementation can throw when it knows what the caller did wrong, and
 * a runner that turns exactly that marker into the settled `ok: false` answer.
 *
 * The marker exists so a refusal does not have to be plumbed by hand out of an
 * argument parser, a policy check, or whatever else is five frames down. It
 * carries a message and nothing else — no code, no class hierarchy, no
 * subclasses to match on — and it never leaves the package that threw it: the
 * runner is that package's own edge, and what crosses is JSON.
 *
 * Everything else propagates. A failure nobody decided to publish is not a
 * result, and turning it into one here would be the exact mistake this boundary
 * exists to prevent.
 */
import type { JsonInvokeResult } from '@excitedjs/dreamux-types';

export class PublicInvokeFailure extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PublicInvokeFailure';
  }
}

export async function settleJsonInvoke<TValue>(
  body: () => Promise<TValue>,
): Promise<JsonInvokeResult<TValue>> {
  try {
    return { ok: true, value: await body() };
  } catch (error) {
    if (error instanceof PublicInvokeFailure) {
      return { ok: false, message: error.message };
    }
    throw error;
  }
}
