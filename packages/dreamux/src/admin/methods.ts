/**
 * Admin method handlers.
 *
 * Each handler takes typed params and returns the `result` payload to put on
 * the wire. Throws `AdminError` for user-actionable failures (the protocol
 * layer formats those as `error` responses).
 */

import type { Server } from '../server.js';
import { AdminError } from './protocol.js';
import type { DispatcherStatus } from '../runtime/dispatcher-store.js';
import { validateDispatcherId } from '../runtime/dispatcher-id.js';

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
    const runtime = server.getRuntime(id);
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
    await server.startDispatcher(id);
    return { dispatcher_id: id, status: server.getRuntime(id)?.getStatus() as DispatcherStatus };
  },

  'dispatcher.stop': async (server, params) => {
    const id = mustDispatcherId(params);
    await server.stopDispatcher(id);
    return { dispatcher_id: id, status: 'stopped' };
  },

  'mcp.reply': async (server, params) => {
    const id = mustDispatcherId(params);
    mustExistingDispatcher(server, id);
    mustRunningDispatcher(server, id);
    const chatId = mustString(params, 'chat_id');
    const text = mustString(params, 'text');
    const messageId = optionalString(params, 'message_id');
    const mentionUserIds = optionalStringArray(params, 'mention_user_ids');
    try {
      return await server.replyFromMcp({
        dispatcherId: id,
        chatId,
        text,
        ...(messageId !== null ? { messageId } : {}),
        ...(mentionUserIds !== null ? { mentionUserIds } : {}),
      });
    } catch (err) {
      throw new AdminError('OUTBOUND_FAILED', parseMessage(err));
    }
  },

  'mcp.react': async (server, params) => {
    const id = mustDispatcherId(params);
    mustExistingDispatcher(server, id);
    mustRunningDispatcher(server, id);
    const messageId = mustString(params, 'message_id');
    const emoji = mustString(params, 'emoji');
    try {
      return await server.reactFromMcp({
        dispatcherId: id,
        messageId,
        emoji,
      });
    } catch (err) {
      throw new AdminError('REACTION_FAILED', parseMessage(err));
    }
  },
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

function optionalStringArray(
  params: Record<string, unknown> | undefined,
  key: string,
): string[] | null {
  if (params === undefined) return null;
  const v = params[key];
  if (v === undefined || v === null) return null;
  if (!Array.isArray(v) || v.some((item) => typeof item !== 'string')) {
    throw new AdminError('BAD_REQUEST', `param '${key}' must be an array of strings`);
  }
  return v as string[];
}

function mustExistingDispatcher(server: Server, id: string): void {
  const row = server.repos.dispatchers.get(id);
  if (row === null) {
    throw new AdminError('DISPATCHER_NOT_FOUND', `no dispatcher with id '${id}'`);
  }
}

function mustRunningDispatcher(server: Server, id: string): void {
  if (server.getRuntime(id) === null) {
    throw new AdminError(
      'DISPATCHER_NOT_RUNNING',
      `dispatcher '${id}' is not running`,
    );
  }
}

function parseMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
