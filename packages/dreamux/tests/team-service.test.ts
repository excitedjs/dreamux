import { existsSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execa } from 'execa';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AgentRuntimeProviderCatalog } from '../src/agent-runtime/index.js';
import { TeamService } from '../src/dispatcher-service/team/service.js';
import { TeamMateAgentService } from '../src/dispatcher-service/teammate/service.js';
import {
  teamLeaderPrincipal,
  teammatePrincipal,
  teamServicePrincipal,
} from '../src/dispatcher-service/teammate/types.js';
import { DispatcherStore } from '../src/state/dispatcher-store.js';
import { resetRuntimeConfig } from '../src/platform/paths.js';
import { createBuiltinProviderRegistry } from '../src/registry/index.js';
import { testDispatcherConfig, testDreamuxConfig } from './helpers/config.js';
import type {
  AgentRuntime,
  AgentRuntimeCapabilities,
  AgentRuntimeCreateContext,
  AgentRuntimeLastResult,
  AgentRuntimeProvider,
  AgentRuntimeResumeInput,
  AgentRuntimeSystemInput,
  AgentRuntimeTurnResult,
} from '../src/agent-runtime/index.js';
import type { InboundTurnInput } from '../src/agent-runtime/turn.js';

const FAKE_CAPABILITIES: AgentRuntimeCapabilities = {
  resume: { supported: true, checkpoint: 'codexThread' },
  steer: { supported: true },
  events: { kind: 'push' },
  last: { supported: true },
  context: { supported: true },
  systemPrompt: { mode: 'replace' },
  teammateCompletion: [],
};

class FakeRuntime implements AgentRuntime {
  readonly providerRef = 'builtin:codex';
  private status: ReturnType<AgentRuntime['getStatus']> = 'declared';
  private threadId: string | null = null;
  private turns = 0;
  readonly submitted: InboundTurnInput[] = [];

  constructor(private readonly context: AgentRuntimeCreateContext) {}

  async start(): Promise<void> {
    this.status = 'ready';
    this.threadId = `${this.context.row.dispatcher_id}-thread`;
    await this.context.state?.setThreadId(this.context.row.dispatcher_id, this.threadId);
    await this.context.state?.setStatus(this.context.row.dispatcher_id, 'ready');
  }

  async resume(input: AgentRuntimeResumeInput = {}): Promise<void> {
    this.status = 'ready';
    this.threadId = input.checkpoint?.id ?? null;
  }

  async stop(): Promise<void> {
    this.status = 'stopped';
    await this.context.state?.setStatus(this.context.row.dispatcher_id, 'stopped');
  }

  async channelInput(input: InboundTurnInput): Promise<AgentRuntimeTurnResult> {
    this.submitted.push(input);
    this.turns += 1;
    return { status: 'submitted', turnId: `turn-${this.turns}` };
  }

  async systemInput(_notice: AgentRuntimeSystemInput): Promise<AgentRuntimeTurnResult> {
    return { status: 'skipped' };
  }

  getStatus(): ReturnType<AgentRuntime['getStatus']> {
    return this.status;
  }

  getThreadId(): string | null {
    return this.threadId;
  }

  wasThreadResumed(): boolean {
    return false;
  }

  async getLast(): Promise<AgentRuntimeLastResult> {
    return { text: 'fake result' };
  }

  async getContext(): Promise<{ usedTokens: number; windowTokens: number }> {
    return { usedTokens: 1, windowTokens: 100 };
  }

  getCapabilities(): AgentRuntimeCapabilities {
    return FAKE_CAPABILITIES;
  }
}

class FakeProvider implements AgentRuntimeProvider {
  readonly ref = 'builtin:codex';
  readonly contexts: AgentRuntimeCreateContext[] = [];

  constructor(readonly descriptor: AgentRuntimeProvider['descriptor']) {}

  getCapabilities(): AgentRuntimeCapabilities {
    return FAKE_CAPABILITIES;
  }

  createRuntime(context: AgentRuntimeCreateContext): AgentRuntime {
    this.contexts.push(context);
    return new FakeRuntime(context);
  }
}

/** The dispatcher workspace cwd for the current test; set in beforeEach. */
let dispatcherCwd: string;

function buildServices(): {
  teams: TeamService;
  teammates: TeamMateAgentService;
  provider: FakeProvider;
} {
  const config = testDreamuxConfig([testDispatcherConfig({ cwd: dispatcherCwd })]);
  const registry = createBuiltinProviderRegistry();
  const descriptor = registry.resolve('builtin:codex');
  const provider = new FakeProvider(descriptor);
  registry.registerImplementation(descriptor.id, provider);
  const teammates = new TeamMateAgentService({
    config,
    dispatchers: new DispatcherStore(config),
    agentRuntimeProviders: new AgentRuntimeProviderCatalog({ registry }),
    log: noopLog(),
  });
  const teams = new TeamService({ teammates });
  return { teams, teammates, provider };
}

describe('TeamService', () => {
  let root: string;
  let previousHome: string | undefined;

  beforeEach(() => {
    // realpath: on macOS tmpdir() is a /var -> /private/var symlink, and git
    // reports symlink-resolved repo roots (source_repo), so fixture paths must
    // be canonical for path equality assertions.
    root = realpathSync(mkdtempSync(join(tmpdir(), 'dreamux-team-')));
    previousHome = process.env['HOME'];
    process.env['HOME'] = join(root, 'home');
    // The dispatcher workspace cwd contract (issue #182 PR-4) requires an
    // explicit, non-`~/.dreamux` workspace; managed team worktrees land under
    // `<workspace>/.workspace/worktree/...`.
    dispatcherCwd = join(root, 'workspace');
    resetRuntimeConfig();
  });

  afterEach(() => {
    if (previousHome === undefined) delete process.env['HOME'];
    else process.env['HOME'] = previousHome;
    resetRuntimeConfig();
    rmSync(root, { recursive: true, force: true });
  });

  it('creates, lists, reloads, and dissolves a team with a leader', async () => {
    const repo = await initGitRepo(join(root, 'repo'));
    const { teams, teammates } = buildServices();

    const created = await teams.create({
      dispatcherId: 'flow',
      name: 'alpha',
      repoCwd: repo,
      leaderAgentRuntime: 'flow',
      intent: 'ship alpha',
    });

    // #188: the Team's leader_name is a concrete, never-reused `tl-` name; the
    // human-readable `${teamId}-leader` survives only as the leader display name.
    expect(created.team.leader_name).toMatch(/^tl-alpha-[a-z0-9]{8}$/);
    // #199 Slice 2: the public team view is keyed by team_name and drops the
    // duplicate team_id and the machine-local repo_cwd / runtime_cwd / worktree.
    expect(created.team).toMatchObject({
      team_name: 'alpha',
      leader_agent_runtime: 'flow',
      status: 'running',
      source_repo: repo,
    });
    expect(created.team).not.toHaveProperty('team_id');
    expect(created.team).not.toHaveProperty('repo_cwd');
    expect(created.team).not.toHaveProperty('runtime_cwd');
    // The leader carries the collapsed `repo` view; owner is the sole ownership
    // authority (no public role/team_id/display_name on the teammate status).
    expect(created.leader).toMatchObject({
      name: created.team.leader_name,
      owner: { kind: 'dispatcher', dispatcher_id: 'flow' },
    });
    expect(created.leader).not.toHaveProperty('display_name');
    expect(created.leader).not.toHaveProperty('role');
    expect(created.leader).not.toHaveProperty('team_id');
    // The leader runs in the prepared team worktree (its repo.path exists).
    expect(existsSync(created.leader!.repo.path)).toBe(true);
    // Required intent (issue #182 PR-3) is persisted and surfaced on the view.
    expect(created.team.intent).toBe('ship alpha');
    // #182 PR-7: list returns compact scan rows, not summaries. #199 Slice 1:
    // rows are keyed by the concrete team_name; the duplicate team_id and the
    // machine-local repo_cwd / worktree_mode are no longer projected.
    const listed = await teams.list('flow');
    expect(listed.map((entry) => entry.team_name)).toEqual(['alpha']);
    expect(listed[0]).toMatchObject({
      team_name: 'alpha',
      status: 'running',
      leader_name: created.team.leader_name,
      member_count: 0,
      bound_group: null,
    });
    expect(listed[0]).not.toHaveProperty('team_id');
    expect(listed[0]).not.toHaveProperty('repo_cwd');
    expect(listed[0]).not.toHaveProperty('worktree_mode');

    const reloaded = new TeamService({ teammates });
    expect((await reloaded.status('flow', 'alpha')).team.team_name).toBe('alpha');

    // #199 Slice 3: the team audit ledger JSONL was removed. Dissolve persists
    // the closed status + the required note on the JSON team record, surfaced by
    // status/history (no separate event stream).
    const dissolved = await reloaded.dissolve({
      dispatcherId: 'flow',
      teamId: 'alpha',
      note: 'done',
    });
    expect(dissolved.team.status).toBe('closed');
    expect(dissolved.team.close_note).toBe('done');
    expect(dissolved.leader?.status).toBe('closed');
    const closedView = (await reloaded.history({ dispatcherId: 'flow', status: 'closed' }))
      .items.find((item) => item.team_name === 'alpha');
    expect(closedView?.close_note).toBe('done');
  });

  it('creates a team with no repo in a plain .workspace/work/<team_name> dir, members inherit it', async () => {
    // #199: a Team with no `repo` runs the TeamLeader (and every member) in a
    // plain `<dispatcher cwd>/.workspace/work/<team_name>/` directory — NOT a git
    // worktree — so the dispatcher cwd need not be a git repo. dispatcherCwd is a
    // plain (non-git) directory here.
    const { teams, teammates } = buildServices();
    const created = await teams.create({
      dispatcherId: 'flow',
      name: 'plain',
      intent: 'work',
      leaderAgentRuntime: 'flow',
    });
    expect(created.team).toMatchObject({
      team_name: 'plain',
      status: 'running',
      source_repo: null,
    });
    expect(created.leader!.repo).toMatchObject({
      mode: 'reuse-cwd',
      source_repo: null,
      cleanup_state: 'not-managed',
    });
    expect(created.leader!.repo.path).toMatch(/\/\.workspace\/work\/plain$/);
    expect(existsSync(created.leader!.repo.path)).toBe(true);

    // A member spawned by the TeamLeader inherits the SAME shared work dir.
    const workspace = await teams.sharedWorkspace('flow', 'plain');
    const member = await teammates.spawnScoped({
      principal: teamLeaderPrincipal({
        dispatcherId: 'flow',
        teamId: 'plain',
        leaderName: created.team.leader_name,
      }),
      name: 'builder',
      intent: 'work',
      prompt: 'build',
      sharedWorkspace: workspace,
    });
    expect(member.teammate.repo.path).toBe(created.leader!.repo.path);
  });

  it('captures a bound-channel TeamLeader turn in the leader turns archive (#199 Slice 3)', async () => {
    const repo = await initGitRepo(join(root, 'channel-repo'));
    const { teams, teammates } = buildServices();

    const created = await teams.create({
      dispatcherId: 'flow',
      name: 'alpha',
      repoCwd: repo,
      leaderAgentRuntime: 'flow',
      intent: 'ship alpha',
    });
    const leaderName = created.team.leader_name;

    // A normal user turn delivered through a bound Team channel goes
    // create -> routeChannelInput -> deliverToLeader -> channelInputScoped, which
    // must now append a durable channel-origin turn (it previously recorded only
    // the in-memory origin).
    await teams.deliverToLeader({
      dispatcherId: 'flow',
      teamId: 'alpha',
      turn: { text: 'please review the auth change', sourceId: 'msg-1' },
    });

    // #199 Slice 3: the channel-origin turn is captured as a compact `submit`
    // row in the LEADER's own per-name turns archive (no separate session ledger;
    // the row carries turn-specific facts only — no name/role/team_id).
    const turnRows = [];
    for await (const row of teammates.turns().stream('flow', leaderName)) {
      turnRows.push(row);
    }
    const channelTurn = turnRows.find((row) => row.turn_origin === 'channel');
    expect(channelTurn).toMatchObject({
      type: 'submit',
      turn_origin: 'channel',
      prompt_preview: 'please review the auth change',
    });
  });

  it('recreating a closed Team persists the new create.intent (#182 PR-3 P1)', async () => {
    const repo = await initGitRepo(join(root, 'reuse-repo'));
    const { teams, teammates } = buildServices();

    const first = await teams.create({
      dispatcherId: 'flow',
      name: 'alpha',
      repoCwd: repo,
      leaderAgentRuntime: 'flow',
      intent: 'first intent',
    });
    expect(first.team.intent).toBe('first intent');
    await teams.dissolve({ dispatcherId: 'flow', teamId: 'alpha', note: 'done' });

    // Reusing the closed record must adopt the NEW intent, not keep the old one
    // (the store.update path previously could not write intent).
    const second = await teams.create({
      dispatcherId: 'flow',
      name: 'alpha',
      repoCwd: repo,
      leaderAgentRuntime: 'flow',
      intent: 'second intent',
    });
    expect(second.team.intent).toBe('second intent');
    // And the durable record (reloaded from disk) carries the new intent.
    const reloaded = new TeamService({ teammates });
    expect((await reloaded.status('flow', 'alpha')).team.intent).toBe('second intent');
  });

  it('recreating a closed Team allocates a fresh leader name + session — never reuses (#188 P1)', async () => {
    const repo = await initGitRepo(join(root, 'recreate-leader-repo'));
    const { teams, teammates } = buildServices();

    const first = await teams.create({
      dispatcherId: 'flow',
      name: 'alpha',
      repoCwd: repo,
      leaderAgentRuntime: 'flow',
      intent: 'first',
    });
    const firstLeader = first.team.leader_name;
    expect(firstLeader).toMatch(/^tl-alpha-[a-z0-9]{8}$/);
    await teams.dissolve({ dispatcherId: 'flow', teamId: 'alpha', note: 'done' });

    const second = await teams.create({
      dispatcherId: 'flow',
      name: 'alpha',
      repoCwd: repo,
      leaderAgentRuntime: 'flow',
      intent: 'second',
    });
    const secondLeader = second.team.leader_name;
    // #188: a recreated closed Team gets a DISTINCT concrete leader name — the
    // closed leader's concrete name is never reused (the name is the session
    // identity now that the Dreamux-minted session id is gone, #199 Slice 3).
    expect(secondLeader).toMatch(/^tl-alpha-[a-z0-9]{8}$/);
    expect(secondLeader).not.toBe(firstLeader);
    expect(second.leader.name).toBe(secondLeader);

    // The Team record (reloaded) routes/statuses on the NEW concrete leader name.
    const reloaded = new TeamService({ teammates });
    const status = await reloaded.status('flow', 'alpha');
    expect(status.team.leader_name).toBe(secondLeader);
    expect(status.leader?.name).toBe(secondLeader);

    // Both leader identities persist; the old closed one is still addressable by
    // its own concrete name (not reused, not deleted) through the Team-service
    // authority — a TeamLeader is never on the dispatcher `teammate.*` surface.
    const oldLeader = await teammates.statusScoped(
      teamServicePrincipal({ dispatcherId: 'flow', teamId: 'alpha', leaderName: firstLeader }),
      firstLeader,
    );
    expect(oldLeader.status).toBe('closed');
    expect(oldLeader.name).toBe(firstLeader);
  });

  it('rejects direct service create/dissolve with missing or empty intent/note (#182 PR-3 P1)', async () => {
    const repo = await initGitRepo(join(root, 'svc-validate-repo'));
    const { teams } = buildServices();

    // create.intent required at the service boundary (in-process bypass).
    await expect(
      teams.create({
        dispatcherId: 'flow',
        name: 'novalidate',
        repoCwd: repo,
        leaderAgentRuntime: 'flow',
        intent: '',
      }),
    ).rejects.toThrow(/Team create intent must be a non-empty string/);

    // dissolve.note required at the service boundary, checked before lookup.
    await teams.create({
      dispatcherId: 'flow',
      name: 'beta',
      repoCwd: repo,
      leaderAgentRuntime: 'flow',
      intent: 'work',
    });
    await expect(
      teams.dissolve({ dispatcherId: 'flow', teamId: 'beta', note: '' }),
    ).rejects.toThrow(/Team dissolve note must be a non-empty string/);
  });

  it('scopes TeamLeader member visibility to its own team', async () => {
    const repo = await initGitRepo(join(root, 'scope-repo'));
    const { teams, teammates, provider } = buildServices();
    await teammates.spawn({
      dispatcherId: 'flow',
      name: 'solo',
      intent: 'work',
      prompt: 'solo',
      cwd: root,
    });
    const alphaTeam = await teams.create({
      dispatcherId: 'flow',
      name: 'alpha',
      intent: 'work',
      repoCwd: repo,
      leaderAgentRuntime: 'flow',
    });
    const betaTeam = await teams.create({
      dispatcherId: 'flow',
      name: 'beta',
      intent: 'work',
      repoCwd: repo,
      leaderAgentRuntime: 'flow',
    });

    // #188: principals carry the team's concrete leader_name, the same value the
    // Team service stores and routes on.
    const alpha = teamLeaderPrincipal({
      dispatcherId: 'flow',
      teamId: 'alpha',
      leaderName: alphaTeam.team.leader_name,
    });
    const beta = teamLeaderPrincipal({
      dispatcherId: 'flow',
      teamId: 'beta',
      leaderName: betaTeam.team.leader_name,
    });
    const workspace = await teams.sharedWorkspace('flow', 'alpha');
    const member = await teammates.spawnScoped({
      principal: alpha,
      name: 'builder',
      intent: 'work',
      prompt: 'build',
      sharedWorkspace: workspace,
    });
    const builderName = member.teammate.name;
    // A Team member gets the `tm-` rule (#188).
    expect(builderName).toMatch(/^tm-builder-[a-z0-9]{8}$/);

    // #199 Slice 2: owner is the sole ownership/visibility authority (no public
    // role); the work directory is reported through the collapsed `repo` view.
    expect(member.teammate).toMatchObject({
      owner: {
        kind: 'team',
        dispatcher_id: 'flow',
        team_id: 'alpha',
        leader_name: alphaTeam.team.leader_name,
      },
      repo: { path: workspace.runtimeCwd },
    });
    expect(member.teammate).not.toHaveProperty('role');
    expect(member.teammate).not.toHaveProperty('display_name');
    expect(provider.contexts.at(-1)?.cwd).toBe(workspace.runtimeCwd);
    // #199 Slice 4 leak prevention: the dispatcher's teammate.* sees ONLY the
    // ordinary teammate it spawned — never a TeamLeader and never a Team member.
    // (concrete names carry a random 8-char suffix; identify by the base.)
    const base = (name: string): string => name.replace(/-[a-z0-9]{8}$/, '');
    expect((await teammates.list('flow')).map((entry) => base(entry.name)).sort())
      .toEqual(['solo']);
    // A TeamLeader is invisible to the dispatcher through status / last / history.
    for (const leaderName of [alphaTeam.team.leader_name, betaTeam.team.leader_name]) {
      await expect(teammates.status('flow', leaderName)).rejects.toThrow(/does not exist/);
      await expect(teammates.last('flow', leaderName)).rejects.toThrow(/does not exist/);
    }
    // A Team member is invisible to the dispatcher too.
    await expect(teammates.status('flow', builderName)).rejects.toThrow(/does not exist/);
    expect(
      (await teammates.history({ dispatcherId: 'flow' })).items.map((row) => base(row.name)),
    ).toEqual(['solo']);
    // A TeamLeader sees only the members of its OWN team — not the leaders, not
    // the dispatcher's ordinary teammates, not another team's members.
    expect((await teammates.listScoped(alpha)).map((entry) => base(entry.name))).toEqual([
      'tm-builder',
    ]);
    expect(await teammates.listScoped(beta)).toEqual([]);
    await expect(teammates.statusScoped(beta, builderName)).rejects.toThrow(/does not exist/);
    await expect(
      teammates.sendScoped({ principal: beta, name: builderName, prompt: 'nope' }),
    ).rejects.toThrow(/does not exist/);
    // An ordinary TeamMate principal can read no peers at all.
    expect(await teammates.listScoped(teammatePrincipal('flow'))).toEqual([]);
    await expect(
      teammates.statusScoped(teammatePrincipal('flow'), builderName),
    ).rejects.toThrow(/does not exist/);
    await expect(
      teammates.closeScoped({ principal: beta, name: builderName, note: 'nope' }),
    ).rejects.toThrow(/does not exist/);
  });

  it('create binds an existing Feishu group via bind_group (#182 PR-8)', async () => {
    const repo = await initGitRepo(join(root, 'bindgroup-repo'));
    const { teams } = buildServices();

    // #182 PR-8: the retired create_group is replaced by binding an EXISTING
    // group at create time — no new Feishu group is created.
    const result = await teams.create({
      dispatcherId: 'flow',
      name: 'gamma',
      intent: 'work',
      repoCwd: repo,
      leaderAgentRuntime: 'flow',
      bindGroup: { chatId: 'oc_existing_group' },
    });
    expect(result.binding).toEqual({
      provider: 'builtin:feishu',
      chat_id: 'oc_existing_group',
    });
    // The bound group resolves to the Team, and status/list surface it.
    await expect(
      teams.resolveChannel({
        dispatcherId: 'flow',
        provider: 'builtin:feishu',
        chatId: 'oc_existing_group',
        chatType: 'group',
      }),
    ).resolves.toMatchObject({ team_name: 'gamma' });
    expect((await teams.status('flow', 'gamma')).binding).toEqual({
      provider: 'builtin:feishu',
      chat_id: 'oc_existing_group',
    });
  });

  it('history paginates by cursor and rejects an invalid cursor (#182 PR-7 P2)', async () => {
    const repo = await initGitRepo(join(root, 'history-page-repo'));
    const { teams } = buildServices();
    for (const name of ['t-one', 't-two', 't-three']) {
      await teams.create({
        dispatcherId: 'flow',
        name,
        repoCwd: repo,
        leaderAgentRuntime: 'flow',
        intent: 'work',
      });
    }

    const page1 = await teams.history({ dispatcherId: 'flow', limit: 2 });
    expect(page1.items).toHaveLength(2);
    expect(page1.next_cursor).not.toBeNull();
    const page2 = await teams.history({
      dispatcherId: 'flow',
      limit: 2,
      cursor: page1.next_cursor!,
    });
    expect(page2.items).toHaveLength(1);
    expect(page2.next_cursor).toBeNull();
    // The two pages together cover all three Teams with no overlap.
    const seen = [...page1.items, ...page2.items].map((row) => row.team_name).sort();
    expect(seen).toEqual(['t-one', 't-three', 't-two']);
    // An invalid cursor fails loud rather than silently resetting to page 0.
    await expect(
      teams.history({ dispatcherId: 'flow', cursor: 'not-a-cursor' }),
    ).rejects.toThrow(/invalid history cursor/);
  });

  it('history is a filterable recovery search; list/status surface the bound group (#182 PR-7)', async () => {
    const repo = await initGitRepo(join(root, 'history-repo'));
    const { teams } = buildServices();

    await teams.create({
      dispatcherId: 'flow',
      name: 'auth-team',
      repoCwd: repo,
      leaderAgentRuntime: 'flow',
      intent: 'ship the auth change',
    });
    await teams.create({
      dispatcherId: 'flow',
      name: 'billing-team',
      repoCwd: repo,
      leaderAgentRuntime: 'flow',
      intent: 'fix billing',
    });
    await teams.dissolve({ dispatcherId: 'flow', teamId: 'billing-team', note: 'done' });

    // No filters → both Teams, most-recent first (billing was touched last).
    const all = await teams.history({ dispatcherId: 'flow' });
    expect(all.items.map((row) => row.team_name).sort()).toEqual([
      'auth-team',
      'billing-team',
    ]);
    expect(all.next_cursor).toBeNull();

    // #199 Slice 1: rows are keyed by team_name. The dissolved Team is still
    // recoverable and carries recovery facts, but the row no longer projects a
    // close_status flag, the duplicate team_id, or machine-local cwd/worktree.
    const dissolved = all.items.find((row) => row.team_name === 'billing-team');
    expect(dissolved).toMatchObject({
      close_note: 'done',
      close_note_preview: 'done',
      source_repo: repo,
    });
    for (const removed of ['close_status', 'team_id', 'repo_cwd', 'runtime_cwd', 'worktree']) {
      expect(dissolved).not.toHaveProperty(removed);
    }

    // The lifecycle `status` filter survives (the legacy close_status is gone):
    // 'running' isolates the live Team, 'closed' the dissolved one.
    expect(
      (await teams.history({ dispatcherId: 'flow', status: 'running' })).items.map(
        (r) => r.team_name,
      ),
    ).toEqual(['auth-team']);
    expect(
      (await teams.history({ dispatcherId: 'flow', status: 'closed' })).items.map(
        (r) => r.team_name,
      ),
    ).toEqual(['billing-team']);

    // grep matches intent text on either Team.
    expect(
      (await teams.history({ dispatcherId: 'flow', grep: 'auth' })).items.map((r) => r.team_name),
    ).toEqual(['auth-team']);
    expect(
      (await teams.history({ dispatcherId: 'flow', grep: 'billing' })).items.map((r) => r.team_name),
    ).toEqual(['billing-team']);

    // Bind a group → it surfaces in list (bound_group) and status (binding).
    await teams.bindChannel({
      dispatcherId: 'flow',
      teamId: 'auth-team',
      provider: 'builtin:feishu',
      chatId: 'chat-auth',
      chatType: 'group',
    });
    const listed = await teams.list('flow');
    const authRow = listed.find((row) => row.team_name === 'auth-team');
    expect(authRow?.bound_group).toEqual({ provider: 'builtin:feishu', chat_id: 'chat-auth' });
    const status = await teams.status('flow', 'auth-team');
    expect(status.binding).toEqual({ provider: 'builtin:feishu', chat_id: 'chat-auth' });
  });
});

function noopLog(): {
  info: () => undefined;
  warn: () => undefined;
  error: () => undefined;
} {
  return {
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
  };
}

async function initGitRepo(path: string): Promise<string> {
  await mkdir(path, { recursive: true });
  await execa('git', ['init', '-b', 'main'], { cwd: path });
  await execa('git', ['config', 'user.name', 'Dreamux Test'], { cwd: path });
  await execa('git', ['config', 'user.email', 'dreamux-test@example.com'], { cwd: path });
  await writeFile(join(path, 'README.md'), 'test\n');
  await execa('git', ['add', 'README.md'], { cwd: path });
  await execa('git', ['commit', '-m', 'Initial test commit'], { cwd: path });
  return path;
}
