/**
 * External-provider compile fixture (issue #209 validation guard).
 *
 * This file imports Dreamux contracts from `@excitedjs/dreamux-types` ONLY and
 * implements a complete Agent Runtime provider (descriptor + `readConfig` +
 * `getCapabilities` + optional `diagnostic` + `createRuntime` returning a live
 * `AgentRuntime` handle, including the optional `completionInput`) and a Channel
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
  AgentRuntimeTurnResult,
  ChannelInboundEnvelope,
  ChannelMessageTargetCheck,
  ChannelProvider,
  ChannelProviderDescriptor,
  ChannelProviderFactory,
  ChannelReactInput,
  ChannelReplyInput,
  ChannelRoutes,
  ChannelSession,
  ChannelTarget,
  ChannelToolCall,
  ChannelToolDescriptor,
  CompletionEnvelope,
  CompletionDeliveryResult,
  DreamuxLogger,
  InboundTurnInput,
} from '@excitedjs/dreamux-types';

export const EXTERNAL_RUNTIME_CAPABILITIES: AgentRuntimeCapabilities = {
  resume: { supported: false },
  steer: { supported: false },
  events: { kind: 'synthesized' },
  last: { supported: false },
  context: { supported: false },
  teammateCompletion: [
    { kind: 'fixturePlainTurn', description: 'deliver as a plain user turn' },
  ],
};

export function describeConfigContext(
  context: AgentRuntimeProviderConfigReadContext,
): string {
  return `${context.providerRef}:${context.agentId}`;
}

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

  async systemInput(): Promise<AgentRuntimeTurnResult> {
    return { status: 'skipped' };
  }

  getStatus(): AgentRuntimeStatus {
    return this.status;
  }

  getCheckpoint(): { kind: string; id: string } | null {
    return this.threadId === null
      ? null
      : { kind: 'fixtureCheckpoint', id: this.threadId };
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

  async completionInput(
    completion: CompletionEnvelope,
  ): Promise<CompletionDeliveryResult> {
    this.logger?.info({ id: completion.id }, 'fixture completion');
    return { status: 'accepted' };
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
