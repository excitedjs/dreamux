import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type {
  AgentRuntime,
  AgentRuntimeCapabilities,
  AgentRuntimeCreateContext,
  AgentRuntimeLastResult,
  AgentRuntimeProvider,
  AgentRuntimeStatus,
  AgentRuntimeSystemInput,
  AgentRuntimeTurnResult,
  DreamuxLogger,
  InboundTurnInput,
} from '@excitedjs/dreamux-types';

import type { AgentRuntimeProviderCatalog } from '../src/agent-runtime/index.js';
import { TeamCollection } from '../src/service/team-collection/index.js';
import { TeamMateIdentityStore } from '../src/service/teammate-collection/identity-store.js';
import { TeamMateTurnsStore } from '../src/service/teammate-collection/turns-store.js';
import { CompletionRouter } from '../src/service/completion-router/index.js';
import { ChannelBindingStore } from '../src/service/channel-binding/store.js';
import { WorktreeManager } from '../src/service/worktree/manager.js';
import { testDispatcherConfig, testDreamuxConfig } from './helpers/config.js';

const FAKE_RUNTIME_REF = 'test:runtime';

const CAPABILITIES: AgentRuntimeCapabilities = {
  resume: { supported: false },
  steer: { supported: false },
  events: { kind: 'synthesized' },
  last: { supported: true },
  context: { supported: false },
  systemPrompt: { mode: 'append' },
  teammateCompletion: [],
};

class FakeRuntime implements AgentRuntime {
  readonly providerRef = FAKE_RUNTIME_REF;
  readonly submitted: InboundTurnInput[] = [];
  private status: AgentRuntimeStatus = 'declared';

  async start(): Promise<void> {
    this.status = 'ready';
  }

  async resume(): Promise<void> {
    this.status = 'ready';
  }

  async stop(): Promise<void> {
    this.status = 'stopped';
  }

  async channelInput(input: InboundTurnInput): Promise<AgentRuntimeTurnResult> {
    this.submitted.push(input);
    return { status: 'submitted', turnId: `turn-${this.submitted.length}` };
  }

  async systemInput(_notice: AgentRuntimeSystemInput): Promise<AgentRuntimeTurnResult> {
    return { status: 'skipped' };
  }

  getStatus(): AgentRuntimeStatus {
    return this.status;
  }

  getThreadId(): string | null {
    return 'thread-fake';
  }

  wasThreadResumed(): boolean {
    return false;
  }

  async getLast(): Promise<AgentRuntimeLastResult> {
    return { text: 'fake last' };
  }

  async getContext(): Promise<null> {
    return null;
  }

  getCapabilities(): AgentRuntimeCapabilities {
    return CAPABILITIES;
  }
}

function fakeRuntimeCatalog(runtimes: FakeRuntime[]): AgentRuntimeProviderCatalog {
  const provider: AgentRuntimeProvider = {
    ref: FAKE_RUNTIME_REF,
    descriptor: {
      id: 'test-runtime',
      kind: 'agentRuntime',
      ref: { source: 'builtin', id: 'test-runtime', raw: FAKE_RUNTIME_REF },
    },
    getCapabilities: () => CAPABILITIES,
    createRuntime(_context: AgentRuntimeCreateContext) {
      const runtime = new FakeRuntime();
      runtimes.push(runtime);
      return runtime;
    },
  };
  return {
    list: () => [provider],
    resolve(ref: string) {
      if (ref !== FAKE_RUNTIME_REF) {
        throw new Error(`unexpected runtime provider ${JSON.stringify(ref)}`);
      }
      return provider;
    },
  } as AgentRuntimeProviderCatalog;
}

function noopLog(): DreamuxLogger {
  const log = {
    error: () => undefined,
    warn: () => undefined,
    info: () => undefined,
    debug: () => undefined,
    trace: () => undefined,
    child: () => log,
  };
  return log as DreamuxLogger;
}

/**
 * Guards issue #233 R4: the read path (`list` / `history` / `status`) reads the
 * leader + member count straight from the shared identity store instead of
 * newing a throwaway per-team collection. The discriminating shape the old
 * #233 scope bug needed is a team with a leader AND ≥1 spawned member: an empty
 * team would pass even a broken rewrite (member_count === 0, trivial leader).
 */
describe('TeamCollection read path (issue #233 R4)', () => {
  let root: string;
  let previousHome: string | undefined;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'dreamux-team-collection-'));
    previousHome = process.env['HOME'];
    process.env['HOME'] = join(root, 'home');
    mkdirSync(process.env['HOME'], { recursive: true });
  });

  afterEach(() => {
    if (previousHome === undefined) delete process.env['HOME'];
    else process.env['HOME'] = previousHome;
    rmSync(root, { recursive: true, force: true });
  });

  it('reports a non-null leader_state and member_count for a team with a spawned member', async () => {
    const workspace = join(root, 'workspace');
    mkdirSync(workspace, { recursive: true });
    const runtimes: FakeRuntime[] = [];
    const config = testDreamuxConfig([
      testDispatcherConfig({
        id: 'dispatcher-a',
        cwd: workspace,
        agentRuntime: 'agent-a',
        runtimeProvider: FAKE_RUNTIME_REF,
      }),
    ]);
    const log = noopLog();
    const teams = new TeamCollection({
      dispatcherId: 'dispatcher-a',
      config,
      agentRuntimeProviders: fakeRuntimeCatalog(runtimes),
      worktrees: new WorktreeManager(),
      bindings: new ChannelBindingStore(),
      identities: new TeamMateIdentityStore({ warn: log.warn.bind(log) }),
      turnsStore: new TeamMateTurnsStore({ warn: log.warn.bind(log) }),
      router: new CompletionRouter({ dispatcherId: 'dispatcher-a', log }),
      initiatorFor: async () => null,
      isShuttingDown: () => false,
      mcpServersForTeamMate: () => [],
      log,
    });

    await teams.create({
      name: 'alpha',
      leaderAgentRuntime: 'agent-a',
      intent: 'lead alpha',
      prompt: 'initial leader prompt',
    });

    // Spawn one team member through the team's own (store-sharing) collection.
    const team = await teams.get('alpha');
    const spawn = await team.spawnTeamMate({
      name: 'worker',
      prompt: 'do the work',
      agentRuntime: 'agent-a',
      intent: 'member work',
    });
    expect(spawn.teammate.name).toMatch(/worker/);

    // list(): leaderState + memberCount read straight from the shared store.
    const rows = await teams.list();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.team_name).toBe('alpha');
    expect(rows[0]!.leader_state).not.toBeNull();
    expect(rows[0]!.member_count).toBe(1);

    // history(): same two probes, via historyRow.
    const history = await teams.history({});
    expect(history.items).toHaveLength(1);
    expect(history.items[0]!.leader_state).not.toBeNull();
    expect(history.items[0]!.member_count).toBe(1);

    // status(): the per-team entity's own memberCount.
    const status = await team.status();
    expect(status.member_count).toBe(1);
    expect(status.leader).not.toBeNull();
  });
});
