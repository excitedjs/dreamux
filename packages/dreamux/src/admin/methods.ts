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
import {
  NestedTeamMateDispatchError,
  type TeamMateInputMode,
  type TeamMateScheduleCallerKind,
  type TeamMateTargetMode,
} from '../teammate/ledger.js';

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

  // Read-only: lists a chat's known + trusted peer bots (issue #69). Reads the
  // per-dispatcher chat-bots store, so it does not require a running slot — only
  // a declared dispatcher.
  'mcp.list_chat_bots': (server, params) => {
    const id = mustDispatcherId(params);
    mustExistingDispatcher(server, id);
    const chatId = mustString(params, 'chat_id');
    return server.listChatBotsFromMcp({ dispatcherId: id, chatId });
  },

  'mcp.teammate.schedule': async (server, params) => {
    const id = mustDispatcherId(params);
    mustExistingDispatcher(server, id);
    const callerKind = mustCallerKind(params);
    const title = mustString(params, 'title');
    const prompt = mustString(params, 'prompt');
    const teammateId = optionalString(params, 'teammate_id');
    try {
      return await server.scheduleTeamMateFromMcp({
        dispatcherId: id,
        callerKind,
        title,
        prompt,
        ...(teammateId !== null ? { teammateId } : {}),
      });
    } catch (err) {
      if (err instanceof NestedTeamMateDispatchError) {
        throw new AdminError(
          'TEAMMATE_NESTED_DISPATCH_REJECTED',
          parseMessage(err),
        );
      }
      throw new AdminError('TEAMMATE_SCHEDULE_FAILED', parseMessage(err));
    }
  },

  // Worker/operator completion ingest (issue #110 PR8). Intentionally NOT a
  // dispatcher-facing teammate-mcp tool, so a dispatcher model cannot fake a
  // completion; it is the seam a future worker / operator tool drives.
  'mcp.teammate.complete': async (server, params) => {
    const id = mustDispatcherId(params);
    mustExistingDispatcher(server, id);
    const taskId = mustString(params, 'task_id');
    const outcome = mustString(params, 'outcome');
    if (outcome !== 'completed' && outcome !== 'failed') {
      throw new AdminError(
        'BAD_REQUEST',
        "param 'outcome' must be 'completed' or 'failed'",
      );
    }
    const finalText = mustString(params, 'final_text');
    try {
      return await server.reportTeamMateCompletion({
        dispatcherId: id,
        taskId,
        outcome,
        finalText,
      });
    } catch (err) {
      throw new AdminError('TEAMMATE_COMPLETE_FAILED', parseMessage(err));
    }
  },

  // Executable normal-path create-and-execute tool (issue #126). No worker is
  // wired yet, so the task is created and the execution sub-result reports
  // provider_unavailable.
  'mcp.teammate.run': async (server, params) => {
    const id = mustDispatcherId(params);
    mustExistingDispatcher(server, id);
    const callerKind = mustCallerKind(params);
    const title = mustString(params, 'title');
    const prompt = mustString(params, 'prompt');
    const targetPath = mustString(params, 'target_path');
    const teammateId = optionalString(params, 'teammate_id');
    const intent = optionalString(params, 'intent');
    const targetMode = optionalString(params, 'target_mode');
    const providerRef = optionalString(params, 'provider_ref');
    const operationId = optionalString(params, 'operation_id');
    try {
      return await server.runTeamMateTaskFromMcp({
        dispatcherId: id,
        callerKind,
        title,
        prompt,
        targetPath,
        ...(teammateId !== null ? { teammateId } : {}),
        ...(intent !== null ? { intent } : {}),
        ...(targetMode !== null
          ? { targetMode: targetMode as TeamMateTargetMode }
          : {}),
        ...(providerRef !== null ? { providerRef } : {}),
        ...(operationId !== null ? { operationId } : {}),
      });
    } catch (err) {
      if (err instanceof NestedTeamMateDispatchError) {
        throw new AdminError(
          'TEAMMATE_NESTED_DISPATCH_REJECTED',
          parseMessage(err),
        );
      }
      throw new AdminError('TEAMMATE_RUN_FAILED', parseMessage(err));
    }
  },

  'mcp.teammate.execute': async (server, params) => {
    const id = mustDispatcherId(params);
    mustExistingDispatcher(server, id);
    const taskId = mustString(params, 'task_id');
    const providerRef = optionalString(params, 'provider_ref');
    const targetMode = optionalString(params, 'target_mode');
    const operationId = optionalString(params, 'operation_id');
    try {
      return await server.executeTeamMateTaskFromMcp({
        dispatcherId: id,
        taskId,
        ...(providerRef !== null ? { providerRef } : {}),
        ...(targetMode !== null
          ? { targetMode: targetMode as TeamMateTargetMode }
          : {}),
        ...(operationId !== null ? { operationId } : {}),
      });
    } catch (err) {
      throw new AdminError('TEAMMATE_EXECUTE_FAILED', parseMessage(err));
    }
  },

  'mcp.teammate.send_input': async (server, params) => {
    const id = mustDispatcherId(params);
    mustExistingDispatcher(server, id);
    const taskId = mustString(params, 'task_id');
    const prompt = mustString(params, 'prompt');
    const mode = optionalString(params, 'mode');
    const operationId = optionalString(params, 'operation_id');
    try {
      return await server.sendTeamMateInputFromMcp({
        dispatcherId: id,
        taskId,
        prompt,
        ...(mode !== null ? { mode: mode as TeamMateInputMode } : {}),
        ...(operationId !== null ? { operationId } : {}),
      });
    } catch (err) {
      throw new AdminError('TEAMMATE_SEND_INPUT_FAILED', parseMessage(err));
    }
  },

  // Internal/admin-diagnostic only — NOT exposed as a dispatcher-facing MCP tool
  // (issue #126 PR8). Normal orchestration is run_task → the dispatcher turn ends
  // → delivery/wakeup starts a new turn; dispatchers never poll. This bounded
  // wait primitive is retained for tests and admin diagnostics; a timeout returns
  // a structured still_running result, not an error.
  'mcp.teammate.await': async (server, params) => {
    const id = mustDispatcherId(params);
    mustExistingDispatcher(server, id);
    const taskId = mustString(params, 'task_id');
    const afterEventId = optionalNumber(params, 'after_event_id');
    const until = optionalStringArray(params, 'until');
    const timeoutMs = optionalNumber(params, 'timeout_ms');
    try {
      return await server.awaitTeamMateCompletionFromMcp({
        dispatcherId: id,
        taskId,
        ...(afterEventId !== null ? { afterEventId } : {}),
        ...(until !== null ? { until } : {}),
        ...(timeoutMs !== null ? { timeoutMs } : {}),
      });
    } catch (err) {
      throw new AdminError('TEAMMATE_AWAIT_FAILED', parseMessage(err));
    }
  },

  'mcp.teammate.cancel': async (server, params) => {
    const id = mustDispatcherId(params);
    mustExistingDispatcher(server, id);
    const taskId = mustString(params, 'task_id');
    const note = optionalString(params, 'note');
    try {
      return await server.cancelTeamMateTaskFromMcp({
        dispatcherId: id,
        taskId,
        ...(note !== null ? { note } : {}),
      });
    } catch (err) {
      throw new AdminError('TEAMMATE_CANCEL_FAILED', parseMessage(err));
    }
  },

  'mcp.teammate.logs': async (server, params) => {
    const id = mustDispatcherId(params);
    mustExistingDispatcher(server, id);
    const taskId = mustString(params, 'task_id');
    const maxBytes = optionalNumber(params, 'max_bytes');
    const stream = optionalString(params, 'stream');
    if (
      stream !== null &&
      stream !== 'stdout' &&
      stream !== 'stderr' &&
      stream !== 'events'
    ) {
      throw new AdminError(
        'BAD_REQUEST',
        "param 'stream' must be 'stdout', 'stderr', or 'events'",
      );
    }
    try {
      return await server.getTeamMateTaskLogsFromMcp({
        dispatcherId: id,
        taskId,
        ...(maxBytes !== null ? { maxBytes } : {}),
        ...(stream !== null
          ? { stream: stream as 'stdout' | 'stderr' | 'events' }
          : {}),
      });
    } catch (err) {
      throw new AdminError('TEAMMATE_LOGS_FAILED', parseMessage(err));
    }
  },

  'mcp.teammate.capabilities': (server) =>
    server.getTeamMateCapabilitiesFromMcp(),

  'mcp.teammate.list': async (server, params) => {
    const id = mustDispatcherId(params);
    mustExistingDispatcher(server, id);
    return { tasks: await server.listTeamMateTasksFromMcp(id) };
  },

  'mcp.teammate.get': async (server, params) => {
    const id = mustDispatcherId(params);
    mustExistingDispatcher(server, id);
    const taskId = mustString(params, 'task_id');
    return { task: await server.getTeamMateTaskFromMcp(id, taskId) };
  },

  'mcp.teammate.pull': async (server, params) => {
    const id = mustDispatcherId(params);
    mustExistingDispatcher(server, id);
    const taskId = optionalString(params, 'task_id');
    const result = await server.pullTeamMateResultFromMcp(
      id,
      taskId !== null ? taskId : undefined,
    );
    return { result };
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

function mustCallerKind(
  params: Record<string, unknown> | undefined,
): TeamMateScheduleCallerKind {
  const callerKind = mustString(params, 'caller_kind');
  if (callerKind === 'dispatcher' || callerKind === 'teammate') return callerKind;
  throw new AdminError(
    'BAD_REQUEST',
    "param 'caller_kind' must be 'dispatcher' or 'teammate'",
  );
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

function optionalNumber(
  params: Record<string, unknown> | undefined,
  key: string,
): number | null {
  if (params === undefined) return null;
  const v = params[key];
  if (v === undefined || v === null) return null;
  if (typeof v !== 'number' || !Number.isFinite(v)) {
    throw new AdminError('BAD_REQUEST', `param '${key}' must be a finite number`);
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
