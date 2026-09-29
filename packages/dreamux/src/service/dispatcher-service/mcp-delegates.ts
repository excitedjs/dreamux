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

import type { ChannelService } from '../channel-service/index.js';
import type { McpServerDelegate } from '../mcp/types.js';
import { createCronMcpDelegate } from '../scheduler/mcp.js';
import type { SchedulerCommands } from '../scheduler/types.js';
import { createTeamMcpDelegate } from '../team/mcp.js';
import type { TeamsPort } from '../team/teams-port.js';
import {
  createTeamMateMcpDelegate,
  type TeamMateMcpDispatcherScope,
} from '../agent/mcp.js';

/**
 * Structural stand-in for `DispatcherService`, naming only the members role
 * assembly calls beyond the ones `TeamMateMcpDispatcherScope` already names
 * (`teammates`/`workflows`/`workspace()` — this file passes `dispatcher`
 * straight through to `createTeamMateMcpDelegate`, so extending that scope
 * instead of restating it keeps the two in sync). `DispatcherService`
 * satisfies this shape without this file needing to import the concrete
 * class from the sibling `index.ts` that owns it — that back-import is what
 * closed the `index.ts` <-> `mcp-delegates.ts` cycle.
 */
interface RoleDelegateDispatcher extends TeamMateMcpDispatcherScope {
  readonly teams: TeamsPort;
  readonly scheduler: SchedulerCommands;
  admitOperation<T>(task: () => Promise<T>): Promise<T>;
}

interface RoleDelegateInput {
  dispatcher: RoleDelegateDispatcher;
  channels: ChannelService;
}

/** The Dispatcher Agent's servers: its channels, Teams, TeamMates, and cron. */
export function dispatcherAgentMcpDelegates(
  input: RoleDelegateInput,
): McpServerDelegate[] {
  const caller: ChannelMcpCaller = { kind: 'dispatcher' };
  return [
    ...input.channels.mcpDelegates(caller, (task) =>
      input.dispatcher.admitOperation(task),
    ),
    createTeamMcpDelegate({
      teams: input.dispatcher.teams,
      caller: { kind: 'dispatcher' },
    }),
    createTeamMateMcpDelegate({
      kind: 'dispatcher',
      // The TeamMate MCP delegate reaches `teammates` and the dispatcher's
      // own default `workspace()` too, unlike the Team delegate above, which
      // needs only `TeamsPort`.
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
 * Every one of them is bound to this one Team. Nothing
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
    ...input.channels.mcpDelegates(caller, (task) =>
      // A leader's channel call also enters its Team's work fence: the
      // runtime-generation lease fences a replaced runtime, but only the Team
      // fence serializes against an in-flight dissolve.
      input.dispatcher.teams.runForLeader(teamId, task),
    ),
    createTeamMcpDelegate({
      teams: input.dispatcher.teams,
      caller: { kind: 'team_leader', teamId },
    }),
    createTeamMateMcpDelegate({
      kind: 'team_leader',
      team: () => input.dispatcher.teams.leaderScope(teamId),
    }),
    createCronMcpDelegate({
      scheduler: () => input.dispatcher.teams.scheduler(teamId),
    }),
  ];
}
