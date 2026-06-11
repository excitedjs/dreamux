import { existsSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execa } from 'execa';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AgentRuntimeProviderCatalog } from '../src/agent-runtime/index.js';
import { TeamService } from '../src/dispatcher-service/team/service.js';
import { TeamMateAgentService } from '../src/dispatcher-service/teammate/service.js';
import { teamLeaderPrincipal } from '../src/dispatcher-service/teammate/types.js';
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
    expect(created.team).toMatchObject({
      team_id: 'alpha',
      leader_agent_runtime: 'flow',
      status: 'running',
      repo_cwd: repo,
      source_repo: repo,
    });
    expect(created.leader).toMatchObject({
      name: created.team.leader_name,
      display_name: 'alpha-leader',
      role: 'team_leader',
      owner: { kind: 'dispatcher', dispatcher_id: 'flow' },
      team_id: 'alpha',
    });
    expect(existsSync(created.team.runtime_cwd)).toBe(true);
    // Required intent (issue #182 PR-3) is persisted on the Team record.
    expect(created.team.intent).toBe('ship alpha');
    // #182 PR-7: list returns compact scan rows (name == team_id), not summaries.
    const listed = await teams.list('flow');
    expect(listed.map((entry) => entry.name)).toEqual(['alpha']);
    expect(listed[0]).toMatchObject({
      team_id: 'alpha',
      status: 'running',
      leader_name: created.team.leader_name,
      member_count: 0,
      bound_group: null,
    });
    expect((await teams.ledger('flow', 'alpha')).events.map((event) => event.type)).toEqual(['create']);

    const reloaded = new TeamService({ teammates });
    expect((await reloaded.status('flow', 'alpha')).team.team_id).toBe('alpha');

    const dissolved = await reloaded.dissolve({
      dispatcherId: 'flow',
      teamId: 'alpha',
      note: 'done',
    });
    expect(dissolved.team.status).toBe('closed');
    expect(dissolved.team.close_note).toBe('done');
    expect(dissolved.leader?.status).toBe('closed');
    const ledger = (await reloaded.ledger('flow', 'alpha')).events;
    expect(ledger.map((event) => event.type)).toEqual(['create', 'dissolve']);
    // Required dissolve note (issue #182 PR-3) is the ledger summary — no
    // synthetic 'team dissolved' fallback.
    expect(ledger.find((e) => e.type === 'dissolve')?.summary).toBe('done');
  });

  it('captures a bound-channel TeamLeader turn in the session ledger (#182 PR-5, PR#187 P1)', async () => {
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

    const events = await teammates.sessions().read('flow');
    const channelTurn = events.find((e) => e.turn_origin === 'channel');
    expect(channelTurn).toMatchObject({
      type: 'send',
      name: leaderName,
      display_name: 'alpha-leader',
      role: 'team_leader',
      team_id: 'alpha',
      leader_name: leaderName,
      turn_origin: 'channel',
      prompt_preview: 'please review the auth change',
    });
    // Carries a stable session id (same as the leader's spawn), never re-keyed.
    expect(channelTurn?.session_id).toBe(
      events.find((e) => e.type === 'spawn' && e.name === leaderName)?.session_id,
    );
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
    const firstSession = first.leader.session_id;
    expect(firstLeader).toMatch(/^tl-alpha-[a-z0-9]{8}$/);
    expect(firstSession).not.toBeNull();
    await teams.dissolve({ dispatcherId: 'flow', teamId: 'alpha', note: 'done' });

    const second = await teams.create({
      dispatcherId: 'flow',
      name: 'alpha',
      repoCwd: repo,
      leaderAgentRuntime: 'flow',
      intent: 'second',
    });
    const secondLeader = second.team.leader_name;
    // #188: a recreated closed Team gets a DISTINCT concrete leader name and a
    // distinct session — the closed leader's concrete name is never reused.
    expect(secondLeader).toMatch(/^tl-alpha-[a-z0-9]{8}$/);
    expect(secondLeader).not.toBe(firstLeader);
    expect(second.leader.name).toBe(secondLeader);
    expect(second.leader.session_id).not.toBe(firstSession);

    // The Team record (reloaded) routes/statuses on the NEW concrete leader name.
    const reloaded = new TeamService({ teammates });
    const status = await reloaded.status('flow', 'alpha');
    expect(status.team.leader_name).toBe(secondLeader);
    expect(status.leader?.name).toBe(secondLeader);

    // Both leader identities persist; the old closed one is still addressable by
    // its own concrete name (not reused, not deleted).
    const oldLeader = await teammates.status('flow', firstLeader);
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

    expect(member.teammate).toMatchObject({
      role: 'team_member',
      display_name: 'builder',
      owner: {
        kind: 'team',
        dispatcher_id: 'flow',
        team_id: 'alpha',
        leader_name: alphaTeam.team.leader_name,
      },
      runtime_cwd: workspace.runtimeCwd,
    });
    expect(provider.contexts.at(-1)?.cwd).toBe(workspace.runtimeCwd);
    // Dispatcher-scoped list sees the two leaders + the ungrouped teammate, by
    // their display names (concrete names carry random suffixes).
    expect((await teammates.list('flow')).map((entry) => entry.display_name).sort())
      .toEqual(['alpha-leader', 'beta-leader', 'solo']);
    expect((await teammates.listScoped(alpha)).map((entry) => entry.display_name)).toEqual(['builder']);
    expect(await teammates.listScoped(beta)).toEqual([]);
    await expect(teammates.statusScoped(beta, builderName)).rejects.toThrow(/does not exist/);
    await expect(
      teammates.sendScoped({ principal: beta, name: builderName, prompt: 'nope' }),
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
    ).resolves.toMatchObject({ team_id: 'gamma' });
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
    const seen = [...page1.items, ...page2.items].map((row) => row.name).sort();
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
    expect(all.items.map((row) => row.name).sort()).toEqual([
      'auth-team',
      'billing-team',
    ]);
    expect(all.next_cursor).toBeNull();

    // close_status filter isolates the dissolved Team and carries recovery facts.
    const closed = await teams.history({ dispatcherId: 'flow', closeStatus: 'closed' });
    expect(closed.items.map((row) => row.name)).toEqual(['billing-team']);
    expect(closed.items[0]).toMatchObject({
      close_status: 'closed',
      close_note: 'done',
      close_note_preview: 'done',
      source_repo: repo,
    });

    // grep matches intent text; status filter narrows to live Teams.
    expect(
      (await teams.history({ dispatcherId: 'flow', grep: 'auth' })).items.map((r) => r.name),
    ).toEqual(['auth-team']);
    expect(
      (await teams.history({ dispatcherId: 'flow', status: 'running' })).items.map((r) => r.name),
    ).toEqual(['auth-team']);

    // Bind a group → it surfaces in list (bound_group) and status (binding).
    await teams.bindChannel({
      dispatcherId: 'flow',
      teamId: 'auth-team',
      provider: 'builtin:feishu',
      chatId: 'chat-auth',
      chatType: 'group',
    });
    const listed = await teams.list('flow');
    const authRow = listed.find((row) => row.name === 'auth-team');
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
