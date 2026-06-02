/**
 * Admin method handlers.
 *
 * Each handler takes typed params and returns the `result` payload to put on
 * the wire. Throws `AdminError` for user-actionable failures (the protocol
 * layer formats those as `error` responses).
 */

import { statSync } from 'node:fs';

import type { Server } from '../server.js';
import { AdminError } from './protocol.js';
import type {
  CodexTeammateStatus,
  DispatcherStatus,
  InboundState,
} from '../db/types.js';

export type AdminHandler = (
  server: Server,
  params: Record<string, unknown> | undefined,
) => Promise<unknown> | unknown;

export const adminMethods: Record<string, AdminHandler> = {
  'server.status': (server) => ({
    pid: process.pid,
    uptimeSec: Math.floor(process.uptime()),
    dispatchers: server.summarize(),
    teammates: server.summarizeTeammates(),
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

  'teammate.spawn': async (server, params) => {
    const name = mustTeammateName(params, 'name');
    const cwd = mustDirectory(params, 'cwd');
    const codexArgsJson = optionalString(params, 'codex_args_json') ?? '{}';
    try {
      return await server.spawnTeammate({
        name,
        cwd,
        codex_args_json: codexArgsJson,
      });
    } catch (err) {
      if (isSqliteConflict(err)) {
        throw new AdminError(
          'CONFLICT',
          `codex teammate already exists: ${(err as Error).message}`,
        );
      }
      throw err;
    }
  },

  'teammate.resume': async (server, params) => {
    const name = mustTeammateName(params, 'name');
    const cwd = mustDirectory(params, 'cwd');
    const threadId = mustString(params, 'thread_id');
    const codexArgsJson = optionalString(params, 'codex_args_json') ?? '{}';
    try {
      return await server.spawnTeammate({
        name,
        cwd,
        codex_args_json: codexArgsJson,
        thread_id: threadId,
      });
    } catch (err) {
      if (isSqliteConflict(err)) {
        throw new AdminError(
          'CONFLICT',
          `codex teammate already exists: ${(err as Error).message}`,
        );
      }
      throw err;
    }
  },

  'teammate.send': async (server, params) => {
    const name = mustTeammateName(params, 'name');
    const prompt = mustString(params, 'prompt');
    const row = server.repos.teammates.get(name);
    if (row === null) {
      throw new AdminError('TEAMMATE_NOT_FOUND', `no codex teammate '${name}'`);
    }
    return server.sendTeammate(name, prompt);
  },

  'teammate.kill': async (server, params) => {
    const name = mustTeammateName(params, 'name');
    const row = server.repos.teammates.get(name);
    if (row === null) {
      throw new AdminError('TEAMMATE_NOT_FOUND', `no codex teammate '${name}'`);
    }
    await server.removeTeammate(name);
    return { name, status: 'stopped' as CodexTeammateStatus };
  },

  'teammate.list': (server) => ({ teammates: server.summarizeTeammates() }),

  'teammate.status': (server, params) => {
    const name = mustTeammateName(params, 'name');
    const row = server.repos.teammates.get(name);
    if (row === null) {
      throw new AdminError('TEAMMATE_NOT_FOUND', `no codex teammate '${name}'`);
    }
    const runtime = server.getTeammateRuntime(name);
    return {
      name: row.name,
      cwd: row.cwd,
      status: runtime?.getStatus() ?? row.status,
      thread_id: runtime?.getThreadId() ?? row.thread_id,
      last_turn_id: row.last_turn_id,
      last_assistant_text: row.last_assistant_text,
      last_error: row.last_error,
    };
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

const TEAMMATE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

function mustTeammateName(
  params: Record<string, unknown> | undefined,
  key: string,
): string {
  const name = mustString(params, key);
  if (!TEAMMATE_NAME_RE.test(name)) {
    throw new AdminError(
      'BAD_REQUEST',
      `invalid codex teammate name '${name}'; use 1-64 ASCII letters, digits, '-' or '_', starting with a letter or digit`,
    );
  }
  return name;
}

function mustDirectory(
  params: Record<string, unknown> | undefined,
  key: string,
): string {
  const value = mustString(params, key);
  try {
    if (statSync(value).isDirectory()) return value;
  } catch {
    /* handled below */
  }
  throw new AdminError('BAD_REQUEST', `param '${key}' must be an existing directory`);
}

function isSqliteConflict(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const code = (err as { code?: string }).code;
  return code === 'SQLITE_CONSTRAINT_UNIQUE' || code === 'SQLITE_CONSTRAINT_PRIMARYKEY';
}
