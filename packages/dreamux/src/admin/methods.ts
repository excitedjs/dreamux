
import type { Server } from '../server.js';
import type {
  ChannelToolCaller,
  DispatcherService,
} from '../service/dispatcher-service/index.js';
import type { ChannelRouteOwner } from '../service/channel-service/index.js';
import { ChannelToolAuthorizationError } from '../service/channel-service/errors.js';
import type { TeamService } from '../service/team-service/index.js';
import type { SchedulerService } from '../service/scheduler/service.js';
import { TeamUnavailableError } from '../service/team-collection/index.js';
import { AdminError } from './protocol.js';
import {
  historyQuery,
  mustDispatcherId,
  mustExistingDispatcher,
  mustNonEmptyString,
  mustRecord,
  mustString,
  optionalBooleanField,
  optionalInteger,
  optionalNonBlankString,
  optionalNullableRecordField,
  optionalNullableStringField,
  optionalRecordField,
  optionalString,
  optionalStringField,
  optionalTeamStatus,
  parseMessage,
  repoRequest,
} from './params.js';

export type AdminHandler = (
  server: Server,
  params: Record<string, unknown> | undefined,
) => Promise<unknown> | unknown;

export const adminMethods: Record<string, AdminHandler> = {
  'server.status': async (server) => ({
    pid: process.pid,
    uptimeSec: Math.floor(process.uptime()),
    dispatchers: await server.summarize(),
  }),

  'dispatcher.add': (server, params) => {
    void server;
    void params;
    throw new AdminError(
      'UNSUPPORTED',
      'dispatcher declarations live in ~/.dreamux/config.json; edit the dispatchers array and restart dreamux serve',
    );
  },

  'dispatcher.remove': async (server, params) => {
    void server;
    void params;
    throw new AdminError(
      'UNSUPPORTED',
      'dispatcher declarations live in ~/.dreamux/config.json; edit the dispatchers array and restart dreamux serve',
    );
  },

  'dispatcher.list': async (server) => ({ dispatchers: await server.summarize() }),

  'dispatcher.status': async (server, params) => {
    const id = mustDispatcherId(params);
    const row = server.repos.dispatchers.get(id);
    if (row === null) {
      throw new AdminError('DISPATCHER_NOT_FOUND', `no dispatcher with id '${id}'`);
    }
    const runtime = await server.dispatchers.status(id);
    return {
      dispatcher_id: row.dispatcher_id,
      channel_identity: row.channel_identity,
      status: runtime.status ?? 'stopped',
      thread_id: runtime.threadId,
      last_lost_thread_id: null,
      last_error: runtime.lastError,
    };
  },

  'dispatcher.start': async (server, params) => {
    const id = mustDispatcherId(params);
    const row = server.repos.dispatchers.get(id);
    if (row === null) {
      throw new AdminError('DISPATCHER_NOT_FOUND', `no dispatcher with id '${id}'`);
    }
    const dispatcher = server.getDispatcher(id);
    await dispatcher.start();
    return {
      dispatcher_id: id,
      status: dispatcher.runtimeStatus().status,
    };
  },

  'dispatcher.stop': async (server, params) => {
    const id = mustDispatcherId(params);
    await server.getDispatcher(id).stop();
    return { dispatcher_id: id, status: 'stopped' };
  },

  'scheduler.cron.list': async (server, params) => {
    return (await cronTargetFor(server, params)).list();
  },

  'scheduler.cron.create': async (server, params) => {
    return (await cronTargetFor(server, params)).create({
      cron: mustString(params, 'cron'),
      prompt: mustNonEmptyString(params, 'prompt'),
      ...optionalStringField(params, 'title'),
      ...optionalBooleanField(params, 'recurring'),
      ...optionalStringField(params, 'tz'),
      ...optionalRecordField(params, 'action'),
      ...optionalRecordField(params, 'deliver'),
    });
  },

  'scheduler.cron.update': async (server, params) => {
    return (await cronTargetFor(server, params)).update({
      id: mustString(params, 'id'),
      ...optionalStringField(params, 'cron'),
      ...optionalStringField(params, 'prompt'),
      ...optionalNullableStringField(params, 'title'),
      ...optionalBooleanField(params, 'recurring'),
      ...optionalStringField(params, 'tz'),
      ...optionalRecordField(params, 'action'),
      ...optionalNullableRecordField(params, 'deliver'),
      ...optionalBooleanField(params, 'enabled'),
    });
  },

  'scheduler.cron.delete': async (server, params) => {
    return (await cronTargetFor(server, params)).delete(mustString(params, 'id'));
  },

  'scheduler.cron.run_now': async (server, params) => {
    return (await cronTargetFor(server, params)).runNow(mustString(params, 'id'));
  },

  'channel.invoke_tool': async (server, params) => {
    const id = mustDispatcherId(params);
    mustExistingDispatcher(server, id);
    const name = mustString(params, 'name');
    const caller = channelToolCaller(params);
    const channelId = optionalString(params, 'channel_id');
    const providerRef = optionalString(params, 'provider_ref');
    try {
      return await server.getDispatcher(id).invokeChannelTool({
        name,
        arguments: mustToolArguments(params),
        caller,
        ...(channelId !== null ? { channelId } : {}),
        ...(providerRef !== null ? { providerRef } : {}),
      });
    } catch (err) {
      if (err instanceof ChannelToolAuthorizationError) {
        throw new AdminError(err.code, err.message);
      }
      if (err instanceof AdminError) throw err;
      throw new AdminError('CHANNEL_TOOL_FAILED', parseMessage(err));
    }
  },

  'subscribe_channel.invoke_tool': async (server, params) => {
    const id = mustDispatcherId(params);
    mustExistingDispatcher(server, id);
    const providerRef = optionalString(params, 'provider_ref');
    try {
      return await server.invokeSubscribeChannelTool({
        dispatcherId: id,
        subscriptionId: mustString(params, 'subscription_id'),
        name: mustString(params, 'name'),
        arguments: mustToolArguments(params),
        ...(providerRef !== null ? { providerRef } : {}),
      });
    } catch (err) {
      if (err instanceof AdminError) throw err;
      throw new AdminError('SUBSCRIBE_CHANNEL_TOOL_FAILED', parseMessage(err));
    }
  },

  'mcp.teammate.spawn': async (server, params) => {
    const id = mustDispatcherId(params);
    mustExistingDispatcher(server, id);
    const name = mustString(params, 'name_prefix');
    const prompt = mustString(params, 'prompt');
    const intent = mustNonEmptyString(params, 'intent');
    const agentRuntime = optionalString(params, 'agent_runtime');
    const identity = optionalNonBlankString(params, 'identity');
    const dispatcher = server.getDispatcher(id);
    const target = await teammateTargetFor(dispatcher, params);
    if (target.callerKind === 'team_leader' && params?.['repo'] !== undefined) {
      throw new AdminError(
        'BAD_REQUEST',
        'Team TeamMate spawn uses the Team shared workspace; repo is only accepted for dispatcher callers',
      );
    }
    const repo = target.callerKind === 'team_leader' ? null : repoRequest(params, 'repo');
    const cwd =
      target.callerKind === 'team_leader' || repo === null
        ? null
        : repo.cwd ?? (await dispatcher.workspace());
    const worktree = target.callerKind === 'team_leader' ? null : repo?.worktree ?? null;
    const spawnInput = {
      name,
      prompt,
      intent,
      ...(cwd !== null ? { cwd } : {}),
      ...(agentRuntime !== null ? { agentRuntime } : {}),
      ...(identity !== null ? { identity } : {}),
      ...(worktree !== null ? { worktree } : {}),
    };
    try {
      // The team_leader path keeps the real `spawnTeamMate` method (it injects
      // the team shared workspace); the dispatcher path drives the collection
      // directly (issue #233).
      return await (target.callerKind === 'team_leader'
        ? target.service.spawnTeamMate(spawnInput)
        : target.service.teammates.spawn(spawnInput));
    } catch (err) {
      throw new AdminError('TEAMMATE_SPAWN_FAILED', parseMessage(err));
    }
  },

  'mcp.teammate.send': async (server, params) => {
    const id = mustDispatcherId(params);
    mustExistingDispatcher(server, id);
    const target = await teammateTargetFor(server.getDispatcher(id), params);
    const name = mustString(params, 'name');
    const prompt = mustString(params, 'prompt');
    const intent = optionalString(params, 'intent');
    try {
      return await target.service.teammates.send({
        name,
        prompt,
        ...(intent !== null ? { intent } : {}),
      });
    } catch (err) {
      throw new AdminError('TEAMMATE_SEND_FAILED', parseMessage(err));
    }
  },

  'mcp.teammate.close': async (server, params) => {
    const id = mustDispatcherId(params);
    mustExistingDispatcher(server, id);
    const target = await teammateTargetFor(server.getDispatcher(id), params);
    const name = mustString(params, 'name');
    const note = mustNonEmptyString(params, 'note');
    try {
      return await target.service.teammates.close({
        name,
        note,
      });
    } catch (err) {
      throw new AdminError('TEAMMATE_CLOSE_FAILED', parseMessage(err));
    }
  },

  'mcp.teammate.history': async (server, params) => {
    const id = mustDispatcherId(params);
    mustExistingDispatcher(server, id);
    return (
      await teammateTargetFor(server.getDispatcher(id), params)
    ).service.teammates.history(historyQuery(params));
  },

  'mcp.teammate.list': async (server, params) => {
    const id = mustDispatcherId(params);
    mustExistingDispatcher(server, id);
    return {
      teammates: await (
        await teammateTargetFor(server.getDispatcher(id), params)
      ).service.teammates.list(),
    };
  },

  'mcp.teammate.status': async (server, params) => {
    const id = mustDispatcherId(params);
    mustExistingDispatcher(server, id);
    const name = mustString(params, 'name');
    return {
      teammate: await (
        await teammateTargetFor(server.getDispatcher(id), params)
      ).service.teammates.status(name),
    };
  },

  'mcp.teammate.last': async (server, params) => {
    const id = mustDispatcherId(params);
    mustExistingDispatcher(server, id);
    const name = mustString(params, 'name');
    const turns = optionalInteger(params, 'turns');
    return (
      await teammateTargetFor(server.getDispatcher(id), params)
    ).service.teammates.last(name, turns ?? undefined);
  },

  'mcp.teammate.capabilities': async (server, params) => {
    const id = mustDispatcherId(params);
    mustExistingDispatcher(server, id);
    return (
      await teammateTargetFor(server.getDispatcher(id), params)
    ).service.teammates.getCapabilities();
  },

  'mcp.team.create': async (server, params) => {
    const id = mustDispatcherId(params);
    mustExistingDispatcher(server, id);
    const name = mustString(params, 'team_name');
    const leaderAgentRuntime = mustString(params, 'leader_agent_runtime');
    const intent = mustNonEmptyString(params, 'intent');
    const repo = repoRequest(params, 'repo');
    const dispatcher = server.getDispatcher(id);
    const repoCwd =
      repo === null
        ? null
        : repo.cwd ?? (await dispatcher.workspace());
    const worktree = repo?.worktree ?? null;
    const prompt = optionalString(params, 'prompt');
    const identity = optionalNonBlankString(params, 'identity');
    try {
      const created = await dispatcher.createTeam({
        name,
        ...(repoCwd !== null ? { repoCwd } : {}),
        leaderAgentRuntime,
        intent,
        ...(worktree !== null ? { worktree } : {}),
        ...(prompt !== null ? { prompt } : {}),
        ...(identity !== null ? { identity } : {}),
      });
      return { ...created, bound_target: null };
    } catch (err) {
      throw new AdminError('TEAM_CREATE_FAILED', parseMessage(err));
    }
  },

  'mcp.team.send': async (server, params) => {
    const id = mustDispatcherId(params);
    mustExistingDispatcher(server, id);
    if (teamCallerKind(params) === 'team_leader') {
      throw new AdminError(
        'BAD_REQUEST',
        'mcp.team.send is not available for this Team MCP caller',
      );
    }
    const name = mustString(params, 'team_name');
    const prompt = mustNonEmptyString(params, 'prompt');
    const intent = optionalString(params, 'intent');
    try {
      return await server.getDispatcher(id).sendTeamLeader({
        teamId: name,
        prompt,
        ...(intent !== null ? { intent } : {}),
      });
    } catch (err) {
      if (err instanceof TeamUnavailableError) {
        throw new AdminError('TEAM_NOT_FOUND', err.message);
      }
      throw new AdminError('TEAM_SEND_FAILED', parseMessage(err));
    }
  },

  'mcp.team.list': async (server, params) => {
    const id = mustDispatcherId(params);
    mustExistingDispatcher(server, id);
    const dispatcher = server.getDispatcher(id);
    const teams = await dispatcher.listTeams();
    return {
      teams: await Promise.all(
        teams.map(async (team) => ({
          ...team,
          bound_target: await dispatcher.activeTeamBindingSummary(ownerForTeamRead(team)),
        })),
      ),
    };
  },

  'mcp.team.status': async (server, params) => {
    const id = mustDispatcherId(params);
    mustExistingDispatcher(server, id);
    const name = mustString(params, 'team_name');
    const dispatcher = server.getDispatcher(id);
    const summary = await dispatcher.getTeamStatus(name);
    return {
      ...summary,
      bound_target: await dispatcher.activeTeamBindingSummary(
        ownerForTeamRead(summary.team),
      ),
    };
  },

  'mcp.team.history': async (server, params) => {
    const id = mustDispatcherId(params);
    mustExistingDispatcher(server, id);
    const name = optionalString(params, 'team_name');
    const status = optionalTeamStatus(params, 'status');
    const repo = optionalString(params, 'repo');
    const grep = optionalString(params, 'grep');
    const since = optionalInteger(params, 'since');
    const until = optionalInteger(params, 'until');
    const limit = optionalInteger(params, 'limit');
    const cursor = optionalString(params, 'cursor');
    const dispatcher = server.getDispatcher(id);
    const history = await dispatcher.getTeamHistory({
      ...(name !== null ? { name } : {}),
      ...(status !== null ? { status } : {}),
      ...(repo !== null ? { repo } : {}),
      ...(grep !== null ? { grep } : {}),
      ...(since !== null ? { since } : {}),
      ...(until !== null ? { until } : {}),
      ...(limit !== null ? { limit } : {}),
      ...(cursor !== null ? { cursor } : {}),
    });
    return {
      ...history,
      items: await Promise.all(
        history.items.map(async (team) => ({
          ...team,
          bound_target: await dispatcher.activeTeamBindingSummary(ownerForTeamRead(team)),
        })),
      ),
    };
  },
  'mcp.team.bind_channel': async (server, params) => {
    const id = mustDispatcherId(params);
    mustExistingDispatcher(server, id);
    const channelId = optionalString(params, 'channel_id');
    return server.getDispatcher(id).bindTeamChannel({
      teamId: mustString(params, 'team_name'),
      ...(channelId !== null ? { channelId } : {}),
      meta: mustRecord(params, 'meta'),
    });
  },

  'mcp.team.transfer_back': async (server, params) => {
    const id = mustDispatcherId(params);
    mustExistingDispatcher(server, id);
    const channelId = optionalString(params, 'channel_id');
    const callerKind = teamCallerKind(params);
    const expectedOwner =
      callerKind === 'team_leader'
        ? {
            kind: 'team' as const,
            teamName: mustString(params, 'team_id'),
            leaderName: mustString(params, 'leader_name'),
          }
        : undefined;
    const binding = await server.getDispatcher(id).transferTeamChannelBack({
      ...(expectedOwner !== undefined ? { expectedOwner } : {}),
      ...(channelId !== null ? { channelId } : {}),
      meta: mustRecord(params, 'meta'),
    });
    return {
      transferred: binding !== null,
      binding,
      message:
        binding === null
          ? 'No active Team channel binding matched the resolved target.'
          : 'Channel target released from Team routing.',
    };
  },

  'mcp.team.dissolve': async (server, params) => {
    const id = mustDispatcherId(params);
    mustExistingDispatcher(server, id);
    const name = mustString(params, 'team_name');
    const note = mustNonEmptyString(params, 'note');
    const dissolved = await server.getDispatcher(id).dissolveTeam({
      teamId: name,
      note,
    });
    return { ...dissolved, bound_target: null };
  },
};

async function cronTargetFor(
  server: Server,
  params: Record<string, unknown> | undefined,
): Promise<SchedulerService> {
  const id = mustDispatcherId(params);
  mustExistingDispatcher(server, id);
  const teamId = optionalString(params, 'team_id');
  const dispatcher = server.getDispatcher(id);
  if (teamId === null) return dispatcher.scheduler;
  try {
    return await dispatcher.teamScheduler(teamId);
  } catch (err) {
    if (err instanceof TeamUnavailableError) {
      throw new AdminError('TEAM_NOT_FOUND', err.message);
    }
    throw err;
  }
}

function mustToolArguments(
  params: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const value = params?.['arguments'];
  if (value === undefined || value === null) return {};
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new AdminError('BAD_REQUEST', "param 'arguments' must be an object");
  }
  return value as Record<string, unknown>;
}

function channelToolCaller(
  params: Record<string, unknown> | undefined,
): ChannelToolCaller {
  const kind = optionalString(params, 'caller_kind') ?? 'dispatcher';
  if (kind === 'dispatcher') return { kind };
  if (kind === 'team_leader') {
    const teamId = mustString(params, 'team_id');
    const leaderName = mustString(params, 'leader_name');
    return { kind, teamId, leaderName };
  }
  throw new AdminError(
    'BAD_REQUEST',
    "param 'caller_kind' must be dispatcher or team_leader",
  );
}

function teamCallerKind(
  params: Record<string, unknown> | undefined,
): 'dispatcher' | 'team_leader' {
  // Omitted caller_kind preserves the existing dispatcher-scoped admin contract.
  const kind = optionalString(params, 'caller_kind') ?? 'dispatcher';
  if (kind === 'dispatcher' || kind === 'team_leader') return kind;
  throw new AdminError(
    'BAD_REQUEST',
    "param 'caller_kind' must be dispatcher or team_leader",
  );
}

function ownerForTeamRead(input: {
  team_name: string;
  leader_name: string;
}): ChannelRouteOwner {
  return {
    kind: 'team',
    teamName: input.team_name,
    leaderName: input.leader_name,
  };
}

async function teammateTargetFor(
  dispatcher: DispatcherService,
  params: Record<string, unknown> | undefined,
): Promise<
  | { callerKind: 'dispatcher'; service: DispatcherService }
  | { callerKind: 'team_leader'; service: TeamService }
> {
  const callerKind = optionalString(params, 'caller_kind') ?? 'dispatcher';
  if (callerKind === 'dispatcher') {
    return { callerKind, service: dispatcher };
  }
  if (callerKind === 'team_leader') {
    return {
      callerKind,
      service: await dispatcher.team(mustString(params, 'team_id')),
    };
  }
  throw new AdminError(
    'BAD_REQUEST',
    "param 'caller_kind' must be dispatcher or team_leader",
  );
}
