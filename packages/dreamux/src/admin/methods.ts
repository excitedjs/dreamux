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
import type { TeamMateWorktreeRequest } from '../dispatcher-service/teammate/types.js';

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
  'mcp.list_chat_bots': (server, params) => {
    const id = mustDispatcherId(params);
    mustExistingDispatcher(server, id);
    return server.dispatcherService.callFeishuMcpTool({
      dispatcherId: id,
      toolName: 'list_chat_bots',
      arguments: params ?? {},
    });
  },

  'mcp.teammate.spawn': async (server, params) => {
    const id = mustDispatcherId(params);
    mustExistingDispatcher(server, id);
    const name = mustString(params, 'name');
    const prompt = mustString(params, 'prompt');
    const agentRuntime = optionalString(params, 'agent_runtime');
    const cwd = mustString(params, 'cwd');
    const worktree = optionalWorktreeRequest(params, 'worktree');
    const intent = optionalString(params, 'intent');
    try {
      return await server.dispatcherService.spawnTeamMate({
        dispatcherId: id,
        name,
        prompt,
        cwd,
        ...(agentRuntime !== null ? { agentRuntime } : {}),
        ...(worktree !== null ? { worktree } : {}),
        ...(intent !== null ? { intent } : {}),
      });
    } catch (err) {
      throw new AdminError('TEAMMATE_SPAWN_FAILED', parseMessage(err));
    }
  },

  'mcp.teammate.send': async (server, params) => {
    const id = mustDispatcherId(params);
    mustExistingDispatcher(server, id);
    const name = mustString(params, 'name');
    const prompt = mustString(params, 'prompt');
    try {
      return await server.dispatcherService.sendTeamMate({
        dispatcherId: id,
        name,
        prompt,
      });
    } catch (err) {
      throw new AdminError('TEAMMATE_SEND_FAILED', parseMessage(err));
    }
  },

  'mcp.teammate.close': async (server, params) => {
    const id = mustDispatcherId(params);
    mustExistingDispatcher(server, id);
    const name = mustString(params, 'name');
    const note = optionalString(params, 'note');
    try {
      return await server.dispatcherService.closeTeamMate({
        dispatcherId: id,
        name,
        ...(note !== null ? { note } : {}),
      });
    } catch (err) {
      throw new AdminError('TEAMMATE_CLOSE_FAILED', parseMessage(err));
    }
  },

  'mcp.teammate.history': async (server, params) => {
    const id = mustDispatcherId(params);
    mustExistingDispatcher(server, id);
    const name = mustString(params, 'name');
    return server.dispatcherService.getTeamMateHistory(id, name);
  },

  'mcp.teammate.list': async (server, params) => {
    const id = mustDispatcherId(params);
    mustExistingDispatcher(server, id);
    return { teammates: await server.dispatcherService.listTeamMates(id) };
  },

  'mcp.teammate.status': async (server, params) => {
    const id = mustDispatcherId(params);
    mustExistingDispatcher(server, id);
    const name = mustString(params, 'name');
    return {
      teammate: await server.dispatcherService.getTeamMateStatus(id, name),
    };
  },

  'mcp.teammate.last': async (server, params) => {
    const id = mustDispatcherId(params);
    mustExistingDispatcher(server, id);
    const name = mustString(params, 'name');
    return server.dispatcherService.getTeamMateLast(id, name);
  },

  'mcp.teammate.ctx': async (server, params) => {
    const id = mustDispatcherId(params);
    mustExistingDispatcher(server, id);
    const name = mustString(params, 'name');
    return server.dispatcherService.getTeamMateContext(id, name);
  },

  'mcp.teammate.capabilities': (server) =>
    server.dispatcherService.getTeamMateCapabilities(),
};

function mustString(
  params: Record<string, unknown> | undefined,
  key: string,
): string {
  if (params === undefined || typeof params[key] !== 'string') {
    throw new AdminError('BAD_REQUEST', `missing or non-string param '${key}'`);
  }
  return params[key] as string;
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
