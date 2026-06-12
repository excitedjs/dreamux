/**
 * External-provider compile fixture (issue #209 validation guard).
 *
 * This file imports Dreamux contracts from `@excitedjs/dreamux-types` ONLY and
 * implements a complete Agent Runtime provider (descriptor + `readConfig` +
 * `getCapabilities` + `createRuntime` returning a live `AgentRuntime` handle)
 * and a Channel provider, the way an external provider package in another
 * repository would. It must never import `@excitedjs/dreamux`. The fixture is
 * type-checked by the package's test typecheck; the runtime assertions live in
 * `fixtures.test.ts`.
 */
import type {
  AgentRuntime,
  AgentRuntimeCapabilities,
  AgentRuntimeContextSnapshot,
  AgentRuntimeCreateContext,
  AgentRuntimeLastResult,
  AgentRuntimeProvider,
  AgentRuntimeProviderConfigReadContext,
  AgentRuntimeStatus,
  AgentRuntimeTurnResult,
  ChannelProvider,
  ChannelSession,
  ChannelTarget,
  DreamuxLogger,
  InboundTurnInput,
  ProviderDescriptor,
} from '@excitedjs/dreamux-types';

export const EXTERNAL_RUNTIME_CAPABILITIES: AgentRuntimeCapabilities = {
  resume: { supported: false },
  steer: { supported: false },
  events: { kind: 'synthesized' },
  last: { supported: false },
  context: { supported: false },
  systemPrompt: { mode: 'append' },
  teammateCompletion: [],
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

  getThreadId(): string | null {
    return this.threadId;
  }

  wasThreadResumed(): boolean {
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
}

const runtimeDescriptor: ProviderDescriptor = {
  id: 'fixture-runtime',
  kind: 'agentRuntime',
  ref: {
    source: 'npm',
    package: '@example/fixture-runtime',
    export: null,
    raw: 'npm:@example/fixture-runtime',
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
    createRuntime(context) {
      return new FixtureRuntime(context);
    },
  };

class FixtureChannelSession implements ChannelSession {
  readonly provider = 'npm:@example/fixture-channel';
  readonly channel_id: string;
  private readonly logger?: DreamuxLogger;

  constructor(channel_id: string, logger?: DreamuxLogger) {
    this.channel_id = channel_id;
    this.logger = logger;
  }

  async start(): Promise<void> {
    this.logger?.info('fixture channel started', { channel_id: this.channel_id });
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
}

const descriptor: ProviderDescriptor & { kind: 'channel' } = {
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
  descriptor,
  createSession(context) {
    return new FixtureChannelSession(context.channel_id, context.logger);
  },
};
