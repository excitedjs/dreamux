import type { AgentRuntimeMcpServer } from '@excitedjs/dreamux-types';

import type { DispatcherSubscriptionConfig } from '../config/config.js';
import { dreamuxBinPath } from '../platform/package-bin.js';
import { adminSocketPath as defaultAdminSocketPath } from '../platform/paths.js';
import type { SubscribeChannelProviderCatalog } from './catalog.js';

export function subscribeChannelMcpServerDescriptors(input: {
  dispatcherId: string;
  subscriptions: readonly DispatcherSubscriptionConfig[];
  subscribeChannelProviders: SubscribeChannelProviderCatalog;
  adminSocketPath?: string;
}): AgentRuntimeMcpServer[] {
  const out: AgentRuntimeMcpServer[] = [];
  for (const subscription of input.subscriptions) {
    if (subscription.dispatcher_id !== input.dispatcherId) continue;
    const provider = input.subscribeChannelProviders.resolve(subscription.provider);
    const tools = provider.tools?.(subscription.config);
    if (tools === undefined || tools.length === 0) continue;
    out.push({
      name: subscribeChannelMcpServerName({
        providerId: provider.descriptor.id,
        subscriptionId: subscription.id,
      }),
      command: dreamuxBinPath(),
      args: [
        'subscribe-channel-mcp',
        '--provider',
        subscription.provider,
        '--subscription-id',
        subscription.id,
        '--dispatcher',
        input.dispatcherId,
        '--subscription-tools-b64',
        Buffer.from(JSON.stringify(tools), 'utf8').toString('base64'),
        '--admin-socket',
        input.adminSocketPath ?? defaultAdminSocketPath(),
      ],
    });
  }
  return out;
}

export function subscribeChannelMcpServerName(input: {
  providerId: string;
  subscriptionId: string;
}): string {
  return [
    'subscribe',
    encodeMcpServerNamePart(input.providerId),
    encodeMcpServerNamePart(input.subscriptionId),
  ].join('-');
}

function encodeMcpServerNamePart(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64url');
}
