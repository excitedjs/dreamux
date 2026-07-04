import type { AgentRuntimeMcpServer } from '@excitedjs/dreamux-types';

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
    const tools = provider.tools?.(channel.config);
    if (tools === undefined || tools.length === 0) continue;
    out.push({
      name: provider.descriptor.id,
      command: dreamuxBinPath(),
      args: [
        'channel-mcp',
        '--provider',
        channel.provider,
        '--channel-id',
        channel.id,
        '--dispatcher',
        input.dispatcher_id,
        ...(input.callerKind !== undefined ? ['--caller', input.callerKind] : []),
        ...(input.team_id !== undefined ? ['--team-id', input.team_id] : []),
        ...(input.leader_name !== undefined
          ? ['--leader-name', input.leader_name]
          : []),
        '--channel-tools-b64',
        Buffer.from(JSON.stringify(tools), 'utf8').toString('base64'),
        '--admin-socket',
        input.adminSocketPath ?? defaultAdminSocketPath(),
      ],
    });
  }
  return out;
}
