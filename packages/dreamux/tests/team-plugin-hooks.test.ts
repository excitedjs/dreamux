/**
 * When the Team-level plugin hooks fire, against a real file-backed
 * `TeamCollection`: `dispatcher.hooks.team` (through `announceTeam`) on create
 * and rebuild, `beforeTeamLeaderLaunch` at every TeamLeader construction, and
 * `created` exactly once per newly created Team, in the background after the
 * create reply.
 *
 * Also: the `created` tap's own no-deadlock guarantee reaching its new Team
 * through the ordinary Command path, `beforeTeamLeaderLaunch`'s `skillSources`
 * composition and its two extra triggers (lazy materialization after a failed
 * dissolve commit, and creation-failure cleanup adopting a durable leader),
 * and that a runtime-process restart inside the same TeamLeader does not
 * refire the launch hook.
 */
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { AgentRuntimeSkillSource, Team } from '@excitedjs/dreamux-types';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AgentRuntimeProviderCatalog } from '../src/agent-runtime/index.js';
import type { DreamuxConfig, ResolvedAgentConfig } from '../src/config/config.js';
import { AgentIdentityStore } from '../src/service/agent-entity/identity-store.js';
import {
  TEAM_LEADER_REQUIRED_SKILL_SOURCES,
  teamCreatePayloadHash,
} from '../src/service/team-collection/create-request.js';
import { TeamStore } from '../src/service/team-collection/store.js';
import type { TeamCollectionOptions, TeamRecord } from '../src/service/team-collection/types.js';
import { AdmissionLedger } from '../src/service/teammate-service/admission-ledger.js';
import type { TeammateAgentMcp } from '../src/service/teammate-service/types.js';
import { AGENT_TASK_SOURCE } from '../src/service/submission-sources.js';
import { TeamService } from '../src/service/team-service/index.js';
import type {
  TeamServiceCreateInput,
  TeamServiceDeps,
} from '../src/service/team-service/types.js';
import { reuseCwdWorktree } from '../src/service/worktree/manager.js';

import { bootDissolveTeam } from './helpers/dissolve-harness.js';
import { ControlledRuntimeProvider } from './helpers/controlled-runtime-provider.js';
import {
  buildRestartedTeamCollection,
  buildTeamCollectionHarness,
  mockLeaderSubmissionRejected,
  type TeamCollectionHarness,
} from './helpers/team-harness.js';

let harness: TeamCollectionHarness | null = null;
let submission: { restore(): void } | null = null;
const roots: string[] = [];

afterEach(async () => {
  submission?.restore();
  submission = null;
  await harness?.cleanup();
  harness = null;
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

const silentLog = {
  warn: () => {},
  error: () => {},
  info: () => {},
  debug: () => {},
  trace: () => {},
  child: () => silentLog,
} as unknown as TeamServiceDeps['log'];

interface Recorder {
  readonly events: string[];
  /** Each announced Team's own `workspace`, as the `team` tap saw it. */
  readonly workspaces: Map<string, string>;
  readonly announce: TeamCollectionOptions['announceTeam'];
}

/**
 * Taps every announced Team the way a plugin's `team` tap would, recording
 * each hook as `<event>:<team name>`.
 */
function recorder(onCreated?: (team: Team) => Promise<void>): Recorder {
  const events: string[] = [];
  const workspaces = new Map<string, string>();
  return {
    events,
    workspaces,
    announce(team, { origin }) {
      events.push(`team:${origin}:${team.name}`);
      workspaces.set(team.name, team.workspace);
      team.hooks.beforeTeamLeaderLaunch.tapPromise('alpha', async () => {
        events.push(`beforeTeamLeaderLaunch:${team.name}`);
      });
      team.hooks.created.tapPromise('alpha', async ({ requestId }) => {
        events.push(`created:${team.name}:${requestId}`);
        await onCreated?.(team);
      });
    },
  };
}

function request(requestId: string, intent: string) {
  return {
    requestId,
    payloadHash: teamCreatePayloadHash({ intent }),
    options: { namePrefix: 'alpha', leaderAgentRuntime: 'fake', intent },
  };
}

describe('Team plugin hooks', () => {
  it('announces a created Team, builds its leader, then fires created once with the request id without holding up the reply', async () => {
    let statusSeenByCreated: string | undefined;
    let release!: () => void;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    const hooks = recorder(async (team) => {
      statusSeenByCreated = (await harness!.seedStore.get(team.name))?.status;
      await released;
      hooks.events.push(`created done:${team.name}`);
    });
    harness = await buildTeamCollectionHarness({ announceTeam: hooks.announce });

    const created = await harness.collection.createFromRequest(request('req-1', 'ship it'));

    const name = created.team_name;
    expect(hooks.events).not.toContain(`created done:${name}`);
    release();
    await harness.collection.drainCreatedHooks();
    expect(hooks.events).toEqual([
      `team:create:${name}`,
      `beforeTeamLeaderLaunch:${name}`,
      `created:${name}:req-1`,
      `created done:${name}`,
    ]);
    expect(statusSeenByCreated).toBe('running');
    // The Team object the `team` tap saw carries its real runtime cwd (row 32),
    // matching the durable record's own `runtime_cwd`.
    const record = await harness.seedStore.get(name);
    expect(hooks.workspaces.get(name)).toBe(record?.runtime_cwd);
  });

  it('never fires the leader or created hooks of an object discarded for a taken name', async () => {
    let calls = 0;
    const hooks = recorder();
    harness = await buildTeamCollectionHarness({
      announceTeam: hooks.announce,
      nameSuffixGenerator: () => (calls++ === 0 ? 'lost' : 'won'),
    });
    // Another writer publishes at the first candidate between the probe and
    // this Team's own publication: the exclusive create answers null.
    const publish = vi.spyOn(TeamStore.prototype, 'create').mockResolvedValueOnce(null);
    submission = { restore: () => publish.mockRestore() };

    await harness.collection.createFromRequest(request('req-retry', 'needs a free name'));
    await harness.collection.drainCreatedHooks();

    expect(hooks.events).toEqual([
      'team:create:alpha-lost',
      'team:create:alpha-won',
      'beforeTeamLeaderLaunch:alpha-won',
      'created:alpha-won:req-retry',
    ]);
  });

  it('fires nothing again for a replayed request, in process or after a restart', async () => {
    const hooks = recorder();
    harness = await buildTeamCollectionHarness({ announceTeam: hooks.announce });
    await harness.collection.createFromRequest(request('req-replay', 'ship it'));
    await harness.collection.drainCreatedHooks();
    const afterCreate = [...hooks.events];

    await harness.collection.createFromRequest(request('req-replay', 'ship it'));
    const restarted = buildRestartedTeamCollection(harness, hooks.announce);
    await restarted.createFromRequest(request('req-replay', 'ship it'));
    await harness.collection.drainCreatedHooks();
    await restarted.drainCreatedHooks();

    expect(hooks.events).toEqual(afterCreate);
  });

  it('announces a rebuilt Team with origin rebuild and never fires created for it', async () => {
    const hooks = recorder();
    harness = await buildTeamCollectionHarness({ announceTeam: hooks.announce });
    const created = await harness.collection.createFromRequest(request('req-1', 'ship it'));
    await harness.collection.drainCreatedHooks();
    hooks.events.length = 0;

    const restarted = buildRestartedTeamCollection(harness, hooks.announce);
    await restarted.open(created.team_name);
    await restarted.drainCreatedHooks();

    expect(hooks.events).toEqual([
      `team:rebuild:${created.team_name}`,
      `beforeTeamLeaderLaunch:${created.team_name}`,
    ]);
  });

  it('does not fire created when creation fails', async () => {
    const hooks = recorder();
    harness = await buildTeamCollectionHarness({ announceTeam: hooks.announce });
    submission = mockLeaderSubmissionRejected(new Error('runtime boom'));

    await expect(
      harness.collection.createFromRequest({
        ...request('req-fail', 'fails on the first prompt'),
        options: {
          namePrefix: 'alpha',
          leaderAgentRuntime: 'fake',
          intent: 'fails on the first prompt',
          prompt: 'first task',
        },
      }),
    ).rejects.toThrow(/runtime boom/);
    await harness.collection.drainCreatedHooks();

    expect(hooks.events.some((event) => event.startsWith('created:'))).toBe(false);
  });

  it('keeps a created Team when a created tap rejects', async () => {
    const hooks = recorder(async () => {
      throw new Error('external action failed');
    });
    harness = await buildTeamCollectionHarness({ announceTeam: hooks.announce });

    const created = await harness.collection.createFromRequest(request('req-1', 'ship it'));
    await harness.collection.drainCreatedHooks();

    expect(created.status).toBe('running');
    expect(hooks.events.at(-1)).toBe(`created:${created.team_name}:req-1`);
  });
});

describe('created reaching its own Team through the ordinary Command path (D15)', () => {
  it('resolves harness.collection.open() from cache instead of joining the in-flight construction', async () => {
    let sameTeam = false;
    const hooks = recorder(async (team) => {
      const opened = await harness!.collection.open(team.name);
      sameTeam = (opened as unknown) === (team as unknown);
    });
    harness = await buildTeamCollectionHarness({ announceTeam: hooks.announce });

    const created = await harness.collection.createFromRequest(
      request('req-reach-own-team', 'reach my own Team through open()'),
    );
    // `publish` runs before `fireCreated` (runtime-registry.ts), so `open()`
    // reads the cache and this resolves; a regression that reordered them
    // would hang here rather than fail an assertion.
    await harness.collection.drainCreatedHooks();

    expect(sameTeam).toBe(true);
    expect(hooks.events.at(-1)).toBe(`created:${created.team_name}:req-reach-own-team`);
  });
});

/** A create request with a prompt, so the leader's runtime actually starts. */
function promptedRequest(
  requestId: string,
  options: { skillSources?: readonly AgentRuntimeSkillSource[] } = {},
) {
  return {
    requestId,
    payloadHash: teamCreatePayloadHash({ requestId }),
    options: {
      namePrefix: 'delta',
      leaderAgentRuntime: 'fake',
      intent: 'exercise beforeTeamLeaderLaunch',
      prompt: 'go',
      ...options,
    },
  };
}

/** A skill root holding one child skill directory per name. */
async function skillRoot(...skills: string[]): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dreamux-team-plugin-skills-'));
  roots.push(root);
  for (const skill of skills) await mkdir(join(root, skill));
  return realpath(root);
}

describe('beforeTeamLeaderLaunch: skillSources composition', () => {
  it('orders required, then the identity\'s own persisted roots, then the plugin draft, and reaches the launched runtime', async () => {
    const identityRoot = await skillRoot('identity-skill');
    const pluginRoot = await skillRoot('plugin-skill');
    const provider = new ControlledRuntimeProvider();
    harness = await buildTeamCollectionHarness({
      agentRuntime: { id: 'fake', provider },
      announceTeam: (team) => {
        team.hooks.beforeTeamLeaderLaunch.tapPromise('alpha', async (draft) => {
          draft.skillSources.push({ name: 'alpha', path: pluginRoot, source: 'alpha' });
        });
      },
    });

    await harness.collection.createFromRequest(
      promptedRequest('req-skill-order', {
        skillSources: [{ name: 'identity', path: identityRoot, source: 'admin' }],
      }),
    );

    expect(provider.runtimes).toHaveLength(1);
    expect(provider.runtimes[0]!.context.skillSources.map((source) => source.name)).toEqual([
      ...TEAM_LEADER_REQUIRED_SKILL_SOURCES.map((source) => source.name),
      'identity',
      'alpha',
    ]);
  });

  it('drops a plugin tap whose skill root collides with the identity\'s own persisted root, without blocking other taps', async () => {
    const identityRoot = await skillRoot('shared-skill');
    const collidingRoot = await skillRoot('shared-skill');
    const cleanRoot = await skillRoot('other-skill');
    const provider = new ControlledRuntimeProvider();
    harness = await buildTeamCollectionHarness({
      agentRuntime: { id: 'fake', provider },
      announceTeam: (team) => {
        team.hooks.beforeTeamLeaderLaunch.tapPromise('colliding', async (draft) => {
          draft.instructions.push('from colliding');
          draft.skillSources.push({ name: 'colliding', path: collidingRoot, source: 'colliding' });
        });
        team.hooks.beforeTeamLeaderLaunch.tapPromise('clean', async (draft) => {
          draft.instructions.push('from clean');
          draft.skillSources.push({ name: 'clean', path: cleanRoot, source: 'clean' });
        });
      },
    });

    await harness.collection.createFromRequest(
      promptedRequest('req-skill-fence', {
        skillSources: [{ name: 'identity', path: identityRoot, source: 'admin' }],
      }),
    );

    expect(provider.runtimes).toHaveLength(1);
    const launched = provider.runtimes[0]!.context;
    expect(launched.skillSources.map((source) => source.name)).toEqual([
      ...TEAM_LEADER_REQUIRED_SKILL_SOURCES.map((source) => source.name),
      'identity',
      'clean',
    ]);
    expect(launched.systemPrompt?.append).toContain('from clean');
    expect(launched.systemPrompt?.append).not.toContain('from colliding');
  });
});

describe('beforeTeamLeaderLaunch: does not refire on a runtime-process restart', () => {
  it('keeps the launch hook at one call across a stop/restart inside the same TeamLeader', async () => {
    const provider = new ControlledRuntimeProvider();
    let tapCalls = 0;
    harness = await buildTeamCollectionHarness({
      agentRuntime: { id: 'fake', provider },
      announceTeam: (team) => {
        team.hooks.beforeTeamLeaderLaunch.tapPromise('alpha', async () => {
          tapCalls += 1;
        });
      },
    });

    const created = await harness.collection.createFromRequest(
      promptedRequest('req-restart'),
    );
    expect(provider.runtimes).toHaveLength(1);
    expect(tapCalls).toBe(1);

    const service = await harness.collection.open(created.team_name);
    await service.stopForHost();
    await service.submitToLeader({ source: AGENT_TASK_SOURCE, text: 'second turn' });

    expect(provider.runtimes).toHaveLength(2);
    expect(tapCalls).toBe(1);
  });
});

describe('beforeTeamLeaderLaunch: lazy TeamLeader materialization after a failed dissolve commit', () => {
  it('rematerializes the leader once, deduped across two concurrent status() callers', async () => {
    const team = await bootDissolveTeam();
    try {
      let tapCalls = 0;
      team.service.hooks.beforeTeamLeaderLaunch.tapPromise('alpha', async () => {
        tapCalls += 1;
      });

      team.setCommitFails(true);
      await team.service.dissolve({
        requester: 'dispatcher',
        force: true,
        note: 'exercise a failed final commit',
      });
      await team.waitDissolveFailed();

      // `closeLeaderForDissolve` already nulled the leader and closed it
      // before the failed commit; the Team is left open with no live leader.
      // Read the field directly (the harness's own accessor) rather than
      // through `status()`, which would itself rematerialize the leader and
      // fire the very hook this assertion is about to count.
      expect(team.leader()).toBeNull();
      expect(tapCalls).toBe(0);

      // Two concurrent callers dedupe to one `leaderForOpenTeam` build.
      const [first, second] = await Promise.all([
        team.service.status(),
        team.service.status(),
      ]);

      expect(first.status).toBe('running');
      expect(second.status).toBe('running');
      expect(tapCalls).toBe(1);
      expect(team.leader()).not.toBeNull();
    } finally {
      await team.cleanup();
    }
  });
});

const CASE_C_DISPATCHER = 'abandon-creation-dispatcher';
const CASE_C_TEAM = 'abandon-creation-team';
const CASE_C_RUNTIME = 'fake-runtime';

/**
 * A hand-rolled `TeamServiceDeps` for `TeamService.createNew`, in the style of
 * `team-leader-lazy-start.test.ts`'s `harness()`: a real (temp-rooted)
 * identity store reached through `teamRoot`, everything else a minimal stub.
 */
async function buildAbandonCreationHarness(
  announceTeam: TeamServiceDeps['announceTeam'],
): Promise<{
  deps: TeamServiceDeps;
  teamRoot: string;
  leaderMcpCalls: () => number;
}> {
  const teamRoot = await mkdtemp(join(tmpdir(), 'dreamux-team-abandon-'));
  roots.push(teamRoot);

  const provider = new ControlledRuntimeProvider();

  const config: DreamuxConfig = {
    agents: {
      [CASE_C_RUNTIME]: { provider: 'fake', config: {} } as unknown as ResolvedAgentConfig,
    },
    dispatchers: [],
  };

  let record: TeamRecord | null = null;
  const store = {
    create: async (
      input: Omit<TeamRecord, 'version' | 'created_at' | 'updated_at' | 'worktree_cleanup_force'>,
    ) => {
      const now = Date.now();
      record = { version: 1, ...input, worktree_cleanup_force: false, created_at: now, updated_at: now };
      return record;
    },
    get: async () => record,
    update: async (previous: TeamRecord, patch: Partial<TeamRecord>) => {
      record = { ...previous, ...patch };
      return record;
    },
    publishRosterState: () => {},
  };

  let leaderMcpCallCount = 0;
  const leaderMcp = (): TeammateAgentMcp => {
    leaderMcpCallCount += 1;
    if (leaderMcpCallCount === 1) {
      throw new Error('leaderMcp unavailable on the first call');
    }
    return {
      leases: {} as unknown as TeammateAgentMcp['leases'],
      delegates: [],
      adminSocketPath: join(teamRoot, 'admin.sock'),
    };
  };

  const deps = {
    dispatcherId: CASE_C_DISPATCHER,
    config,
    agentRuntimeProviders: {
      resolve: () => ({ implementation: provider }),
    } as unknown as AgentRuntimeProviderCatalog,
    worktrees: {},
    teamRoot,
    names: { allocate: async () => `${CASE_C_TEAM}-leader` },
    admissions: new AdmissionLedger(),
    admitOperation: <T>(task: () => Promise<T>) => task(),
    completionDelivery: {},
    leaderCompletionInitiator: async () => null,
    leaderMcp,
    announceTeam,
    store,
    log: silentLog,
    workflowLog: silentLog,
  } as unknown as TeamServiceDeps;

  return { deps, teamRoot, leaderMcpCalls: () => leaderMcpCallCount };
}

function abandonCreationInput(teamRoot: string): TeamServiceCreateInput {
  return {
    teamId: CASE_C_TEAM,
    name: CASE_C_TEAM,
    leaderAgentRuntime: CASE_C_RUNTIME,
    intent: 'exercise creation-failure cleanup',
    workspace: {
      sourceCwd: teamRoot,
      sourceRepo: null,
      runtimeCwd: teamRoot,
      worktree: reuseCwdWorktree(teamRoot),
      createdCheckout: false,
    },
  };
}

describe('beforeTeamLeaderLaunch: creation-failure cleanup adopting a durable leader', () => {
  it('fires twice for one failed createFromRequest, and closes the durable leader identity it adopted', async () => {
    let tapCalls = 0;
    const { deps, teamRoot, leaderMcpCalls } = await buildAbandonCreationHarness((team) => {
      team.hooks.beforeTeamLeaderLaunch.tapPromise('alpha', async () => {
        tapCalls += 1;
      });
    });

    // `leaderMcp` fails once `composeLaunchDraft` already ran (fire 1) and
    // after `deps.identities.create` already durably persisted the leader
    // identity, so `abandonCreation`'s `adoptDurableLeader` restores that same
    // identity (fire 2) and then closes it.
    await expect(TeamService.createNew(deps, abandonCreationInput(teamRoot))).rejects.toThrow(
      /leaderMcp unavailable on the first call/,
    );

    expect(leaderMcpCalls()).toBe(2);
    expect(tapCalls).toBe(2);

    const identities = new AgentIdentityStore({
      dir: teamRoot,
      dispatcherId: CASE_C_DISPATCHER,
      expectedName: null,
      log: silentLog,
    });
    const identity = await identities.read();
    expect(identity?.status).toBe('closed');
  });
});
