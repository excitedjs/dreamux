/**
 * Core's one bounded, process-local duplicate-admission ledger, plus the
 * `TeammateService.submitInput` orchestration that sits on top of it.
 *
 * Two layers, two kinds of test:
 *
 * - `AdmissionLedger` itself is pure — no runtime, no identity store, no
 *   filesystem — so its concurrency, commit/release, and global-window rules
 *   are proven directly against the class.
 * - The properties that only exist at the orchestration boundary (a duplicate
 *   must not rewrite the durable recovery subject; the Agent Runtime seam
 *   never sees a source id; an ordinary submission reopens its target before
 *   the runtime is asked) are proven behaviorally against a real
 *   `TeammateService`, wired to a minimal fake Agent Runtime provider so no
 *   native process, network, or real Codex/Claude login is ever involved.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type {
  AgentRuntimeProvider,
  AgentRuntimeSubmissionInput,
  DreamuxLogger,
} from '@excitedjs/dreamux-types';

import type { AgentRuntimeProviderCatalog } from '../src/agent-runtime/index.js';
import type { ConversationProjection } from '../src/channel/conversation-projection.js';
import type { DreamuxConfig, ResolvedAgentConfig } from '../src/config/config.js';
import { AgentIdentityStore } from '../src/service/agent-entity/identity-store.js';
import {
  ADMISSION_SOURCE_WINDOW,
  AdmissionLedger,
  type AgentEntityLedgerKey,
} from '../src/service/teammate-service/admission-ledger.js';
import { createTeammateService } from '../src/service/teammate-service/factory.js';
import type { TeammateService } from '../src/service/teammate-service/index.js';
import type { Turn, TurnAdmission } from '../src/service/teammate-service/turn-recording.js';
import { reuseCwdWorktree } from '../src/service/worktree/manager.js';
import { controllableRuntimeSubmission } from './helpers/runtime-submission.js';

const silentLog = {
  error: () => {},
  warn: () => {},
  info: () => {},
  debug: () => {},
  trace: () => {},
  child: () => silentLog,
} as unknown as DreamuxLogger;

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
          ? { status: 'failed' as const, error: new Error('pre-admission failure') }
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
    await ledger.admit(a, 'shared-src', async () => submittedAdmission('a-turn'));
    // A different entity's identical sourceId is a fresh admission: the
    // entity itself is part of the key, so committing `a` never touches `b`.
    const admissionForB = await ledger.admit(b, 'shared-src', async () =>
      submittedAdmission('b-turn'));
    expect(admissionForB.status).toBe('submitted');
  });

  it('shares ONE bounded window across every entity — filling it with one entity evicts admissions for another', async () => {
    const ledger = new AdmissionLedger();
    const filler = entity('filler');
    const watched = entity('watched');

    const watchedAdmission = await ledger.admit(watched, 'watched-src', async () =>
      submittedAdmission('watched-turn'));
    expect(watchedAdmission.status).toBe('submitted');
    // Immediately after commit, a repeat is still a duplicate.
    expect(
      await ledger.admit(watched, 'watched-src', async () => submittedAdmission('x')),
    ).toEqual({ status: 'duplicate' });

    // Push exactly ADMISSION_SOURCE_WINDOW more DIFFERENT commits through a
    // different entity. If the window were per-entity, none of this would
    // touch `watched`'s reservation; because it is one shared, bounded
    // window, this evicts `watched-src` once the window is exceeded.
    for (let i = 0; i < ADMISSION_SOURCE_WINDOW; i += 1) {
      await ledger.admit(filler, `filler-src-${i}`, async () => submittedAdmission(`f${i}`));
    }

    const afterEviction = await ledger.admit(watched, 'watched-src', async () =>
      submittedAdmission('watched-turn-2'));
    // The oldest committed key was evicted by the shared window filling up
    // with a completely different entity's admissions — proof there is no
    // second, per-entity registry keeping `watched-src` alive on its own.
    expect(afterEviction.status).toBe('submitted');
  }, 15_000);

  it('never survives a restart: a fresh ledger instance has no memory of a prior one’s commits', async () => {
    const before = new AdmissionLedger();
    const target = entity();
    await before.admit(target, 'src-1', async () => submittedAdmission('turn-1'));
    expect(
      await before.admit(target, 'src-1', async () => submittedAdmission('x')),
    ).toEqual({ status: 'duplicate' });

    // A process restart replaces the ledger object; nothing durable backs it.
    const after = new AdmissionLedger();
    const admission = await after.admit(target, 'src-1', async () =>
      submittedAdmission('turn-1-again'));
    expect(admission.status).toBe('submitted');
  });
});

// ---------------------------------------------------------------------------
// TeammateService.submitInput: the orchestration properties only visible at
// the real boundary (renderSubmission -> ledger.admit -> ensureStarted ->
// intent update -> runtime.submit).
// ---------------------------------------------------------------------------

const DISPATCHER = 'flow';
const RUNTIME_ID = 'fake-runtime';

interface Harness {
  readonly service: TeammateService;
  readonly order: string[];
  readonly submittedInputs: AgentRuntimeSubmissionInput[];
  readonly createRuntimeCalls: () => number;
  readonly cleanup: () => Promise<void>;
}

async function buildTeammateHarness(
  options: {
    name?: string;
    closed?: boolean;
    admissions?: AdmissionLedger;
    conversationProjection?: ConversationProjection;
  } = {},
): Promise<Harness> {
  const dir = await mkdtemp(join(tmpdir(), 'dreamux-submission-admission-'));
  const identities = new AgentIdentityStore({
    dir,
    dispatcherId: DISPATCHER,
    expectedName: null,
    log: silentLog,
  });
  let identity = await identities.create({
    name: options.name ?? 'worker',
    teamId: null,
    agentRuntime: RUNTIME_ID,
    sourceCwd: dir,
    sourceRepo: null,
    cwd: dir,
    runtimeCwd: dir,
    worktree: reuseCwdWorktree(dir),
    intent: null,
    identityPrompt: null,
    sessionId: null,
    status: 'running',
  });
  if (options.closed === true) {
    identity = await identities.update(identity, {
      status: 'closed',
      closedAt: Date.now(),
      closeNote: 'closed for the reopen test',
    });
  }

  const order: string[] = [];
  const submittedInputs: AgentRuntimeSubmissionInput[] = [];
  let createRuntimeCalls = 0;

  // The minimal Agent Runtime provider fake: everything the seam actually
  // exercises (createRuntime -> start -> submit), and nothing else. `submit`
  // records exactly what it received, which is how "no source id crosses the
  // seam" gets proven — by inspecting the real argument object, not by trust.
  const provider = {
    getCapabilities: () => ({ tags: [], publicConfig: null }),
    readRecentActivity: async () => ({ records: [], truncated: false }),
    async createRuntime() {
      createRuntimeCalls += 1;
      order.push('createRuntime');
      return {
        async start() {
          order.push('start');
          return { continuity: 'fresh' as const };
        },
        async submit(input: AgentRuntimeSubmissionInput) {
          order.push('submit');
          submittedInputs.push(input);
          const pending = controllableRuntimeSubmission();
          pending.complete(null);
          return { status: 'submitted' as const, submission: pending.submission };
        },
        async stop() {
          order.push('stop');
        },
      };
    },
  } as unknown as AgentRuntimeProvider<unknown>;

  const catalog = {
    resolve: () => ({ implementation: provider }),
  } as unknown as AgentRuntimeProviderCatalog;

  const config: DreamuxConfig = {
    agents: {
      [RUNTIME_ID]: { provider: 'fake', config: {} } as unknown as ResolvedAgentConfig,
    },
    dispatchers: [],
  };

  const admissions = options.admissions ?? new AdmissionLedger();
  const service = createTeammateService({
    config,
    agentRuntimeProviders: catalog,
    identities,
    admissions,
    ...(options.conversationProjection !== undefined
      ? { conversationProjection: options.conversationProjection }
      : {}),
    log: silentLog,
    dispatcherId: DISPATCHER,
    identity,
    options: { runtimeId: RUNTIME_ID, role: 'teammate', ownsWorktreeOnClose: false },
  });

  return {
    service,
    order,
    submittedInputs,
    createRuntimeCalls: () => createRuntimeCalls,
    cleanup: async () => {
      await rm(dir, { recursive: true, force: true });
    },
  };
}

const roots: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of roots.splice(0)) await cleanup();
});

async function harness(
  options?: Parameters<typeof buildTeammateHarness>[0],
): Promise<Harness> {
  const built = await buildTeammateHarness(options);
  roots.push(built.cleanup);
  return built;
}

describe('TeammateService.submitInput: starts or reopens the target before Runtime submission', () => {
  it('reopens a closed target and starts its runtime before the runtime ever sees a submission', async () => {
    const h = await harness({ closed: true });
    expect(h.service.current().status).toBe('closed');

    const admission = await h.service.submitInput({ source: 'channel', text: 'hello' });

    expect(admission.status).toBe('submitted');
    expect(h.order).toEqual(['createRuntime', 'start', 'submit']);
    expect(h.service.current().status).not.toBe('closed');
    expect(h.service.current().closed_at).toBeNull();
  });

  it('starts the runtime before submitting for an already-running (non-closed) target too', async () => {
    const h = await harness();
    await h.service.submitInput({ source: 'channel', text: 'hello' });
    expect(h.order).toEqual(['createRuntime', 'start', 'submit']);
  });
});

describe('TeammateService.submitInput: no source id crosses the Agent Runtime seam', () => {
  it('hands the runtime exactly { text } — sourceId and intent never appear on the submit payload', async () => {
    const h = await harness();
    await h.service.submitInput({
      source: 'channel',
      text: 'hi',
      sourceId: 'msg-77',
      intent: 'chat',
    });
    expect(h.submittedInputs).toHaveLength(1);
    expect(Object.keys(h.submittedInputs[0]!)).toEqual(['text']);
    expect(h.submittedInputs[0]!.text).toContain('hi');
  });
});

describe('TeammateService.submitInput: intent updates only a newly accepted turn', () => {
  it('records intent on a fresh admission, and a later duplicate never rewrites it', async () => {
    const h = await harness();

    const first = await h.service.submitInput({
      source: 'channel',
      text: 'first',
      sourceId: 's1',
      intent: 'first-intent',
    });
    expect(first.status).toBe('submitted');
    expect(h.service.current().intent).toBe('first-intent');

    const second = await h.service.submitInput({
      source: 'channel',
      text: 'second — must never reach the runtime',
      sourceId: 's1',
      intent: 'second-intent',
    });
    expect(second.status).toBe('duplicate');
    // The duplicate short-circuited before the admitted operation ran: the
    // recovery subject is untouched and the runtime saw exactly one submit.
    expect(h.service.current().intent).toBe('first-intent');
    expect(h.submittedInputs).toHaveLength(1);
  });
});

describe('TeammateService.submitInput: admission ledger bypass and joining, at the real boundary', () => {
  it('reaches the runtime every time when sourceId is omitted', async () => {
    const h = await harness();
    await h.service.submitInput({ source: 'channel', text: 'a' });
    await h.service.submitInput({ source: 'channel', text: 'b' });
    expect(h.submittedInputs).toHaveLength(2);
  });

  it('joins a concurrent repeat into one admission — the runtime is asked once and both callers observe the same turn', async () => {
    const h = await harness();
    const [a, b] = await Promise.all([
      h.service.submitInput({ source: 'channel', text: 'x', sourceId: 'dup-1' }),
      h.service.submitInput({ source: 'channel', text: 'x', sourceId: 'dup-1' }),
    ]);
    expect(h.createRuntimeCalls()).toBe(1);
    expect(h.submittedInputs).toHaveLength(1);
    expect(a).toBe(b);
    expect(a.status).toBe('submitted');
  });

  it('does not dedupe two different entities that happen to reuse the same source id, even sharing one ledger', async () => {
    const shared = new AdmissionLedger();
    const alpha = await harness({ name: 'alpha', admissions: shared });
    const beta = await harness({ name: 'beta', admissions: shared });

    const first = await alpha.service.submitInput({
      source: 'channel',
      text: 'to alpha',
      sourceId: 'shared-msg-id',
    });
    const second = await beta.service.submitInput({
      source: 'channel',
      text: 'to beta',
      sourceId: 'shared-msg-id',
    });

    expect(first.status).toBe('submitted');
    expect(second.status).toBe('submitted');
    expect(alpha.submittedInputs).toHaveLength(1);
    expect(beta.submittedInputs).toHaveLength(1);
  });
});

describe('TeammateService.submitInput: the conversation projection records the source body, not the rendered envelope', () => {
  it('projects the original text and caller id on a fresh admission — no envelope markup, and not the reminder', async () => {
    const projected: Array<{
      prompt: string | null;
      source: string;
      sourceId: string | null | undefined;
    }> = [];
    const conversationProjection: ConversationProjection = {
      projectSubmitted(_agent, turn) {
        projected.push({
          prompt: turn.prompt,
          source: turn.source,
          sourceId: turn.sourceId,
        });
      },
      projectActivity() {},
      projectSettled() {},
      projectNativeTurnEnd() {},
    };
    const h = await harness({ conversationProjection });

    await h.service.submitInput({
      source: 'channel',
      attrs: { chat: 'general' },
      text: 'hello there',
      reminder: 'stay on task',
      sourceId: 'message-fixture',
    });

    expect(projected).toHaveLength(1);
    // Exactly the caller's own body: not the `<channel chat="general">...`
    // start tag, not the closing tag, and not the trailing `<reminder>`
    // sibling — all three are delivery formatting `renderSubmission` adds on
    // top of `input.text`, which the turn never records (index.ts:
    // `prompt: input.text`).
    expect(projected[0]?.prompt).toBe('hello there');
    expect(projected[0]?.source).toBe('channel');
    expect(projected[0]?.sourceId).toBe('message-fixture');
  });

  it('never re-projects a duplicate: only the first admission of a repeated sourceId is recorded', async () => {
    const projected: string[] = [];
    const conversationProjection: ConversationProjection = {
      projectSubmitted(_agent, turn) {
        if (turn.prompt !== null) projected.push(turn.prompt);
      },
      projectActivity() {},
      projectSettled() {},
      projectNativeTurnEnd() {},
    };
    const h = await harness({ conversationProjection });

    await h.service.submitInput({ source: 'channel', text: 'first', sourceId: 'dup-2' });
    await h.service.submitInput({ source: 'channel', text: 'first, again', sourceId: 'dup-2' });

    expect(projected).toEqual(['first']);
  });
});

describe('TeammateService.prepareCompletion: completion delivery defaults to the reserved task-notification source', () => {
  it('renders the delivered turn under <task-notification>, never under the reporting teammate name or <channel>', async () => {
    const h = await harness();
    // A runtime has to already be running for prepareCompletion to proceed
    // (index.ts: `existingRuntimeAfterStart` returns null otherwise), so start
    // it with one ordinary submission first.
    await h.service.submitInput({ source: 'channel', text: 'get started' });
    expect(h.submittedInputs).toHaveLength(1);

    const delivery = await h.service.prepareCompletion({
      kind: 'teammate',
      source: 'reporter-agent',
      status: 'completed',
      result: 'the work is done',
    });
    const result = await delivery.submit();

    expect(result.status).toBe('accepted');
    expect(h.submittedInputs).toHaveLength(2);
    const deliveredText = h.submittedInputs[1]?.text ?? '';
    expect(deliveredText.startsWith('<task-notification')).toBe(true);
    expect(deliveredText).not.toMatch(/^<channel/);
  });
});
