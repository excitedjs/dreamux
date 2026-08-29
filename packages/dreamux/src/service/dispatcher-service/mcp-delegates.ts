/**
 * Which Agent-facing MCP servers each conversational role gets.
 *
 * This is the whole role→tools decision, in one place, expressed as delegates
 * rather than command lines. Every entry is an owning object bound to its
 * caller; nothing here renders a subcommand, a caller flag, or a socket path.
 *
 * The Dispatcher Agent and a TeamLeader get different sets because they are
 * different callers, not because a shared server filters by who is asking:
 * a TeamLeader has no Team `create`/`send`/`list`, and its TeamMate and cron
 * surfaces operate on its own Team.
 */
import type { ChannelMcpCaller } from '@excitedjs/dreamux-types';

import type { ChannelProviderCatalog } from '../../channel/catalog.js';
import type { ChannelService } from '../channel-service/index.js';
import { channelMcpDelegates } from '../channel-service/mcp-delegates.js';
import type { McpServerDelegate } from '../mcp/types.js';
import { createCronMcpDelegate } from '../scheduler/mcp-delegate.js';
import { createTeamMcpDelegate } from '../team-collection/mcp-delegate.js';
import { createTeamMateMcpDelegate } from '../teammate-collection/mcp-delegate.js';
import type { DispatcherService } from './index.js';

interface RoleDelegateInput {
  dispatcherId: string;
  dispatcher: DispatcherService;
  channels: ChannelService;
  channelProviders: ChannelProviderCatalog;
}

/** The Dispatcher Agent's servers: its channels, Teams, TeamMates, and cron. */
export function dispatcherAgentMcpDelegates(
  input: RoleDelegateInput,
): McpServerDelegate[] {
  const caller: ChannelMcpCaller = { kind: 'dispatcher' };
  return [
    ...channelDelegates(input, caller, (task) =>
      input.dispatcher.admitOperation(task),
    ),
    createTeamMcpDelegate({
      dispatcher: input.dispatcher,
      caller: { kind: 'dispatcher' },
    }),
    createTeamMateMcpDelegate({
      kind: 'dispatcher',
      dispatcher: input.dispatcher,
    }),
    createCronMcpDelegate({
      scheduler: async () => input.dispatcher.scheduler,
    }),
  ];
}

/**
 * One TeamLeader's servers.
 *
 * Every one of them is bound to this Team and this leader generation. Nothing
 * the model sends can widen that: the Team surface takes no `team_name`, the
 * TeamMate surface resolves this Team's own handle, and cron reaches this
 * Team's own scheduler.
 */
export function teamLeaderMcpDelegates(
  input: RoleDelegateInput & { teamId: string; leaderName: string },
): McpServerDelegate[] {
  const { teamId, leaderName } = input;
  const caller: ChannelMcpCaller = {
    kind: 'team_leader',
    team_name: teamId,
    leader_name: leaderName,
  };
  return [
    ...channelDelegates(input, caller, (task) =>
      // A leader's channel call also takes its Team lease: the runtime-generation
      // lease fences a replaced runtime, but only the Team lease serializes
      // against an in-flight dissolve.
      input.dispatcher.runForTeamLeader({ teamId, leaderName }, task),
    ),
    createTeamMcpDelegate({
      dispatcher: input.dispatcher,
      caller: { kind: 'team_leader', teamId, leaderName },
    }),
    createTeamMateMcpDelegate({
      kind: 'team_leader',
      team: () => input.dispatcher.team(teamId),
    }),
    createCronMcpDelegate({
      scheduler: () => input.dispatcher.teamScheduler(teamId),
    }),
  ];
}

function channelDelegates(
  input: RoleDelegateInput,
  caller: ChannelMcpCaller,
  dispatch: <T>(task: () => Promise<T>) => Promise<T>,
): McpServerDelegate[] {
  return channelMcpDelegates({
    dispatcherId: input.dispatcherId,
    channels: input.channels.configuredChannels(),
    channelProviders: input.channelProviders,
    caller,
    sessionMcp: (channelId) => input.channels.sessionMcp(channelId),
    dispatch,
  });
}
