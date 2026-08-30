/**
 * Cell E (completion half) — the completion delivery BOUNDARY, distinct from
 * the token-routing fold/queue contract already covered by
 * `completion-token-routing.test.ts` and the retry/preparation state machine
 * already covered by `completion-router.test.ts`.
 *
 * This file proves four things the router/state-machine tests do not:
 *
 * 1. `deliverCompletion` is a Core-only callback — the model never sees it, and
 *    a delivered completion opens under the fixed `task-notification`
 *    provenance name (`COMPLETION_SOURCE`), never something a caller invents.
 * 2. Operator failure-ledger item 13: completion ownership is stated by the
 *    real caller as an explicit fact, never re-derived from which adapter
 *    (Channel vs `admin.sock`) carried the call. This is a source-shape guard
 *    because the CONTRACT under test is an absence — no
 *    `isChannelInvocation`-style branch anywhere on this path — which no
 *    behavioral test can observe by construction.
 * 3. A `null` provider token (an internally `failed`/`stopped` turn, which
 *    never produced a native result) still reaches its recipient, is never
 *    folded with another null-token delivery, and never touches the
 *    token-keyed dedupe map a REAL completion for the same producer uses.
 * 4. `EntityTurnCoordinator` never gates presentation on `role`: a
 *    `dispatcher`-role entity's completion-source turn is projected exactly
 *    like any other role's, so Dispatcher presentation cannot be silently
 *    erased by a `role === 'dispatcher'`-shaped filter reappearing here.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it, vi } from 'vitest';

import type {
  AgentRuntimeSkillSource,
  ChannelCoreEvent,
  DreamuxLogger,
  RuntimeAdmission,
  TeammateRole,
} from '@excitedjs/dreamux-types';

import {
  createConversationProjection,
  type ConversationProjection,
  type ProjectedAgent,
} from '../src/channel/conversation-projection.js';
import type { AgentEntityIdentity } from '../src/service/agent-entity/types.js';
import {
  CompletionDeliveryPolicy,
  type CompletionDeliveryResult,
  type CompletionInitiator,
  type PreparedCompletionDelivery,
  type PreparedCompletionFact,
} from '../src/service/completion-router/index.js';
import type { DispatcherCoreEventPublisher } from '../src/service/dispatcher-core-events/index.js';
import { COMPLETION_SOURCE } from '../src/service/submission-sources.js';
import {
  renderSubmission,
  type TeammateSubmitInput,
} from '../src/service/teammate-service/submission.js';
import { EntityTurnCoordinator } from '../src/service/teammate-service/turn-coordinator.js';
import type { TurnCompletionDelivery } from '../src/service/teammate-service/turn-recording.js';
import {
  completedCompletion,
  controllableRuntimeSubmission,
} from './helpers/runtime-submission.js';

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

function readSource(relPath: string): string {
  return readFileSync(join(packageRoot, relPath), 'utf8');
}

/* -------------------------------------------------------------------------
 * 1. Core-only callback: never rendered, delivered source is task-notification
 * ---------------------------------------------------------------------- */

describe('deliverCompletion is a Core-only callback, never part of the model envelope', () => {
  it('COMPLETION_SOURCE is the fixed provenance name a delivered completion opens under', () => {
    // teammate-service/index.ts renders a prepared completion body under this
    // exact constant (`renderSubmission({ source: COMPLETION_SOURCE, ... })`);
    // pinning the value here is what makes that call site's contract testable
    // without constructing the whole TeammateService.
    expect(COMPLETION_SOURCE).toBe('task-notification');
  });

  it('the actual delivery call site renders under COMPLETION_SOURCE, not a locally re-derived literal', () => {
    // Pinning only the constant's value would still pass if the call site
    // switched to a hardcoded 'task-notification' string or a different
    // source entirely — tie the two together at the source-text level, the
    // same way the other shape guards in this file do.
    const teammateServiceText = readSource('src/service/teammate-service/index.ts');
    expect(teammateServiceText).toMatch(/source:\s*COMPLETION_SOURCE/u);
  });

  it('renders identically whether or not a deliverCompletion callback is attached', () => {
    const deliverCompletion: TurnCompletionDelivery = vi.fn(async () => undefined);
    const body = 'TeamMate worker has finished its task. Output below:\n\ndone';

    const withCallback: TeammateSubmitInput = {
      source: COMPLETION_SOURCE,
      text: body,
      deliverCompletion,
    };
    const withoutCallback: TeammateSubmitInput = {
      source: COMPLETION_SOURCE,
      text: body,
    };

    const rendered = renderSubmission(withCallback);

    // Only `source`, `attrs`, `text`, `reminder` participate: attaching a
    // callback function changes nothing about what the model reads, and the
    // callback is never invoked as a side effect of rendering.
    expect(rendered).toBe(renderSubmission(withoutCallback));
    expect(rendered).toBe(`<task-notification>${body}</task-notification>`);
    expect(deliverCompletion).not.toHaveBeenCalled();
  });
});

/* -------------------------------------------------------------------------
 * 2. Ledger #13 — ownership belongs to the real caller, never the adapter
 * ---------------------------------------------------------------------- */

describe('completion ownership: never inferred from the transport adapter (failure-ledger #13)', () => {
  // Every module on the completion-delivery path a Channel-vs-admin check
  // could plausibly be smuggled into.
  const guardedFiles = [
    'src/service/completion-router/index.ts',
    'src/service/team-service/completion-targets.ts',
    'src/service/team-service/index.ts',
    'src/service/teammate-service/index.ts',
    'src/service/teammate-service/turn-coordinator.ts',
    'src/service/teammate-service/turn-recording.ts',
    'src/service/teammate-service/submission.ts',
    'src/service/dispatcher-service/index.ts',
    'src/service/team-collection/commands.ts',
    'src/service/team-collection/mcp-delegate.ts',
  ];

  it('never reintroduces an isChannelInvocation-style adapter branch on the completion path', () => {
    for (const relPath of guardedFiles) {
      const text = readSource(relPath);
      expect(
        text,
        `${relPath} must not branch on isChannelInvocation; completion ownership ` +
          'belongs to the caller, not the transport that carried the call',
      ).not.toMatch(/isChannelInvocation/u);
    }
  });

  it('states deliverCompletionToDispatcher as a caller-supplied literal at both call sites, never a computed adapter check', () => {
    const dispatcherServiceText = readSource('src/service/dispatcher-service/index.ts');
    // submitToTeamLeader forwards the flag it was handed; it must never
    // recompute it by inspecting what kind of call carried the request.
    expect(dispatcherServiceText).toMatch(
      /deliverCompletionToDispatcher\s*\?\s*\{\s*initiator:/u,
    );
    expect(dispatcherServiceText).not.toMatch(
      /(instanceof|adapter|\.kind\s*===)[^\n]*deliverCompletionToDispatcher/iu,
    );

    // The Agent-to-Team MCP delegate is a Core-side caller waiting for the
    // answer, so it states `true` outright.
    const mcpDelegateText = readSource('src/service/team-collection/mcp-delegate.ts');
    expect(mcpDelegateText).toMatch(/deliverCompletionToDispatcher:\s*true/u);

    // The Channel-facing `team.submit` Command has no Core-side waiter,
    // whichever adapter (Channel or admin.sock) carried it, so it states
    // `false` outright rather than branching on the adapter.
    const commandsText = readSource('src/service/team-collection/commands.ts');
    expect(commandsText).toMatch(/deliverCompletionToDispatcher:\s*false/u);
  });
});

/* -------------------------------------------------------------------------
 * 3. Null-token delivery: FAILED/STOPPED reach the recipient, distinctly
 * ---------------------------------------------------------------------- */

/** Records every user-visible send attempt the router actually makes. */
class RecordingInitiator implements CompletionInitiator {
  readonly prepared: PreparedCompletionFact[] = [];
  readonly submitted: PreparedCompletionFact[] = [];

  async prepareCompletion(
    fact: PreparedCompletionFact,
  ): Promise<PreparedCompletionDelivery> {
    this.prepared.push(fact);
    return Object.freeze({
      submit: async (): Promise<CompletionDeliveryResult> => {
        this.submitted.push(fact);
        return { status: 'accepted' };
      },
    });
  }
}

function policy(): CompletionDeliveryPolicy {
  return new CompletionDeliveryPolicy({ dispatcherId: 'flow', log: noopLog() });
}

function failedFact(source = 'worker'): PreparedCompletionFact {
  return { kind: 'teammate', source, status: 'failed', result: null };
}

function stoppedFact(source = 'worker'): PreparedCompletionFact {
  return { kind: 'teammate', source, status: 'stopped', result: null };
}

describe('null-token completion delivery: an internal failed/stopped turn still reaches its recipient', () => {
  it('delivers a failed outcome that carries no native token', async () => {
    const recipient = new RecordingInitiator();
    const fact = failedFact();

    await policy().deliverRuntime(recipient, null, fact);

    expect(recipient.submitted).toEqual([fact]);
  });

  it('delivers a stopped outcome that carries no native token', async () => {
    const recipient = new RecordingInitiator();
    const fact = stoppedFact();

    await policy().deliverRuntime(recipient, null, fact);

    expect(recipient.submitted).toEqual([fact]);
  });

  it('is a distinct path from a successful completion: status and result are not conflated', async () => {
    const recipient = new RecordingInitiator();
    const router = policy();
    const completedFact: PreparedCompletionFact = {
      kind: 'teammate',
      source: 'worker',
      status: 'completed',
      result: 'done',
    };
    const token = completedCompletion(controllableRuntimeSubmission().submission, 'done');

    await router.deliverRuntime(recipient, null, failedFact());
    await router.deliverRuntime(recipient, token, completedFact);

    expect(recipient.submitted).toEqual([failedFact(), completedFact]);
    expect(recipient.submitted[0]?.status).toBe('failed');
    expect(recipient.submitted[1]?.status).toBe('completed');
  });

  it('never folds two null-token deliveries, even with byte-identical fact content', async () => {
    // A real provider token is the ONLY fold identity the router recognizes
    // (see completion-token-routing.test.ts). `null` carries none, so two
    // internal failures/stops for the same producer are two separate turns
    // the recipient must be told about individually, not a single collapsed
    // push the way a folded steer would be.
    const recipient = new RecordingInitiator();
    const router = policy();

    await router.deliverRuntime(recipient, null, stoppedFact());
    await router.deliverRuntime(recipient, null, stoppedFact());

    expect(recipient.submitted).toHaveLength(2);
  });

  it('does not consume or corrupt the token-keyed dedupe entry a later real completion from the same producer uses', async () => {
    const recipient = new RecordingInitiator();
    const router = policy();
    const completedFact: PreparedCompletionFact = {
      kind: 'teammate',
      source: 'worker',
      status: 'completed',
      result: 'done',
    };
    const token = completedCompletion(controllableRuntimeSubmission().submission, 'done');

    await router.deliverRuntime(recipient, null, failedFact());
    // Register the SAME real token twice: this only collapses to one send if
    // the token-keyed dedupe map still works correctly after the null-token
    // delivery above touched the router.
    await router.deliverRuntime(recipient, token, completedFact);
    await router.deliverRuntime(recipient, token, completedFact);

    expect(recipient.submitted).toEqual([failedFact(), completedFact]);
  });
});

/* -------------------------------------------------------------------------
 * Delivery-boundary resilience: timeouts are reported, a bad recipient can't
 * break the producer's own settlement.
 * ---------------------------------------------------------------------- */

const okCompletion: PreparedCompletionFact = {
  kind: 'teammate',
  source: 'worker',
  status: 'completed',
  result: 'done',
};

describe('completion delivery boundary: a failing recipient cannot break the producer', () => {
  it('logs a timeout as reported news rather than silently vanishing', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const warn = vi.fn();
      const preparation = new Promise<PreparedCompletionDelivery>(() => {
        // Never settles: the deadline is what ends this delivery.
      });
      const initiator: CompletionInitiator = {
        prepareCompletion: vi.fn(() => preparation),
      };
      const router = new CompletionDeliveryPolicy({
        dispatcherId: 'flow',
        log: noopLog(warn),
        attemptTimeoutMs: 50,
      });

      const delivery = router.deliver(initiator, okCompletion);
      await vi.advanceTimersByTimeAsync(50);
      await delivery;

      expect(warn).toHaveBeenCalledTimes(1);
      const [fields, message] = warn.mock.calls[0] as [Record<string, unknown>, string];
      expect(message).toMatch(/timed out/u);
      expect(fields['timeout_ms']).toBe(50);
    } finally {
      vi.useRealTimers();
    }
  });

  it('never rejects the producer-facing delivery when the recipient throws synchronously while preparing', async () => {
    const initiator: CompletionInitiator = {
      prepareCompletion: () => {
        throw new Error('recipient exploded before returning a promise');
      },
    };

    await expect(policy().deliver(initiator, okCompletion)).resolves.toBeUndefined();
  });

  it('never rejects the producer-facing delivery after a persistently failing submit exhausts every retry', async () => {
    const initiator: CompletionInitiator = {
      prepareCompletion: async () =>
        Object.freeze({
          submit: async (): Promise<CompletionDeliveryResult> => ({
            status: 'failed',
            error: new Error('recipient transport is down'),
          }),
        }),
    };

    await expect(policy().deliver(initiator, okCompletion)).resolves.toBeUndefined();
  });
});

/* -------------------------------------------------------------------------
 * 4. Dispatcher presentation is not silently erased by a role filter
 * ---------------------------------------------------------------------- */

/** Records every projection call, keyed by the entry point that produced it. */
class RecordingProjection implements ConversationProjection {
  readonly submittedRoles: TeammateRole[] = [];
  readonly settledRoles: TeammateRole[] = [];

  projectSubmitted(agent: ProjectedAgent): void {
    this.submittedRoles.push(agent.role);
  }

  projectActivity(): void {
    // Not exercised by this suite.
  }

  projectSettled(input: { agent: ProjectedAgent }): void {
    this.settledRoles.push(input.agent.role);
  }
}

function fakeIdentity(overrides: Partial<AgentEntityIdentity> = {}): AgentEntityIdentity {
  const now = Date.now();
  return {
    version: 1,
    dispatcher_id: 'flow',
    name: 'dispatcher',
    team_id: null,
    agent_runtime: 'fake-runtime',
    session: null,
    source_cwd: '/tmp/src',
    source_repo: null,
    cwd: '/tmp/cwd',
    runtime_cwd: '/tmp/run',
    worktree: {
      mode: 'reuse-cwd',
      slug: null,
      path: '/tmp/cwd',
      branch: null,
      base_ref: null,
      cleanup: 'keep',
      cleanup_state: 'not-managed',
      cleanup_error: null,
    },
    intent: null,
    identity_prompt: null,
    skill_sources: [] as readonly AgentRuntimeSkillSource[],
    created_at: now,
    updated_at: now,
    status: 'running',
    last_error: null,
    closed_at: null,
    close_note: null,
    ...overrides,
  };
}

function noopLog(warn?: (...args: unknown[]) => void): DreamuxLogger {
  const log = {
    info: () => undefined,
    warn: warn ?? (() => undefined),
    error: () => undefined,
    debug: () => undefined,
    trace: () => undefined,
    child: () => log,
  };
  return log as DreamuxLogger;
}

/** Build a coordinator that projects into `projection` under one fixed role. */
function coordinatorFor(
  role: TeammateRole,
  projection: ConversationProjection,
  identity: AgentEntityIdentity,
): EntityTurnCoordinator {
  return new EntityTurnCoordinator({
    identity: () => identity,
    role,
    intent: () => null,
    isActive: () => true,
    conversationProjection: projection,
    log: noopLog(),
  });
}

/** Poll microtasks until `predicate` is true or attempts are exhausted. */
async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (predicate()) return;
    await Promise.resolve();
  }
  throw new Error('condition was not reached');
}

describe('EntityTurnCoordinator projects a completion-source turn regardless of role (failure-ledger #13)', () => {
  it.each([
    ['dispatcher', fakeIdentity({ name: 'dispatcher', team_id: null })],
    ['team_leader', fakeIdentity({ name: 'leader', team_id: 'alpha' })],
    ['teammate', fakeIdentity({ name: 'worker', team_id: 'alpha' })],
  ] as const)(
    'projects both submission and settlement for a %s-role entity delivering a completion',
    async (role, identity) => {
      const projection = new RecordingProjection();
      const coordinator = coordinatorFor(role, projection, identity);
      const runtime = controllableRuntimeSubmission();
      const admission: RuntimeAdmission = {
        status: 'submitted',
        submission: runtime.submission,
      };

      const resultPromise = coordinator.submitCompletion(
        async () => admission,
        { source: COMPLETION_SOURCE, prompt: 'TeamMate worker has finished its task.' },
      );
      runtime.complete('done');
      await resultPromise;

      // The submitted projection fires synchronously inside admission —
      // no branch inside the coordinator ever skips it for a particular role.
      expect(projection.submittedRoles).toEqual([role]);

      await waitFor(() => projection.settledRoles.length === 1);
      expect(projection.settledRoles).toEqual([role]);
    },
  );

  it('a dispatcher-role completion delivery is projected exactly like any other role, never dropped by a role check', async () => {
    // This is the concrete regression class failure-ledger item 13 names: a
    // `role === 'dispatcher'`-shaped filter silently erasing Dispatcher
    // presentation. There is no such branch in EntityTurnCoordinator today —
    // this test fails the moment one is added back.
    const projection = new RecordingProjection();
    const identity = fakeIdentity({ name: 'dispatcher', team_id: null });
    const coordinator = coordinatorFor('dispatcher', projection, identity);
    const runtime = controllableRuntimeSubmission();

    await coordinator.submitCompletion(
      async () => ({ status: 'submitted', submission: runtime.submission }),
      { source: COMPLETION_SOURCE, prompt: 'Workflow report-1 has completed.' },
    );

    expect(projection.submittedRoles).toEqual(['dispatcher']);
  });
});

/* -------------------------------------------------------------------------
 * 4b. Same claim, through the REAL conversation projection.
 *
 * The coordinator tests above prove EntityTurnCoordinator itself has no role
 * gate, but the one actual `role === 'dispatcher'` branch on this whole path
 * lives one layer down, in `eventScope` (conversation-projection.ts). A test
 * that swaps in a fake `ConversationProjection` never exercises that branch at
 * all, so it would not fail if `eventScope` regressed to drop dispatcher
 * presentation — exactly the erasure failure-ledger item 13 names. Wire the
 * real `createConversationProjection` here instead.
 * ---------------------------------------------------------------------- */

/** Records every event a dispatcher id published, in order. */
class RecordingPublisher implements DispatcherCoreEventPublisher {
  readonly events: Array<{ dispatcherId: string; event: ChannelCoreEvent }> = [];

  publish(dispatcherId: string, event: ChannelCoreEvent): void {
    this.events.push({ dispatcherId, event });
  }
}

describe('the real conversation projection presents a dispatcher completion delivery (failure-ledger #13)', () => {
  it('publishes the submitted+message events for a dispatcher-role completion turn, scoped to team_name: null', async () => {
    const publisher = new RecordingPublisher();
    const projection = createConversationProjection({
      coreEvents: publisher,
      log: noopLog(),
    });
    const identity = fakeIdentity({ name: 'dispatcher', team_id: null });
    const coordinator = coordinatorFor('dispatcher', projection, identity);
    const runtime = controllableRuntimeSubmission();

    await coordinator.submitCompletion(
      async () => ({ status: 'submitted', submission: runtime.submission }),
      { source: COMPLETION_SOURCE, prompt: 'TeamMate worker has finished its task.' },
    );

    const submitted = publisher.events
      .map((entry) => entry.event)
      .find((event) => event.kind === 'teammate.turn.submitted');
    expect(submitted).toBeDefined();
    expect(submitted).toMatchObject({
      kind: 'teammate.turn.submitted',
      team_name: null,
      teammate_name: 'dispatcher',
      role: 'dispatcher',
      turn_source: COMPLETION_SOURCE,
    });
  });

  it('publishes the settled event once the completion resolves, still scoped to team_name: null', async () => {
    const publisher = new RecordingPublisher();
    const projection = createConversationProjection({
      coreEvents: publisher,
      log: noopLog(),
    });
    const identity = fakeIdentity({ name: 'dispatcher', team_id: null });
    const coordinator = coordinatorFor('dispatcher', projection, identity);
    const runtime = controllableRuntimeSubmission();

    const resultPromise = coordinator.submitCompletion(
      async () => ({ status: 'submitted', submission: runtime.submission }),
      { source: COMPLETION_SOURCE, prompt: 'TeamMate worker has finished its task.' },
    );
    runtime.complete('all done');
    await resultPromise;

    await waitFor(() =>
      publisher.events.some((entry) => entry.event.kind === 'teammate.turn.settled'));
    const settled = publisher.events
      .map((entry) => entry.event)
      .find((event) => event.kind === 'teammate.turn.settled');
    expect(settled).toMatchObject({
      kind: 'teammate.turn.settled',
      team_name: null,
      status: 'completed',
    });
  });

  it('negative control: a dispatcher-scoped TeamMate (role teammate, team_id null) is legitimately out of scope, not "erased"', async () => {
    // This is the real, intended boundary eventScope draws: only a Team's own
    // conversation (`role !== 'dispatcher' && team_id !== null`) and the
    // dispatcher's own conversation (`role === 'dispatcher' && team_id ===
    // null`) exist. A `teammate`-role entity with no team is neither, so it
    // projects nothing — a scoping decision, not a role filter erasing
    // Dispatcher presentation. Pinning this distinguishes the two: the
    // dispatcher case above must publish, this one must not.
    const publisher = new RecordingPublisher();
    const projection = createConversationProjection({
      coreEvents: publisher,
      log: noopLog(),
    });
    const identity = fakeIdentity({ name: 'orphan', team_id: null });
    const coordinator = coordinatorFor('teammate', projection, identity);
    const runtime = controllableRuntimeSubmission();

    await coordinator.submitCompletion(
      async () => ({ status: 'submitted', submission: runtime.submission }),
      { source: COMPLETION_SOURCE, prompt: 'TeamMate worker has finished its task.' },
    );

    expect(publisher.events).toHaveLength(0);
  });
});
