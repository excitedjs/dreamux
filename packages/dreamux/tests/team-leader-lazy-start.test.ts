/**
 * Team creation starts no runtime; the leader's runtime starts inside its own
 * first submission.
 *
 * A codex thread started at creation time, ahead of any turn, writes no
 * rollout — so the leader could never be resumed by a later start (found live,
 * 2026-09-03). Creation therefore starts nothing on its own: a prompt-less
 * creation starts no runtime at all, and a creation prompt starts the runtime
 * exactly the way an ordinary `submitToLeader` call does — through
 * `TeammateService.submitInput`'s own admitted-input span, which announces the
 * input before asking for a runtime and, on a start failure, ends the display
 * with the provider's own error and abandons the creation the same way an
 * `activate()` failure once did.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type {
  AgentRuntimeProvider,
  RuntimeActivity,
} from '@excitedjs/dreamux-types';

import type { AgentRuntimeProviderCatalog } from '../src/agent-runtime/index.js';
import type {
  ConversationInput,
  ConversationProjection,
} from '../src/channel/conversation-projection.js';
import type { DreamuxConfig, ResolvedAgentConfig } from '../src/config/config.js';
import { AGENT_TASK_SOURCE } from '../src/service/submission-sources.js';
import { TeamService } from '../src/service/team-service/index.js';
import type {
  TeamServiceCreateInput,
  TeamServiceDeps,
} from '../src/service/team-service/types.js';
import type { TeamRecord } from '../src/service/team-collection/types.js';
import { AdmissionLedger } from '../src/service/teammate-service/admission-ledger.js';
import { reuseCwdWorktree } from '../src/service/worktree/manager.js';
import { controllableRuntimeSubmission } from './helpers/runtime-submission.js';

const DISPATCHER = 'dispatcher-1';
const TEAM = 'alpha';
const RUNTIME_ID = 'fake-runtime';

const silentLog = {
  warn: () => {},
  error: () => {},
  info: () => {},
  debug: () => {},
  trace: () => {},
  child: () => silentLog,
} as unknown as TeamServiceDeps['log'];

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

/**
 * One shared timeline of every event a display surface and the Agent Runtime
 * provider are told, in the order they were told — the same seam
 * `admission-ledger.test` and `team-leader-start-failure.test` fake, extended
 * with the provider's own `createRuntime`/`start`/`submit` so creation and an
 * ordinary later submission can be told apart in the same trace.
 */
async function harness(options: {
  /** Fail the provider's own `start`, the way a codex that never comes up does. */
  startError?: Error;
}): Promise<{
  deps: TeamServiceDeps;
  teamRoot: string;
  order: string[];
  inputs: ConversationInput[];
  activities: RuntimeActivity[];
  createRuntimeCalls: () => number;
  currentRecord: () => TeamRecord | null;
}> {
  const teamRoot = await mkdtemp(join(tmpdir(), 'dreamux-team-'));
  roots.push(teamRoot);

  const order: string[] = [];
  let createRuntimeCalls = 0;

  const provider = {
    getCapabilities: () => ({ tags: [], publicConfig: null }),
    readRecentActivity: async () => ({ records: [], truncated: false }),
    async createRuntime() {
      createRuntimeCalls += 1;
      order.push('createRuntime');
      return {
        async start() {
          order.push('start');
          if (options.startError !== undefined) throw options.startError;
          return { continuity: 'fresh' as const };
        },
        async submit() {
          order.push('submit');
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

  const config: DreamuxConfig = {
    agents: {
      [RUNTIME_ID]: { provider: 'fake', config: {} } as unknown as ResolvedAgentConfig,
    },
    dispatchers: [],
  };

  const inputs: ConversationInput[] = [];
  const activities: RuntimeActivity[] = [];
  const projection: ConversationProjection = {
    projectInput(_agent, input) {
      order.push(`input:${input.text}`);
      inputs.push(input);
    },
    projectActivity(_agent, activity) {
      order.push(`activity:${activity.kind}`);
      activities.push(activity);
    },
  };

  let record: TeamRecord | null = null;
  const store = {
    create: async (
      input: Omit<
        TeamRecord,
        'version' | 'created_at' | 'updated_at' | 'worktree_cleanup_force'
      >,
    ) => {
      const now = Date.now();
      record = {
        version: 1,
        ...input,
        worktree_cleanup_force: false,
        created_at: now,
        updated_at: now,
      };
      return record;
    },
    get: async () => record,
    update: async (previous: TeamRecord, patch: Partial<TeamRecord>) => {
      record = { ...previous, ...patch };
      return record;
    },
    publishRosterState: () => {},
  };

  const deps = {
    dispatcherId: DISPATCHER,
    config,
    agentRuntimeProviders: {
      resolve: () => ({ implementation: provider }),
    } as unknown as AgentRuntimeProviderCatalog,
    worktrees: {},
    teamRoot,
    names: { allocate: async () => `${TEAM}-leader` },
    admissions: new AdmissionLedger(),
    admitOperation: <T>(task: () => Promise<T>) => task(),
    conversationProjection: projection,
    completionDelivery: {},
    leaderCompletionInitiator: async () => null,
    leaderMcp: () => ({
      leases: {},
      delegates: [],
      adminSocketPath: join(teamRoot, 'admin.sock'),
    }),
    store,
    log: silentLog,
    workflowLog: silentLog,
  } as unknown as TeamServiceDeps;

  return {
    deps,
    teamRoot,
    order,
    inputs,
    activities,
    createRuntimeCalls: () => createRuntimeCalls,
    currentRecord: () => record,
  };
}

function createInput(
  teamRoot: string,
  options: { prompt?: string },
): TeamServiceCreateInput {
  return {
    teamId: TEAM,
    name: TEAM,
    leaderAgentRuntime: RUNTIME_ID,
    intent: 'do the work',
    ...(options.prompt !== undefined ? { prompt: options.prompt } : {}),
    workspace: {
      sourceCwd: teamRoot,
      sourceRepo: null,
      runtimeCwd: teamRoot,
      worktree: reuseCwdWorktree(teamRoot),
      createdCheckout: false,
    },
  };
}

describe('TeamService.createNew: the leader starts inside its first submission', () => {
  it('creates a Team without a prompt and starts nothing', async () => {
    const team = await harness({});

    const result = await TeamService.createNew(team.deps, createInput(team.teamRoot, {}));

    expect(result).not.toBeNull();
    // Nothing asked the Agent Runtime provider for anything: no thread, no
    // codex process, nothing that would need a resumable rollout.
    expect(team.createRuntimeCalls()).toBe(0);
    expect(result?.leaderResult.submission).toBeNull();
    expect(result?.service.view().status).toBe('running');
    expect(team.order).toEqual([]);

    // The first ordinary submission is where the runtime actually starts.
    const admission = await result?.service.submitToLeader({
      source: AGENT_TASK_SOURCE,
      text: 'first work',
    });

    expect(admission?.status).toBe('submitted');
    expect(team.order).toEqual(['input:first work', 'createRuntime', 'start', 'submit']);
    expect(team.createRuntimeCalls()).toBe(1);
  });

  it('creates a Team with a prompt and starts the leader inside that submission', async () => {
    const team = await harness({});

    const result = await TeamService.createNew(
      team.deps,
      createInput(team.teamRoot, { prompt: 'do the thing' }),
    );

    expect(result).not.toBeNull();
    expect(team.order).toEqual(['input:do the thing', 'createRuntime', 'start', 'submit']);
    expect(team.createRuntimeCalls()).toBe(1);
    expect(result?.leaderResult.submission?.status).toBe('submitted');
    expect(team.currentRecord()?.status).toBe('running');
  });

  it('abandons a creation whose prompt cannot start the leader', async () => {
    const startError = new Error('codex app-server exited before it answered');
    const team = await harness({ startError });

    await expect(
      TeamService.createNew(team.deps, createInput(team.teamRoot, { prompt: 'do the thing' })),
    ).rejects.toThrow('codex app-server exited before it answered');

    // The input is announced and the runtime is asked for before the failure —
    // the same admitted-input span an ordinary `submitToLeader` call takes —
    // and the display is ended with the provider's own error afterward.
    expect(team.order.slice(0, 3)).toEqual([
      'input:do the thing',
      'createRuntime',
      'start',
    ]);
    expect(team.order.indexOf('activity:turn.ended')).toBeGreaterThan(
      team.order.indexOf('start'),
    );
    expect(team.createRuntimeCalls()).toBe(1);
    // Creation is abandoned exactly the way an `activate()` failure once was:
    // the record this Team published is closed, not left `starting` forever.
    expect(team.currentRecord()?.status).toBe('closed');
  });
});
