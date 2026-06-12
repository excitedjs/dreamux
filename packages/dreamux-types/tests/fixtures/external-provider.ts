/**
 * External-provider compile fixture (issue #209 validation guard).
 *
 * This file imports Dreamux contracts from `@excitedjs/dreamux-types` ONLY and
 * implements both an Agent Runtime provider config-reader shape and a Channel
 * provider, the way an external provider package in another repository would.
 * It must never import `@excitedjs/dreamux`. The fixture is type-checked by the
 * package's test typecheck; the runtime assertion lives in `fixtures.test.ts`.
 */
import type {
  AgentRuntimeCapabilities,
  AgentRuntimeProviderConfigReadContext,
  ChannelProvider,
  ChannelSession,
  ChannelTarget,
  DreamuxLogger,
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
