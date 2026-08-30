import type { ProviderRegistry } from '../registry/index.js';
import { errMessage } from '../registry/provider-loader.js';
import {
  asAgentRuntimeProvider,
  asChannelProvider,
  resolveConfigProvider,
} from './config-helpers.js';
import type {
  DispatcherChannelConfig,
  DispatcherProviderConfig,
  ResolvedAgentConfig,
} from './config.js';
import type { HostAgentConfig, HostChannelConfig } from './host-config.js';

export class ProviderReadConfigError extends Error {
  readonly phase = 'readConfig';
  constructor(
    readonly providerKind: 'agentRuntime' | 'channel',
    readonly providerRef: string,
    cause: unknown,
  ) {
    super(
      `provider ${providerKind} ${JSON.stringify(providerRef)} readConfig failed: ${errMessage(cause)}`,
      { cause },
    );
    this.name = 'ProviderReadConfigError';
  }
}

export async function readHostAgentConfig(
  raw: HostAgentConfig,
  file: string,
  providerRegistry: ProviderRegistry,
  prefix: string,
): Promise<ResolvedAgentConfig> {
  const provider = resolveConfigProvider(
    raw.provider,
    'agentRuntime',
    file,
    prefix,
    providerRegistry,
  );
  const runtimeProvider = asAgentRuntimeProvider(
    providerRegistry.getImplementation(provider.descriptor.id),
  );
  if (runtimeProvider === null) {
    throw implementationMissing(file, prefix, provider.ref, 'runnable agentRuntime');
  }
  let parsedConfig = raw.rawConfig;
  if (runtimeProvider.readConfig !== undefined) {
    try {
      parsedConfig =
        ((await runtimeProvider.readConfig(raw.rawConfig, {
          providerRef: provider.ref,
          agentId: raw.id,
          file,
          prefix: `${prefix}config.`,
        })) as DispatcherProviderConfig | undefined) ?? raw.rawConfig;
    } catch (err) {
      throw new ProviderReadConfigError('agentRuntime', provider.ref, err);
    }
  }
  return { provider: provider.ref, config: parsedConfig, rawConfig: raw.rawConfig };
}

export async function readHostChannelConfig(
  raw: HostChannelConfig,
  file: string,
  providerRegistry: ProviderRegistry,
  context: {
    dispatcherId: string;
    dispatcherPrefix: string;
    channelIndex: number;
  },
): Promise<DispatcherChannelConfig> {
  const channelPrefix = `${context.dispatcherPrefix}channels[${context.channelIndex}].`;
  const provider = resolveConfigProvider(
    raw.provider,
    'channel',
    file,
    channelPrefix,
    providerRegistry,
  );
  const channelProvider = asChannelProvider(
    providerRegistry.getImplementation(provider.descriptor.id),
  );
  if (channelProvider === null) {
    throw implementationMissing(file, channelPrefix, provider.ref, 'usable channel');
  }
  let parsed = raw.rawConfig;
  if (channelProvider.readConfig !== undefined) {
    try {
      parsed =
        ((await channelProvider.readConfig(raw.rawConfig, {
          dispatcher_id: context.dispatcherId,
          channel_id: raw.id,
          provider: provider.ref,
        })) as DispatcherProviderConfig | undefined) ?? raw.rawConfig;
    } catch (err) {
      throw new ProviderReadConfigError('channel', provider.ref, err);
    }
  }
  let identity = '';
  try {
    identity = channelProvider.getIdentity?.(parsed) ?? '';
  } catch {
    identity = '';
  }
  return {
    id: raw.id,
    provider: provider.ref,
    collaborationSpace: raw.collaborationSpace,
    config: parsed,
    rawConfig: raw.rawConfig,
    identity,
  };
}

function implementationMissing(
  file: string,
  prefix: string,
  providerRef: string,
  expected: string,
): Error {
  return new Error(
    `dreamux config error in ${file}: ${prefix}provider='${providerRef}' is registered but has no ${expected} implementation.\n` +
      'Seed the registry with builtin descriptors or register a valid implementation before config validation.',
  );
}
