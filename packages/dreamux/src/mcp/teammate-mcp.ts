import { createInterface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';

import {
  AdminClientError,
  sendAdminRequest,
} from '../admin/client.js';
import { adminSocketPath as defaultAdminSocketPath } from '../platform/paths.js';
import { validateDispatcherId } from '../state/dispatcher-id.js';
import { validateTeamId } from '../dispatcher-service/team/types.js';
import { validateTeamMateName } from '../dispatcher-service/teammate/types.js';

export interface TeamMateMcpOptions {
  dispatcherId: string;
  callerKind: 'dispatcher' | 'team_leader' | 'teammate';
  teamId?: string;
  leaderName?: string;
  adminSocketPath?: string;
  input?: Readable;
  output?: Writable;
  log?: (message: string) => void;
}

interface JsonRpcRequest {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: unknown;
}

interface ToolCall {
  name: string;
  arguments: unknown;
}

const JSONRPC_VERSION = '2.0';
const DEFAULT_MCP_PROTOCOL_VERSION = '2024-11-05';
const SUPPORTED_MCP_PROTOCOL_VERSIONS = new Set([
  '2025-06-18',
  '2025-03-26',
  '2024-11-05',
]);

export async function runTeamMateMcp(opts: TeamMateMcpOptions): Promise<void> {
  const dispatcherId = validateDispatcherId(opts.dispatcherId);
  const callerKind = validateCallerKind(opts.callerKind);
  const teamId = callerKind === 'team_leader' ? validateRequiredTeamId(opts.teamId) : undefined;
  const leaderName = callerKind === 'team_leader'
    ? validateTeamMateName(opts.leaderName ?? '')
    : undefined;
  const socketPath = opts.adminSocketPath ?? defaultAdminSocketPath();
  const input = opts.input ?? process.stdin;
  const output = opts.output ?? process.stdout;
  const log = opts.log ?? ((message) => console.error(message));
  const lines = createInterface({ input, crlfDelay: Infinity });

  for await (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    let request: JsonRpcRequest;
    try {
      request = JSON.parse(trimmed) as JsonRpcRequest;
    } catch (err) {
      write(output, errorResponse(null, -32700, parseMessage(err)));
      continue;
    }
    try {
      await handleRequest(request, {
        dispatcherId,
        callerKind,
        ...(teamId !== undefined ? { teamId } : {}),
        ...(leaderName !== undefined ? { leaderName } : {}),
        socketPath,
        output,
      });
    } catch (err) {
      log(`teammate-mcp: ${parseMessage(err)}`);
      if (request.id !== undefined) {
        write(output, errorResponse(request.id, -32603, parseMessage(err)));
      }
    }
  }
}

async function handleRequest(
  request: JsonRpcRequest,
  ctx: {
    dispatcherId: string;
    callerKind: 'dispatcher' | 'team_leader' | 'teammate';
    teamId?: string;
    leaderName?: string;
    socketPath: string;
    output: Writable;
  },
): Promise<void> {
  if (typeof request.method !== 'string') {
    if (request.id !== undefined) {
      write(ctx.output, errorResponse(request.id, -32600, 'missing method'));
    }
    return;
  }

  switch (request.method) {
    case 'initialize':
      if (request.id !== undefined) {
        write(ctx.output, okResponse(request.id, initializeResult(request.params)));
      }
      return;
    case 'initialized':
    case 'notifications/initialized':
      return;
    case 'tools/list':
      if (request.id !== undefined) {
        write(ctx.output, okResponse(request.id, { tools: teammateTools(ctx.callerKind) }));
      }
      return;
    case 'tools/call':
      if (request.id !== undefined) {
        write(ctx.output, okResponse(request.id, await callTool(request.params, ctx)));
      }
      return;
    default:
      if (request.id !== undefined) {
        write(
          ctx.output,
          errorResponse(request.id, -32601, `unknown MCP method '${request.method}'`),
        );
      }
  }
}

function initializeResult(params: unknown): Record<string, unknown> {
  return {
    protocolVersion: negotiateProtocolVersion(params),
    capabilities: { tools: {} },
    serverInfo: { name: 'dreamux-teammate', version: '0.3.0' },
  };
}

function teammateTools(
  callerKind: 'dispatcher' | 'team_leader' | 'teammate',
): Array<Record<string, unknown>> {
  const readTools = [
    tool('history', 'List bounded TeamMate session ledger rows for recovery.', {
      name: { type: 'string', minLength: 1, maxLength: 64 },
      id: { type: 'string', minLength: 1, maxLength: 64 },
      agent_runtime: { type: 'string', minLength: 1, maxLength: 128 },
      state: {
        type: 'string',
        enum: ['active', 'starting', 'running', 'degraded', 'closed', 'stopped'],
      },
      close_status: { type: 'string', enum: ['open', 'closed'] },
      source_cwd: { type: 'string', minLength: 1, maxLength: 4096 },
      runtime_cwd: { type: 'string', minLength: 1, maxLength: 4096 },
      grep: { type: 'string', minLength: 1, maxLength: 500 },
      limit: { type: 'integer', minimum: 1, maximum: 100 },
      cursor: { type: 'string', minLength: 1, maxLength: 1000 },
    }, []),
    tool('list', 'List this dispatcher\'s TeamMate identities (concrete name, display name, status, repo/cwd/session essentials).', {}, []),
    tool('status', 'Read one TeamMate identity and live runtime status by its concrete name.', {
      name: { type: 'string', minLength: 1, maxLength: 64 },
    }, ['name']),
    tool('last', 'Read a TeamMate\'s most recent settled turn(s) from the durable session ledger by concrete name. Works for a closed/stopped TeamMate without starting a runtime; this is the fallback when a completion was not delivered. turns defaults to 1 (range 1..5); the newest turn is last.', {
      name: { type: 'string', minLength: 1, maxLength: 64 },
      turns: { type: 'integer', minimum: 1, maximum: 5 },
    }, ['name']),
    tool('get_capabilities', 'List TeamMate verbs and spawnable agent runtime ids.', {}, []),
  ];
  if (callerKind === 'teammate') return readTools;
  const spawnProperties: Record<string, unknown> = {
    name: { type: 'string', minLength: 1, maxLength: 64 },
    prompt: { type: 'string', minLength: 1, maxLength: 20000 },
    agent_runtime: {
      type: 'string',
      description:
        'Spawnable agents[].id returned by get_capabilities.agent_runtimes[].id.',
    },
    intent: { type: 'string', minLength: 1, maxLength: 2000 },
  };
  if (callerKind === 'dispatcher') {
    spawnProperties['cwd'] = { type: 'string', minLength: 1, maxLength: 4096 };
    spawnProperties['worktree'] = {
      type: 'object',
      additionalProperties: false,
      properties: {
        mode: { type: 'string', enum: ['reuse-cwd', 'managed'] },
        slug: { type: 'string', minLength: 1, maxLength: 64 },
        base_ref: { type: 'string', minLength: 1, maxLength: 256 },
        branch: { type: 'string', minLength: 1, maxLength: 256 },
        cleanup: { type: 'string', enum: ['keep', 'delete-on-close'] },
      },
      required: ['mode'],
    };
  }
  return [
    tool(
      'spawn',
      'Start a named, resumable TeamMate agent and submit its first turn. Use get_capabilities.agent_runtimes[].id as agent_runtime. intent is required: it is the durable recovery subject for the session ledger.',
      spawnProperties,
      callerKind === 'team_leader'
        ? ['name', 'prompt', 'intent']
        : ['name', 'prompt', 'cwd', 'intent'],
    ),
    tool('send', 'Send a turn to a TeamMate agent; reopens a closed one from its checkpoint first. Pass intent to update the recorded recovery subject before the turn.', {
      name: { type: 'string', minLength: 1, maxLength: 64 },
      prompt: { type: 'string', minLength: 1, maxLength: 20000 },
      intent: { type: 'string', minLength: 1, maxLength: 2000 },
    }, ['name', 'prompt']),
    tool('close', 'Close a named TeamMate agent and retain its history; send reopens it later. note is required: it records why a recoverable session was stopped.', {
      name: { type: 'string', minLength: 1, maxLength: 64 },
      note: { type: 'string', minLength: 1, maxLength: 2000 },
    }, ['name', 'note']),
    ...readTools,
  ];
}

function tool(
  name: string,
  description: string,
  properties: Record<string, unknown>,
  required: string[],
): Record<string, unknown> {
  return {
    name,
    description,
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties,
      required,
    },
  };
}

async function callTool(
  params: unknown,
  ctx: {
    dispatcherId: string;
    callerKind: 'dispatcher' | 'team_leader' | 'teammate';
    teamId?: string;
    leaderName?: string;
    socketPath: string;
  },
): Promise<Record<string, unknown>> {
  try {
    const call = asToolCallParams(params);
    if (ctx.callerKind === 'teammate' && isLifecycleTool(call.name)) {
      return toolError(`TeamMate tool '${call.name}' is not available to teammates`);
    }
    const mapped = mapToolCall(call, ctx.callerKind);
    return forwardToolCall(
      mapped.method,
      {
        dispatcher_id: ctx.dispatcherId,
        ...mapped.params,
        caller_kind: ctx.callerKind,
        ...(ctx.teamId !== undefined ? { team_id: ctx.teamId } : {}),
        ...(ctx.leaderName !== undefined ? { leader_name: ctx.leaderName } : {}),
      },
      ctx.socketPath,
      call.name,
    );
  } catch (err) {
    return toolError(parseMessage(err));
  }
}

function mapToolCall(
  call: ToolCall,
  callerKind: 'dispatcher' | 'team_leader' | 'teammate',
): {
  method: string;
  params: Record<string, unknown>;
} {
  switch (call.name) {
    case 'spawn':
      return { method: 'mcp.teammate.spawn', params: spawnArgs(call.arguments, callerKind) };
    case 'send':
      return { method: 'mcp.teammate.send', params: sendArgs(call.arguments) };
    case 'close':
      return { method: 'mcp.teammate.close', params: closeArgs(call.arguments) };
    case 'history':
      return { method: 'mcp.teammate.history', params: historyArgs(call.arguments) };
    case 'list':
      return { method: 'mcp.teammate.list', params: {} };
    case 'status':
      return { method: 'mcp.teammate.status', params: nameArgs(call.arguments) };
    case 'last':
      return { method: 'mcp.teammate.last', params: lastArgs(call.arguments) };
    case 'get_capabilities':
      return { method: 'mcp.teammate.capabilities', params: {} };
    default:
      throw new Error(`unknown TeamMate tool '${String(call.name)}'`);
  }
}

function isLifecycleTool(name: string): boolean {
  return name === 'spawn' || name === 'send' || name === 'close';
}

function negotiateProtocolVersion(params: unknown): string {
  const requested =
    params !== null && typeof params === 'object' && !Array.isArray(params)
      ? (params as Record<string, unknown>)['protocolVersion']
      : undefined;
  if (
    typeof requested === 'string' &&
    SUPPORTED_MCP_PROTOCOL_VERSIONS.has(requested)
  ) {
    return requested;
  }
  return DEFAULT_MCP_PROTOCOL_VERSION;
}

async function forwardToolCall(
  method: string,
  params: Record<string, unknown>,
  socketPath: string,
  label: string,
): Promise<Record<string, unknown>> {
  try {
    const result = await sendAdminRequest(method, params, { socketPath });
    return {
      content: [{ type: 'text', text: `${label} forwarded to dreamux serve` }],
      structuredContent: result,
    };
  } catch (err) {
    const prefix = err instanceof AdminClientError ? `[${err.code}] ` : '';
    return toolError(`${prefix}${parseMessage(err)}`);
  }
}

function asToolCallParams(params: unknown): ToolCall {
  const obj = asRecord(params, 'tools/call params');
  const name = obj['name'];
  if (typeof name !== 'string' || name === '') {
    throw new Error('tools/call params.name must be a non-empty string');
  }
  return { name, arguments: obj['arguments'] ?? {} };
}

function spawnArgs(
  value: unknown,
  callerKind: 'dispatcher' | 'team_leader' | 'teammate',
): Record<string, unknown> {
  const obj = asRecord(value, 'spawn arguments');
  const agentRuntime = optionalString(obj, 'agent_runtime');
  // Required recovery subject (issue #182 PR-3).
  const intent = requireString(obj, 'intent');
  if (callerKind === 'team_leader') {
    return {
      name: requireString(obj, 'name'),
      prompt: requireString(obj, 'prompt'),
      intent,
      ...(agentRuntime !== null ? { agent_runtime: agentRuntime } : {}),
    };
  }
  const worktree = optionalWorktree(obj, 'worktree');
  return {
    name: requireString(obj, 'name'),
    prompt: requireString(obj, 'prompt'),
    cwd: requireString(obj, 'cwd'),
    intent,
    ...(agentRuntime !== null ? { agent_runtime: agentRuntime } : {}),
    ...(worktree !== null ? { worktree } : {}),
  };
}

function optionalWorktree(
  obj: Record<string, unknown>,
  key: string,
): Record<string, unknown> | null {
  const value = obj[key];
  if (value === undefined || value === null) return null;
  const worktree = asRecord(value, key);
  const mode = requireString(worktree, 'mode');
  if (mode !== 'reuse-cwd' && mode !== 'managed') {
    throw new Error(`${key}.mode must be 'reuse-cwd' or 'managed'`);
  }
  const cleanup = optionalString(worktree, 'cleanup');
  if (
    cleanup !== null &&
    cleanup !== 'keep' &&
    cleanup !== 'delete-on-close'
  ) {
    throw new Error(`${key}.cleanup must be 'keep' or 'delete-on-close'`);
  }
  return {
    mode,
    ...optionalProp(worktree, 'slug'),
    ...optionalProp(worktree, 'base_ref'),
    ...optionalProp(worktree, 'branch'),
    ...(cleanup !== null ? { cleanup } : {}),
  };
}

function optionalProp(
  obj: Record<string, unknown>,
  key: string,
): Record<string, string> {
  const value = optionalString(obj, key);
  return value === null ? {} : { [key]: value };
}

function sendArgs(value: unknown): Record<string, unknown> {
  const obj = asRecord(value, 'send arguments');
  // Optional updated recovery subject (issue #182 PR-3). An empty string is
  // treated as absent so it never wipes the recorded subject.
  const intent = optionalString(obj, 'intent');
  return {
    name: requireString(obj, 'name'),
    prompt: requireString(obj, 'prompt'),
    ...(intent !== null && intent !== '' ? { intent } : {}),
  };
}

function closeArgs(value: unknown): Record<string, unknown> {
  const obj = asRecord(value, 'close arguments');
  // Required close reason (issue #182 PR-3).
  return {
    name: requireString(obj, 'name'),
    note: requireString(obj, 'note'),
  };
}

function historyArgs(value: unknown): Record<string, unknown> {
  const obj = asRecord(value, 'history arguments');
  const name = optionalString(obj, 'name');
  const id = optionalString(obj, 'id');
  const agentRuntime = optionalString(obj, 'agent_runtime');
  const state = optionalEnum(obj, 'state', [
    'active',
    'starting',
    'running',
    'degraded',
    'closed',
    'stopped',
  ]);
  const closeStatus = optionalEnum(obj, 'close_status', ['open', 'closed']);
  const sourceCwd = optionalString(obj, 'source_cwd');
  const runtimeCwd = optionalString(obj, 'runtime_cwd');
  const grep = optionalString(obj, 'grep');
  const limit = optionalInteger(obj, 'limit');
  const cursor = optionalString(obj, 'cursor');
  return {
    ...(name !== null ? { name } : {}),
    ...(id !== null ? { id } : {}),
    ...(agentRuntime !== null ? { agent_runtime: agentRuntime } : {}),
    ...(state !== null ? { state } : {}),
    ...(closeStatus !== null ? { close_status: closeStatus } : {}),
    ...(sourceCwd !== null ? { source_cwd: sourceCwd } : {}),
    ...(runtimeCwd !== null ? { runtime_cwd: runtimeCwd } : {}),
    ...(grep !== null ? { grep } : {}),
    ...(limit !== null ? { limit } : {}),
    ...(cursor !== null ? { cursor } : {}),
  };
}

function nameArgs(value: unknown): Record<string, unknown> {
  const obj = asRecord(value, 'arguments');
  return { name: requireString(obj, 'name') };
}

function lastArgs(value: unknown): Record<string, unknown> {
  const obj = asRecord(value, 'last arguments');
  const turns = optionalInteger(obj, 'turns');
  return {
    name: requireString(obj, 'name'),
    ...(turns !== null ? { turns } : {}),
  };
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requireString(obj: Record<string, unknown>, key: string): string {
  const value = obj[key];
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${key} must be a non-empty string`);
  }
  return value;
}

function optionalString(obj: Record<string, unknown>, key: string): string | null {
  const value = obj[key];
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') throw new Error(`${key} must be a string`);
  return value;
}

function optionalInteger(obj: Record<string, unknown>, key: string): number | null {
  const value = obj[key];
  if (value === undefined || value === null) return null;
  if (!Number.isInteger(value)) throw new Error(`${key} must be an integer`);
  return value as number;
}

function optionalEnum(
  obj: Record<string, unknown>,
  key: string,
  values: string[],
): string | null {
  const value = optionalString(obj, key);
  if (value === null) return null;
  if (!values.includes(value)) {
    throw new Error(`${key} must be one of: ${values.join(', ')}`);
  }
  return value;
}

function okResponse(id: JsonRpcRequest['id'], result: unknown): string {
  return `${JSON.stringify({ jsonrpc: JSONRPC_VERSION, id, result })}\n`;
}

function errorResponse(
  id: JsonRpcRequest['id'],
  code: number,
  message: string,
): string {
  return `${JSON.stringify({
    jsonrpc: JSONRPC_VERSION,
    id,
    error: { code, message },
  })}\n`;
}

function toolError(message: string): Record<string, unknown> {
  return { content: [{ type: 'text', text: message }], isError: true };
}

function write(output: Writable, line: string): void {
  output.write(line);
}

function validateCallerKind(value: string): 'dispatcher' | 'team_leader' | 'teammate' {
  if (value === 'dispatcher' || value === 'team_leader' || value === 'teammate') return value;
  throw new Error("caller kind must be 'dispatcher', 'team_leader', or 'teammate'");
}

function validateRequiredTeamId(value: string | undefined): string {
  if (value === undefined || value === '') {
    throw new Error('team_leader caller requires team id');
  }
  return validateTeamId(value);
}

function parseMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
