/**
 * The failure boundary for a one-request/one-result JSON invocation.
 *
 * A one-request/one-result call needs a producing side, and this is all of it:
 * a marker a deep implementation can throw when it knows what the caller did
 * wrong, and a runner that turns exactly that marker into the settled
 * `ok: false` answer.
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
/**
 * The settled shape, declared here rather than imported.
 *
 * This package knows no Dreamux contracts: `@excitedjs/dreamux-types` is the
 * type set an *external provider* compiles against, and a utility every layer
 * calls must not reach into it. The shape is structural and identical to that
 * package's `JsonInvokeResult`, so a caller that names the contract assigns one
 * of these to it without a cast.
 */
export type SettledInvoke<TValue> =
  | { readonly ok: true; readonly value: TValue }
  | { readonly ok: false; readonly message: string };

export class PublicInvokeFailure extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PublicInvokeFailure';
  }
}

export async function settleJsonInvoke<TValue>(
  body: () => Promise<TValue>,
): Promise<SettledInvoke<TValue>> {
  try {
    return { ok: true, value: await body() };
  } catch (error) {
    if (error instanceof PublicInvokeFailure) {
      return { ok: false, message: error.message };
    }
    throw error;
  }
}
