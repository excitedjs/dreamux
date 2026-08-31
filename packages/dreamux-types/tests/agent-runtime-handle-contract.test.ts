/**
 * AgentRuntime live-handle contract (issue #209 minimal-provider-boundaries).
 *
 * `@excitedjs/dreamux-types` emits no runtime JS, so the contract itself — not
 * a running implementation — is the product. These are compile-time
 * conformance checks (validated by `tsc -p tsconfig.tests.json`, not by
 * `vitest run`, which strips types via esbuild) paired with small behavioral
 * checks against a hand-built fake handle wherever a real runtime assertion is
 * possible.
 *
 * Why this file exists: the minimize-provider-boundaries refactor deliberately
 * shrank the live `AgentRuntime` handle to `start`/`submit`/`stop` and deleted
 * every pull-style member (`resume`, `waitIdle`, `getStatus`, `getCheckpoint`,
 * `wasCheckpointResumed`, `getContext`, handle-level `getCapabilities`/
 * `providerRef`). A provider author who accidentally widens the interface, or
 * a future PR that quietly resurrects one of those members, must fail this
 * file's compile step.
 */
import { describe, expect, it } from 'vitest';

import type {
  AgentRuntime,
  AgentRuntimeStartOutcome,
  AgentRuntimeSubmissionInput,
  RuntimeAdmission,
  RuntimeCompletion,
  RuntimeSubmission,
  RuntimeSubmissionSettlement,
} from '../src/agent-runtime.js';

/**
 * Compile-time type equality. The double-conditional trick (rather than a
 * naive `A extends B ? B extends A : false`) stays correct across unions and
 * optional members, which a naive mutual-extends check can misjudge.
 */
type Equal<A, B> = (<T>() => T extends A ? 1 : 0) extends <T>() => T extends B
  ? 1
  : 0
  ? true
  : false;

/**
 * The vehicle for a compile-time-only assertion: calling `assertType<Equal<A,
 * B>>()` fails `tsc` with "Type 'false' does not satisfy the constraint
 * 'true'" if `A` and `B` diverge, and is a runtime no-op otherwise.
 */
function assertType<T extends true>(_proof?: T): void {
  // Intentionally empty: the check is the generic constraint above, not this body.
}

/** Exhaustiveness vehicle: a new union member breaks every `default: assertNever(x)` call site. */
function assertNever(value: never): never {
  throw new Error(`unreachable union member: ${JSON.stringify(value)}`);
}

describe('AgentRuntime live handle exposes exactly start, submit, stop', () => {
  it('the interface has no member beyond start/submit/stop', () => {
    // Proves absence-by-construction: `keyof` on a plain (non-extending)
    // interface is exactly its declared member set. If `resume`, `waitIdle`,
    // `getStatus`, `getCheckpoint`, `wasCheckpointResumed`, `getContext`, or a
    // handle-level `getCapabilities`/`providerRef` were reintroduced, this
    // equality would fail to compile.
    assertType<Equal<keyof AgentRuntime, 'start' | 'submit' | 'stop'>>();
  });

  it('a fake object with only start/submit/stop satisfies AgentRuntime end-to-end', async () => {
    let seenInput: AgentRuntimeSubmissionInput | undefined;
    let stopped = false;

    const settlement: RuntimeSubmissionSettlement = {
      kind: 'completion',
      completion: { status: 'completed', resultText: 'ack', truncated: false },
    };
    const submission: RuntimeSubmission = { settled: Promise.resolve(settlement) };

    // This object literal is checked against the full `AgentRuntime` shape by
    // TypeScript's excess-property check: it would be a compile error to omit
    // any of the three required members, and (for a literal specifically) an
    // error to add an unknown one.
    const handle: AgentRuntime = {
      async start(): Promise<AgentRuntimeStartOutcome> {
        return { continuity: 'fresh' };
      },
      async submit(input: AgentRuntimeSubmissionInput): Promise<RuntimeAdmission> {
        seenInput = input;
        return { status: 'submitted', submission };
      },
      async stop(): Promise<void> {
        stopped = true;
      },
    };

    const outcome = await handle.start();
    expect(outcome.continuity).toBe('fresh');

    const admission = await handle.submit({ text: 'hello agent' });
    expect(seenInput).toEqual({ text: 'hello agent' });
    expect(admission.status).toBe('submitted');

    await handle.stop();
    expect(stopped).toBe(true);
  });
});

describe('AgentRuntimeSubmissionInput carries exactly { text: string }', () => {
  it('no kind, source, sourceId, attrs, or rendering instruction crosses the seam', () => {
    assertType<Equal<keyof AgentRuntimeSubmissionInput, 'text'>>();
  });

  it('a bare { text } literal is the only accepted submission shape', () => {
    const input: AgentRuntimeSubmissionInput = { text: 'plain text only' };
    expect(Object.keys(input)).toEqual(['text']);
  });
});

describe('RuntimeAdmission is exactly submitted | stopped | skipped | failed | ambiguous', () => {
  it('the status union carries no duplicate branch', () => {
    assertType<
      Equal<
        RuntimeAdmission['status'],
        'submitted' | 'stopped' | 'skipped' | 'failed' | 'ambiguous'
      >
    >();
  });

  it('only the submitted branch carries a RuntimeSubmission; failed/ambiguous carry an Error', () => {
    assertType<
      Equal<keyof Extract<RuntimeAdmission, { status: 'submitted' }>, 'status' | 'submission'>
    >();
    assertType<Equal<keyof Extract<RuntimeAdmission, { status: 'stopped' }>, 'status'>>();
    assertType<Equal<keyof Extract<RuntimeAdmission, { status: 'skipped' }>, 'status'>>();
    assertType<
      Equal<keyof Extract<RuntimeAdmission, { status: 'failed' }>, 'status' | 'error'>
    >();
    assertType<
      Equal<keyof Extract<RuntimeAdmission, { status: 'ambiguous' }>, 'status' | 'error'>
    >();
  });

  it('every admission is reachable through an exhaustive switch with no leftover branch', () => {
    // A real behavioral proof: this function is only well-typed if the union
    // has exactly these five members. Adding a sixth (e.g. reviving
    // `duplicate` on this provider seam) makes the `default` branch's
    // `assertNever(admission)` call fail to compile, because `admission`
    // would no longer narrow to `never` there.
    function classify(admission: RuntimeAdmission): string {
      switch (admission.status) {
        case 'submitted':
          return 'submitted';
        case 'stopped':
          return 'stopped';
        case 'skipped':
          return 'skipped';
        case 'failed':
          return 'failed';
        case 'ambiguous':
          return 'ambiguous';
        default:
          return assertNever(admission);
      }
    }

    const submission: RuntimeSubmission = {
      settled: Promise.resolve<RuntimeSubmissionSettlement>({ kind: 'stopped' }),
    };
    expect(classify({ status: 'submitted', submission })).toBe('submitted');
    expect(classify({ status: 'stopped' })).toBe('stopped');
    expect(classify({ status: 'skipped' })).toBe('skipped');
    expect(classify({ status: 'failed', error: new Error('boom') })).toBe('failed');
    expect(classify({ status: 'ambiguous', error: new Error('boom') })).toBe('ambiguous');
  });
});

describe('RuntimeCompletion has no displaySubmission member', () => {
  it('the completed branch carries only status/resultText/truncated', () => {
    assertType<
      Equal<
        keyof Extract<RuntimeCompletion, { status: 'completed' }>,
        'status' | 'resultText' | 'truncated'
      >
    >();
  });

  it('the failed branch carries only status/error', () => {
    assertType<Equal<keyof Extract<RuntimeCompletion, { status: 'failed' }>, 'status' | 'error'>>();
  });
});

describe('RuntimeSubmissionSettlement is exactly completion | failed | stopped', () => {
  it('the kind union has no extra member', () => {
    assertType<Equal<RuntimeSubmissionSettlement['kind'], 'completion' | 'failed' | 'stopped'>>();
  });

  it('every settlement resolves through an exhaustive switch', () => {
    function describeSettlement(settlement: RuntimeSubmissionSettlement): string {
      switch (settlement.kind) {
        case 'completion':
          return settlement.completion.status;
        case 'failed':
          return settlement.error.message;
        case 'stopped':
          return 'stopped';
        default:
          return assertNever(settlement);
      }
    }

    expect(
      describeSettlement({
        kind: 'completion',
        completion: { status: 'completed', resultText: null, truncated: false },
      }),
    ).toBe('completed');
    expect(describeSettlement({ kind: 'failed', error: new Error('nope') })).toBe('nope');
    expect(describeSettlement({ kind: 'stopped' })).toBe('stopped');
  });
});
