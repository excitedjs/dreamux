import type { ChannelToolCallerContext } from '@excitedjs/dreamux-types';

import type { ChannelService } from '../channel-service/index.js';

/**
 * The core-internal caller identity. `teamId` is the Team store key, which is
 * exactly the `team_name` core publishes on channel core events — so the
 * neutral {@link ChannelToolCallerContext} handed to a provider joins tool
 * calls and events on one value.
 */
export type ChannelToolCaller =
  | { kind: 'dispatcher' }
  | { kind: 'team_leader'; teamId: string; leaderName: string };

function toCallerContext(caller: ChannelToolCaller): ChannelToolCallerContext {
  return caller.kind === 'dispatcher'
    ? { kind: 'dispatcher' }
    : {
        kind: 'team_leader',
        team_name: caller.teamId,
        leader_name: caller.leaderName,
      };
}

export async function invokeDispatcherChannelTool(input: {
  channels: ChannelService;
  providerRef?: string;
  channelId?: string;
  name: string;
  arguments: Record<string, unknown>;
  caller: ChannelToolCaller;
}): Promise<unknown> {
  if (input.caller.kind === 'team_leader') {
    await input.channels.authorizeTeamLeaderEgress({
      owner: {
        kind: 'team',
        teamName: input.caller.teamId,
        leaderName: input.caller.leaderName,
      },
      ...(input.channelId !== undefined ? { channelId: input.channelId } : {}),
      ...(input.providerRef !== undefined ? { providerRef: input.providerRef } : {}),
      arguments: input.arguments,
    });
  }
  return input.channels.invokeTool({
    ...(input.providerRef !== undefined ? { providerRef: input.providerRef } : {}),
    name: input.name,
    arguments: input.arguments,
    caller: toCallerContext(input.caller),
    ...(input.channelId !== undefined ? { channelId: input.channelId } : {}),
  });
}
