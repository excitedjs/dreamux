/**
 * What a TeamLeader's runtime is actually launched with.
 *
 * The prompt is assembled inside `restoreTeamLeaderAgentForTeam` and never
 * exported, so the only honest way to read it is the way a provider reads it:
 * build a real leader through that construction boundary against a minimal
 * fake Agent Runtime provider, start it, and inspect the launch context the
 * provider is handed.
 *
 * The positive assertions name durable role facts only — which MCP servers
 * this role has, that the operator's identity text is the last thing the model
 * reads, and that no skill is mandated before every turn — never the sentences
 * that carry them. The negative ones do match fragments, because a rule this
 * prompt no longer owns can only be named by its own words: each fragment is
 * Dreamux-owned and stable, so seeing one here means a rule that now belongs
 * to another surface came back.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type {
  AgentRuntimeCreateContext,
  AgentRuntimeProvider,
  DreamuxLogger,
} from '@excitedjs/dreamux-types';

import type { AgentRuntimeProviderCatalog } from '../src/agent-runtime/index.js';
import type { DreamuxConfig, ResolvedAgentConfig } from '../src/config/config.js';
import { AgentIdentityStore } from '../src/service/agent-entity/identity-store.js';
import type { AgentEntityWorktreeIdentity } from '../src/service/agent-entity/types.js';
import { restoreTeamLeaderAgentForTeam } from '../src/service/team-service/leader-agent.js';
import { AdmissionLedger } from '../src/service/teammate-service/admission-ledger.js';
import type { TeammateAgentMcp } from '../src/service/teammate-service/types.js';
import { reuseCwdWorktree, type WorktreeManager } from '../src/service/worktree/manager.js';

const DISPATCHER = 'flow';
const TEAM = 'alpha';
const LEADER = 'alpha-leader';
const RUNTIME_ID = 'fake-runtime';

const silentLog = {
  error: () => {},
  warn: () => {},
  info: () => {},
  debug: () => {},
  trace: () => {},
  child: () => silentLog,
} as unknown as DreamuxLogger;

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

/**
 * Start a real TeamLeader and return the system-prompt lines its runtime was
 * launched with, in order.
 */
async function launchedLeaderAppend(
  identityPrompt: string | null = null,
  workspace: (teamRoot: string) => AgentEntityWorktreeIdentity = reuseCwdWorktree,
): Promise<readonly string[]> {
  const teamRoot = await mkdtemp(join(tmpdir(), 'dreamux-team-leader-prompt-'));
  roots.push(teamRoot);

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
    identityPrompt,
    status: 'running',
  });

  // A leader is restored from the identity on disk, so the test reads it back
  // the same way: what the provider is launched with has to survive the file,
  // not only the call that wrote it.
  const identity = await new AgentIdentityStore({
    dir: teamRoot,
    dispatcherId: DISPATCHER,
    expectedName: null,
    log: silentLog,
  }).read();
  if (identity === null) throw new Error('the leader identity was not stored');

  // The minimal provider: it records the context Core launches it with and
  // does nothing else. Anything Core calls that is not here fails loudly.
  const launches: AgentRuntimeCreateContext<unknown>[] = [];
  const provider = {
    getCapabilities: () => ({ tags: [], publicConfig: null }),
    readRecentActivity: async () => ({ records: [], truncated: false }),
    async createRuntime(context: AgentRuntimeCreateContext<unknown>) {
      launches.push(context);
      return {
        async start() {
          return { continuity: 'fresh' as const };
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

  const leader = restoreTeamLeaderAgentForTeam({
    dispatcherId: DISPATCHER,
    teamId: TEAM,
    workspace: workspace(teamRoot),
    identity,
    leaderMcp: () =>
      ({ leases: {}, delegates: [], adminSocketPath: '' }) as unknown as TeammateAgentMcp,
    config,
    agentRuntimeProviders: {
      resolve: () => ({ implementation: provider }),
    } as unknown as AgentRuntimeProviderCatalog,
    identities,
    admissions: new AdmissionLedger(),
    worktrees: {} as unknown as WorktreeManager,
    log: silentLog,
  });
  await leader.activate();

  expect(launches).toHaveLength(1);
  return launches[0]?.systemPrompt?.append ?? [];
}

/** The whole prompt as one text, for the assertions that read across lines. */
async function launchedLeaderPrompt(
  identityPrompt: string | null = null,
  workspace: (teamRoot: string) => AgentEntityWorktreeIdentity = reuseCwdWorktree,
): Promise<string> {
  return (await launchedLeaderAppend(identityPrompt, workspace)).join('\n');
}

function managedWorktree(
  cleanup: AgentEntityWorktreeIdentity['cleanup'],
): (teamRoot: string) => AgentEntityWorktreeIdentity {
  return (teamRoot) => ({
    mode: 'managed',
    slug: 'team-alpha',
    path: teamRoot,
    branch: 'dreamux/team-alpha',
    base_ref: 'HEAD',
    cleanup,
    cleanup_state: 'managed-active',
    cleanup_error: null,
  });
}

describe('the prompt a TeamLeader runtime is launched with', () => {
  it('maps the role\'s MCP servers', async () => {
    const prompt = await launchedLeaderPrompt();
    expect(prompt).toContain('`teammate`');
    expect(prompt).toContain('`team`');
    expect(prompt).toContain('`cron`');
    expect(prompt).toContain('channel-');
  });

  it('names a reused workspace and its cleanup mode', async () => {
    const prompt = await launchedLeaderPrompt();
    expect(prompt).toContain('is a reused directory (cleanup: keep).');
  });

  it('names a managed delete-on-close workspace and its cleanup mode', async () => {
    const prompt = await launchedLeaderPrompt(null, managedWorktree('delete-on-close'));
    expect(prompt).toContain('is a managed git worktree (cleanup: delete-on-close).');
  });

  it('names a managed kept workspace and its cleanup mode', async () => {
    const prompt = await launchedLeaderPrompt(null, managedWorktree('keep'));
    expect(prompt).toContain('is a managed git worktree (cleanup: keep).');
  });

  it('never mentions dissolving; that lives in the dissolve description', async () => {
    for (const workspace of [undefined, managedWorktree('delete-on-close'), managedWorktree('keep')]) {
      const prompt = await launchedLeaderPrompt(null, workspace);
      expect(prompt.replace(/`team` \(dissolve this Team\)/, '')).not.toMatch(/dissolv/i);
    }
  });

  it('ends with the operator\'s own identity text', async () => {
    const identityPrompt = 'You are the release captain for this Team.';
    const append = await launchedLeaderAppend(identityPrompt);
    expect(append.at(-1)).toBe(identityPrompt);
  });

  it('keeps a channel-composed identity whole across storage and restore', async () => {
    // What Feishu provisioning hands `team.create` is one string: the operator's
    // configured identity and the reply address the Team was created from. The
    // Team stores a string and the leader reads a string, so the composition
    // happens once, at creation, and nothing downstream appends it again.
    const configured = 'You are the release captain for this Team.';
    const guidance = [
      'Reply in this Feishu conversation with the channel reply tool:',
      '- chat_id: oc_example',
      '- message_id: om_initial_message (the message that initially triggered Team creation)',
      'Never omit message_id.',
    ].join('\n');
    const composed = `${configured}\n\n${guidance}`;

    const append = await launchedLeaderAppend(composed);

    expect(append.at(-1)).toBe(composed);
    const prompt = append.join('\n');
    expect(prompt.indexOf(guidance)).toBe(prompt.lastIndexOf(guidance));
    expect(prompt.indexOf(composed)).toBeGreaterThan(prompt.indexOf('`teammate`'));
  });

  it('carries no rule that another surface now owns', async () => {
    const prompt = await launchedLeaderPrompt();
    for (const fragment of [
      'do not poll',
      'reply tool',
      'public artifacts',
      'Load a tool',
    ]) {
      expect(
        prompt,
        `the TeamLeader prompt states "${fragment}" again`,
      ).not.toContain(fragment);
    }
  });

  it('mandates no skill before a turn', async () => {
    const prompt = await launchedLeaderPrompt();
    expect(prompt).not.toContain('teamwork');
  });
});
