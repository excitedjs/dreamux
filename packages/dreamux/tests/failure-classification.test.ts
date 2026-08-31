/**
 * Which failures are the caller's, and which stay the server's.
 *
 * Two rules are locked here, both of them about *not* over-claiming:
 *
 *  - A request reader re-types exactly one thing — a `RuleViolation`, the named
 *    class a domain rule throws — as `BAD_REQUEST`. An unforeseen failure
 *    raised while validating stays unclassified, so it reaches an agent as
 *    `INTERNAL` carrying its own native message rather than as advice to fix a
 *    request that was fine. The same rule broken by persisted state also stays
 *    loud, because nothing the caller can send would fix it.
 *  - Closing an already-closed TeamMate is the operation succeeding. The
 *    collection answers it from the durable record, including when a
 *    concurrent close commits inside the window this one is reading.
 */
import { rm } from 'node:fs/promises';

import { describe, expect, it, vi } from 'vitest';

import {
  DreamuxError,
  RuleViolation,
  ServerShuttingDownError,
} from '../src/platform/errors.js';
import { throwCallerMistake } from '../src/command/errors.js';
import { normalizeSkillSources } from '../src/agent-runtime/skill-sources.js';
import {
  AgentActivityReadError,
  readAgentActivity,
} from '../src/service/agent-entity/activity-reader.js';
import { capturingLogger, type CapturedLog } from './helpers/command-harness.js';
import { AgentEntityCollectionStore } from '../src/service/agent-entity/identity-store.js';
import {
  agentEntityLastQuery,
  optionalAgentEntityNameParam,
  validateLastLimit,
} from '../src/service/agent-entity/read-helpers.js';
import { validateAgentEntityName } from '../src/service/agent-entity/types.js';
import { SchedulerService } from '../src/service/scheduler/service.js';
import type { SchedulerServiceOptions } from '../src/service/scheduler/types.js';
import {
  teamNameParam,
  validateTeamId,
} from '../src/service/team-collection/types.js';
import { TeammateCollection } from '../src/service/teammate-collection/index.js';
import { parseWorkflowMaxConcurrency } from '../src/service/workflow-service/limits.js';
import { workflowRunInput } from '../src/service/workflow-service/types.js';
import { reuseCwdWorktree } from '../src/service/worktree/manager.js';
import { makeTempDir, silentLog } from './helpers/dissolve-harness.js';
import {
  fakeCronStore,
  silentLog as silentCronLog,
  testCronJob,
} from './helpers/workflow-harness.js';

function scheduler(options: Partial<SchedulerServiceOptions> = {}): SchedulerService {
  return new SchedulerService({
    ownerId: 'dispatcher-1',
    store: fakeCronStore([]).store,
    admit: (task) => task(),
    submitScheduled: vi.fn(async () => ({ status: 'submitted' as const })),
    log: silentCronLog(),
    ...options,
  } as SchedulerServiceOptions);
}

function codeOf(error: unknown): string | undefined {
  return error instanceof DreamuxError ? error.code : undefined;
}

async function raised(run: () => Promise<unknown>): Promise<unknown> {
  try {
    await run();
  } catch (error) {
    return error;
  }
  throw new Error('expected the call to fail, but it resolved');
}

describe('a skill root the caller can fix, and a filesystem failure it cannot', () => {
  /**
   * Both cases go through the same reader on the same field. The only thing
   * that differs is the code the filesystem reported, which is exactly what
   * decides whether the caller was told to fix an argument or told what the
   * host said.
   */
  const source = (path: string) => [{ name: 'extra', path }];

  it('a path that is not there is BAD_REQUEST naming the field', async () => {
    const error = await raised(() =>
      normalizeSkillSources(source('/definitely/not/here-xyz') as never),
    );
    expect(codeOf(error)).toBe('BAD_REQUEST');
    expect((error as Error).message).toBe(
      "param 'skill_sources'[0].path must be an existing readable directory",
    );
    // The system's own wording about the path is not restated as caller advice.
    expect((error as Error).message).not.toContain('ENOENT');
  });

  it('a filesystem failure the caller cannot fix keeps its own message', async () => {
    // ENAMETOOLONG is the host answering about itself, not about a field the
    // caller chose wrongly, so nothing re-types it and nothing rewrites it.
    const error = await raised(() =>
      normalizeSkillSources(source(`/tmp/${'a'.repeat(300)}`) as never),
    );
    expect(error).not.toBeInstanceOf(DreamuxError);
    expect((error as NodeJS.ErrnoException).code).toBe('ENAMETOOLONG');
    expect((error as Error).message).toContain('ENAMETOOLONG');
  });
});

describe('an Activity read reports what failed, and invents nothing', () => {
  /**
   * The reader with one provider that always throws `raise()`.
   *
   * Everything else is the smallest structural fixture that reaches the
   * provider call: the point under test is what happens to the thrown value,
   * not how the agent was resolved.
   */
  async function readThrowing(
    raise: () => never,
    logs: CapturedLog[] = [],
  ): Promise<unknown> {
    return raised(() =>
      readAgentActivity({
        config: { agents: { r1: { provider: 'builtin:fake', config: {} } } },
        providers: {
          resolve: () => ({
            implementation: {
              readRecentActivity: async () => raise(),
            },
          }),
        },
        identity: {
          name: 'mate-9z',
          dispatcher_id: 'd1',
          agent_runtime: 'r1',
          runtime_cwd: '/tmp',
          session_id: 'session-1',
        },
        query: {},
        log: capturingLogger(logs),
      } as never),
    );
  }

  it('a provider failure nobody named leaves with its own type and message', async () => {
    const native = 'EPIPE: broken pipe writing to the codex rpc stream';
    class ProviderStreamError extends Error {
      override readonly name = 'ProviderStreamError';
    }
    const error = await readThrowing(() => {
      throw new ProviderStreamError(native);
    });
    expect(error).toBeInstanceOf(ProviderStreamError);
    expect(error).not.toBeInstanceOf(AgentActivityReadError);
    expect((error as Error).message).toBe(native);
  });

  it('a reason the provider seam names still becomes the named read failure', async () => {
    const error = await readThrowing(() => {
      throw Object.assign(new Error('provider said so'), {
        name: 'AgentActivityError',
        reason: 'cursor_invalid',
      });
    });
    expect(error).toBeInstanceOf(AgentActivityReadError);
    expect((error as AgentActivityReadError).reason).toBe('cursor_invalid');
  });

  it('logs the whole value either way, and the reason only when there is one', async () => {
    const named: CapturedLog[] = [];
    await readThrowing(() => {
      throw Object.assign(new Error('provider said so'), {
        name: 'AgentActivityError',
        reason: 'provider_failure',
      });
    }, named);
    expect(named).toHaveLength(1);
    expect(named[0]!.fields['activity_reason']).toBe('provider_failure');
    expect(named[0]!.fields['teammate']).toBe('mate-9z');
    expect((named[0]!.fields['err'] as { message: string }).message).toBe(
      'provider said so',
    );

    const unnamed: CapturedLog[] = [];
    await readThrowing(() => {
      throw new Error('EIO: i/o error');
    }, unnamed);
    expect(unnamed).toHaveLength(1);
    // Nothing is claimed about a reason the provider never gave.
    expect(unnamed[0]!.fields).not.toHaveProperty('activity_reason');
    const err = unnamed[0]!.fields['err'] as { message: string; stack?: string };
    expect(err.message).toBe('EIO: i/o error');
    expect(typeof err.stack).toBe('string');
  });
});

describe('a broken cron rule is the caller`s mistake', () => {
  const badRequests: ReadonlyArray<[string, Record<string, unknown>]> = [
    ['an empty prompt', { cron: '*/5 * * * *', prompt: '' }],
    ['an empty title', { cron: '*/5 * * * *', prompt: 'go', title: '' }],
    ['an action kind nothing can run', {
      cron: '*/5 * * * *',
      prompt: 'go',
      action: { kind: 'spawn-teammate' },
    }],
    ['a cron that is not five fields', { cron: '*/5 * * *', prompt: 'go' }],
    ['a five-field cron the library cannot parse', {
      cron: '99 99 99 99 99',
      prompt: 'go',
    }],
    ['a timezone that does not exist', {
      cron: '*/5 * * * *',
      prompt: 'go',
      tz: 'Mars/Olympus',
    }],
  ];

  for (const [label, request] of badRequests) {
    it(`${label} is reported as BAD_REQUEST, naming the rule it broke`, async () => {
      const service = scheduler();
      const error = await raised(() => service.create(request as never));
      expect(codeOf(error)).toBe('BAD_REQUEST');
      expect((error as Error).message).not.toBe('');
    });
  }

  it('an unparseable expression is stated in the scheduler`s words, not the library`s', async () => {
    // The rule is the scheduler's, so the sentence is too: a caller reads about
    // the field it sent, never about a parser it never chose.
    const service = scheduler();
    const error = await raised(() =>
      service.create({ cron: '99 99 99 99 99', prompt: 'go' } as never));
    expect((error as Error).message).toBe(
      "cron '99 99 99 99 99' is not a valid 5-field expression",
    );
  });

  it('an update breaking the same rule is the caller`s mistake too', async () => {
    const job = testCronJob({ id: 'job-1' });
    const service = scheduler({ store: fakeCronStore([job]).store });
    const error = await raised(() =>
      service.update({ id: 'job-1', cron: 'not a cron' } as never));
    expect(codeOf(error)).toBe('BAD_REQUEST');
  });
});

describe('a failure nobody classified stays the server`s, even on a validation path', () => {
  /**
   * A request whose `action` explodes when it is read.
   *
   * `normalizeAction` reads `action.kind` first, so this raises a `TypeError`
   * from inside the very closure that validates the request — the exact place a
   * closure-wide catch would have relabelled as the caller's fault.
   */
  function explodingAction(): Record<string, unknown> {
    const action: Record<string, unknown> = {};
    Object.defineProperty(action, 'kind', {
      enumerable: true,
      get() {
        throw new TypeError('reading kind blew up');
      },
    });
    return action;
  }

  it('a create whose validation path throws something unforeseen is not the caller`s fault', async () => {
    const service = scheduler();
    const error = await raised(() =>
      service.create({
        cron: '*/5 * * * *',
        prompt: 'go',
        action: explodingAction(),
      } as never));
    expect(error).toBeInstanceOf(TypeError);
    expect(codeOf(error)).toBeUndefined();
  });

  it('an update whose validation path throws something unforeseen is not the caller`s fault', async () => {
    const job = testCronJob({ id: 'job-1' });
    const service = scheduler({ store: fakeCronStore([job]).store });
    const error = await raised(() =>
      service.update({ id: 'job-1', action: explodingAction() } as never));
    expect(error).toBeInstanceOf(TypeError);
    expect(codeOf(error)).toBeUndefined();
  });

  it('a persisted job that breaks a rule stays loud rather than becoming a caller mistake', async () => {
    const service = scheduler({
      store: fakeCronStore([testCronJob({ id: 'job-1', cron: 'not a cron' })]).store,
    });
    const error = await raised(() => service.start());
    expect(codeOf(error)).not.toBe('BAD_REQUEST');
  });
});

describe('every request reader re-types the rule and nothing else', () => {
  /**
   * Every reader narrows through one shared helper, so the helper is pinned
   * directly — a broadened catch there reclassifies everything at once — and
   * each reader is pinned to the rule it re-types. What a reader must *not*
   * reclassify is proven end to end on the scheduler's real validation path
   * above, where an unforeseen `TypeError` crosses the same narrowing.
   */
  it('the shared narrowing converts a rule violation and rethrows everything else', () => {
    expect(() => throwCallerMistake(new RuleViolation('name is too long')))
      .toThrowError(expect.objectContaining({ code: 'BAD_REQUEST' }));
    const unforeseen = new TypeError('cannot read properties of undefined');
    expect(() => throwCallerMistake(unforeseen)).toThrow(unforeseen);
    const shuttingDown = new ServerShuttingDownError();
    expect(() => throwCallerMistake(shuttingDown)).toThrow(shuttingDown);
  });

  const readers: ReadonlyArray<{
    what: string;
    rule: () => unknown;
    read: () => unknown;
  }> = [
    {
      what: 'a Team name',
      rule: () => validateTeamId('not a legal team'),
      read: () => teamNameParam({ team_name: 'not a legal team' } as never, 'team_name'),
    },
    {
      what: 'a TeamMate name',
      rule: () => validateAgentEntityName('not a legal name'),
      read: () =>
        optionalAgentEntityNameParam({ name: 'not a legal name' } as never, 'name'),
    },
    {
      what: 'a last-read limit',
      rule: () => validateLastLimit(0),
      read: () => agentEntityLastQuery({ name: 'mate-1', limit: 0 } as never),
    },
    {
      what: 'a workflow concurrency bound',
      rule: () => parseWorkflowMaxConcurrency(0),
      read: () => workflowRunInput({ prompt: 'go', max_concurrency: 0 } as never),
    },
  ];

  for (const entry of readers) {
    it(`${entry.what}: the rule is a named violation, and reading it is BAD_REQUEST`, () => {
      expect(() => entry.rule()).toThrow(RuleViolation);
      let code: string | undefined;
      try {
        entry.read();
      } catch (error) {
        code = codeOf(error);
      }
      expect(code).toBe('BAD_REQUEST');
    });
  }
});

describe('closing an already-closed TeamMate is the operation succeeding', () => {
  const DISPATCHER = 'dispatcher-1';

  async function collection(): Promise<{
    store: AgentEntityCollectionStore;
    teammates: TeammateCollection;
    cleanup: () => Promise<void>;
  }> {
    const root = await makeTempDir('dreamux-close-idempotency-');
    const store = new AgentEntityCollectionStore({
      root,
      dispatcherId: DISPATCHER,
      log: silentLog,
    } as never);
    const teammates = new TeammateCollection({
      dispatcherId: DISPATCHER,
      teamScope: null,
      config: { agents: {} } as never,
      agentRuntimeProviders: {} as never,
      worktrees: {} as never,
      store,
      names: {} as never,
      admissions: {} as never,
      log: silentLog as never,
    });
    return {
      store,
      teammates,
      cleanup: () => rm(root, { recursive: true, force: true }),
    };
  }

  async function seed(
    store: AgentEntityCollectionStore,
    name: string,
    status: 'running' | 'closed',
  ): Promise<void> {
    const created = await store.entity(name).create({
      name,
      teamId: undefined,
      agentRuntime: 'fake-runtime',
      sourceCwd: '/repo',
      sourceRepo: null,
      cwd: '/repo',
      runtimeCwd: '/repo',
      worktree: reuseCwdWorktree('/repo'),
      intent: null,
      identityPrompt: null,
      status: 'running',
    } as never);
    if (status === 'closed') {
      await store.entity(name).update(created, {
        status: 'closed',
        closedAt: Date.now() - 60_000,
        closeNote: 'closed earlier',
      } as never);
    }
  }

  it('a record that already says closed is the answer, not a failure', async () => {
    const { store, teammates, cleanup } = await collection();
    try {
      await seed(store, 'retired', 'closed');
      const result = await teammates.close({ name: 'retired', note: 'cleanup' });
      expect(result.teammate.name).toBe('retired');
      expect(result.teammate.status).toBe('closed');
    } finally {
      await cleanup();
    }
  });

  it('a close that loses the race to a concurrent one still answers, it does not refuse', async () => {
    const { store, teammates, cleanup } = await collection();
    try {
      await seed(store, 'racer', 'running');
      // The record flips to closed the moment after the first read of it — a
      // concurrent close committing inside this close's window. Whichever read
      // this close ends up making, the TeamMate is closed and saying so is the
      // whole job; refusing would make an idempotent operation fail on timing.
      const real = store.entity.bind(store);
      let reads = 0;
      vi.spyOn(store, 'entity').mockImplementation((name: string) => {
        const entity = real(name);
        const read = entity.read.bind(entity);
        return Object.assign(Object.create(Object.getPrototypeOf(entity)), entity, {
          read: async () => {
            const identity = await read();
            reads += 1;
            return reads === 1 || identity === null
              ? identity
              : { ...identity, status: 'closed', closed_at: Date.now() };
          },
        }) as ReturnType<typeof real>;
      });

      const result = await teammates.close({ name: 'racer', note: 'cleanup' });
      expect(result.teammate.status).toBe('closed');
      expect(reads).toBeGreaterThan(0);
    } finally {
      vi.restoreAllMocks();
      await cleanup();
    }
  });

  it('a name that never existed is still the caller`s to fix', async () => {
    const { teammates, cleanup } = await collection();
    try {
      const error = await raised(() =>
        teammates.close({ name: 'ghost', note: 'cleanup' }));
      expect(codeOf(error)).toBe('TEAMMATE_NOT_FOUND');
    } finally {
      await cleanup();
    }
  });
});
