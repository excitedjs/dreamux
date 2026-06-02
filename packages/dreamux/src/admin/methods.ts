/**
 * Admin method handlers.
 *
 * Each handler takes typed params and returns the `result` payload to put on
 * the wire. Throws `AdminError` for user-actionable failures (the protocol
 * layer formats those as `error` responses).
 */

import type { Server } from '../server.js';
import { AdminError } from './protocol.js';
import type { DispatcherStatus, InboundState } from '../db/types.js';

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
    const id = mustString(params, 'dispatcher_id');
    const botAppId = mustString(params, 'bot_app_id');
    const botSecretRef = mustString(params, 'bot_secret_ref');
    const codexArgsJson = optionalString(params, 'codex_args_json') ?? '{}';
    const codexCwd = optionalString(params, 'codex_cwd');
    try {
      const row = server.repos.dispatchers.create({
        dispatcher_id: id,
        bot_app_id: botAppId,
        bot_secret_ref: botSecretRef,
        codex_args_json: codexArgsJson,
        codex_cwd: codexCwd ?? null,
      });
      return { dispatcher_id: row.dispatcher_id, status: row.status };
    } catch (err) {
      if (err && typeof err === 'object') {
        const code = (err as { code?: string }).code;
        if (
          code === 'SQLITE_CONSTRAINT_UNIQUE' ||
          code === 'SQLITE_CONSTRAINT_PRIMARYKEY'
        ) {
          throw new AdminError(
            'CONFLICT',
            `dispatcher_id or bot_app_id already exists: ${(err as Error).message}`,
          );
        }
      }
      throw err;
    }
  },

  'dispatcher.remove': async (server, params) => {
    const id = mustString(params, 'dispatcher_id');
    const row = server.repos.dispatchers.get(id);
    if (row === null) {
      throw new AdminError('DISPATCHER_NOT_FOUND', `no dispatcher with id '${id}'`);
    }
    await server.stopDispatcher(id);
    server.repos.dispatchers.remove(id);
    return { dispatcher_id: id };
  },

  'dispatcher.list': (server) => ({ dispatchers: server.summarize() }),

  'dispatcher.status': (server, params) => {
    const id = mustString(params, 'dispatcher_id');
    const row = server.repos.dispatchers.get(id);
    if (row === null) {
      throw new AdminError('DISPATCHER_NOT_FOUND', `no dispatcher with id '${id}'`);
    }
    const runtime = server.getRuntime(id);
    const counts: Record<InboundState, number> = server.repos.inbound.countByState(id);
    return {
      dispatcher_id: row.dispatcher_id,
      bot_app_id: row.bot_app_id,
      status: runtime?.getStatus() ?? row.status,
      thread_id: runtime?.getThreadId() ?? row.thread_id,
      last_lost_thread_id: row.last_lost_thread_id,
      last_error: row.last_error,
      inbound_buffer: counts,
    };
  },

  'dispatcher.start': async (server, params) => {
    const id = mustString(params, 'dispatcher_id');
    const row = server.repos.dispatchers.get(id);
    if (row === null) {
      throw new AdminError('DISPATCHER_NOT_FOUND', `no dispatcher with id '${id}'`);
    }
    await server.startDispatcher(id);
    return { dispatcher_id: id, status: server.getRuntime(id)?.getStatus() as DispatcherStatus };
  },

  'dispatcher.stop': async (server, params) => {
    const id = mustString(params, 'dispatcher_id');
    await server.stopDispatcher(id);
    return { dispatcher_id: id, status: 'stopped' };
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
