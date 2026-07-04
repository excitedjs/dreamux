import type {
  AgentRuntimeProviderDescriptor,
  ChannelProviderDescriptor,
  ProviderDescriptor,
  SubscribeChannelProviderDescriptor,
} from '@excitedjs/dreamux-types';

/**
 * Validate + narrow a registry descriptor to the Agent Runtime kind.
 *
 * `ProviderRegistry.resolve` returns the wide `ProviderDescriptor`; provider
 * doubles and inline factories in tests need the narrowed
 * `AgentRuntimeProviderDescriptor`. This mirrors the production narrow each
 * runtime package performs on its seed descriptor.
 */
export function asAgentRuntimeDescriptor(
  descriptor: ProviderDescriptor,
): AgentRuntimeProviderDescriptor {
  if (descriptor.kind !== 'agentRuntime') {
    throw new Error(
      `expected an agentRuntime descriptor (got ${JSON.stringify(descriptor.kind)})`,
    );
  }
  return { ...descriptor, kind: descriptor.kind };
}

/** Validate + narrow a registry descriptor to the Channel kind. */
export function asChannelDescriptor(
  descriptor: ProviderDescriptor,
): ChannelProviderDescriptor {
  if (descriptor.kind !== 'channel') {
    throw new Error(
      `expected a channel descriptor (got ${JSON.stringify(descriptor.kind)})`,
    );
  }
  return { ...descriptor, kind: descriptor.kind };
}

/** Validate + narrow a registry descriptor to the SubscribeChannel kind. */
export function asSubscribeChannelDescriptor(
  descriptor: ProviderDescriptor,
): SubscribeChannelProviderDescriptor {
  if (descriptor.kind !== 'subscribeChannel') {
    throw new Error(
      `expected a subscribeChannel descriptor (got ${JSON.stringify(descriptor.kind)})`,
    );
  }
  return { ...descriptor, kind: descriptor.kind };
}
