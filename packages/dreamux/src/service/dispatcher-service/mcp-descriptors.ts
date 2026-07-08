import type { AgentRuntimeMcpServer } from '@excitedjs/dreamux-types';

import type { DispatcherChannelConfig } from '../../config/config.js';
import { adminSocketPath as defaultAdminSocketPath } from '../../platform/paths.js';
import type { ChannelProviderCatalog } from '../../channel/catalog.js';
import { channelMcpServerDescriptorsForCaller } from '../channel-service/mcp-descriptors.js';
import { teamMcpServerDescriptor } from '../team-collection/mcp-config.js';
import { teammateMcpServerDescriptor } from '../teammate-collection/mcp-config.js';
import { cronMcpServerDescriptor } from '../scheduler/mcp-config.js';

/**
 * Assemble the dispatcher-root MCP descriptor set (issue #209 / PR #282
 * review). Channel descriptor rendering lives in
 * `service/channel-service/mcp-descriptors.ts` (core-owned, not
 * provider-owned); this module only composes the dispatcher-root aggregate
 * (channel + team + teammate + cron). The channel service never imports back
 * from `dispatcher-service`.
 */
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
    ...channelMcpServerDescriptorsForCaller({
      dispatcherId: input.dispatcherId,
      channels: input.channels,
      channelProviders: input.channelProviders,
      adminSocketPath: input.adminSocketPath,
      scope: { callerKind: 'dispatcher' },
    }),
    teamMcpServerDescriptor(context),
    teammateMcpServerDescriptor({
      ...context,
      callerKind: 'dispatcher',
    }),
    cronMcpServerDescriptor(context),
  ];
}
