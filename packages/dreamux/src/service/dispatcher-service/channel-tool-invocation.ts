import type { ChannelService } from '../channel-service/index.js';

export type ChannelToolCaller =
  | { kind: 'dispatcher' }
  | { kind: 'team_leader'; teamId: string; leaderName: string };

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
    ...(input.channelId !== undefined ? { channelId: input.channelId } : {}),
  });
}
