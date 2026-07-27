import type { AgentRuntimeMcpServer } from '@excitedjs/dreamux-types';

import type { ChannelProviderCatalog } from '../../channel/catalog.js';
import type { DispatcherChannelConfig } from '../../config/config.js';
import { dreamuxBinPath } from '../../platform/package-bin.js';
import { adminSocketPath as defaultAdminSocketPath } from '../../platform/paths.js';

/**
 * Caller scope carried into the channel MCP descriptor (issue #209 / PR #282
 * review). Core-owned: the channel provider never sees these flags.
 */
export interface ChannelMcpCallerScope {
  callerKind?: 'dispatcher' | 'team_leader';
  team_id?: string;
  leader_name?: string;
}

/**
 * Render the core-owned `channel-mcp` stdio MCP shim descriptors for a set of
 * dispatcher-scoped configured channels (issue #209 / PR #282 review).
 *
 * Ownership lives in `channel-service` because the descriptor is a core channel
 * concern: the generic shim command, `--provider`, `--channel-id`,
 * `--dispatcher`, caller/team routing args, `--channel-tools-b64`, and
 * `--admin-socket`. Provider packages expose only static tool catalogs and
 * never compose core command lines.
 */
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
      name:
        provider.descriptor.ref.source === 'builtin'
          ? provider.descriptor.id
          : channel.id,
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
