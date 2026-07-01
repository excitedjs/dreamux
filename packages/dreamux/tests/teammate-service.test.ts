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
  AgentRuntimeTextInput,
  AgentRuntimeTurnResult,
  DreamuxLogger,
  InboundTurnInput,
} from '@excitedjs/dreamux-types';

import type { AgentRuntimeProviderCatalog } from '../src/agent-runtime/index.js';
import { TeamMateIdentityStore } from '../src/service/teammate-collection/identity-store.js';
import { TeamMateTurnsStore } from '../src/service/teammate-collection/turns-store.js';
import type { TeamMateWorktreeIdentity } from '../src/service/teammate-collection/types.js';
import { createTeamLeaderAgent } from '../src/service/team-service/leader-agent.js';
import type { TeammateService } from '../src/service/teammate-service/index.js';
import { WorktreeManager } from '../src/service/worktree/manager.js';
import { testDispatcherConfig, testDreamuxConfig } from './helpers/config.js';

const FAKE_RUNTIME_REF = 'test:runtime';

const CAPABILITIES: AgentRuntimeCapabilities = {
  resume: { supported: false },
};

class FakeRuntime implements AgentRuntime {
  readonly providerRef = FAKE_RUNTIME_REF;
  readonly submitted: InboundTurnInput[] = [];
  readonly textSubmitted: AgentRuntimeTextInput[] = [];
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

  async completionInput(input: AgentRuntimeTextInput): Promise<AgentRuntimeTurnResult> {
    this.textSubmitted.push(input);
    return { status: 'submitted', turnId: `text-${this.textSubmitted.length}` };
  }

  getStatus(): AgentRuntimeStatus {
    return this.status;
  }

  getCheckpoint(): { id: string } | null {
    return { id: 'thread-fake' };
  }

  wasCheckpointResumed(): boolean {
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

function fakeRuntimeCatalog(
  runtimes: FakeRuntime[],
  contexts: AgentRuntimeCreateContext[] = [],
): AgentRuntimeProviderCatalog {
  const provider: AgentRuntimeProvider = {
    ref: FAKE_RUNTIME_REF,
    descriptor: {
      id: 'test-runtime',
      kind: 'agentRuntime',
      ref: { source: 'builtin', id: 'test-runtime', raw: FAKE_RUNTIME_REF },
    },
    getCapabilities: () => CAPABILITIES,
    createRuntime(context: AgentRuntimeCreateContext) {
      const runtime = new FakeRuntime();
      contexts.push(context);
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

function reuseCwd(path: string): TeamMateWorktreeIdentity {
  return {
    mode: 'reuse-cwd',
    slug: null,
    path,
    branch: null,
    base_ref: null,
    cleanup: 'keep',
    cleanup_state: 'not-managed',
    cleanup_error: null,
  };
}

async function createTestTeamLeader(input: {
  dispatcherId: string;
  teamId: string;
  name: string;
  prompt?: string;
  agentRuntime: string;
  workspace: string;
  config: ReturnType<typeof testDreamuxConfig>;
  agentRuntimeProviders: AgentRuntimeProviderCatalog;
  identity?: string;
}): Promise<TeammateService> {
  const log = noopLog();
  const identities = new TeamMateIdentityStore({ warn: log.warn.bind(log) });
  const turnsStore = new TeamMateTurnsStore({ warn: log.warn.bind(log) });
  const identity = await identities.create({
    dispatcherId: input.dispatcherId,
    name: input.name,
    role: 'team_leader',
    teamId: input.teamId,
    agentRuntime: input.agentRuntime,
    sourceCwd: input.workspace,
    sourceRepo: null,
    cwd: input.workspace,
    runtimeCwd: input.workspace,
    worktree: reuseCwd(input.workspace),
    intent: 'lead alpha',
    ...(input.identity !== undefined ? { identityPrompt: input.identity } : {}),
    status: 'starting',
  });
  const leader = createTeamLeaderAgent({
    dispatcherId: input.dispatcherId,
    identity,
    mcpServers: [],
    disableFeatures: [],
    config: input.config,
    agentRuntimeProviders: input.agentRuntimeProviders,
    identities,
    turnsStore,
    worktrees: new WorktreeManager(),
    log,
    nextSubmissionSeq: () => 0,
    trackSettleCapture: () => {
      /* tests do not emit settle signals */
    },
    routeSettledCompletion: async () => {
      /* no router in this unit helper */
    },
  });
  await leader.ensureStarted();
  if (input.prompt !== undefined) {
    await leader.submitInitialPrompt(input.prompt, {
      turnOrigin: 'dispatcher',
    });
  }
  return leader;
}

describe('TeammateService channel input routing', () => {
  let root: string;
  let previousHome: string | undefined;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'dreamux-teammate-service-'));
    previousHome = process.env['HOME'];
    process.env['HOME'] = join(root, 'home');
    mkdirSync(process.env['HOME'], { recursive: true });
  });

  afterEach(() => {
    if (previousHome === undefined) delete process.env['HOME'];
    else process.env['HOME'] = previousHome;
    rmSync(root, { recursive: true, force: true });
  });

  it('delivers channel input to a team-scoped TeamLeader without dispatcher-scope lookup', async () => {
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
    const leader = await createTestTeamLeader({
      dispatcherId: 'dispatcher-a',
      teamId: 'alpha',
      name: 'tl-alpha-0001',
      prompt: 'initial leader prompt',
      agentRuntime: 'agent-a',
      workspace,
      config,
      agentRuntimeProviders: fakeRuntimeCatalog(runtimes),
    });

    await expect(
      leader.channelInput({ sourceId: 'message-1', text: 'from bound group' }),
    ).resolves.toMatchObject({ status: 'submitted' });
    expect(runtimes).toHaveLength(1);
    expect(runtimes[0]!.textSubmitted.map((input) => input.text)).toEqual([
      'initial leader prompt',
    ]);
    expect(runtimes[0]!.submitted.map((input) => input.text)).toEqual([
      'from bound group',
    ]);
  });

  it('sets append-only systemPrompt from the stored identity and keeps it out of channel input', async () => {
    const workspace = join(root, 'workspace');
    mkdirSync(workspace, { recursive: true });
    const runtimes: FakeRuntime[] = [];
    const contexts: AgentRuntimeCreateContext[] = [];
    const config = testDreamuxConfig([
      testDispatcherConfig({
        id: 'dispatcher-a',
        cwd: workspace,
        agentRuntime: 'agent-a',
        runtimeProvider: FAKE_RUNTIME_REF,
      }),
    ]);
    const leader = await createTestTeamLeader({
      dispatcherId: 'dispatcher-a',
      teamId: 'alpha',
      name: 'tl-alpha-0001',
      prompt: 'current task only',
      agentRuntime: 'agent-a',
      workspace,
      config,
      agentRuntimeProviders: fakeRuntimeCatalog(runtimes, contexts),
      identity: 'architecture reviewer',
    });

    expect(leader.current().identity_prompt).toBe('architecture reviewer');
    expect(contexts[0]?.systemPrompt?.append).toContain('architecture reviewer');
    expect(contexts[0]?.systemPrompt).not.toHaveProperty('replace');
    expect(leader.status()).not.toHaveProperty('identity_prompt');
    expect(runtimes[0]!.textSubmitted.map((input) => input.text)).toEqual([
      'current task only',
    ]);
    expect(runtimes[0]!.submitted).toEqual([]);
  });

  it('reapplies stored identity when a closed teammate is reopened', async () => {
    const workspace = join(root, 'workspace');
    mkdirSync(workspace, { recursive: true });
    const runtimes: FakeRuntime[] = [];
    const contexts: AgentRuntimeCreateContext[] = [];
    const config = testDreamuxConfig([
      testDispatcherConfig({
        id: 'dispatcher-a',
        cwd: workspace,
        agentRuntime: 'agent-a',
        runtimeProvider: FAKE_RUNTIME_REF,
      }),
    ]);
    const leader = await createTestTeamLeader({
      dispatcherId: 'dispatcher-a',
      teamId: 'alpha',
      name: 'tl-alpha-0001',
      agentRuntime: 'agent-a',
      workspace,
      config,
      agentRuntimeProviders: fakeRuntimeCatalog(runtimes, contexts),
      identity: 'architecture reviewer',
    });

    await leader.close({ note: 'pause' });
    await leader.send({
      prompt: 'resume the review',
      turnOrigin: 'dispatcher',
    });

    expect(contexts).toHaveLength(2);
    expect(contexts[0]?.systemPrompt?.append).toContain('architecture reviewer');
    expect(contexts[1]?.systemPrompt?.append).toContain('architecture reviewer');
    expect(contexts[0]?.systemPrompt).not.toHaveProperty('replace');
    expect(contexts[1]?.systemPrompt).not.toHaveProperty('replace');
    expect(runtimes[1]!.textSubmitted.map((input) => input.text)).toEqual([
      'resume the review',
    ]);
    expect(runtimes[1]!.submitted).toEqual([]);
  });

  it('lazy-starts a cold team-scoped TeamLeader for scheduled input', async () => {
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
    const leader = await createTestTeamLeader({
      dispatcherId: 'dispatcher-a',
      teamId: 'alpha',
      name: 'tl-alpha-0001',
      agentRuntime: 'agent-a',
      workspace,
      config,
      agentRuntimeProviders: fakeRuntimeCatalog(runtimes),
    });

    await expect(
      leader.scheduledInput({
        jobId: 'job-1',
        prompt: 'scheduled report',
        sourceId: 'scheduled:job-1:1',
      }),
    ).resolves.toMatchObject({ status: 'submitted' });
    expect(runtimes).toHaveLength(1);
    expect(runtimes[0]!.submitted).toEqual([]);
    expect(runtimes[0]!.textSubmitted).toEqual([
      { text: 'scheduled report', sourceId: 'scheduled:job-1:1' },
    ]);
  });

  it('submits scheduled input to an already-running team-scoped TeamLeader', async () => {
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
    const leader = await createTestTeamLeader({
      dispatcherId: 'dispatcher-a',
      teamId: 'alpha',
      name: 'tl-alpha-0001',
      prompt: 'initial leader prompt',
      agentRuntime: 'agent-a',
      workspace,
      config,
      agentRuntimeProviders: fakeRuntimeCatalog(runtimes),
    });

    await expect(
      leader.scheduledInput({
        jobId: 'job-1',
        prompt: 'scheduled report',
        sourceId: 'scheduled:job-1:2',
      }),
    ).resolves.toMatchObject({ status: 'submitted' });
    expect(runtimes).toHaveLength(1);
    expect(runtimes[0]!.textSubmitted.map((input) => input.text)).toEqual([
      'initial leader prompt',
      'scheduled report',
    ]);
    expect(runtimes[0]!.textSubmitted[1]).toEqual({
      text: 'scheduled report',
      sourceId: 'scheduled:job-1:2',
    });
  });
});
