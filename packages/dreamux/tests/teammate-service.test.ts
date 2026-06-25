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
import { TeammateCollection } from '../src/service/teammate-collection/index.js';
import type { TeamMateWorktreeIdentity } from '../src/service/teammate-collection/types.js';
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
  readonly systemSubmitted: AgentRuntimeSystemInput[] = [];
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

  async systemInput(notice: AgentRuntimeSystemInput): Promise<AgentRuntimeTurnResult> {
    this.systemSubmitted.push(notice);
    return { status: 'submitted', turnId: `system-${this.systemSubmitted.length}` };
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
    const collection = new TeammateCollection({
      dispatcherId: 'dispatcher-a',
      teamScope: 'alpha',
      config,
      agentRuntimeProviders: fakeRuntimeCatalog(runtimes),
      worktrees: new WorktreeManager(),
      log: noopLog(),
    });

    const { leader } = await collection.createTeamLeader(
      {
        name: 'tl-alpha-0001',
        prompt: 'initial leader prompt',
        agentRuntime: 'agent-a',
        sourceCwd: workspace,
        sourceRepo: null,
        runtimeCwd: workspace,
        worktree: reuseCwd(workspace),
        intent: 'lead alpha',
      },
      { launchPolicy: { mcpServers: [], disableFeatures: [] } },
    );

    await expect(
      leader.channelInput({ sourceId: 'message-1', text: 'from bound group' }),
    ).resolves.toMatchObject({ status: 'submitted' });
    expect(runtimes).toHaveLength(1);
    expect(runtimes[0]!.submitted.map((input) => input.text)).toEqual([
      'initial leader prompt',
      'from bound group',
    ]);
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
    const collection = new TeammateCollection({
      dispatcherId: 'dispatcher-a',
      teamScope: 'alpha',
      config,
      agentRuntimeProviders: fakeRuntimeCatalog(runtimes),
      worktrees: new WorktreeManager(),
      log: noopLog(),
    });

    const { leader } = await collection.createTeamLeader(
      {
        name: 'tl-alpha-0001',
        agentRuntime: 'agent-a',
        sourceCwd: workspace,
        sourceRepo: null,
        runtimeCwd: workspace,
        worktree: reuseCwd(workspace),
        intent: 'lead alpha',
      },
      { launchPolicy: { mcpServers: [], disableFeatures: [] } },
    );

    await expect(
      leader.scheduledInput({ jobId: 'job-1', prompt: 'scheduled report' }),
    ).resolves.toMatchObject({ status: 'submitted' });
    expect(runtimes).toHaveLength(1);
    expect(runtimes[0]!.systemSubmitted).toEqual([
      { kind: 'system', text: 'scheduled report', reason: 'scheduled' },
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
    const collection = new TeammateCollection({
      dispatcherId: 'dispatcher-a',
      teamScope: 'alpha',
      config,
      agentRuntimeProviders: fakeRuntimeCatalog(runtimes),
      worktrees: new WorktreeManager(),
      log: noopLog(),
    });

    const { leader } = await collection.createTeamLeader(
      {
        name: 'tl-alpha-0001',
        prompt: 'initial leader prompt',
        agentRuntime: 'agent-a',
        sourceCwd: workspace,
        sourceRepo: null,
        runtimeCwd: workspace,
        worktree: reuseCwd(workspace),
        intent: 'lead alpha',
      },
      { launchPolicy: { mcpServers: [], disableFeatures: [] } },
    );

    await expect(
      leader.scheduledInput({ jobId: 'job-1', prompt: 'scheduled report' }),
    ).resolves.toMatchObject({ status: 'submitted' });
    expect(runtimes).toHaveLength(1);
    expect(runtimes[0]!.submitted.map((input) => input.text)).toEqual([
      'initial leader prompt',
    ]);
    expect(runtimes[0]!.systemSubmitted.map((input) => input.text)).toEqual([
      'scheduled report',
    ]);
  });
});
