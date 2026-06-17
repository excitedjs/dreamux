import type { ChannelTarget } from '@excitedjs/dreamux-types';

import { ChannelToolAuthorizationError } from './errors.js';

/**
 * The narrow seams the TeamLeader channel-egress gate needs (issue #233 Phase 5,
 * split out of `DispatcherService` for module size). `DispatcherService` supplies
 * them from its live channel sessions + team topology.
 */
export interface TeamLeaderChannelEgressContext {
  resolveTarget(meta: unknown, channelId?: string): Promise<ChannelTarget>;
  messageBelongsToTarget(
    target: ChannelTarget,
    messageId: string,
    channelId?: string,
  ): Promise<boolean>;
  teamLeaderCanUseChannel(input: {
    teamId: string;
    leaderName: string;
    targetKey: string;
  }): Promise<{ allowed: boolean; channelId: string | null }>;
}

/**
 * Authorize a TeamLeader's channel tool call before it egresses (issue #209
 * egress gate). The leader may act only on a resolvable target, only on messages
 * its bound team channel observed, only for a bound team channel, and only
 * through the channel MCP server bound to that target. Any miss fails loud with a
 * {@link ChannelToolAuthorizationError}.
 */
export async function authorizeTeamLeaderChannelEgress(
  context: TeamLeaderChannelEgressContext,
  input: {
    channelId: string;
    teamId: string;
    leaderName: string;
    arguments: Record<string, unknown>;
  },
): Promise<void> {
  let target: ChannelTarget;
  try {
    target = await context.resolveTarget(input.arguments, input.channelId);
  } catch {
    throw new ChannelToolAuthorizationError(
      'BAD_REQUEST',
      'TeamLeader channel tools require a resolvable target',
    );
  }
  const messageId = input.arguments['message_id'];
  if (
    typeof messageId === 'string' &&
    !(await context.messageBelongsToTarget(target, messageId, input.channelId))
  ) {
    throw new ChannelToolAuthorizationError(
      'CHANNEL_SCOPE_DENIED',
      'TeamLeader may act only on messages observed in bound team channels',
    );
  }
  const { allowed, channelId } = await context.teamLeaderCanUseChannel({
    teamId: input.teamId,
    leaderName: input.leaderName,
    targetKey: target.target_key,
  });
  if (!allowed || channelId === null) {
    throw new ChannelToolAuthorizationError(
      'CHANNEL_SCOPE_DENIED',
      'TeamLeader may use channels only for bound team channels',
    );
  }
  if (channelId !== input.channelId) {
    throw new ChannelToolAuthorizationError(
      'CHANNEL_SCOPE_DENIED',
      'TeamLeader may use only the channel MCP server bound to the target',
    );
  }
}
