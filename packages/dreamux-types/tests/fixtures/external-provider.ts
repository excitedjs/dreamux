/**
 * External-provider compile fixture (issue #209 validation guard).
 *
 * This file imports Dreamux contracts from `@excitedjs/dreamux-types` ONLY and
 * implements a complete Agent Runtime provider (descriptor + `readConfig` +
 * `getCapabilities` + optional `diagnostic` + `createRuntime` returning a live
 * `AgentRuntime` handle) and a Channel
 * provider (with the optional `reply` / `react` / `tools` / `handleTool` /
 * `messageBelongsToTarget`), the way an external provider package in another
 * repository would. It also exercises the published provider factory contracts
 * (`AgentRuntimeProviderFactory` / `ChannelProviderFactory`).
 *
 * It must never import `@excitedjs/dreamux`. Because it imports from the package
 * ROOT only, it doubles as the over-exposure oracle: every type it must name to
 * implement these surfaces has to be a root export. The fixture is type-checked
 * by the package's test typecheck; the runtime assertions live in
 * `fixtures.test.ts`.
 */
import type {
  AgentRuntime,
  AgentRuntimeBinCheck,
  AgentRuntimeCapabilities,
  AgentRuntimeContextSnapshot,
  AgentRuntimeCreateContext,
  AgentRuntimeDiagnostic,
  AgentRuntimeDiagnosticResult,
  AgentRuntimeLastResult,
  AgentRuntimeProvider,
  AgentRuntimeProviderConfigReadContext,
  AgentRuntimeProviderDescriptor,
  AgentRuntimeProviderFactory,
  AgentRuntimeStatus,
  AgentRuntimeSystemPrompt,
  AgentRuntimeTextInput,
  AgentRuntimeTurnResult,
  ChannelInboundEnvelope,
  ChannelLogicalRepositoryBinding,
  ChannelMessageTargetCheck,
  ChannelProvider,
  ChannelProviderDescriptor,
  ChannelProviderFactory,
  ChannelReactInput,
  ChannelReplyInput,
  ChannelRoutes,
  ChannelTaskCancelInput,
  ChannelTaskCancelResult,
  ChannelTaskHost,
  ChannelTaskHostAcknowledgeInput,
  ChannelTaskHostAcknowledgeResult,
  ChannelTaskHostEventBatch,
  ChannelTaskHostEventSink,
  ChannelTaskHostReplayRequest,
  ChannelTaskHostReplayResult,
  ChannelTaskHostStreamCursor,
  ChannelTaskProviderCapability,
  ChannelTaskContainerIdentity,
  ChannelTaskTurnInput,
  ChannelTaskSnapshotItem,
  ChannelSession,
  ChannelTarget,
  ChannelToolCall,
  ChannelToolDescriptor,
  DreamuxLogger,
  InboundTurnInput,
} from '@excitedjs/dreamux-types';

export const EXTERNAL_RUNTIME_CAPABILITIES: AgentRuntimeCapabilities = {
  resume: { supported: false },
};

export function describeConfigContext(
  context: AgentRuntimeProviderConfigReadContext,
): string {
  return `${context.providerRef}:${context.agentId}`;
}

export const appendArrayPrompt: AgentRuntimeSystemPrompt = {
  replace: 'full replacement prompt',
  append: ['first append fragment', 'second append fragment'],
};

/** The fixture runtime's parsed config shape. */
interface FixtureRuntimeConfig {
  model: string;
}

class FixtureRuntime implements AgentRuntime {
  readonly providerRef = 'npm:@example/fixture-runtime';
  private status: AgentRuntimeStatus = 'declared';
  private threadId: string | null = null;
  private readonly logger?: DreamuxLogger;

  constructor(context: AgentRuntimeCreateContext<FixtureRuntimeConfig>) {
    this.logger = context.logger;
    this.threadId = context.identity.checkpoint_id ?? null;
  }

  async start(): Promise<void> {
    this.status = 'ready';
    this.logger?.info('fixture runtime started');
  }

  async resume(): Promise<void> {
    this.status = 'ready';
  }

  async stop(): Promise<void> {
    this.status = 'stopped';
  }

  async channelInput(input: InboundTurnInput): Promise<AgentRuntimeTurnResult> {
    return { status: 'submitted', turnId: input.sourceId };
  }

  getStatus(): AgentRuntimeStatus {
    return this.status;
  }

  getCheckpoint(): { id: string } | null {
    return this.threadId === null ? null : { id: this.threadId };
  }

  wasCheckpointResumed(): boolean {
    return false;
  }

  async getLast(): Promise<AgentRuntimeLastResult | null> {
    return { text: null };
  }

  async getContext(): Promise<AgentRuntimeContextSnapshot | null> {
    return { usedTokens: null, windowTokens: null };
  }

  getCapabilities(): AgentRuntimeCapabilities {
    return EXTERNAL_RUNTIME_CAPABILITIES;
  }

  async completionInput(input: AgentRuntimeTextInput): Promise<AgentRuntimeTurnResult> {
    return { status: 'submitted', turnId: input.sourceId ?? 'plain-turn' };
  }
}

const runtimeDescriptor: AgentRuntimeProviderDescriptor = {
  id: 'fixture-runtime',
  kind: 'agentRuntime',
  ref: {
    source: 'npm',
    package: '@example/fixture-runtime',
    export: null,
    raw: 'npm:@example/fixture-runtime',
  },
};

/**
 * An optional diagnostic driven by Dreamux core. The host supplies the
 * command runner; the fixture only declares bin checks and runs its own check.
 */
const fixtureRuntimeDiagnostic: AgentRuntimeDiagnostic<FixtureRuntimeConfig> = {
  binChecks(): AgentRuntimeBinCheck[] {
    return [{ name: 'fixture', bin: 'fixture-cli', args: ['--version'] }];
  },
  async runDiagnostic(context, runner): Promise<AgentRuntimeDiagnosticResult> {
    const ok = await runner.check('fixture-cli', ['--version'], {
      env: context.env,
    });
    return { ok, detail: ok ? 'fixture ready' : 'fixture missing', errors: [] };
  },
};

export const fixtureRuntimeProvider: AgentRuntimeProvider<FixtureRuntimeConfig> =
  {
    ref: 'npm:@example/fixture-runtime',
    descriptor: runtimeDescriptor,
    getCapabilities() {
      return EXTERNAL_RUNTIME_CAPABILITIES;
    },
    readConfig(rawConfig) {
      const model = typeof rawConfig.model === 'string' ? rawConfig.model : 'default';
      return { model };
    },
    diagnostic: fixtureRuntimeDiagnostic,
    createRuntime(context) {
      return new FixtureRuntime(context);
    },
  };

/**
 * The package's default export an external runtime ships: the loader invokes it
 * with the seed `ProviderFactoryContext`, narrowed to the Agent Runtime kind.
 */
export const fixtureRuntimeFactory: AgentRuntimeProviderFactory<FixtureRuntimeConfig> =
  (context) => ({ ...fixtureRuntimeProvider, descriptor: context.descriptor });

class FixtureChannelSession implements ChannelSession {
  readonly provider = 'npm:@example/fixture-channel';
  readonly channel_id: string;
  private readonly logger?: DreamuxLogger;

  constructor(channel_id: string, logger?: DreamuxLogger) {
    this.channel_id = channel_id;
    this.logger = logger;
  }

  async start(routes: ChannelRoutes): Promise<void> {
    this.logger?.info(
      { channel_id: this.channel_id },
      'fixture channel started',
    );
    const envelope: ChannelInboundEnvelope = {
      provider: this.provider,
      channel_id: this.channel_id,
      target: { target_type: 'group', target_key: 'demo', bindable: true },
    };
    await routes.deliver(
      { text: 'fixture event', sourceId: 'fixture-event-1' },
      envelope,
    );
  }

  async close(): Promise<void> {}

  async resolveTarget(meta: unknown): Promise<ChannelTarget> {
    const record = (meta ?? {}) as Record<string, unknown>;
    const key = String(record.id ?? 'unknown');
    return {
      target_type: 'group',
      target_key: key,
      bindable: true,
    };
  }

  async reply(input: ChannelReplyInput): Promise<unknown> {
    this.logger?.info({ key: input.target.target_key }, 'reply');
    return { delivered: true };
  }

  async react(input: ChannelReactInput): Promise<unknown> {
    return { reacted: input.reaction };
  }

  tools(): readonly ChannelToolDescriptor[] {
    return [{ name: 'echo', description: 'echo a message' }];
  }

  // Optional ChannelSession methods: a strict implementer names these param
  // types (they are not contextually inferred for optional members).
  async handleTool(call: ChannelToolCall): Promise<unknown> {
    return { echoed: call.name };
  }

  messageBelongsToTarget(input: ChannelMessageTargetCheck): boolean {
    return input.target.target_key === input.message_id;
  }
}

const channelDescriptor: ChannelProviderDescriptor = {
  id: 'fixture-channel',
  kind: 'channel',
  ref: {
    source: 'npm',
    package: '@example/fixture-channel',
    export: null,
    raw: 'npm:@example/fixture-channel',
  },
};

export const fixtureChannelProvider: ChannelProvider = {
  ref: 'npm:@example/fixture-channel',
  descriptor: channelDescriptor,
  createSession(context) {
    return new FixtureChannelSession(context.channel_id, context.logger);
  },
};

/** The package's default export an external channel ships. */
export const fixtureChannelFactory: ChannelProviderFactory = (context) => ({
  ...fixtureChannelProvider,
  descriptor: context.descriptor,
});

interface FixtureTaskChannelConfig {
  repositories: Record<string, { cwd: string; revision: string; baseRef?: string }>;
}

const TASK_CHANNEL_CAPABILITY = {
  protocol: 'task_channel_host_v1',
  schema_versions: [1],
  capabilities: [
    'durable_task_submission_v1',
    'host_event_stream_v1',
    'logical_repository_binding_v1',
  ],
} as const satisfies ChannelTaskProviderCapability;

const taskCursors = new Map<string, ChannelTaskHostStreamCursor>();
const taskProjections = new Map<string, ReadonlyMap<string, ChannelTaskSnapshotItem>>();
const fixtureTaskTurn: ChannelTaskTurnInput = {
  sourceId: 'remote-attempt-delivery',
  text: 'Execute the remote task attempt',
  attachments: [{ kind: 'artifact', name: 'input.txt' }],
};

class FixtureTaskChannelSession implements ChannelSession {
  readonly provider = 'npm:@example/dreamux-task-channel';
  readonly channel_id: string;
  private acknowledgedThrough = 0;

  readonly taskHostEvents: ChannelTaskHostEventSink = {
    acceptHostEvents: async (batch) => this.acceptHostEvents(batch),
  };

  constructor(channelId: string) {
    this.channel_id = channelId;
  }

  async start(routes: ChannelRoutes): Promise<void> {
    const host = routes.taskHost;
    if (host === undefined) throw new Error('task host capability is required');
    const persisted = taskCursors.get(this.channel_id);
    for (const required of host.scope.required_capabilities) {
      if (!TASK_CHANNEL_CAPABILITY.capabilities.includes(required)) {
        throw new Error(`host requires unsupported capability: ${required}`);
      }
    }
    this.acknowledgedThrough = persisted?.acknowledged_through ?? 0;
    const negotiated = await host.negotiate({
      supported_schema_versions: TASK_CHANNEL_CAPABILITY.schema_versions,
      supported_capabilities: TASK_CHANNEL_CAPABILITY.capabilities,
      ...(persisted !== undefined ? { resume: persisted } : {}),
    });
    if (negotiated.resume === 'snapshot_required') {
      const staged = await stageTaskSnapshot(host);
      taskProjections.set(this.channel_id, staged.projection);
      this.persistCursor({
        host_stream_id: negotiated.host_stream_id,
        stream_generation: negotiated.stream_generation,
        acknowledged_through: staged.watermark,
      });
    } else {
      if (this.acknowledgedThrough > negotiated.acknowledged_through) {
        await host.acknowledgeHostEvents({
          host_stream_id: negotiated.host_stream_id,
          stream_generation: negotiated.stream_generation,
          acknowledged_through: this.acknowledgedThrough,
        });
      }
      await this.replayFrom(host, negotiated.host_stream_id, negotiated.stream_generation);
    }
    const container: ChannelTaskContainerIdentity = {
      container_type: 'task-space',
      container_key: 'space-1',
    };
    await host.submit({
      attempt: { task_key: 'task-1', attempt_key: 'attempt-1' },
      container,
      repository: { repository_key: 'repository-1' },
      turn: fixtureTaskTurn,
      title: 'Fixture task',
    });
  }

  async close(): Promise<void> {}

  async resolveTarget(): Promise<ChannelTarget> {
    return { target_type: 'task', target_key: 'task-only', bindable: false };
  }

  private async acceptHostEvents(
    batch: ChannelTaskHostEventBatch,
  ): Promise<ChannelTaskHostAcknowledgeResult> {
    if (
      batch.first_sequence !== null &&
      batch.first_sequence !== this.acknowledgedThrough + 1
    ) {
      throw new Error('host event batch is not a consecutive prefix');
    }
    this.acknowledgedThrough = batch.last_sequence ?? this.acknowledgedThrough;
    this.persistCursor({
      host_stream_id: batch.host_stream_id,
      stream_generation: batch.stream_generation,
      acknowledged_through: this.acknowledgedThrough,
    });
    return { acknowledged_through: this.acknowledgedThrough };
  }

  private async replayFrom(
    host: ChannelTaskHost,
    hostStreamId: string,
    streamGeneration: number,
  ): Promise<void> {
    for (;;) {
      const request: ChannelTaskHostReplayRequest = {
        host_stream_id: hostStreamId,
        stream_generation: streamGeneration,
        after_sequence: this.acknowledgedThrough,
      };
      const replay: ChannelTaskHostReplayResult = await host.replay(request);
      if (replay.status === 'snapshot_required') {
        const staged = await stageTaskSnapshot(host);
        taskProjections.set(this.channel_id, staged.projection);
        this.persistCursor({
          host_stream_id: hostStreamId,
          stream_generation: streamGeneration,
          acknowledged_through: staged.watermark,
        });
        return;
      }
      const batch = replay.batch;
      if (batch.events.length === 0) return;
      await this.acceptHostEvents(batch);
      const acknowledgement: ChannelTaskHostAcknowledgeInput = {
        host_stream_id: hostStreamId,
        stream_generation: streamGeneration,
        acknowledged_through: this.acknowledgedThrough,
      };
      await host.acknowledgeHostEvents(acknowledgement);
      if (!batch.has_more) return;
    }
  }

  private persistCursor(cursor: ChannelTaskHostStreamCursor): void {
    this.acknowledgedThrough = cursor.acknowledged_through;
    taskCursors.set(this.channel_id, cursor);
  }
}

export function cancelFixtureTask(
  host: ChannelTaskHost,
  input: ChannelTaskCancelInput,
): Promise<ChannelTaskCancelResult> {
  return host.cancel(input);
}

const taskChannelDescriptor: ChannelProviderDescriptor = {
  id: 'fixture-task-channel',
  kind: 'channel',
  ref: {
    source: 'npm',
    package: '@example/dreamux-task-channel',
    export: null,
    raw: 'npm:@example/dreamux-task-channel',
  },
};

export const fixtureTaskChannelProvider: ChannelProvider<FixtureTaskChannelConfig> = {
  ref: 'npm:@example/dreamux-task-channel',
  descriptor: taskChannelDescriptor,
  taskChannel: TASK_CHANNEL_CAPABILITY,
  readConfig(raw) {
    const candidate = raw !== null && typeof raw === 'object'
      ? raw as Record<string, unknown>
      : {};
    const repositories = candidate['repositories'];
    if (repositories === null || typeof repositories !== 'object') {
      throw new Error('repositories must be configured');
    }
    return {
      repositories: repositories as FixtureTaskChannelConfig['repositories'],
    };
  },
  createSession(context) {
    return new FixtureTaskChannelSession(context.channel_id);
  },
  resolveRepositoryBinding(binding, context) {
    return resolveFixtureRepository(binding, context.config);
  },
};

function resolveFixtureRepository(
  binding: ChannelLogicalRepositoryBinding,
  config: FixtureTaskChannelConfig,
) {
  const repository = config.repositories[binding.repository_key];
  if (repository === undefined) return null;
  return {
    cwd: repository.cwd,
    binding_revision: repository.revision,
    ...(repository.baseRef !== undefined ? { base_ref: repository.baseRef } : {}),
  };
}

/** Stage every page and return a projection only after the final completeness proof. */
export async function stageTaskSnapshot(
  host: ChannelTaskHost,
): Promise<{
  projection: ReadonlyMap<string, ChannelTaskSnapshotItem>;
  watermark: number;
}> {
  let cursor: string | undefined;
  let snapshotId: string | null = null;
  let watermark: number | null = null;
  let totalItems: number | null = null;
  let hostStreamId: string | null = null;
  let streamGeneration: number | null = null;
  let acknowledgedThrough: number | null = null;
  let hostStatus: string | null = null;
  let nextOffset = 0;
  const staged = new Map<string, ChannelTaskSnapshotItem>();
  while (true) {
    const result = await host.snapshot(cursor === undefined ? {} : { cursor });
    if (result.status === 'restart_required') {
      throw new Error(`snapshot staging must restart: ${result.reason}`);
    }
    const page = result.page;
    snapshotId ??= page.snapshot_id;
    watermark ??= page.watermark;
    totalItems ??= page.total_items;
    hostStreamId ??= page.host_stream_id;
    streamGeneration ??= page.stream_generation;
    acknowledgedThrough ??= page.acknowledged_through;
    hostStatus ??= page.host_status;
    if (
      page.snapshot_id !== snapshotId ||
      page.watermark !== watermark ||
      page.total_items !== totalItems ||
      page.host_stream_id !== hostStreamId ||
      page.stream_generation !== streamGeneration ||
      page.acknowledged_through !== acknowledgedThrough ||
      page.host_status !== hostStatus ||
      page.session_fence !== host.scope.session_fence ||
      page.host_stream_id !== host.scope.host_stream_id ||
      page.stream_generation !== host.scope.stream_generation ||
      page.item_offset !== nextOffset ||
      page.item_count !== page.items.length
    ) {
      throw new Error('snapshot changed while it was staged');
    }
    for (const item of page.items) {
      if (staged.has(item.receipt.target_id)) {
        throw new Error('snapshot repeats a task target');
      }
      staged.set(item.receipt.target_id, item);
    }
    nextOffset += page.item_count;
    if (page.complete) {
      if (
        page.next_cursor !== null ||
        nextOffset !== page.total_items ||
        staged.size !== page.total_items
      ) {
        throw new Error('snapshot completeness proof is invalid');
      }
      const acknowledgement: ChannelTaskHostAcknowledgeInput = {
        host_stream_id: page.host_stream_id,
        stream_generation: page.stream_generation,
        acknowledged_through: page.watermark,
      };
      await host.acknowledgeHostEvents(acknowledgement);
      return { projection: staged, watermark: page.watermark };
    }
    if (page.next_cursor === null) {
      throw new Error('incomplete snapshot has no continuation cursor');
    }
    cursor = page.next_cursor;
  }
}
