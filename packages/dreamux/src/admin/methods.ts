/**
 * Admin method handlers.
 *
 * Each handler takes typed params and returns the `result` payload to put on
 * the wire. Throws `AdminError` for user-actionable failures (the protocol
 * layer formats those as `error` responses).
 */

import type { Server } from '../server.js';
import { AdminError } from './protocol.js';
import { validateDispatcherId } from '../state/dispatcher-id.js';
import {
  teamLeaderPrincipal,
  type TeamMateCallerPrincipal,
  type TeamMateHistoryQuery,
  type TeamMateIdentityStatus,
  type TeamMateWorktreeRequest,
  dispatcherPrincipal,
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
    const runtime = server.dispatcherService.getRuntime(id);
    return {
      dispatcher_id: row.dispatcher_id,
      bot_app_id: row.bot_app_id,
      status: runtime?.getStatus() ?? row.status,
      thread_id: runtime?.getThreadId() ?? row.thread_id,
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
    await server.dispatcherService.startDispatcher(id);
    return {
      dispatcher_id: id,
      status: server.dispatcherService.getRuntime(id)?.getStatus(),
    };
  },

  'dispatcher.stop': async (server, params) => {
    const id = mustDispatcherId(params);
    await server.dispatcherService.stopDispatcher(id);
    return { dispatcher_id: id, status: 'stopped' };
  },

  'mcp.reply': async (server, params) => {
    const id = mustDispatcherId(params);
    mustExistingDispatcher(server, id);
    mustRunningDispatcher(server, id);
    await assertFeishuScope(server, id, params);
    try {
      return await server.dispatcherService.callFeishuMcpTool({
        dispatcherId: id,
        toolName: 'reply',
        arguments: params ?? {},
      });
    } catch (err) {
      throw new AdminError('OUTBOUND_FAILED', parseMessage(err));
    }
  },

  'mcp.react': async (server, params) => {
    const id = mustDispatcherId(params);
    mustExistingDispatcher(server, id);
    mustRunningDispatcher(server, id);
    await assertFeishuScope(server, id, params);
    try {
      return await server.dispatcherService.callFeishuMcpTool({
        dispatcherId: id,
        toolName: 'react',
        arguments: params ?? {},
      });
    } catch (err) {
      throw new AdminError('REACTION_FAILED', parseMessage(err));
    }
  },

  // Read-only: lists a chat's known + trusted peer bots (issue #69). Reads the
  // per-dispatcher chat-bots store, so it does not require a running slot — only
  // a declared dispatcher.
  'mcp.list_chat_bots': async (server, params) => {
    const id = mustDispatcherId(params);
    mustExistingDispatcher(server, id);
    await assertFeishuScope(server, id, params);
    return server.dispatcherService.callFeishuMcpTool({
      dispatcherId: id,
      toolName: 'list_chat_bots',
      arguments: params ?? {},
    });
  },

  'mcp.teammate.spawn': async (server, params) => {
    const id = mustDispatcherId(params);
    mustExistingDispatcher(server, id);
    const caller = callerPrincipal(id, params);
    const name = mustString(params, 'name');
    const prompt = mustString(params, 'prompt');
    const agentRuntime = optionalString(params, 'agent_runtime');
    const cwd = caller.kind === 'team_leader' ? optionalString(params, 'cwd') : mustString(params, 'cwd');
    if (caller.kind === 'team_leader' && params?.['owner'] !== undefined) {
      throw new AdminError('BAD_REQUEST', 'TeamMate owner and team_id are server-derived for team_leader callers');
    }
    const worktree =
      caller.kind === 'team_leader' ? null : optionalWorktreeRequest(params, 'worktree');
    const sharedWorkspace =
      caller.kind === 'team_leader'
        ? await server.dispatcherService.teams.sharedWorkspace(id, caller.teamId)
        : undefined;
    // Required recovery subject (issue #182 PR-3).
    const intent = mustNonEmptyString(params, 'intent');
    try {
      return await server.dispatcherService.teammates.spawnScoped({
        principal: caller,
        name,
        prompt,
        intent,
        ...(sharedWorkspace !== undefined ? { sharedWorkspace } : {}),
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
    const caller = callerPrincipal(id, params);
    const name = mustString(params, 'name');
    const prompt = mustString(params, 'prompt');
    // Optional: when supplied, updates the recorded recovery subject before the
    // turn (issue #182 PR-3).
    const intent = optionalString(params, 'intent');
    try {
      return await server.dispatcherService.teammates.sendScoped({
        principal: caller,
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
    const caller = callerPrincipal(id, params);
    const name = mustString(params, 'name');
    // Required close reason (issue #182 PR-3).
    const note = mustNonEmptyString(params, 'note');
    try {
      return await server.dispatcherService.teammates.closeScoped({
        principal: caller,
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
    return server.dispatcherService.getTeamMateHistory({
      dispatcherId: id,
      principal: callerPrincipal(id, params),
      ...historyQuery(params),
    });
  },

  'mcp.teammate.list': async (server, params) => {
    const id = mustDispatcherId(params);
    mustExistingDispatcher(server, id);
    return {
      teammates: await server.dispatcherService.teammates.listScoped(
        callerPrincipal(id, params),
      ),
    };
  },

  'mcp.teammate.status': async (server, params) => {
    const id = mustDispatcherId(params);
    mustExistingDispatcher(server, id);
    const name = mustString(params, 'name');
    return {
      teammate: await server.dispatcherService.teammates.statusScoped(
        callerPrincipal(id, params),
        name,
      ),
    };
  },

  'mcp.teammate.last': async (server, params) => {
    const id = mustDispatcherId(params);
    mustExistingDispatcher(server, id);
    const name = mustString(params, 'name');
    const turns = optionalInteger(params, 'turns');
    return server.dispatcherService.teammates.lastScoped(
      callerPrincipal(id, params),
      name,
      turns ?? undefined,
    );
  },

  'mcp.teammate.capabilities': (server) =>
    server.dispatcherService.getTeamMateCapabilities(),

  'mcp.team.create': async (server, params) => {
    const id = mustDispatcherId(params);
    mustExistingDispatcher(server, id);
    const name = mustString(params, 'name');
    const repoCwd = mustString(params, 'repo_cwd');
    const leaderAgentRuntime = mustString(params, 'leader_agent_runtime');
    const worktree = optionalWorktreeRequest(params, 'worktree');
    // Required recovery subject (issue #182 PR-3).
    const intent = mustNonEmptyString(params, 'intent');
    const prompt = optionalString(params, 'prompt');
    const bindGroup = optionalBindGroup(params, 'bind_group');
    try {
      return await server.dispatcherService.createTeam({
        dispatcherId: id,
        name,
        repoCwd,
        leaderAgentRuntime,
        intent,
        ...(worktree !== null ? { worktree } : {}),
        ...(prompt !== null ? { prompt } : {}),
        ...(bindGroup !== null ? { bindGroup } : {}),
      });
    } catch (err) {
      throw new AdminError('TEAM_CREATE_FAILED', parseMessage(err));
    }
  },

  'mcp.team.list': async (server, params) => {
    const id = mustDispatcherId(params);
    mustExistingDispatcher(server, id);
    return { teams: await server.dispatcherService.listTeams(id) };
  },

  'mcp.team.status': async (server, params) => {
    const id = mustDispatcherId(params);
    mustExistingDispatcher(server, id);
    // #182 PR-7: public addressing is by `name` (== team_id storage key).
    const name = mustString(params, 'name');
    return server.dispatcherService.getTeamStatus(id, name);
  },

  'mcp.team.history': async (server, params) => {
    const id = mustDispatcherId(params);
    mustExistingDispatcher(server, id);
    const name = optionalString(params, 'name');
    const status = optionalTeamStatus(params, 'status');
    const closeStatus = optionalCloseStatus(params, 'close_status');
    const repo = optionalString(params, 'repo');
    const grep = optionalString(params, 'grep');
    const since = optionalInteger(params, 'since');
    const until = optionalInteger(params, 'until');
    const limit = optionalInteger(params, 'limit');
    const cursor = optionalString(params, 'cursor');
    return server.dispatcherService.getTeamHistory({
      dispatcherId: id,
      ...(name !== null ? { name } : {}),
      ...(status !== null ? { status } : {}),
      ...(closeStatus !== null ? { closeStatus } : {}),
      ...(repo !== null ? { repo } : {}),
      ...(grep !== null ? { grep } : {}),
      ...(since !== null ? { since } : {}),
      ...(until !== null ? { until } : {}),
      ...(limit !== null ? { limit } : {}),
      ...(cursor !== null ? { cursor } : {}),
    });
  },

  'mcp.team.bind_group': async (server, params) => {
    const id = mustDispatcherId(params);
    mustExistingDispatcher(server, id);
    // #182 PR-7: bindings are always Feishu group chats; the public surface no
    // longer takes `chat_type` (the store rejects non-group for Team binding).
    return server.dispatcherService.bindTeamChannel({
      dispatcherId: id,
      teamId: mustString(params, 'name'),
      provider: 'builtin:feishu',
      chatId: mustString(params, 'chat_id'),
      chatType: 'group',
    });
  },

  'mcp.team.transfer_channel_back': async (server, params) => {
    const id = mustDispatcherId(params);
    mustExistingDispatcher(server, id);
    return {
      binding: await server.dispatcherService.transferTeamChannelBack({
        dispatcherId: id,
        provider: 'builtin:feishu',
        chatId: mustString(params, 'chat_id'),
        // #182 PR-7: group-only; the public surface no longer takes `chat_type`.
        chatType: 'group',
      }),
    };
  },

  'mcp.team.dissolve': async (server, params) => {
    const id = mustDispatcherId(params);
    mustExistingDispatcher(server, id);
    const name = mustString(params, 'name');
    // Required dissolve reason (issue #182 PR-3).
    const note = mustNonEmptyString(params, 'note');
    return server.dispatcherService.dissolveTeam({
      dispatcherId: id,
      teamId: name,
      note,
    });
  },
};

async function assertFeishuScope(
  server: Server,
  dispatcherId: string,
  params: Record<string, unknown> | undefined,
): Promise<void> {
  const caller = callerPrincipal(dispatcherId, params);
  if (caller.kind !== 'team_leader') return;
  const chatId = optionalString(params, 'chat_id');
  if (chatId === null) {
    throw new AdminError(
      'BAD_REQUEST',
      "param 'chat_id' is required for TeamLeader Feishu tools",
    );
  }
  const messageId = optionalString(params, 'message_id');
  if (
    messageId !== null &&
    !server.dispatcherService.feishuMessageBelongsToChat(
      dispatcherId,
      messageId,
      chatId,
    )
  ) {
    throw new AdminError(
      'CHANNEL_SCOPE_DENIED',
      'TeamLeader may react/reply only to messages observed in bound team channels',
    );
  }
  const allowed = await server.dispatcherService.teamLeaderCanUseChannel({
    dispatcherId,
    teamId: caller.teamId,
    leaderName: caller.leaderName,
    provider: 'builtin:feishu',
    chatId,
  });
  if (!allowed) {
    throw new AdminError(
      'CHANNEL_SCOPE_DENIED',
      'TeamLeader may use Feishu only for bound team channels',
    );
  }
}

function callerPrincipal(
  dispatcherId: string,
  params: Record<string, unknown> | undefined,
): TeamMateCallerPrincipal {
  const kind = optionalString(params, 'caller_kind') ?? 'dispatcher';
  if (kind === 'dispatcher') return dispatcherPrincipal(dispatcherId);
  if (kind === 'team_leader') {
    const teamId = mustString(params, 'team_id');
    const leaderName = mustString(params, 'leader_name');
    return teamLeaderPrincipal({ dispatcherId, teamId, leaderName });
  }
  if (kind === 'teammate') return { kind: 'teammate', dispatcherId };
  throw new AdminError(
    'BAD_REQUEST',
    "param 'caller_kind' must be dispatcher, team_leader, or teammate",
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

/**
 * Like `mustString` but rejects the empty string too — the admin-layer guard
 * for required, meaningful fields (issue #182 PR-3 intent/note). Matches the
 * shim's `requireString` so an empty required field is rejected at every layer,
 * including a direct admin caller that bypasses the shim.
 */
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

function optionalWorktreeRequest(
  params: Record<string, unknown> | undefined,
  key: string,
): TeamMateWorktreeRequest | null {
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
  const cleanup = optionalString(obj, 'cleanup');
  if (
    cleanup !== null &&
    cleanup !== 'keep' &&
    cleanup !== 'delete-on-close'
  ) {
    throw new AdminError(
      'BAD_REQUEST',
      `param '${key}.cleanup' must be 'keep' or 'delete-on-close'`,
    );
  }
  return {
    mode,
    ...optionalStringProp(obj, 'slug'),
    ...optionalStringProp(obj, 'base_ref'),
    ...optionalStringProp(obj, 'branch'),
    ...(cleanup !== null ? { cleanup } : {}),
  };
}

function historyQuery(
  params: Record<string, unknown> | undefined,
): Omit<TeamMateHistoryQuery, 'dispatcherId'> {
  const name = optionalString(params, 'name');
  const id = optionalString(params, 'id');
  const agentRuntime = optionalString(params, 'agent_runtime');
  const state = optionalHistoryState(params, 'state');
  const closeStatus = optionalCloseStatus(params, 'close_status');
  const sourceCwd = optionalString(params, 'source_cwd');
  const runtimeCwd = optionalString(params, 'runtime_cwd');
  const grep = optionalString(params, 'grep');
  const cursor = optionalString(params, 'cursor');
  const limit = optionalInteger(params, 'limit');
  return {
    ...(name !== null ? { name } : {}),
    ...(id !== null ? { id } : {}),
    ...(agentRuntime !== null ? { agentRuntime } : {}),
    ...(state !== null ? { state } : {}),
    ...(closeStatus !== null ? { closeStatus } : {}),
    ...(sourceCwd !== null ? { sourceCwd } : {}),
    ...(runtimeCwd !== null ? { runtimeCwd } : {}),
    ...(grep !== null ? { grep } : {}),
    ...(cursor !== null ? { cursor } : {}),
    ...(limit !== null ? { limit } : {}),
  };
}

function optionalHistoryState(
  params: Record<string, unknown> | undefined,
  key: string,
): TeamMateIdentityStatus | 'active' | null {
  const value = optionalString(params, key);
  if (value === null) return null;
  if (
    value === 'active' ||
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
    `param '${key}' must be active, starting, running, degraded, closed, or stopped`,
  );
}

function optionalCloseStatus(
  params: Record<string, unknown> | undefined,
  key: string,
): 'open' | 'closed' | null {
  const value = optionalString(params, key);
  if (value === null) return null;
  if (value === 'open' || value === 'closed') return value;
  throw new AdminError('BAD_REQUEST', `param '${key}' must be open or closed`);
}

function optionalBindGroup(
  params: Record<string, unknown> | undefined,
  key: string,
): { chatId: string } | null {
  if (params === undefined) return null;
  const value = params[key];
  if (value === undefined || value === null) return null;
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new AdminError('BAD_REQUEST', `param '${key}' must be an object`);
  }
  const chatId = (value as Record<string, unknown>)['chat_id'];
  if (typeof chatId !== 'string' || chatId === '') {
    throw new AdminError('BAD_REQUEST', `param '${key}.chat_id' must be a non-empty string`);
  }
  return { chatId };
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

function mustRunningDispatcher(server: Server, id: string): void {
  if (server.dispatcherService.getRuntime(id) === null) {
    throw new AdminError(
      'DISPATCHER_NOT_RUNNING',
      `dispatcher '${id}' is not running`,
    );
  }
}

function parseMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
