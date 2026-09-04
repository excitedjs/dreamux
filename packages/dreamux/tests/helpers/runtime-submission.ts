/**
 * Shared test seam for the value-keyed submission/completion contract.
 *
 * The locked contract (`restore-value-keyed-turn-contract`) separates three
 * things the old `RuntimeTurn` conflated:
 *
 * - a {@link RuntimeSubmission} is ONE accepted send. Its object identity never
 *   implies folding.
 * - a {@link RuntimeCompletion} is ONE provider-observed native result. It is a
 *   frozen, provider-owned opaque token.
 * - folded sends settle with `Object.is`-identical completion tokens; queued
 *   sends settle with distinct tokens even when their payload is identical.
 *
 * These helpers only build the *shapes*; they never encode "how many pushes
 * should happen". A suite proves fold/queue by wiring submissions to the same
 * or to different tokens, exactly as a provider would.
 *
 * `RuntimeCompletion` itself carries no `displaySubmission` member (see
 * `packages/dreamux-types/src/agent-runtime.ts`): the current contract is
 * `{ status: 'completed', resultText }` or
 * `{ status: 'failed', error }` and nothing else. `completedCompletion` /
 * `failedCompletion` below still accept a leading `submission` argument only
 * because it is the natural argument every call site already has on hand (the
 * `RuntimeSubmission` this token is settling) — it is discarded, not stored,
 * so folding still has to be proven the one way the current contract allows:
 * by handing the SAME token object to every submission's `settle`, which
 * {@link foldSubmissions} does. Two `completedCompletion(...)` calls are always
 * distinct tokens even with identical arguments, matching the queued case.
 */
import type {
  RuntimeCompletion,
  RuntimeSubmission,
  RuntimeSubmissionSettlement,
} from '@excitedjs/dreamux-types';

export interface ControllableRuntimeSubmission {
  readonly submission: RuntimeSubmission;
  /** Settle exactly once. Returns false on every later attempt. */
  settle(settlement: RuntimeSubmissionSettlement): boolean;
  /**
   * Settle with a NEW completion token. Use for a queued (non-folded) result.
   */
  complete(resultText?: string | null): RuntimeCompletion;
  /** Settle with a NEW failed completion token (a real native result boundary). */
  failCompletion(error: Error): RuntimeCompletion;
  /** Settle as an internal non-completion failure: never a completion token. */
  fail(error: Error): boolean;
  /** Settle as internal `stopped`: never a completion token, never a push. */
  stop(): boolean;
  isSettled(): boolean;
}

export function controllableRuntimeSubmission(): ControllableRuntimeSubmission {
  let done = false;
  let resolve!: (settlement: RuntimeSubmissionSettlement) => void;
  const submission: RuntimeSubmission = Object.freeze({
    settled: new Promise<RuntimeSubmissionSettlement>((accept) => {
      resolve = accept;
    }),
  });
  const settle = (settlement: RuntimeSubmissionSettlement): boolean => {
    if (done) return false;
    done = true;
    resolve(settlement);
    return true;
  };
  return {
    submission,
    settle,
    complete(resultText = null) {
      const completion = completedCompletion(submission, resultText);
      settle({ kind: 'completion', completion });
      return completion;
    },
    failCompletion(error) {
      const completion = failedCompletion(submission, error);
      settle({ kind: 'completion', completion });
      return completion;
    },
    fail: (error) => settle({ kind: 'failed', error }),
    stop: () => settle({ kind: 'stopped' }),
    isSettled: () => done,
  };
}

/**
 * A frozen `completed` token.
 *
 * `_submission` is accepted and discarded: `RuntimeCompletion` has no
 * `displaySubmission` field in the current contract, so nothing links this
 * token back to the submission that produced it except the identity the
 * caller wires by hand (see {@link foldSubmissions}).
 */
export function completedCompletion(
  _submission: RuntimeSubmission,
  resultText: string | null = null,
): RuntimeCompletion {
  return Object.freeze({
    status: 'completed' as const,
    resultText,
  });
}

/**
 * A frozen `failed` token: a real native result boundary that failed.
 *
 * `_submission` is accepted and discarded for the same reason as
 * {@link completedCompletion}.
 */
export function failedCompletion(
  _submission: RuntimeSubmission,
  error: Error,
): RuntimeCompletion {
  return Object.freeze({
    status: 'failed' as const,
    error,
  });
}

/**
 * Model a steer/fold: every member submission settles with the SAME frozen
 * completion object (`Object.is`-identical), built once from the first
 * (representative) member.
 */
export function foldSubmissions(
  members: readonly ControllableRuntimeSubmission[],
  resultText: string | null = null,
): RuntimeCompletion {
  const representative = members[0];
  if (representative === undefined) {
    throw new Error('foldSubmissions needs at least one submission');
  }
  const completion = completedCompletion(representative.submission, resultText);
  for (const member of members) {
    member.settle({ kind: 'completion', completion });
  }
  return completion;
}

/** An already-completed submission, for suites that never inspect settlement. */
export function completedRuntimeSubmission(
  resultText: string | null = null,
): RuntimeSubmission {
  const pending = controllableRuntimeSubmission();
  pending.complete(resultText);
  return pending.submission;
}
