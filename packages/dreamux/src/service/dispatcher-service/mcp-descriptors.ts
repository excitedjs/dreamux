import type {
  AgentRuntimeMcpServer,
  ChannelMcpDescriptorContext,
} from '@excitedjs/dreamux-types';

import type { ChannelProviderCatalog } from '../../channel/catalog.js';
import type { DispatcherChannelConfig } from '../../config/config.js';
import { dreamuxBinPath } from '../../platform/package-bin.js';
import { adminSocketPath as defaultAdminSocketPath } from '../../platform/paths.js';
import { teamMcpServerDescriptor } from '../team-collection/mcp-config.js';
import { teammateMcpServerDescriptor } from '../teammate-collection/mcp-config.js';
import { cronMcpServerDescriptor } from '../scheduler/mcp-config.js';

export interface ChannelMcpCallerScope {
  callerKind?: 'dispatcher' | 'team_leader';
  team_id?: string;
  leader_name?: string;
}

export function dispatcherMcpServerDescriptors(input: {
  dispatcherId: string;
  channels: readonly DispatcherChannelConfig[];
  channelProviders: ChannelProviderCatalog;
  adminSocketPath?: string;
}): AgentRuntimeMcpServer[] {
  const context = {
    dispatcherId: input.dispatcherId,
    adminSocketPath: input.adminSocketPath ?? defaultAdminSocketPath(),
  };
  return [
    ...channelMcpServerDescriptors({
      channels: input.channels,
      channelProviders: input.channelProviders,
      adminSocketPath: input.adminSocketPath,
      dispatcher_id: input.dispatcherId,
      callerKind: 'dispatcher',
    }),
    teamMcpServerDescriptor(context),
    teammateMcpServerDescriptor({
      ...context,
      callerKind: 'dispatcher',
    }),
    cronMcpServerDescriptor(context),
  ];
}

export function channelMcpServerDescriptorsForCaller(input: {
  dispatcherId: string;
  channels: readonly DispatcherChannelConfig[];
  channelProviders: ChannelProviderCatalog;
  adminSocketPath?: string;
  scope: ChannelMcpCallerScope;
}): AgentRuntimeMcpServer[] {
  return channelMcpServerDescriptors({
    channels: input.channels,
    channelProviders: input.channelProviders,
    adminSocketPath: input.adminSocketPath,
    dispatcher_id: input.dispatcherId,
    ...input.scope,
  });
}

function channelMcpServerDescriptors(input: {
  channels: readonly DispatcherChannelConfig[];
  channelProviders: ChannelProviderCatalog;
  adminSocketPath?: string;
  dispatcher_id: string;
  callerKind?: 'dispatcher' | 'team_leader';
  team_id?: string;
  leader_name?: string;
}): AgentRuntimeMcpServer[] {
  const out: AgentRuntimeMcpServer[] = [];
  for (const channel of input.channels) {
    const provider = input.channelProviders.resolve(channel.provider);
    const context: ChannelMcpDescriptorContext = {
      command: dreamuxBinPath(),
      adminSocketPath: input.adminSocketPath ?? defaultAdminSocketPath(),
      dispatcher_id: input.dispatcher_id,
      provider: channel.provider,
      channel_id: channel.id,
      ...(input.callerKind !== undefined ? { callerKind: input.callerKind } : {}),
      ...(input.team_id !== undefined ? { team_id: input.team_id } : {}),
      ...(input.leader_name !== undefined ? { leader_name: input.leader_name } : {}),
    };
    const descriptor = provider.mcpServerDescriptor?.(context, channel.config);
    if (descriptor != null) out.push(descriptor);
  }
  return out;
}
