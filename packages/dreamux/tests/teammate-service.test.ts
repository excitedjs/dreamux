import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type {
  AgentRuntime,
  AgentRuntimeCapabilities,
  AgentRuntimeCreateContext,
  AgentRuntimeProvider,
  AgentRuntimeStatus,
  AgentRuntimeTextInput,
  RuntimeAdmission,
  RuntimeTurn,
  RuntimeTurnOutcome,
  DreamuxLogger,
  InboundTurnInput,
} from '@excitedjs/dreamux-types';
import {
  SupervisedChild,
  isProcessAlive,
} from '@excitedjs/dreamux-utils';

import type { AgentRuntimeProviderCatalog } from '../src/agent-runtime/index.js';
import { AgentIdentityStore } from '../src/service/agent-entity/identity-store.js';
import type { AgentEntityWorktreeIdentity } from '../src/service/agent-entity/types.js';
import { createTeamLeaderAgent } from '../src/service/team-service/leader-agent.js';
import { CompletionDeliveryPolicy } from '../src/service/completion-router/index.js';
import type { TeammateService } from '../src/service/teammate-service/index.js';
import { WorktreeManager } from '../src/service/worktree/manager.js';
import { testDispatcherConfig, testDreamuxConfig } from './helpers/config.js';
import { completedRuntimeTurn } from './helpers/runtime-turn.js';

const FAKE_RUNTIME_REF = 'test:runtime';

const CAPABILITIES: AgentRuntimeCapabilities = {
  resume: { supported: false },
};

class FakeRuntime implements AgentRuntime {
  readonly providerRef = FAKE_RUNTIME_REF;
  readonly submitted: InboundTurnInput[] = [];
  readonly textSubmitted: AgentRuntimeTextInput[] = [];
  stopCount = 0;
  private status: AgentRuntimeStatus = 'declared';

  async start(): Promise<void> {
    this.status = 'ready';
  }

  async resume(): Promise<void> {
    this.status = 'ready';
  }

  async stop(): Promise<void> {
    this.stopCount += 1;
    this.status = 'stopped';
  }

  async channelInput(input: InboundTurnInput): Promise<RuntimeAdmission> {
    this.submitted.push(input);
    return { status: 'submitted', turn: completedRuntimeTurn('fake last') };
  }

  async completionInput(input: AgentRuntimeTextInput): Promise<RuntimeAdmission> {
    this.textSubmitted.push(input);
    return { status: 'submitted', turn: completedRuntimeTurn('fake last') };
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

  async getContext(): Promise<null> {
    return null;
  }

  getCapabilities(): AgentRuntimeCapabilities {
    return CAPABILITIES;
  }
}

class SupervisedRuntime extends FakeRuntime {
  readonly child = new SupervisedChild(
    {
      kind: 'spawn',
      command: process.execPath,
      args: ['-e', 'setInterval(() => {}, 1000)'],
      options: { stdio: 'ignore' },
    },
    { stopTimeoutMs: 30, pollIntervalMs: 2 },
  );

  override async start(): Promise<void> {
    await this.child.start();
    await super.start();
  }

  override async stop(): Promise<void> {
    await this.child.stop();
    await super.stop();
  }
}

class DeferredStartRuntime extends FakeRuntime {
  releaseStart: (() => void) | null = null;
  started = false;

  override async start(): Promise<void> {
    this.started = true;
    await new Promise<void>((resolve) => {
      this.releaseStart = resolve;
    });
    await super.start();
  }
}

class DeferredAdmissionRuntime extends FakeRuntime {
  readonly admissions: Array<(admission: RuntimeAdmission) => void> = [];
  readonly runtimeTurn: RuntimeTurn;
  private settleRuntimeTurn!: (outcome: RuntimeTurnOutcome) => void;

  constructor() {
    super();
    this.runtimeTurn = Object.freeze({
      settled: new Promise<RuntimeTurnOutcome>((resolve) => {
        this.settleRuntimeTurn = resolve;
      }),
    });
  }

  override async completionInput(
    input: AgentRuntimeTextInput,
  ): Promise<RuntimeAdmission> {
    this.textSubmitted.push(input);
    return new Promise((resolve) => this.admissions.push(resolve));
  }

  override async channelInput(
    input: InboundTurnInput,
  ): Promise<RuntimeAdmission> {
    this.submitted.push(input);
    return new Promise((resolve) => this.admissions.push(resolve));
  }

  resolveAdmission(index: number, admission?: RuntimeAdmission): void {
    this.admissions[index]?.(
      admission ?? { status: 'submitted', turn: this.runtimeTurn },
    );
  }

  settle(outcome: RuntimeTurnOutcome): void {
    this.settleRuntimeTurn(outcome);
  }
}

function fakeRuntimeCatalog(
  runtimes: FakeRuntime[],
  contexts: AgentRuntimeCreateContext[] = [],
  createRuntime: () => FakeRuntime = () => new FakeRuntime(),
): AgentRuntimeProviderCatalog {
  const provider: AgentRuntimeProvider = {
    ref: FAKE_RUNTIME_REF,
    descriptor: {
      id: 'test-runtime',
      kind: 'agentRuntime',
      ref: { source: 'builtin', id: 'test-runtime', raw: FAKE_RUNTIME_REF },
    },
    getCapabilities: () => CAPABILITIES,
    async readTranscript(query) {
      return {
        turns: runtimes
          .flatMap((runtime) =>
            runtime.textSubmitted.map((input) => ({
              startedAt: null,
              endedAt: null,
              blocks: [
                {
                  kind: 'message' as const,
                  role: 'user' as const,
                  text: input.text,
                  truncated: false,
                },
              ],
            })),
          )
          .slice(-query.turns),
        nextCursor: null,
        truncated: false,
      };
    },
    createRuntime(context: AgentRuntimeCreateContext) {
      const runtime = createRuntime();
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

function reuseCwd(path: string): AgentEntityWorktreeIdentity {
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
  start?: boolean;
}): Promise<TeammateService> {
  const log = noopLog();
  const identities = new AgentIdentityStore(log);
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
    skillSources: [],
    disableFeatures: [],
    systemPrompt: {
      append: [
        `You are the TeamLeader of Dreamux Team ${JSON.stringify(input.teamId)}.`,
        ...(identity.identity_prompt !== null ? [identity.identity_prompt] : []),
      ],
    },
    config: input.config,
    agentRuntimeProviders: input.agentRuntimeProviders,
    identities,
    worktrees: new WorktreeManager(),
    log,
  });
  if (input.start !== false) await leader.activate();
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
    process.env['DREAMUX_ROOT'] = join(root, 'dreamux');
    mkdirSync(process.env['HOME'], { recursive: true });
  });

  afterEach(() => {
    vi.useRealTimers();
    if (previousHome === undefined) delete process.env['HOME'];
    else process.env['HOME'] = previousHome;
    delete process.env['DREAMUX_ROOT'];
    rmSync(root, { recursive: true, force: true });
  });

  it('delivers channel input to a team-scoped TeamLeader without dispatcher-scope lookup', async () => {
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
      prompt: 'initial leader prompt',
      agentRuntime: 'agent-a',
      workspace,
      config,
      agentRuntimeProviders: fakeRuntimeCatalog(runtimes, contexts),
    });

    await expect(
      leader.channelInput({ sourceId: 'message-1', text: 'from bound group' }),
    ).resolves.toMatchObject({ status: 'submitted' });
    expect(runtimes).toHaveLength(1);
    expect(contexts[0]?.systemPrompt?.append).toEqual([
      'You are the TeamLeader of Dreamux Team "alpha".',
    ]);
    expect(contexts[0]?.systemPrompt).not.toHaveProperty('replace');
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
    expect(contexts[0]?.systemPrompt?.append).toEqual([
      'You are the TeamLeader of Dreamux Team "alpha".',
      'architecture reviewer',
    ]);
    expect(contexts[0]?.systemPrompt).not.toHaveProperty('replace');
    expect(leader.status()).not.toHaveProperty('identity_prompt');
    expect(runtimes[0]!.textSubmitted.map((input) => input.text)).toEqual([
      'current task only',
    ]);
    expect(runtimes[0]!.submitted).toEqual([]);
  });

  it('passes an initial prompt output schema through the neutral runtime input', async () => {
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
    const outputSchema = {
      type: 'object',
      properties: { answer: { type: 'string' } },
      required: ['answer'],
    };

    await leader.submitInitialPrompt('return structured output', {
      turnOrigin: 'dispatcher',
      outputSchema,
    });

    expect(runtimes[0]!.textSubmitted).toEqual([
      {
        text: 'return structured output',
        outputSchema,
      },
    ]);
  });

  it('does not reopen a retired entity instance after close', async () => {
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
    await expect(
      leader.send({
        prompt: 'resume the review',
        turnOrigin: 'dispatcher',
      }),
    ).rejects.toThrow(/cannot accept send/);

    expect(contexts).toHaveLength(1);
    expect(contexts[0]?.systemPrompt?.append).toEqual([
      'You are the TeamLeader of Dreamux Team "alpha".',
      'architecture reviewer',
    ]);
    expect(contexts[0]?.systemPrompt).not.toHaveProperty('replace');
    expect(runtimes).toHaveLength(1);
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
      start: false,
    });

    await expect(
      leader.scheduledInput({
        jobId: 'job-1',
        prompt: 'scheduled report',
        sourceId: 'scheduled:job-1:1',
        signal: new AbortController().signal,
      }),
    ).resolves.toMatchObject({ status: 'submitted' });
    expect(runtimes).toHaveLength(1);
    expect(runtimes[0]!.submitted).toEqual([]);
    expect(runtimes[0]!.textSubmitted).toEqual([
      { text: 'scheduled report', sourceId: 'scheduled:job-1:1' },
    ]);
  });

  it('does not start a cold scheduled runtime when signal is already false', async () => {
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
      start: false,
    });

    await expect(
      leader.scheduledInput({
        jobId: 'job-1',
        prompt: 'scheduled report',
        sourceId: 'scheduled:job-1:1',
        signal: AbortSignal.abort(),
      }),
    ).resolves.toMatchObject({ status: 'skipped' });
    expect(runtimes).toHaveLength(0);
  });

  it('does not submit when signal flips false during scheduled runtime start', async () => {
    const workspace = join(root, 'workspace');
    mkdirSync(workspace, { recursive: true });
    const runtimes: FakeRuntime[] = [];
    const created: DeferredStartRuntime[] = [];
    const controller = new AbortController();
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
      agentRuntimeProviders: fakeRuntimeCatalog(runtimes, [], () => {
        const runtime = new DeferredStartRuntime();
        created.push(runtime);
        return runtime;
      }),
      start: false,
    });

    const scheduled = leader.scheduledInput({
      jobId: 'job-1',
      prompt: 'scheduled report',
      sourceId: 'scheduled:job-1:1',
      signal: controller.signal,
    });
    await waitFor(() => created[0]?.releaseStart !== null);
    controller.abort();
    const runtime = created[0]!;
    runtime.releaseStart!();

    await expect(scheduled).resolves.toMatchObject({ status: 'skipped' });
    expect(runtime.started).toBe(true);
    expect(runtime.textSubmitted).toEqual([]);
  });

  it('does not submit through a runtime published before its start barrier resolves', async () => {
    const workspace = join(root, 'workspace');
    mkdirSync(workspace, { recursive: true });
    const runtimes: FakeRuntime[] = [];
    const created: DeferredStartRuntime[] = [];
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
      agentRuntimeProviders: fakeRuntimeCatalog(runtimes, [], () => {
        const runtime = new DeferredStartRuntime();
        created.push(runtime);
        return runtime;
      }),
      start: false,
    });

    const activation = leader.activate();
    await waitFor(() => created[0]?.releaseStart !== null);
    const inbound = leader.channelInput({ sourceId: 'message-1', text: 'wait' });
    await new Promise((resolve) => setImmediate(resolve));
    expect(created[0]!.submitted).toEqual([]);

    created[0]!.releaseStart!();
    await activation;
    await expect(inbound).resolves.toMatchObject({ status: 'submitted' });
    expect(created[0]!.submitted).toHaveLength(1);
  });

  it('serializes reversed admissions and folds one RuntimeTurn into one entity Turn', async () => {
    const workspace = join(root, 'workspace');
    mkdirSync(workspace, { recursive: true });
    const runtimes: FakeRuntime[] = [];
    const created: DeferredAdmissionRuntime[] = [];
    const firstDelivery = vi.fn(async () => undefined);
    const secondDelivery = vi.fn(async () => undefined);
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
      agentRuntimeProviders: fakeRuntimeCatalog(runtimes, [], () => {
        const runtime = new DeferredAdmissionRuntime();
        created.push(runtime);
        return runtime;
      }),
    });
    const runtime = created[0]!;
    const prepared = await leader.prepareCompletion({
      kind: 'teammate',
      source: 'worker',
      status: 'completed',
      result: 'unrelated completion',
    });

    const first = leader.submitInitialPromptRuntime('first prompt', {
      turnOrigin: 'dispatcher',
      deliverCompletion: firstDelivery,
    });
    const channel = leader.channelInput({
      sourceId: 'message-between-sends',
      text: 'unrelated channel input',
    });
    const second = leader.submitInitialPromptRuntime('second prompt', {
      turnOrigin: 'dispatcher',
      deliverCompletion: secondDelivery,
    });
    const completion = prepared.submit();
    await waitFor(() => runtime.admissions.length === 4);
    runtime.resolveAdmission(3);
    runtime.resolveAdmission(2);
    runtime.resolveAdmission(1);
    runtime.resolveAdmission(0);

    const [firstAdmission, channelAdmission, secondAdmission, completionResult] =
      await Promise.all([first, channel, second, completion]);
    expect(firstAdmission.status).toBe('submitted');
    expect(channelAdmission.status).toBe('submitted');
    expect(secondAdmission.status).toBe('submitted');
    expect(completionResult).toEqual({ status: 'accepted' });
    if (
      firstAdmission.status !== 'submitted' ||
      channelAdmission.status !== 'submitted' ||
      secondAdmission.status !== 'submitted'
    ) {
      throw new Error('expected submitted admissions');
    }
    expect(channelAdmission.turn).toBe(firstAdmission.turn);
    expect(secondAdmission.turn).toBe(firstAdmission.turn);

    runtime.settle({ status: 'completed', resultText: 'done', truncated: false });
    await firstAdmission.turn.delivery;
    expect(firstDelivery).toHaveBeenCalledTimes(1);
    expect(secondDelivery).not.toHaveBeenCalled();
    await expect(firstAdmission.turn.settled).resolves.toMatchObject({
      status: 'completed',
      resultText: 'done',
    });
  });

  it('bounds completion delivery so source close cannot wait forever', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
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
      name: 'tl-alpha-timeout',
      agentRuntime: 'agent-a',
      workspace,
      config,
      agentRuntimeProviders: fakeRuntimeCatalog(runtimes),
    });
    const submit = vi.fn(() => new Promise<never>(() => undefined));
    const deliveryPolicy = new CompletionDeliveryPolicy({
      dispatcherId: 'dispatcher-a',
      log: noopLog(),
      attemptTimeoutMs: 100,
    });
    const admission = await leader.submitInitialPromptRuntime('finish', {
      turnOrigin: 'dispatcher',
      deliverCompletion: (fact) => deliveryPolicy.deliver({
        prepareCompletion: async () => Object.freeze({ submit }),
      }, fact),
    });
    if (admission.status !== 'submitted') throw new Error('expected submitted');
    await waitForEventLoop(() => submit.mock.calls.length === 1);

    const closing = leader.close({ note: 'bounded completion delivery' });
    let closed = false;
    void closing.then(() => {
      closed = true;
    });
    await vi.advanceTimersByTimeAsync(99);
    expect(closed).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await expect(closing).resolves.toMatchObject({
      teammate: { status: 'closed' },
    });
    expect(submit).toHaveBeenCalledTimes(1);
  });

  it('converges a late accepted RuntimeTurn to stopped during close', async () => {
    const workspace = join(root, 'workspace');
    mkdirSync(workspace, { recursive: true });
    const runtimes: FakeRuntime[] = [];
    const created: DeferredAdmissionRuntime[] = [];
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
      agentRuntimeProviders: fakeRuntimeCatalog(runtimes, [], () => {
        const runtime = new DeferredAdmissionRuntime();
        created.push(runtime);
        return runtime;
      }),
    });
    const runtime = created[0]!;

    const admissionPromise = leader.submitInitialPromptRuntime('late', {
      turnOrigin: 'dispatcher',
    });
    await waitFor(() => runtime.admissions.length === 1);
    const closing = leader.close({ note: 'stop now' });
    runtime.resolveAdmission(0);
    const admission = await admissionPromise;
    expect(admission.status).toBe('submitted');
    if (admission.status !== 'submitted') throw new Error('expected submitted admission');

    await expect(admission.turn.settled).resolves.toEqual({ status: 'stopped' });
    const closed = await closing;
    expect(closed.teammate.status).toBe('closed');
  });

  it('records no Turn when close wins before runtime admission', async () => {
    const workspace = join(root, 'workspace');
    mkdirSync(workspace, { recursive: true });
    const runtimes: FakeRuntime[] = [];
    const created: DeferredAdmissionRuntime[] = [];
    const delivery = vi.fn(async () => undefined);
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
      agentRuntimeProviders: fakeRuntimeCatalog(runtimes, [], () => {
        const runtime = new DeferredAdmissionRuntime();
        created.push(runtime);
        return runtime;
      }),
    });
    const runtime = created[0]!;

    const admissionPromise = leader.submitInitialPromptRuntime(
      'never admitted',
      {
        turnOrigin: 'dispatcher',
        deliverCompletion: delivery,
      },
    );
    await waitFor(() => runtime.admissions.length === 1);
    const closing = leader.close({ note: 'stop before admission' });
    await waitFor(() => runtime.stopCount === 1);
    runtime.resolveAdmission(0, { status: 'stopped' });

    await expect(admissionPromise).resolves.toEqual({ status: 'stopped' });
    await expect(closing).resolves.toMatchObject({
      teammate: { status: 'closed' },
    });
    expect(delivery).not.toHaveBeenCalled();
  });

  it('ignores inert Turn archive residue during settlement and close', async () => {
    const workspace = join(root, 'workspace');
    mkdirSync(workspace, { recursive: true });
    const runtimes: FakeRuntime[] = [];
    const created: DeferredAdmissionRuntime[] = [];
    const delivery = vi.fn(async () => undefined);
    const residue = join(
      process.env['HOME']!,
      '.dreamux',
      'state',
      'dispatcher-a',
      'team',
      'alpha',
      'turn.jsonl',
    );
    mkdirSync(residue, { recursive: true });
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
      agentRuntimeProviders: fakeRuntimeCatalog(runtimes, [], () => {
        const runtime = new DeferredAdmissionRuntime();
        created.push(runtime);
        return runtime;
      }),
    });
    const runtime = created[0]!;
    const closedFacts: unknown[] = [];
    const subscription = leader.onClosed((fact) => {
      closedFacts.push(fact);
    });
    const admitted = leader.submitInitialPromptRuntime('persist me', {
      turnOrigin: 'dispatcher',
      deliverCompletion: delivery,
    });
    await waitFor(() => runtime.admissions.length === 1);
    runtime.resolveAdmission(0);
    const admission = await admitted;
    if (admission.status !== 'submitted') throw new Error('expected submitted admission');
    runtime.settle({ status: 'completed', resultText: 'done', truncated: false });
    await expect(admission.turn.settled).resolves.toMatchObject({
      status: 'completed',
      resultText: 'done',
    });
    await expect(admission.turn.delivery).resolves.toBeUndefined();
    expect(delivery).toHaveBeenCalledTimes(1);

    await expect(leader.close({ note: 'complete' })).resolves.toMatchObject({
      teammate: { status: 'closed' },
    });
    expect(leader.current().status).toBe('closed');
    expect(runtime.stopCount).toBe(1);
    expect(() => readFileSync(residue, 'utf8')).toThrow();
    await vi.waitFor(() => expect(closedFacts).toHaveLength(1));
    subscription.unsubscribe();
  });

  it('lets a lock fence every ordinary mutator while reads remain available', async () => {
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
    const runtime = runtimes[0]!;
    const completion = {
      kind: 'teammate' as const,
      source: 'worker',
      status: 'completed' as const,
      result: 'done',
    };
    const preparedBeforeLock = await leader.prepareCompletion(completion);
    const identityBefore = leader.current();
    const handle = leader.lock();

    await expect(leader.send({
      prompt: 'public send',
      turnOrigin: 'dispatcher',
    })).rejects.toThrow(/cannot accept send/u);
    await expect(leader.channelInput({
      sourceId: 'message-locked',
      text: 'channel input',
    })).rejects.toThrow(/cannot accept channel input/u);
    await expect(leader.scheduledInput({
      jobId: 'job-locked',
      prompt: 'scheduled input',
      sourceId: 'scheduled:job-locked:1',
      signal: new AbortController().signal,
    })).rejects.toThrow(/cannot accept scheduled input/u);
    await expect(leader.controlInput({
      text: 'completion input',
      sourceId: 'completion-locked',
    })).rejects.toThrow(/cannot accept control input/u);
    await expect(leader.activate()).rejects.toThrow(/cannot accept activation/u);
    await expect(leader.applyWorktreeCleanup({
      ...reuseCwd(join(root, 'changed')),
      cleanup_error: 'must not persist',
    })).rejects.toThrow(/cannot accept worktree cleanup/u);
    await expect(leader.close({ note: 'public close' })).rejects.toThrow(/locked/u);

    const preparedWhileLocked = await leader.prepareCompletion(completion);
    await expect(preparedBeforeLock.submit()).resolves.toMatchObject({
      status: 'unsupported',
    });
    await expect(preparedWhileLocked.submit()).resolves.toMatchObject({
      status: 'unsupported',
    });

    expect(leader.current()).toEqual(identityBefore);
    expect(runtime.submitted).toEqual([]);
    expect(runtime.textSubmitted).toEqual([]);
    expect(runtimes).toHaveLength(1);
    expect(leader.status()).toMatchObject({ name: 'tl-alpha-0001' });
    await expect(leader.waitIdle()).resolves.toBeUndefined();
    expect(leader.runtimeStatus()).toBe('ready');
    expect(leader.checkpointId()).toBe('thread-fake');
    expect(leader.wasCheckpointResumed()).toBe(false);

    handle.unlock();
    const laterHandle = leader.lock();
    expect(() => handle.submit({
      prompt: 'stale submit',
      turnOrigin: 'dispatcher',
    })).toThrow(/stale TeamMate lock/u);
    expect(() => handle.close({ note: 'stale close' }))
      .toThrow(/stale TeamMate lock/u);
    expect(() => handle.unlock()).toThrow(/stale TeamMate lock/u);

    const firstClose = laterHandle.close({ note: 'workflow complete' });
    const secondClose = laterHandle.close({ note: 'joined close' });
    expect(secondClose).toBe(firstClose);
    await expect(leader.close({ note: 'public close while locked' }))
      .rejects.toThrow(/locked/u);
    await expect(Promise.all([firstClose, secondClose])).resolves.toHaveLength(2);
    expect(runtime.stopCount).toBe(1);
    laterHandle.unlock();
  });

  it('lets every ordinary mutator fence a later lock before its first await', async () => {
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
    const runtime = runtimes[0]!;
    let expectedSubmissionCount = 0;
    const waitForTurn = async (): Promise<void> => {
      expectedSubmissionCount += 1;
      await vi.waitFor(() => {
        expect(runtime.submitted.length + runtime.textSubmitted.length).toBe(
          expectedSubmissionCount,
        );
      });
    };
    const assertLockLoses = (): void => {
      expect(() => leader.lock()).toThrow(/being mutated/u);
    };

    const sending = leader.send({
      prompt: 'ordinary send',
      turnOrigin: 'dispatcher',
    });
    assertLockLoses();
    await expect(sending).resolves.toMatchObject({ status: 'submitted' });
    await waitForTurn();

    const channel = leader.channelInput({
      sourceId: 'message-ordinary',
      text: 'channel input',
    });
    assertLockLoses();
    const channelAdmission = await channel;
    if (channelAdmission.status !== 'submitted') {
      throw new Error('expected submitted channel input');
    }
    await channelAdmission.turn.settled;
    await waitForTurn();

    const scheduled = leader.scheduledInput({
      jobId: 'job-ordinary',
      prompt: 'scheduled input',
      sourceId: 'scheduled:job-ordinary:1',
      signal: new AbortController().signal,
    });
    assertLockLoses();
    const scheduledAdmission = await scheduled;
    if (scheduledAdmission.status !== 'submitted') {
      throw new Error('expected submitted scheduled input');
    }
    await scheduledAdmission.turn.settled;
    await waitForTurn();

    const control = leader.controlInput({
      text: 'control input',
      sourceId: 'completion-ordinary',
    });
    assertLockLoses();
    const controlAdmission = await control;
    if (controlAdmission.status !== 'submitted') {
      throw new Error('expected submitted control input');
    }
    await controlAdmission.turn.settled;
    await waitForTurn();

    const preparing = leader.prepareCompletion({
      kind: 'teammate',
      source: 'worker',
      status: 'completed',
      result: 'prepared completion',
    });
    assertLockLoses();
    const prepared = await preparing;
    const submitting = prepared.submit();
    assertLockLoses();
    await expect(submitting).resolves.toMatchObject({ status: 'accepted' });
    await waitForTurn();

    const updatedWorktree = {
      ...reuseCwd(join(root, 'updated-worktree')),
      cleanup_error: 'recorded',
    };
    const updating = leader.applyWorktreeCleanup(updatedWorktree);
    assertLockLoses();
    await updating;
    expect(leader.current().worktree).toEqual(updatedWorktree);

    const activating = leader.activate();
    assertLockLoses();
    await activating;

    const closing = leader.close({ note: 'ordinary close wins' });
    expect(() => leader.lock()).toThrow(/not active/u);
    await expect(closing).resolves.toMatchObject({
      teammate: { status: 'closed' },
    });
    expect(runtimes[0]!.stopCount).toBe(1);
  });

  it('propagates failed process-group absence proof through retryable entity close', async () => {
    const workspace = join(root, 'workspace');
    mkdirSync(workspace, { recursive: true });
    const runtimes: FakeRuntime[] = [];
    const supervised: SupervisedRuntime[] = [];
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
      agentRuntimeProviders: fakeRuntimeCatalog(runtimes, [], () => {
        const runtime = new SupervisedRuntime();
        supervised.push(runtime);
        return runtime;
      }),
    });
    const runtime = supervised[0]!;
    const pid = runtime.child.pid!;
    const realKill = process.kill.bind(process);
    const kill = vi.spyOn(process, 'kill').mockImplementation((target, signal) => {
      if (target === -pid) return true;
      return realKill(target, signal);
    });
    try {
      await expect(leader.close({ note: 'first close' }))
        .rejects.toThrow(/still exists after SIGKILL/u);
      expect(leader.current().status).not.toBe('closed');
      expect(runtime.child.pid).toBe(pid);
    } finally {
      kill.mockRestore();
    }

    await expect(leader.close({ note: 'retry close' })).resolves.toMatchObject({
      teammate: { status: 'closed' },
    });
    await vi.waitFor(() => expect(isProcessAlive(pid)).toBe(false));
    expect(runtime.child.pid).toBeNull();
  });

  it('returns the durable closed projection for repeated close', async () => {
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

    const first = await leader.close({ note: 'done' });
    const second = await leader.close({ note: 'ignored retry note' });
    expect(second).toEqual(first);
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
        signal: new AbortController().signal,
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

async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('waitFor timed out');
}

async function waitForEventLoop(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error('event-loop condition was not reached');
}
