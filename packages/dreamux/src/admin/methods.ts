
import type { Server } from '../server.js';
import type {
  ChannelToolCaller,
  DispatcherService,
} from '../dispatcher-service/dispatcher-instance.js';
import type { TeamService } from '../dispatcher-service/team/service.js';
import { AdminError } from './protocol.js';
import { validateDispatcherId } from '../state/dispatcher-id.js';
import { ChannelToolAuthorizationError } from '../dispatcher-service/errors.js';
import {
  type TeamMateHistoryQuery,
  type TeamMateIdentityStatus,
  type TeamMateWorktreeRequest,
} from '../dispatcher-service/teammate/types.js';

export type AdminHandler = (
  server: Server,
  params: Record<string, unknown> | undefined,
) => Promise<unknown> | unknown;

export const adminMethods: Record<string, AdminHandler> = {
  'server.status': (server) => ({
    pid: process.pid,
    uptimeSec: Math.floor(process.uptime()),
    dispatchers: server.summarize(),
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

  'dispatcher.list': (server) => ({ dispatchers: server.summarize() }),

  'dispatcher.status': (server, params) => {
    const id = mustDispatcherId(params);
    const row = server.repos.dispatchers.get(id);
    if (row === null) {
      throw new AdminError('DISPATCHER_NOT_FOUND', `no dispatcher with id '${id}'`);
    }
    const runtime = server.getDispatcher(id).runtimeStatus();
    return {
      dispatcher_id: row.dispatcher_id,
      channel_identity: row.channel_identity,
      status: runtime.status ?? row.status,
      thread_id: runtime.threadId ?? row.thread_id,
      last_lost_thread_id: row.last_lost_thread_id,
      last_error: row.last_error,
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

  'mcp.teammate.spawn': async (server, params) => {
    const id = mustDispatcherId(params);
    mustExistingDispatcher(server, id);
    const name = mustString(params, 'name_prefix');
    const prompt = mustString(params, 'prompt');
    const intent = mustNonEmptyString(params, 'intent');
    const agentRuntime = optionalString(params, 'agent_runtime');
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
    try {
      return await target.service.spawnTeamMate({
        name,
        prompt,
        intent,
        ...(cwd !== null ? { cwd } : {}),
        ...(agentRuntime !== null ? { agentRuntime } : {}),
        ...(worktree !== null ? { worktree } : {}),
      });
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
      return await target.service.sendTeamMate({
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
      return await target.service.closeTeamMate({
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
    ).service.getTeamMateHistory(historyQuery(params));
  },

  'mcp.teammate.list': async (server, params) => {
    const id = mustDispatcherId(params);
    mustExistingDispatcher(server, id);
    return {
      teammates: await (
        await teammateTargetFor(server.getDispatcher(id), params)
      ).service.listTeamMates(),
    };
  },

  'mcp.teammate.status': async (server, params) => {
    const id = mustDispatcherId(params);
    mustExistingDispatcher(server, id);
    const name = mustString(params, 'name');
    return {
      teammate: await (
        await teammateTargetFor(server.getDispatcher(id), params)
      ).service.getTeamMateStatus(name),
    };
  },

  'mcp.teammate.last': async (server, params) => {
    const id = mustDispatcherId(params);
    mustExistingDispatcher(server, id);
    const name = mustString(params, 'name');
    const turns = optionalInteger(params, 'turns');
    return (
      await teammateTargetFor(server.getDispatcher(id), params)
    ).service.getTeamMateLast(name, turns ?? undefined);
  },

  'mcp.teammate.capabilities': async (server, params) => {
    const id = mustDispatcherId(params);
    mustExistingDispatcher(server, id);
    return (
      await teammateTargetFor(server.getDispatcher(id), params)
    ).service.getTeamMateCapabilities();
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
    try {
      return await dispatcher.createTeam({
        name,
        ...(repoCwd !== null ? { repoCwd } : {}),
        leaderAgentRuntime,
        intent,
        ...(worktree !== null ? { worktree } : {}),
        ...(prompt !== null ? { prompt } : {}),
      });
    } catch (err) {
      throw new AdminError('TEAM_CREATE_FAILED', parseMessage(err));
    }
  },

  'mcp.team.list': async (server, params) => {
    const id = mustDispatcherId(params);
    mustExistingDispatcher(server, id);
    return { teams: await server.getDispatcher(id).listTeams() };
  },

  'mcp.team.status': async (server, params) => {
    const id = mustDispatcherId(params);
    mustExistingDispatcher(server, id);
    const name = mustString(params, 'team_name');
    return server.getDispatcher(id).getTeamStatus(name);
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
    return server.getDispatcher(id).getTeamHistory({
      ...(name !== null ? { name } : {}),
      ...(status !== null ? { status } : {}),
      ...(repo !== null ? { repo } : {}),
      ...(grep !== null ? { grep } : {}),
      ...(since !== null ? { since } : {}),
      ...(until !== null ? { until } : {}),
      ...(limit !== null ? { limit } : {}),
      ...(cursor !== null ? { cursor } : {}),
    });
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
    return server.getDispatcher(id).transferTeamChannelBack({
      ...(channelId !== null ? { channelId } : {}),
      meta: mustRecord(params, 'meta'),
    });
  },

  'mcp.team.dissolve': async (server, params) => {
    const id = mustDispatcherId(params);
    mustExistingDispatcher(server, id);
    const name = mustString(params, 'team_name');
    const note = mustNonEmptyString(params, 'note');
    return server.getDispatcher(id).dissolveTeam({
      teamId: name,
      note,
    });
  },
};

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

function mustString(
  params: Record<string, unknown> | undefined,
  key: string,
): string {
  if (params === undefined || typeof params[key] !== 'string') {
    throw new AdminError('BAD_REQUEST', `missing or non-string param '${key}'`);
  }
  return params[key] as string;
}

function mustNonEmptyString(
  params: Record<string, unknown> | undefined,
  key: string,
): string {
  const value = mustString(params, key);
  if (value === '') {
    throw new AdminError('BAD_REQUEST', `param '${key}' must be a non-empty string`);
  }
  return value;
}

function mustRecord(
  params: Record<string, unknown> | undefined,
  key: string,
): Record<string, unknown> {
  const value = params?.[key];
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new AdminError('BAD_REQUEST', `param '${key}' must be an object`);
  }
  return value as Record<string, unknown>;
}

function mustDispatcherId(
  params: Record<string, unknown> | undefined,
): string {
  const id = mustString(params, 'dispatcher_id');
  try {
    return validateDispatcherId(id);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new AdminError('BAD_REQUEST', message);
  }
}

function optionalString(
  params: Record<string, unknown> | undefined,
  key: string,
): string | null {
  if (params === undefined) return null;
  const v = params[key];
  if (v === undefined || v === null) return null;
  if (typeof v !== 'string') {
    throw new AdminError('BAD_REQUEST', `param '${key}' must be a string`);
  }
  return v;
}

function repoRequest(
  params: Record<string, unknown> | undefined,
  key: string,
): { cwd: string | null; worktree: TeamMateWorktreeRequest | null } | null {
  if (params === undefined) return null;
  const value = params[key];
  if (value === undefined || value === null) return null;
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new AdminError('BAD_REQUEST', `param '${key}' must be an object`);
  }
  const obj = value as Record<string, unknown>;
  const mode = mustString(obj, 'mode');
  if (mode !== 'reuse-cwd' && mode !== 'managed') {
    throw new AdminError(
      'BAD_REQUEST',
      `param '${key}.mode' must be 'reuse-cwd' or 'managed'`,
    );
  }
  const cwd = optionalString(obj, 'path');
  if (mode === 'reuse-cwd') {
    return { cwd, worktree: { mode: 'reuse-cwd' } };
  }
  const cleanup = optionalString(obj, 'cleanup');
  if (cleanup !== null && cleanup !== 'keep' && cleanup !== 'delete-on-close') {
    throw new AdminError(
      'BAD_REQUEST',
      `param '${key}.cleanup' must be 'keep' or 'delete-on-close'`,
    );
  }
  return {
    cwd,
    worktree: {
      mode,
      ...optionalStringProp(obj, 'slug'),
      ...optionalStringProp(obj, 'base_ref'),
      ...optionalStringProp(obj, 'branch'),
      ...(cleanup !== null ? { cleanup } : {}),
    },
  };
}

function historyQuery(
  params: Record<string, unknown> | undefined,
): Omit<TeamMateHistoryQuery, 'dispatcherId'> {
  const name = optionalString(params, 'name');
  const status = optionalTeammateStatus(params, 'status');
  const agentRuntime = optionalString(params, 'agent_runtime');
  const repo = optionalString(params, 'repo');
  const grep = optionalString(params, 'grep');
  const since = optionalInteger(params, 'since');
  const until = optionalInteger(params, 'until');
  const cursor = optionalString(params, 'cursor');
  const limit = optionalInteger(params, 'limit');
  return {
    ...(name !== null ? { name } : {}),
    ...(status !== null ? { status } : {}),
    ...(agentRuntime !== null ? { agentRuntime } : {}),
    ...(repo !== null ? { repo } : {}),
    ...(grep !== null ? { grep } : {}),
    ...(since !== null ? { since } : {}),
    ...(until !== null ? { until } : {}),
    ...(cursor !== null ? { cursor } : {}),
    ...(limit !== null ? { limit } : {}),
  };
}

function optionalTeammateStatus(
  params: Record<string, unknown> | undefined,
  key: string,
): TeamMateIdentityStatus | null {
  const value = optionalString(params, key);
  if (value === null) return null;
  if (
    value === 'starting' ||
    value === 'running' ||
    value === 'degraded' ||
    value === 'closed' ||
    value === 'stopped'
  ) {
    return value;
  }
  throw new AdminError(
    'BAD_REQUEST',
    `param '${key}' must be starting, running, degraded, closed, or stopped`,
  );
}

function optionalTeamStatus(
  params: Record<string, unknown> | undefined,
  key: string,
): 'starting' | 'running' | 'closed' | null {
  const value = optionalString(params, key);
  if (value === null) return null;
  if (value === 'starting' || value === 'running' || value === 'closed') return value;
  throw new AdminError(
    'BAD_REQUEST',
    `param '${key}' must be starting, running, or closed`,
  );
}

function optionalInteger(
  params: Record<string, unknown> | undefined,
  key: string,
): number | null {
  if (params === undefined) return null;
  const value = params[key];
  if (value === undefined || value === null) return null;
  if (!Number.isInteger(value)) {
    throw new AdminError('BAD_REQUEST', `param '${key}' must be an integer`);
  }
  return value as number;
}

function optionalStringProp(
  params: Record<string, unknown>,
  key: string,
): Record<string, string> {
  const value = optionalString(params, key);
  return value === null ? {} : { [key]: value };
}

function mustExistingDispatcher(server: Server, id: string): void {
  const row = server.repos.dispatchers.get(id);
  if (row === null) {
    throw new AdminError('DISPATCHER_NOT_FOUND', `no dispatcher with id '${id}'`);
  }
}

function parseMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
