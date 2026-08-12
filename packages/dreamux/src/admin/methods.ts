
import type { Server } from '../server.js';
import type { ChannelToolCaller } from '../service/dispatcher-service/index.js';
import { ChannelToolAuthorizationError } from '../service/channel-service/errors.js';
import type { SchedulerCommands } from '../service/scheduler/types.js';
import { parseWorkflowMaxConcurrency } from '../service/workflow-service/limits.js';
import { WorkflowStopInterruptedError } from '../service/workflow-service/run-terminal.js';
import {
  TeamDissolveBlockedError,
  TeamDissolveFailedError,
  TeamUnavailableError,
} from '../service/team-collection/errors.js';
import { AdminError } from './protocol.js';
import { teammateTargetFor } from './teammate-target.js';
import {
  TEAM_LEADER_REQUIRED_SKILL_SOURCES,
  mustTeamIdParam,
  mustTeamMateNameParam,
  teamBindingFields,
  teamCallerKind,
} from './team-method-params.js';
import {
  historyQuery,
  mustDispatcherId,
  mustExistingDispatcher,
  mustNonBlankString,
  mustNonEmptyString,
  mustRecord,
  mustString,
  optionalBooleanField,
  optionalInteger,
  optionalNonBlankString,
  optionalNullableRecordField,
  optionalNullableStringField,
  optionalRecordField,
  optionalSkillSources,
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
      if (err instanceof TeamUnavailableError) {
        throw new AdminError('TEAM_NOT_FOUND', err.message);
      }
      if (err instanceof AdminError) throw err;
      throw new AdminError('CHANNEL_TOOL_FAILED', parseMessage(err));
    }
  },

  'teammate.spawn': async (server, params) => {
    const target = await teammateTargetFor(server, params);
    const name = mustString(params, 'name_prefix');
    const prompt = mustString(params, 'prompt');
    const intent = mustNonEmptyString(params, 'intent');
    const agentRuntime = optionalString(params, 'agent_runtime');
    const identity = optionalNonBlankString(params, 'identity');
    const skillSources = await optionalSkillSources(params);
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
        : repo.cwd ?? (await target.dispatcher.workspace());
    const worktree = target.callerKind === 'team_leader' ? null : repo?.worktree ?? null;
    const spawnInput = {
      name,
      prompt,
      intent,
      ...(cwd !== null ? { cwd } : {}),
      ...(agentRuntime !== null ? { agentRuntime } : {}),
      ...(identity !== null ? { identity } : {}),
      ...(skillSources !== null ? { skillSources } : {}),
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

  'teammate.send': async (server, params) => {
    const target = await teammateTargetFor(server, params);
    const name = mustString(params, 'name');
    const prompt = mustString(params, 'prompt');
    const intent = optionalString(params, 'intent');
    try {
      const send = () => target.service.teammates.send({
        name,
        prompt,
        ...(intent !== null ? { intent } : {}),
      });
      return await send();
    } catch (err) {
      throw new AdminError('TEAMMATE_SEND_FAILED', parseMessage(err));
    }
  },

  'teammate.close': async (server, params) => {
    const target = await teammateTargetFor(server, params);
    const name = mustString(params, 'name');
    const note = mustNonEmptyString(params, 'note');
    try {
      const close = () => target.service.teammates.close({
        name,
        note,
      });
      return await close();
    } catch (err) {
      throw new AdminError('TEAMMATE_CLOSE_FAILED', parseMessage(err));
    }
  },

  'teammate.history': async (server, params) => {
    return (
      await teammateTargetFor(server, params)
    ).service.teammates.history(historyQuery(params));
  },

  'teammate.list': async (server, params) => {
    return {
      teammates: await (
        await teammateTargetFor(server, params)
      ).service.teammates.list(),
    };
  },

  'teammate.status': async (server, params) => {
    const target = await teammateTargetFor(server, params);
    const name = mustString(params, 'name');
    return {
      teammate: await target.service.teammates.status(name),
    };
  },

  'teammate.last': async (server, params) => {
    const target = await teammateTargetFor(server, params);
    const name = mustString(params, 'name');
    const turns = optionalInteger(params, 'turns');
    return target.service.teammates.last(name, turns ?? undefined);
  },

  'teammate.capabilities': async (server, params) => (
    await teammateTargetFor(server, params)
  ).service.teammates.getCapabilities(),

  'workflow.run': async (server, params) => {
    const rawMaxConcurrency = params?.['max_concurrency'];
    let maxConcurrency: number;
    try {
      maxConcurrency = parseWorkflowMaxConcurrency(rawMaxConcurrency);
    } catch (error) {
      throw new AdminError('BAD_REQUEST', parseMessage(error));
    }
    const script = optionalNonBlankString(params, 'script');
    const scriptPath = optionalNonBlankString(params, 'scriptPath');
    if (script === null && scriptPath === null) {
      throw new AdminError('BAD_REQUEST', 'workflow.run requires either script or scriptPath');
    }
    return (await teammateTargetFor(server, params)).service.workflows.run({
      ...(script !== null ? { script } : {}),
      ...(scriptPath !== null ? { scriptPath } : {}),
      ...(params !== undefined && Object.hasOwn(params, 'args')
        ? { args: params['args'] }
        : {}),
      ...(rawMaxConcurrency !== undefined && rawMaxConcurrency !== null
        ? { max_concurrency: maxConcurrency }
        : {}),
    });
  },
  'workflow.status': async (server, params) =>
    (await teammateTargetFor(server, params)).service.workflows.status(
      { run_id: mustNonEmptyString(params, 'run_id') },
    ),
  'workflow.stop': async (server, params) => {
    const target = await teammateTargetFor(server, params);
    try {
      return await target.service.workflows.stop({
        run_id: mustNonEmptyString(params, 'run_id'),
      });
    } catch (error) {
      if (error instanceof WorkflowStopInterruptedError) {
        throw new AdminError('SERVER_SHUTTING_DOWN', error.message);
      }
      throw error;
    }
  },
  'workflow.list': async (server, params) =>
    (await teammateTargetFor(server, params)).service.workflows.list(),
  'team.create': async (server, params) => {
    const id = mustDispatcherId(params);
    mustExistingDispatcher(server, id);
    const namePrefix = mustString(params, 'name_prefix');
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
    const skillSources = await optionalSkillSources(params, {
      requiredSources: TEAM_LEADER_REQUIRED_SKILL_SOURCES,
    });
    try {
      const created = await dispatcher.createTeam({
        namePrefix,
        ...(repoCwd !== null ? { repoCwd } : {}),
        leaderAgentRuntime,
        intent,
        ...(worktree !== null ? { worktree } : {}),
        ...(prompt !== null ? { prompt } : {}),
        ...(identity !== null ? { identity } : {}),
        ...(skillSources !== null ? { skillSources } : {}),
      });
      return { ...created, bound_target: null, bound_targets: [] };
    } catch (err) {
      throw new AdminError('TEAM_CREATE_FAILED', parseMessage(err));
    }
  },

  'team.send': async (server, params) => {
    const id = mustDispatcherId(params);
    mustExistingDispatcher(server, id);
    if (teamCallerKind(params) === 'team_leader') {
      throw new AdminError(
        'BAD_REQUEST',
        'team.send is available only to dispatcher callers',
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
      if (err instanceof AdminError) throw err;
      if (err instanceof TeamUnavailableError) {
        throw new AdminError('TEAM_NOT_FOUND', err.message);
      }
      throw new AdminError('TEAM_SEND_FAILED', parseMessage(err));
    }
  },

  'team.list': async (server, params) => {
    const id = mustDispatcherId(params);
    mustExistingDispatcher(server, id);
    const dispatcher = server.getDispatcher(id);
    const teams = await dispatcher.listTeams();
    return {
      teams: await Promise.all(
        teams.map(async (team) => ({
          ...team,
          ...(await teamBindingFields(dispatcher, team)),
        })),
      ),
    };
  },

  'team.status': async (server, params) => {
    const id = mustDispatcherId(params);
    mustExistingDispatcher(server, id);
    const name = mustString(params, 'team_name');
    const dispatcher = server.getDispatcher(id);
    const summary = await dispatcher.getTeamStatus(name);
    return {
      ...summary,
      ...(await teamBindingFields(dispatcher, summary.team)),
    };
  },

  'team.history': async (server, params) => {
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
          ...(await teamBindingFields(dispatcher, team)),
        })),
      ),
    };
  },
  'team.bind_channel': async (server, params) => {
    const id = mustDispatcherId(params);
    mustExistingDispatcher(server, id);
    const channelId = optionalString(params, 'channel_id');
    const callerKind = teamCallerKind(params);
    if (callerKind === 'dispatcher') {
      return server.getDispatcher(id).bindTeamChannel({
        teamId: mustString(params, 'team_name'),
        ...(channelId !== null ? { channelId } : {}),
        meta: mustRecord(params, 'meta'),
      });
    }
    if (params !== undefined && Object.hasOwn(params, 'team_name')) {
      throw new AdminError(
        'BAD_REQUEST',
        "param 'team_name' is not accepted for a team_leader caller",
      );
    }
    const lease = {
      teamId: mustString(params, 'team_id'),
      leaderName: mustString(params, 'leader_name'),
    };
    const meta = mustRecord(params, 'meta');
    try {
      return await server.getDispatcher(id).bindTeamLeaderChannel({
        lease,
        ...(channelId !== null ? { channelId } : {}),
        meta,
      });
    } catch (err) {
      if (err instanceof TeamUnavailableError) {
        throw new AdminError('TEAM_NOT_FOUND', err.message);
      }
      throw new AdminError('TEAM_BIND_FAILED', parseMessage(err));
    }
  },

  'team.transfer_back': async (server, params) => {
    const id = mustDispatcherId(params);
    mustExistingDispatcher(server, id);
    const channelId = optionalString(params, 'channel_id');
    const callerKind = teamCallerKind(params);
    if (callerKind === 'team_leader' && Object.hasOwn(params ?? {}, 'team_name')) {
      throw new AdminError(
        'BAD_REQUEST',
        "param 'team_name' is not accepted for a team_leader caller",
      );
    }
    const dispatcher = server.getDispatcher(id);
    let binding;
    try {
      binding = callerKind === 'team_leader'
        ? await dispatcher.transferTeamLeaderChannelBack({
            lease: {
              teamId: mustTeamIdParam(params, 'team_id'),
              leaderName: mustTeamMateNameParam(params, 'leader_name'),
            },
            ...(channelId !== null ? { channelId } : {}),
            meta: mustRecord(params, 'meta'),
          })
        : await dispatcher.transferTeamChannelBack({
            ...(channelId !== null ? { channelId } : {}),
            meta: mustRecord(params, 'meta'),
          });
    } catch (err) {
      if (err instanceof TeamUnavailableError) {
        throw new AdminError('TEAM_NOT_FOUND', err.message);
      }
      throw err;
    }
    return {
      transferred: binding !== null,
      binding,
      message:
        binding === null
          ? 'No active Team channel binding matched the resolved target.'
          : 'Channel target released from Team routing.',
    };
  },

  'team.dissolve': async (server, params) => {
    const id = mustDispatcherId(params);
    mustExistingDispatcher(server, id);
    const callerKind = teamCallerKind(params);
    const note = mustNonBlankString(params, 'note');
    if (callerKind === 'team_leader' && Object.hasOwn(params ?? {}, 'team_name')) {
      throw new AdminError(
        'BAD_REQUEST',
        "param 'team_name' is not accepted for a team_leader caller",
      );
    }
    const leaderLease = callerKind === 'team_leader'
      ? {
          teamId: mustTeamIdParam(params, 'team_id'),
          leaderName: mustTeamMateNameParam(params, 'leader_name'),
        }
      : null;
    const dispatcherTeamId = callerKind === 'dispatcher'
      ? mustTeamIdParam(params, 'team_name')
      : null;
    try {
      const dispatcher = server.getDispatcher(id);
      const dissolved = callerKind === 'team_leader'
        ? await dispatcher.dissolveTeamForLeader({
            lease: leaderLease!,
            note,
          })
        : await dispatcher.dissolveTeam({
            teamId: dispatcherTeamId!,
            note,
          });
      return { ...dissolved, bound_target: null, bound_targets: [] };
    } catch (err) {
      if (err instanceof TeamUnavailableError) {
        throw new AdminError('TEAM_NOT_FOUND', err.message);
      }
      if (err instanceof TeamDissolveBlockedError) {
        throw new AdminError('TEAM_DISSOLVE_BLOCKED', err.reason);
      }
      if (err instanceof TeamDissolveFailedError) {
        throw new AdminError('TEAM_DISSOLVE_FAILED', err.message);
      }
      throw new AdminError('TEAM_DISSOLVE_FAILED', parseMessage(err));
    }
  },

  'collaboration_space.bind': async (server, params) => {
    const id = mustDispatcherId(params);
    mustExistingDispatcher(server, id);
    const channelId = optionalString(params, 'channel_id');
    const identity = optionalNonBlankString(params, 'identity');
    const display = optionalString(params, 'display');
    const rawRepo = params?.['repo'];
    const repo = rawRepo === undefined || rawRepo === null
      ? null
      : mustRecord(params, 'repo');
    const baseRef = repo === null ? null : optionalString(repo, 'base_ref');
    const container = optionalCollaborationContainer(params);
    try {
      return await server.getDispatcher(id).bindCollaborationSpace({
        spaceName: mustString(params, 'space_name'),
        ...(channelId !== null ? { channelId } : {}),
        ...(container !== null ? { container } : {}),
        ...(display !== null ? { display } : {}),
        ...(repo !== null
          ? {
              repo: {
                cwd: mustNonEmptyString(repo, 'cwd'),
                ...(baseRef !== null ? { baseRef } : {}),
              },
            }
          : {}),
        leaderAgentRuntime: mustString(params, 'leader_agent_runtime'),
        ...(identity !== null ? { identity } : {}),
      });
    } catch (err) {
      throw new AdminError('COLLABORATION_SPACE_BIND_FAILED', parseMessage(err));
    }
  },

  'collaboration_space.dissolve': async (server, params) => {
    const id = mustDispatcherId(params);
    mustExistingDispatcher(server, id);
    try {
      return await server.getDispatcher(id).dissolveCollaborationSpace({
        spaceName: mustString(params, 'space_name'),
        note: mustNonEmptyString(params, 'note'),
      });
    } catch (err) {
      throw new AdminError('COLLABORATION_SPACE_DISSOLVE_FAILED', parseMessage(err));
    }
  },

  'collaboration_space.status': async (server, params) => {
    const id = mustDispatcherId(params);
    mustExistingDispatcher(server, id);
    try {
      return await server.getDispatcher(id).getCollaborationSpaceStatus({
        spaceName: mustString(params, 'space_name'),
      });
    } catch (err) {
      throw new AdminError('COLLABORATION_SPACE_STATUS_FAILED', parseMessage(err));
    }
  },

  'collaboration_space.list': async (server, params) => {
    const id = mustDispatcherId(params);
    mustExistingDispatcher(server, id);
    try {
      return await server.getDispatcher(id).listCollaborationSpaces();
    } catch (err) {
      throw new AdminError('COLLABORATION_SPACE_LIST_FAILED', parseMessage(err));
    }
  },
};

async function cronTargetFor(
  server: Server,
  params: Record<string, unknown> | undefined,
): Promise<SchedulerCommands> {
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

function optionalCollaborationContainer(
  params: Record<string, unknown> | undefined,
): import('@excitedjs/dreamux-types').ChannelContainer | null {
  if (params === undefined || params['container'] === undefined || params['container'] === null) {
    return null;
  }
  const container = mustRecord(params, 'container');
  const display = optionalString(container, 'display');
  const canonicalUrl = optionalString(container, 'canonical_url');
  const meta = container['meta'];
  if (meta !== undefined && (meta === null || typeof meta !== 'object' || Array.isArray(meta))) {
    throw new AdminError('BAD_REQUEST', "param 'container.meta' must be an object");
  }
  return {
    container_type: mustNonEmptyString(container, 'container_type'),
    container_key: mustNonEmptyString(container, 'container_key'),
    ...(display !== null ? { display } : {}),
    ...(canonicalUrl !== null ? { canonical_url: canonicalUrl } : {}),
    ...(meta !== undefined ? { meta: meta as Record<string, unknown> } : {}),
  };
}
