/**
 * A TeamLeader's runtime starts inside the submission that needs it.
 *
 * Every invoker that reaches a TeamLeader — a Channel delivery, an Agent
 * delegate, a cron fire — goes through `TeamService.submitToLeader`, and the
 * leader's runtime is started by the entity's own admitted-input span: after
 * the input is announced, before its failed end is projected. Starting the
 * leader ahead of the submission is what left a Feishu card on its opening
 * label forever when codex could not come up (2026-09-03): the start failed
 * before anything was announced, so nothing ended.
 *
 * The Agent Runtime is the one seam faked here, the way `admission-ledger.test`
 * fakes it: everything from the Team's record down to the provider's `start()`
 * runs for real.
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
import { AgentIdentityStore } from '../src/service/agent-entity/identity-store.js';
import { AGENT_TASK_SOURCE } from '../src/service/submission-sources.js';
import { TeamService } from '../src/service/team-service/index.js';
import type { TeamServiceDeps } from '../src/service/team-service/types.js';
import type { TeamRecord } from '../src/service/team-collection/types.js';
import { AdmissionLedger } from '../src/service/teammate-service/admission-ledger.js';
import { reuseCwdWorktree } from '../src/service/worktree/manager.js';
import { controllableRuntimeSubmission } from './helpers/runtime-submission.js';

const DISPATCHER = 'dispatcher-1';
const TEAM = 'alpha';
const LEADER = 'alpha-leader';
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

async function bootTeam(options: {
  status: TeamRecord['status'];
  /** Fail the provider's own `start`, the way a codex that never comes up does. */
  startError?: Error;
}): Promise<{
  service: TeamService;
  /** What a display surface was told, in the order it was told. */
  seen: string[];
  inputs: ConversationInput[];
  activities: RuntimeActivity[];
}> {
  const teamRoot = await mkdtemp(join(tmpdir(), 'dreamux-team-'));
  roots.push(teamRoot);
  const now = Date.now();
  let record: TeamRecord = {
    version: 1,
    dispatcher_id: DISPATCHER,
    team_id: TEAM,
    name: TEAM,
    repo_cwd: teamRoot,
    source_repo: null,
    leader_name: LEADER,
    leader_agent_runtime: RUNTIME_ID,
    leader_identity_prompt: null,
    leader_skill_sources: [],
    runtime_cwd: teamRoot,
    worktree: reuseCwdWorktree(teamRoot),
    status: options.status,
    intent: null,
    created_at: now,
    updated_at: now,
    closed_at: null,
    close_note: null,
    create_request_id: null,
    create_payload_hash: null,
    worktree_cleanup_force: false,
  };
  const identities = new AgentIdentityStore({
    dir: teamRoot,
    dispatcherId: DISPATCHER,
    expectedName: null,
    log: silentLog,
  });
  await identities.create({
    name: LEADER,
    teamId: TEAM,
    agentRuntime: RUNTIME_ID,
    sourceCwd: teamRoot,
    sourceRepo: null,
    cwd: teamRoot,
    runtimeCwd: teamRoot,
    worktree: reuseCwdWorktree(teamRoot),
    intent: null,
    identityPrompt: null,
    sessionId: null,
    status: 'running',
  });

  const provider = {
    getCapabilities: () => ({ tags: [], publicConfig: null }),
    readRecentActivity: async () => ({ records: [], truncated: false }),
    async createRuntime() {
      return {
        async start() {
          if (options.startError !== undefined) throw options.startError;
          return { continuity: 'fresh' as const };
        },
        async submit() {
          const pending = controllableRuntimeSubmission();
          pending.complete(null);
          return { status: 'submitted' as const, submission: pending.submission };
        },
        async stop() {},
      };
    },
  } as unknown as AgentRuntimeProvider<unknown>;
  const config: DreamuxConfig = {
    agents: {
      [RUNTIME_ID]: { provider: 'fake', config: {} } as unknown as ResolvedAgentConfig,
    },
    dispatchers: [],
  };

  const seen: string[] = [];
  const inputs: ConversationInput[] = [];
  const activities: RuntimeActivity[] = [];
  const projection: ConversationProjection = {
    projectInput(_agent, input) {
      seen.push(`input:${input.text}`);
      inputs.push(input);
    },
    projectActivity(_agent, activity) {
      seen.push(`activity:${activity.kind}`);
      activities.push(activity);
    },
  };

  const deps = {
    dispatcherId: DISPATCHER,
    config,
    agentRuntimeProviders: {
      resolve: () => ({ implementation: provider }),
    } as unknown as AgentRuntimeProviderCatalog,
    worktrees: {},
    teamRoot,
    names: {},
    admissions: new AdmissionLedger(),
    conversationProjection: projection,
    completionDelivery: {},
    leaderCompletionInitiator: async () => null,
    admitOperation: <T>(task: () => Promise<T>) => task(),
    leaderMcp: () => ({
      leases: {},
      delegates: [],
      adminSocketPath: join(teamRoot, 'admin.sock'),
    }),
    store: {
      get: async () => record,
      update: async (previous: TeamRecord, patch: Partial<TeamRecord>) => {
        record = { ...previous, ...patch };
        return record;
      },
      publishRosterState: () => {},
    },
    log: silentLog,
    workflowLog: silentLog,
  } as unknown as TeamServiceDeps;

  const { service } = await TeamService.rebuild(deps, record);
  return { service, seen, inputs, activities };
}

describe('TeamService.submitToLeader: the leader starts inside the submission', () => {
  it('announces the input, then ends it with the provider\'s start error', async () => {
    const team = await bootTeam({
      status: 'starting',
      startError: new Error('codex app-server exited before it answered'),
    });

    await expect(
      team.service.submitToLeader({
        source: AGENT_TASK_SOURCE,
        text: 'first work for the leader',
      }),
    ).rejects.toThrow('codex app-server exited before it answered');

    // The input is on the display before the runtime is asked for, so the
    // failure that follows has something to end — carrying the provider's own
    // words, which is all a Channel has to show.
    expect(team.seen).toEqual([
      'input:first work for the leader',
      'activity:turn.ended',
    ]);
    expect(team.activities).toEqual([{
      kind: 'turn.ended',
      occurredAt: expect.any(Number),
      status: 'failed',
      reason: 'codex app-server exited before it answered',
    }]);
    // The Team is still the recoverable tail of its creation: its leader has
    // not taken a turn.
    expect(team.service.view().status).toBe('starting');
  });

  it('marks a starting Team running once its leader has taken a turn', async () => {
    const team = await bootTeam({ status: 'starting' });

    const admission = await team.service.submitToLeader({
      source: AGENT_TASK_SOURCE,
      text: 'first work for the leader',
    });

    expect(admission.status).toBe('submitted');
    expect(team.service.view().status).toBe('running');
    // The runtime owns the end of an accepted turn; Core ends nothing here.
    expect(team.seen).toEqual(['input:first work for the leader']);
  });
});
