import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type {
  AgentRuntime,
  AgentRuntimeCapabilities,
  AgentRuntimeCreateContext,
  AgentRuntimeLastResult,
  AgentRuntimeProvider,
  AgentRuntimeProviderDescriptor,
  AgentRuntimeResumeCheckpoint,
  AgentRuntimeStatus,
  AgentRuntimeContextSnapshot,
  AgentRuntimeTextInput,
  AgentRuntimeTurnResult,
  ChannelProvider,
  ChannelProviderDescriptor,
  ChannelSession,
  ChannelTarget,
  DreamuxLogger,
  InboundDeliveryHooks,
  InboundTurnInput,
} from '@excitedjs/dreamux-types';

import { AgentRuntimeProviderCatalog } from '../agent-runtime/catalog.js';
import { ChannelProviderCatalog } from '../channel/catalog.js';
import type { DreamuxConfig } from '../config/config.js';
import {
  BUILTIN_CODEX_PROVIDER_REF,
  BUILTIN_FEISHU_PROVIDER_REF,
  createBuiltinProviderRegistry,
} from '../registry/index.js';
import { DispatcherService } from '../service/dispatcher-service/index.js';
import { DispatcherStore } from '../state/dispatcher-store.js';

export interface FeishuTopicContextSmokeResult {
  ok: boolean;
  tempHome: string;
  accepted: string[];
  runtimeCount: number;
  globalRuntimeIds: string[];
  targetRuntimeIds: string[];
  resumedRuntimeIds: string[];
  targetInputs: Record<string, string[]>;
}

interface RuntimeRecord {
  runtimeId: string;
  checkpointId: string | null;
  resumed: boolean;
  inputs: string[];
}

interface SmokeRecorder {
  runtimes: RuntimeRecord[];
}

const DISPATCHER_ID = 'topic-smoke';
const CHANNEL_ID = 'primary';
const TOPIC_A_TARGET = 'group-demo#thread:topic-a';
const TOPIC_B_TARGET = 'group-demo#thread:topic-b';

export async function runFeishuTopicContextSmoke(): Promise<FeishuTopicContextSmokeResult> {
  const previousHome = process.env['HOME'];
  const tempRoot = await mkdtemp(join(tmpdir(), 'dreamux-topic-context-'));
  process.env['HOME'] = join(tempRoot, 'home');
  const recorder: SmokeRecorder = { runtimes: [] };
  const accepted: string[] = [];
  try {
    const config = smokeConfig(join(tempRoot, 'workspace'));
    const service = await startSmokeDispatcher(config, recorder);
    await routeTopicTurns(service, accepted);
    await service.shutdown();

    const resumedService = await startSmokeDispatcher(config, recorder);
    await routeTurn(resumedService, TOPIC_A_TARGET, 'a-3', accepted);
    await resumedService.shutdown();

    const result = summarizeSmoke(recorder, accepted, tempRoot);
    assertSmokeResult(result);
    return result;
  } finally {
    if (previousHome === undefined) delete process.env['HOME'];
    else process.env['HOME'] = previousHome;
    await rm(tempRoot, { recursive: true, force: true });
  }
}

async function startSmokeDispatcher(
  config: DreamuxConfig,
  recorder: SmokeRecorder,
): Promise<DispatcherService> {
  const store = new DispatcherStore(config);
  await store.hydrate();
  const service = new DispatcherService({
    id: DISPATCHER_ID,
    config,
    dispatchers: store,
    agentRuntimeProviders: agentRuntimeCatalog(recorder),
    channelProviders: channelProviderCatalog(),
    adminSocketPath: join(process.env['HOME'] ?? tmpdir(), '.dreamux', 'run', 'admin.sock'),
    channelLoggerFactory: () => noopLogger(),
    log: noopLogger(),
  });
  await service.start();
  return service;
}

async function routeTopicTurns(
  service: DispatcherService,
  accepted: string[],
): Promise<void> {
  await routeTurn(service, TOPIC_A_TARGET, 'a-1', accepted);
  await routeTurn(service, TOPIC_A_TARGET, 'a-2', accepted);
  await routeTurn(service, TOPIC_B_TARGET, 'b-1', accepted);
}

async function routeTurn(
  service: DispatcherService,
  targetKey: string,
  sourceId: string,
  accepted: string[],
): Promise<void> {
  const result = await service.routeChannelInput(
    CHANNEL_ID,
    {
      text: sourceId,
      sourceId,
      source: 'feishu',
      attrs: [['chat_type', 'group']],
    },
    {
      provider: BUILTIN_FEISHU_PROVIDER_REF,
      channel_id: CHANNEL_ID,
      target: groupTarget(targetKey),
      message_id: `message-${sourceId}`,
    },
    {
      onAccepted: async (input) => {
        accepted.push(input.sourceId);
      },
    },
  );
  if (result.status !== 'submitted') {
    throw new Error(`expected submitted turn for ${sourceId}, got ${result.status}`);
  }
}

function summarizeSmoke(
  recorder: SmokeRecorder,
  accepted: string[],
  tempHome: string,
): FeishuTopicContextSmokeResult {
  const targetRuntimes = recorder.runtimes.filter((record) =>
    record.runtimeId.includes('.ch.'),
  );
  const targetInputs: Record<string, string[]> = {};
  for (const [index, record] of targetRuntimes.entries()) {
    targetInputs[`${record.runtimeId}#${index}`] = record.inputs;
  }
  return {
    ok: true,
    tempHome,
    accepted,
    runtimeCount: recorder.runtimes.length,
    globalRuntimeIds: recorder.runtimes
      .filter((record) => !record.runtimeId.includes('.ch.'))
      .map((record) => record.runtimeId),
    targetRuntimeIds: targetRuntimes.map((record) => record.runtimeId),
    resumedRuntimeIds: recorder.runtimes
      .filter((record) => record.resumed)
      .map((record) => record.runtimeId),
    targetInputs,
  };
}

function assertSmokeResult(result: FeishuTopicContextSmokeResult): void {
  if (result.globalRuntimeIds.length !== 2) {
    throw new Error('expected one global dispatcher runtime per service start');
  }
  if (result.targetRuntimeIds.length !== 3) {
    throw new Error('expected two initial target runtimes plus one resumed target runtime');
  }
  if (result.resumedRuntimeIds.length < 2) {
    throw new Error('expected dispatcher and topic-a runtimes to resume after restart');
  }
  const targetRuns = Object.values(result.targetInputs);
  if (!targetRuns.some((inputs) => inputs.join(',') === 'a-1,a-2')) {
    throw new Error('topic-a first session did not keep both turns on one runtime');
  }
  if (!targetRuns.some((inputs) => inputs.join(',') === 'a-3')) {
    throw new Error('topic-a resumed session did not receive the follow-up turn');
  }
  if (!targetRuns.some((inputs) => inputs.join(',') === 'b-1')) {
    throw new Error('topic-b did not receive an isolated runtime');
  }
  if (result.accepted.join(',') !== 'a-1,a-2,b-1,a-3') {
    throw new Error('channel acceptance hooks did not fire in delivery order');
  }
}

function smokeConfig(cwd: string): DreamuxConfig {
  return {
    agents: {
      [DISPATCHER_ID]: {
        provider: BUILTIN_CODEX_PROVIDER_REF,
        config: {},
      },
    },
    dispatchers: [{
      id: DISPATCHER_ID,
      cwd,
      enabled: true,
      channels: [{
        id: CHANNEL_ID,
        provider: BUILTIN_FEISHU_PROVIDER_REF,
        config: {},
        identity: 'topic-context-smoke',
      }],
      agentRuntime: DISPATCHER_ID,
      runtime: {
        provider: BUILTIN_CODEX_PROVIDER_REF,
        config: {},
      },
    }],
  };
}

function agentRuntimeCatalog(
  recorder: SmokeRecorder,
): AgentRuntimeProviderCatalog {
  const registry = createBuiltinProviderRegistry();
  const descriptor = registry.resolve(
    BUILTIN_CODEX_PROVIDER_REF,
  ) as AgentRuntimeProviderDescriptor;
  registry.registerImplementation(
    descriptor.id,
    createSmokeRuntimeProvider(descriptor, recorder),
  );
  return new AgentRuntimeProviderCatalog({ registry });
}

function channelProviderCatalog(): ChannelProviderCatalog {
  const registry = createBuiltinProviderRegistry();
  const descriptor = registry.resolve(
    BUILTIN_FEISHU_PROVIDER_REF,
  ) as ChannelProviderDescriptor;
  registry.registerImplementation(descriptor.id, {
    ref: BUILTIN_FEISHU_PROVIDER_REF,
    descriptor,
    readConfig: () => ({}),
    createSession(context) {
      return {
        provider: BUILTIN_FEISHU_PROVIDER_REF,
        channel_id: context.channel_id,
        start: async () => undefined,
        close: async () => undefined,
        resolveTarget: async (meta) =>
          groupTarget(
            typeof (meta as { target_key?: unknown })?.target_key === 'string'
              ? (meta as { target_key: string }).target_key
              : TOPIC_A_TARGET,
          ),
      } satisfies ChannelSession;
    },
  } satisfies ChannelProvider);
  return new ChannelProviderCatalog({ registry });
}

function createSmokeRuntimeProvider(
  descriptor: AgentRuntimeProviderDescriptor,
  recorder: SmokeRecorder,
): AgentRuntimeProvider {
  return {
    ref: BUILTIN_CODEX_PROVIDER_REF,
    descriptor,
    getCapabilities: () => ({ resume: { supported: true } }),
    createRuntime: (context) => new SmokeRuntime(context, recorder),
  };
}

class SmokeRuntime implements AgentRuntime {
  readonly providerRef = BUILTIN_CODEX_PROVIDER_REF;
  private status: AgentRuntimeStatus = 'declared';
  private checkpoint: AgentRuntimeResumeCheckpoint | null;
  private resumed = false;
  private readonly record: RuntimeRecord;

  constructor(
    private readonly context: AgentRuntimeCreateContext,
    recorder: SmokeRecorder,
  ) {
    this.checkpoint = context.identity.checkpoint_id === undefined ||
      context.identity.checkpoint_id === null
      ? null
      : { id: context.identity.checkpoint_id };
    this.record = {
      runtimeId: context.identity.runtime_id,
      checkpointId: this.checkpoint?.id ?? null,
      resumed: false,
      inputs: [],
    };
    recorder.runtimes.push(this.record);
  }

  async start(): Promise<void> {
    this.status = 'ready';
    await this.context.state?.setStatus('ready', {
      last_started_at: Date.now(),
      last_ready_at: Date.now(),
    });
    await this.setCheckpoint(`checkpoint:${this.context.identity.runtime_id}`);
  }

  async resume(): Promise<void> {
    this.resumed = true;
    this.record.resumed = true;
    this.status = 'ready';
    await this.context.state?.setStatus('ready', {
      last_started_at: Date.now(),
      last_ready_at: Date.now(),
    });
    if (this.checkpoint === null) {
      await this.setCheckpoint(`checkpoint:${this.context.identity.runtime_id}`);
    }
  }

  async stop(): Promise<void> {
    this.status = 'stopped';
    await this.context.state?.setStatus('stopped');
  }

  async channelInput(
    input: InboundTurnInput,
    hooks?: InboundDeliveryHooks,
  ): Promise<AgentRuntimeTurnResult> {
    this.record.inputs.push(input.sourceId);
    await hooks?.onAccepted?.(input);
    return {
      status: 'submitted',
      turnId: `${this.context.identity.runtime_id}:${this.record.inputs.length}`,
    };
  }

  async completionInput(
    input: AgentRuntimeTextInput,
  ): Promise<AgentRuntimeTurnResult> {
    this.record.inputs.push(input.sourceId ?? input.text);
    return {
      status: 'submitted',
      turnId: `${this.context.identity.runtime_id}:completion:${this.record.inputs.length}`,
    };
  }

  getStatus(): AgentRuntimeStatus {
    return this.status;
  }

  getCheckpoint(): AgentRuntimeResumeCheckpoint | null {
    return this.checkpoint;
  }

  wasCheckpointResumed(): boolean {
    return this.resumed;
  }

  async getLast(): Promise<AgentRuntimeLastResult | null> {
    return null;
  }

  async getContext(): Promise<AgentRuntimeContextSnapshot | null> {
    return null;
  }

  getCapabilities(): AgentRuntimeCapabilities {
    return { resume: { supported: true } };
  }

  private async setCheckpoint(id: string): Promise<void> {
    this.checkpoint = { id };
    this.record.checkpointId = id;
    await this.context.state?.setCheckpoint(this.checkpoint);
  }
}

function groupTarget(targetKey: string): ChannelTarget {
  return {
    target_type: 'group',
    target_key: targetKey,
    bindable: true,
    display: targetKey,
    meta: { target_key: targetKey },
  };
}

function noopLogger(): DreamuxLogger {
  const log = (() => undefined) as DreamuxLogger['info'];
  return {
    error: log,
    warn: log,
    info: log,
    debug: log,
    trace: log,
    child: () => noopLogger(),
  };
}
