import { existsSync, mkdtempSync, rmSync } from 'node:fs';
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
import { testDreamuxConfig } from './helpers/config.js';
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

function buildServices(): {
  teams: TeamService;
  teammates: TeamMateAgentService;
  provider: FakeProvider;
} {
  const config = testDreamuxConfig();
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
  return { teams: new TeamService({ teammates }), teammates, provider };
}

describe('TeamService', () => {
  let root: string;
  let previousHome: string | undefined;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'dreamux-team-'));
    previousHome = process.env['HOME'];
    process.env['HOME'] = join(root, 'home');
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

    expect(created.team).toMatchObject({
      team_id: 'alpha',
      leader_name: 'alpha-leader',
      leader_agent_runtime: 'flow',
      status: 'running',
      repo_cwd: repo,
      source_repo: repo,
    });
    expect(created.leader).toMatchObject({
      name: 'alpha-leader',
      role: 'team_leader',
      owner: { kind: 'dispatcher', dispatcher_id: 'flow' },
      team_id: 'alpha',
    });
    expect(existsSync(created.team.runtime_cwd)).toBe(true);
    expect((await teams.list('flow')).map((entry) => entry.team.team_id)).toEqual(['alpha']);
    expect((await teams.ledger('flow', 'alpha')).events.map((event) => event.type)).toEqual(['create']);

    const reloaded = new TeamService({ teammates });
    expect((await reloaded.status('flow', 'alpha')).team.team_id).toBe('alpha');

    const dissolved = await reloaded.dissolve({
      dispatcherId: 'flow',
      teamId: 'alpha',
      note: 'done',
    });
    expect(dissolved.team.status).toBe('closed');
    expect(dissolved.leader?.status).toBe('closed');
    expect((await reloaded.ledger('flow', 'alpha')).events.map((event) => event.type))
      .toEqual(['create', 'dissolve']);
  });

  it('scopes TeamLeader member visibility to its own team', async () => {
    const repo = await initGitRepo(join(root, 'scope-repo'));
    const { teams, teammates, provider } = buildServices();
    await teammates.spawn({
      dispatcherId: 'flow',
      name: 'solo',
      prompt: 'solo',
      cwd: root,
    });
    await teams.create({
      dispatcherId: 'flow',
      name: 'alpha',
      repoCwd: repo,
      leaderAgentRuntime: 'flow',
    });
    await teams.create({
      dispatcherId: 'flow',
      name: 'beta',
      repoCwd: repo,
      leaderAgentRuntime: 'flow',
    });

    const alpha = teamLeaderPrincipal({
      dispatcherId: 'flow',
      teamId: 'alpha',
      leaderName: 'alpha-leader',
    });
    const beta = teamLeaderPrincipal({
      dispatcherId: 'flow',
      teamId: 'beta',
      leaderName: 'beta-leader',
    });
    const workspace = await teams.sharedWorkspace('flow', 'alpha');
    const member = await teammates.spawnScoped({
      principal: alpha,
      name: 'builder',
      prompt: 'build',
      sharedWorkspace: workspace,
    });

    expect(member.teammate).toMatchObject({
      role: 'team_member',
      owner: {
        kind: 'team',
        dispatcher_id: 'flow',
        team_id: 'alpha',
        leader_name: 'alpha-leader',
      },
      runtime_cwd: workspace.runtimeCwd,
    });
    expect(provider.contexts.at(-1)?.cwd).toBe(workspace.runtimeCwd);
    expect((await teammates.list('flow')).map((entry) => entry.name).sort())
      .toEqual(['alpha-leader', 'beta-leader', 'solo']);
    expect((await teammates.listScoped(alpha)).map((entry) => entry.name)).toEqual(['builder']);
    expect(await teammates.listScoped(beta)).toEqual([]);
    await expect(teammates.statusScoped(beta, 'builder')).rejects.toThrow(/does not exist/);
    await expect(
      teammates.sendScoped({ principal: beta, name: 'builder', prompt: 'nope' }),
    ).rejects.toThrow(/does not exist/);
    await expect(
      teammates.closeScoped({ principal: beta, name: 'builder' }),
    ).rejects.toThrow(/does not exist/);
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
