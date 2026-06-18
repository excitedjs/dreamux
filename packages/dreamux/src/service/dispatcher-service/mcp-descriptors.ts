import type {
  AgentRuntimeMcpServer,
  ChannelMcpDescriptorContext,
  ChannelSession,
} from '@excitedjs/dreamux-types';

import { dreamuxBinPath } from '../../platform/package-bin.js';
import { adminSocketPath as defaultAdminSocketPath } from '../../platform/paths.js';
import { teamMcpServerDescriptor } from '../team-collection/mcp-config.js';
import { teammateMcpServerDescriptor } from '../teammate-collection/mcp-config.js';

export interface ChannelMcpCallerScope {
  callerKind?: 'dispatcher' | 'team_leader';
  team_id?: string;
  leader_name?: string;
}

export function dispatcherMcpServerDescriptors(input: {
  dispatcherId: string;
  channels: Map<string, ChannelSession>;
  adminSocketPath?: string;
}): AgentRuntimeMcpServer[] {
  const context = {
    dispatcherId: input.dispatcherId,
    adminSocketPath: input.adminSocketPath ?? defaultAdminSocketPath(),
  };
  return [
    ...channelMcpServerDescriptors({
      channels: input.channels,
      adminSocketPath: input.adminSocketPath,
      dispatcher_id: input.dispatcherId,
      callerKind: 'dispatcher',
    }),
    teamMcpServerDescriptor(context),
    teammateMcpServerDescriptor({
      ...context,
      callerKind: 'dispatcher',
    }),
  ];
}

export function channelMcpServerDescriptorsForCaller(input: {
  dispatcherId: string;
  channels: Map<string, ChannelSession>;
  adminSocketPath?: string;
  scope: ChannelMcpCallerScope;
}): AgentRuntimeMcpServer[] {
  return channelMcpServerDescriptors({
    channels: input.channels,
    adminSocketPath: input.adminSocketPath,
    dispatcher_id: input.dispatcherId,
    ...input.scope,
  });
}

function channelMcpServerDescriptors(input: {
  channels: Map<string, ChannelSession>;
  adminSocketPath?: string;
  dispatcher_id: string;
  callerKind?: 'dispatcher' | 'team_leader';
  team_id?: string;
  leader_name?: string;
}): AgentRuntimeMcpServer[] {
  const out: AgentRuntimeMcpServer[] = [];
  for (const session of input.channels.values()) {
    const context: ChannelMcpDescriptorContext = {
      command: dreamuxBinPath(),
      adminSocketPath: input.adminSocketPath ?? defaultAdminSocketPath(),
      dispatcher_id: input.dispatcher_id,
      provider: session.provider,
      channel_id: session.channel_id,
      ...(input.callerKind !== undefined ? { callerKind: input.callerKind } : {}),
      ...(input.team_id !== undefined ? { team_id: input.team_id } : {}),
      ...(input.leader_name !== undefined ? { leader_name: input.leader_name } : {}),
    };
    const descriptor = session.mcpServerDescriptor?.(context);
    if (descriptor != null) out.push(descriptor);
  }
  return out;
}
