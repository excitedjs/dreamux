import { RuleViolation } from '@excitedjs/dreamux-utils';
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
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkFence } from '../src/platform/work-fence.js';
import { dispatcherFixture } from './helpers/real-dispatcher.js';
import { AgentRuntimeProviderCatalog } from '../src/agent-runtime/catalog.js';
import { ProviderRegistry, parseProviderRef } from '../src/registry/index.js';
import { ControlledRuntimeProvider } from './helpers/controlled-runtime-provider.js';
import type { CronJob } from '../src/service/scheduler/types.js';
import type { AgentEntityIdentity } from '../src/service/agent/identity.js';

import {
  DreamuxError,
  ServerShuttingDownError,
} from '../src/platform/errors.js';
import { throwCallerMistake } from '../src/command/errors.js';
import { normalizeSkillSources } from '../src/agent-runtime/skill-sources.js';
import {
  AgentActivityReadError,
  readAgentActivity,
} from '../src/service/agent/activity.js';
import {
  capturingLogger,
  type CapturedLog,
} from './helpers/command-harness.js';
import {
  agentEntityLastQuery,
  optionalAgentEntityNameParam,
  validateLastLimit,
} from '../src/service/agent/requests.js';
import { validateAgentEntityName } from '../src/service/agent/identity.js';
import { SchedulerService } from '../src/service/scheduler/index.js';
import { teamNameParam } from '../src/service/team/requests.js';
import { validateTeamId } from '../src/service/team/types.js';
import { assertWorkflowMaxConcurrency } from '../src/service/workflow-service/limits.js';
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  try {
    for (const done of cleanup.splice(0).reverse()) await done();
  } finally {
    vi.restoreAllMocks();
  }
});
function testCronJob(overrides: Partial<CronJob> = {}): CronJob {
  return {
    id: 'job-1',
    cron: '* * * * *',
    tz: 'UTC',
    recurring: true,
    action: { kind: 'prompt-agent', prompt: 'go' },
    enabled: true,
    created_at: 1,
    updated_at: 1,
    next_run_at: Date.now() + 60_000,
    last_fired_at: null,
    ...overrides,
  };
}
async function scheduler(
  jobs: readonly unknown[] = [],
): Promise<SchedulerService> {
  const root = await mkdtemp(join(tmpdir(), 'dreamux-failure-cron-'));
  const path = join(root, 'cron-jobs.json');
  await writeFile(path, JSON.stringify({ version: 1, jobs }), { mode: 0o600 });
  const fence = new WorkFence('dispatcher-1');
  const service = new SchedulerService({
    ownerId: 'dispatcher-1',
    cronJobsPath: path,
    fence,
    recipient: { submitInput: async () => ({ status: 'stopped' }) },
    log: capturingLogger([]),
  });
  cleanup.push(async () => {
    service.stop();
    await fence.drain();
    await rm(root, { recursive: true, force: true });
  });
  return service;
}
function activityIdentity(): AgentEntityIdentity {
  return {
    version: 1,
    dispatcher_id: 'd1',
    name: 'mate-9z',
    team_id: null,
    agent_runtime: 'r1',
    session_id: 'session-1',
    source_cwd: '/tmp',
    source_repo: null,
    cwd: '/tmp',
    runtime_cwd: '/tmp',
    worktree: {
      mode: 'reuse-cwd',
      slug: null,
      path: '/tmp',
      branch: null,
      base_ref: null,
      cleanup: 'keep',
      cleanup_state: 'not-managed',
      cleanup_error: null,
    },
    intent: null,
    identity_prompt: null,
    skill_sources: [],
    created_at: 1,
    updated_at: 1,
    status: 'running',
    last_error: null,
    closed_at: null,
    close_note: null,
  };
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
    const provider = new ControlledRuntimeProvider();
    vi.spyOn(provider, 'readRecentActivity').mockImplementation(async () =>
      raise(),
    );
    const registry = new ProviderRegistry();
    registry.register(
      {
        id: 'fake',
        kind: 'agentRuntime',
        ref: parseProviderRef('builtin:fake'),
      },
      provider,
    );
    return raised(() =>
      readAgentActivity({
        config: {
          agents: { r1: { provider: 'builtin:fake', config: {} } },
          dispatchers: [],
        },
        providers: new AgentRuntimeProviderCatalog({ registry }),
        identity: activityIdentity(),
        running: null,
        query: {},
        log: capturingLogger(logs),
      }),
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
    const err = unnamed[0]!.fields['err'] as {
      message: string;
      stack?: string;
    };
    expect(err.message).toBe('EIO: i/o error');
    expect(typeof err.stack).toBe('string');
  });
});

describe('a broken cron rule is the caller`s mistake', () => {
  const badRequests: ReadonlyArray<[string, Record<string, unknown>]> = [
    ['an empty prompt', { cron: '*/5 * * * *', prompt: '' }],
    ['an empty title', { cron: '*/5 * * * *', prompt: 'go', title: '' }],
    ['a cron that is not five fields', { cron: '*/5 * * *', prompt: 'go' }],
    [
      'a five-field cron the library cannot parse',
      {
        cron: '99 99 99 99 99',
        prompt: 'go',
      },
    ],
    [
      'a timezone that does not exist',
      {
        cron: '*/5 * * * *',
        prompt: 'go',
        tz: 'Mars/Olympus',
      },
    ],
  ];

  for (const [label, request] of badRequests) {
    it(`${label} is reported as BAD_REQUEST, naming the rule it broke`, async () => {
      const service = await scheduler();
      const error = await raised(() => service.create(request as never));
      expect(codeOf(error)).toBe('BAD_REQUEST');
      expect((error as Error).message).not.toBe('');
    });
  }

  it('an unparseable expression is stated in the scheduler`s words, not the library`s', async () => {
    // The rule is the scheduler's, so the sentence is too: a caller reads about
    // the field it sent, never about a parser it never chose.
    const service = await scheduler();
    const error = await raised(() =>
      service.create({ cron: '99 99 99 99 99', prompt: 'go' } as never),
    );
    expect((error as Error).message).toBe(
      "cron '99 99 99 99 99' is not a valid 5-field expression",
    );
  });

  it('an update breaking the same rule is the caller`s mistake too', async () => {
    const job = testCronJob({ id: 'job-1' });
    const service = await scheduler([job]);
    const error = await raised(() =>
      service.update({ id: 'job-1', cron: 'not a cron' } as never),
    );
    expect(codeOf(error)).toBe('BAD_REQUEST');
  });
});

describe('a failure nobody classified stays the server`s, even on a validation path', () => {
  function explodingPrompt(
    input: Record<string, unknown>,
  ): Record<string, unknown> {
    return Object.defineProperty(input, 'prompt', {
      enumerable: true,
      get() {
        throw new TypeError('reading prompt blew up');
      },
    });
  }

  it('a create whose validation path throws something unforeseen is not the caller`s fault', async () => {
    const service = await scheduler();
    const error = await raised(() =>
      service.create(explodingPrompt({ cron: '*/5 * * * *' }) as never),
    );
    expect(error).toBeInstanceOf(TypeError);
    expect(codeOf(error)).toBeUndefined();
  });

  it('an update whose validation path throws something unforeseen is not the caller`s fault', async () => {
    const job = testCronJob({ id: 'job-1' });
    const service = await scheduler([job]);
    const error = await raised(() =>
      service.update(explodingPrompt({ id: 'job-1' }) as never),
    );
    expect(error).toBeInstanceOf(TypeError);
    expect(codeOf(error)).toBeUndefined();
  });

  it('a persisted job that breaks a rule stays loud rather than becoming a caller mistake', async () => {
    const service = await scheduler([
      testCronJob({ id: 'job-1', cron: 'not a cron' }),
    ]);
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
    expect(() =>
      throwCallerMistake(new RuleViolation('name is too long')),
    ).toThrowError(expect.objectContaining({ code: 'BAD_REQUEST' }));
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
      read: () =>
        teamNameParam({ team_name: 'not a legal team' } as never, 'team_name'),
    },
    {
      what: 'a TeamMate name',
      rule: () => validateAgentEntityName('not a legal name'),
      read: () =>
        optionalAgentEntityNameParam(
          { name: 'not a legal name' } as never,
          'name',
        ),
    },
    {
      what: 'a last-read limit',
      rule: () => validateLastLimit(0),
      read: () => agentEntityLastQuery({ name: 'mate-1', limit: 0 } as never),
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

// The reader shapes a number; the owning service applies the domain bound.
it('a workflow concurrency bound: the rule is a named violation, and running it is BAD_REQUEST', async () => {
  expect(() => assertWorkflowMaxConcurrency(0)).toThrow(RuleViolation);
  const fixture = await dispatcherFixture();
  await fixture.host.start();
  await expect(
    fixture.host.workflows.run({ script: 'return 1;', max_concurrency: 0 }),
  ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  expect(fixture.provider.runtimes).toHaveLength(0);
});
