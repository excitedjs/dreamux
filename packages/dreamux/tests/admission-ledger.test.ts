/**
 * Core's one bounded, process-local duplicate-admission ledger.
 *
 * `AdmissionLedger` itself is pure — no runtime, no identity store, no
 * filesystem — so its concurrency, commit/release, and global-window rules
 * are proven directly against the class.
 */
import { describe, expect, it } from 'vitest';

import {
  ADMISSION_SOURCE_WINDOW,
  AdmissionLedger,
  type AgentEntityLedgerKey,
} from '../src/service/teammate-service/admission-ledger.js';
import type {
  Turn,
  TurnAdmission,
} from '../src/service/teammate-service/turn-recording.js';

function entity(name = 'worker'): AgentEntityLedgerKey {
  return { dispatcherId: 'flow', teamId: null, name };
}

function submittedAdmission(id: string): TurnAdmission {
  return { status: 'submitted', turn: { id } as unknown as Turn };
}

// ---------------------------------------------------------------------------
// AdmissionLedger: pure, direct tests.
// ---------------------------------------------------------------------------

describe('AdmissionLedger: bypass for an unbounded source id', () => {
  it('runs the operation every time when sourceId is omitted', async () => {
    const ledger = new AdmissionLedger();
    let calls = 0;
    const op = async () => {
      calls += 1;
      return submittedAdmission(String(calls));
    };
    await ledger.admit(entity(), undefined, op);
    await ledger.admit(entity(), undefined, op);
    expect(calls).toBe(2);
  });

  it('runs the operation every time when sourceId is the empty string', async () => {
    const ledger = new AdmissionLedger();
    let calls = 0;
    const op = async () => {
      calls += 1;
      return submittedAdmission(String(calls));
    };
    await ledger.admit(entity(), '', op);
    await ledger.admit(entity(), '', op);
    expect(calls).toBe(2);
  });
});

describe('AdmissionLedger: concurrent repeats join the same pending admission', () => {
  it('never invokes the operation twice for two concurrent calls with the same key', async () => {
    const ledger = new AdmissionLedger();
    let calls = 0;
    let release!: (admission: TurnAdmission) => void;
    const op = () =>
      new Promise<TurnAdmission>((resolve) => {
        calls += 1;
        release = resolve;
      });

    const first = ledger.admit(entity(), 'src-1', op);
    const second = ledger.admit(entity(), 'src-1', op);
    // `admit` schedules `operation()` via `Promise.resolve().then(...)`
    // (so a synchronous throw inside `admit` itself can never leak past the
    // reservation); flush one microtask turn before observing the call count.
    await Promise.resolve();
    expect(calls).toBe(1);

    const admission = submittedAdmission('turn-1');
    release(admission);
    const [a, b] = await Promise.all([first, second]);
    // Both callers observe the exact same admission object — a real join, not
    // two calls that happen to agree.
    expect(a).toBe(admission);
    expect(b).toBe(admission);
  });

  it('a repeat that arrives after the first commits observes `duplicate` without a second operation call', async () => {
    const ledger = new AdmissionLedger();
    let calls = 0;
    const op = async () => {
      calls += 1;
      return submittedAdmission('turn-1');
    };
    const first = await ledger.admit(entity(), 'src-1', op);
    expect(first.status).toBe('submitted');
    const second = await ledger.admit(entity(), 'src-1', op);
    expect(second).toEqual({ status: 'duplicate' });
    expect(calls).toBe(1);
  });
});

describe('AdmissionLedger: commit on submitted/ambiguous, release on failed/stopped/skipped', () => {
  it('commits on `submitted`', async () => {
    const ledger = new AdmissionLedger();
    let calls = 0;
    await ledger.admit(entity(), 'src-1', async () => {
      calls += 1;
      return submittedAdmission('turn-1');
    });
    const repeat = await ledger.admit(entity(), 'src-1', async () => {
      calls += 1;
      return submittedAdmission('turn-2');
    });
    expect(repeat).toEqual({ status: 'duplicate' });
    expect(calls).toBe(1);
  });

  it('commits on `ambiguous` — an uncertain provider-seam crossing must not be retried automatically', async () => {
    const ledger = new AdmissionLedger();
    let calls = 0;
    await ledger.admit(entity(), 'src-1', async () => {
      calls += 1;
      return { status: 'ambiguous', error: new Error('crossed the seam') };
    });
    const repeat = await ledger.admit(entity(), 'src-1', async () => {
      calls += 1;
      return submittedAdmission('turn-2');
    });
    expect(repeat).toEqual({ status: 'duplicate' });
    expect(calls).toBe(1);
  });

  it.each(['failed', 'stopped', 'skipped'] as const)(
    'releases the key on `%s` so a genuine retry still runs the operation',
    async (status) => {
      const ledger = new AdmissionLedger();
      let calls = 0;
      const first = await ledger.admit(entity(), 'src-1', async () => {
        calls += 1;
        return status === 'failed'
          ? {
              status: 'failed' as const,
              error: new Error('pre-admission failure'),
            }
          : { status };
      });
      expect(first.status).toBe(status);
      const retry = await ledger.admit(entity(), 'src-1', async () => {
        calls += 1;
        return submittedAdmission('turn-2');
      });
      expect(retry.status).toBe('submitted');
      expect(calls).toBe(2);
    },
  );

  it('releases the key when the operation rejects outright (pre-admission failure, not a thrown TurnAdmission)', async () => {
    const ledger = new AdmissionLedger();
    let calls = 0;
    await expect(
      ledger.admit(entity(), 'src-1', async () => {
        calls += 1;
        throw new Error('start failed before the provider seam');
      }),
    ).rejects.toThrow(/start failed/);
    const retry = await ledger.admit(entity(), 'src-1', async () => {
      calls += 1;
      return submittedAdmission('turn-2');
    });
    expect(retry.status).toBe('submitted');
    expect(calls).toBe(2);
  });
});

describe('AdmissionLedger: one global ledger, no per-entity child registry, no cross-restart survival', () => {
  it('does not collide across two different entities that reuse the same source id', async () => {
    const ledger = new AdmissionLedger();
    const a = entity('agent-a');
    const b = entity('agent-b');
    await ledger.admit(a, 'shared-src', async () =>
      submittedAdmission('a-turn'),
    );
    // A different entity's identical sourceId is a fresh admission: the
    // entity itself is part of the key, so committing `a` never touches `b`.
    const admissionForB = await ledger.admit(b, 'shared-src', async () =>
      submittedAdmission('b-turn'),
    );
    expect(admissionForB.status).toBe('submitted');
  });

  it('shares ONE bounded window across every entity — filling it with one entity evicts admissions for another', async () => {
    const ledger = new AdmissionLedger();
    const filler = entity('filler');
    const watched = entity('watched');

    const watchedAdmission = await ledger.admit(
      watched,
      'watched-src',
      async () => submittedAdmission('watched-turn'),
    );
    expect(watchedAdmission.status).toBe('submitted');
    // Immediately after commit, a repeat is still a duplicate.
    expect(
      await ledger.admit(watched, 'watched-src', async () =>
        submittedAdmission('x'),
      ),
    ).toEqual({ status: 'duplicate' });

    // Push exactly ADMISSION_SOURCE_WINDOW more DIFFERENT commits through a
    // different entity. If the window were per-entity, none of this would
    // touch `watched`'s reservation; because it is one shared, bounded
    // window, this evicts `watched-src` once the window is exceeded.
    for (let i = 0; i < ADMISSION_SOURCE_WINDOW; i += 1) {
      await ledger.admit(filler, `filler-src-${i}`, async () =>
        submittedAdmission(`f${i}`),
      );
    }

    const afterEviction = await ledger.admit(watched, 'watched-src', async () =>
      submittedAdmission('watched-turn-2'),
    );
    // The oldest committed key was evicted by the shared window filling up
    // with a completely different entity's admissions — proof there is no
    // second, per-entity registry keeping `watched-src` alive on its own.
    expect(afterEviction.status).toBe('submitted');
  }, 15_000);

  it('never survives a restart: a fresh ledger instance has no memory of a prior one’s commits', async () => {
    const before = new AdmissionLedger();
    const target = entity();
    await before.admit(target, 'src-1', async () =>
      submittedAdmission('turn-1'),
    );
    expect(
      await before.admit(target, 'src-1', async () => submittedAdmission('x')),
    ).toEqual({ status: 'duplicate' });

    // A process restart replaces the ledger object; nothing durable backs it.
    const after = new AdmissionLedger();
    const admission = await after.admit(target, 'src-1', async () =>
      submittedAdmission('turn-1-again'),
    );
    expect(admission.status).toBe('submitted');
  });
});
