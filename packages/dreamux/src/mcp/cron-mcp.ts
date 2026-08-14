import type { Readable, Writable } from 'node:stream';

import { adminSocketPath as defaultAdminSocketPath } from '../platform/paths.js';
import { validateDispatcherId } from '../state/dispatcher-id.js';
import {
  runMcpServer,
  type McpToolDefinition,
  type McpToolMetadata,
  type RunMcpServerOptions,
} from './server.js';
import {
  DESTRUCTIVE_ANNOTATIONS,
  MUTATING_ANNOTATIONS,
  OPEN_OBJECT,
  READ_ONLY_ANNOTATIONS,
  arrayOf,
  closedObjectSchema,
  forwardAdmin,
  publicErrorRules,
  toolMetadata,
  type PublicErrorRule,
} from './tool-catalog.js';

export interface CronMcpOptions {
  dispatcherId: string;
  teamId?: string;
  adminSocketPath?: string;
  input?: Readable;
  output?: Writable;
  transport?: RunMcpServerOptions['transport'];
  log?: (message: string) => void;
}

interface CronMcpScope {
  dispatcherId: string;
  teamId: string | undefined;
  socketPath: string;
}

const SERVER_IDENTITY = { name: 'dreamux-cron', version: '0.3.0' };

const PUBLIC_ERRORS: readonly PublicErrorRule[] = [
  ...publicErrorRules(
    [
      'scheduler.cron.create',
      'scheduler.cron.list',
      'scheduler.cron.delete',
      'scheduler.cron.update',
      'scheduler.cron.run_now',
    ],
    ['BAD_REQUEST', 'DISPATCHER_NOT_FOUND', 'TEAM_NOT_FOUND'],
  ),
];

export async function runCronMcp(opts: CronMcpOptions): Promise<void> {
  const dispatcherId = validateDispatcherId(opts.dispatcherId);
  const socketPath = opts.adminSocketPath ?? defaultAdminSocketPath();
  const scope: CronMcpScope = { dispatcherId, teamId: opts.teamId, socketPath };
  await runMcpServer({
    identity: SERVER_IDENTITY,
    tools: cronToolDefinitions(scope),
    ...(opts.input !== undefined ? { input: opts.input } : {}),
    ...(opts.output !== undefined ? { output: opts.output } : {}),
    ...(opts.transport !== undefined ? { transport: opts.transport } : {}),
    ...(opts.log !== undefined ? { log: opts.log } : {}),
  });
}

export function cronTools(): Array<Record<string, unknown>> {
  return cronToolMetadata() as unknown as Array<Record<string, unknown>>;
}

function cronToolMetadata(): McpToolMetadata[] {
  return [
    tool('cron_create', 'Create a durable Dreamux cron job for this agent. cron is a standard 5-field local-time expression (M H DoM Mon DoW); prefer off-:00/:30 minutes for approximate schedules. prompt is the text injected into this dispatcher or TeamLeader agent. recurring defaults to true; use recurring:false for one-shot reminders. dreamux jobs are always persisted and do not auto-expire. tz is resolved and stored. Cron jobs inject prompts back into this agent; they do not deliver channel messages or spawn agents.', {
      cron: { type: 'string', minLength: 1, maxLength: 200 },
      prompt: { type: 'string', minLength: 1, maxLength: 20000 },
      recurring: { type: 'boolean' },
      tz: { type: 'string', minLength: 1, maxLength: 100 },
      title: { type: 'string', minLength: 1, maxLength: 200 },
    }, ['cron', 'prompt'], {
      title: 'Create a cron job',
      output: cronJobSchema(),
      annotations: MUTATING_ANNOTATIONS,
    }),
    tool('cron_list', 'List durable cron jobs for this agent.', {}, [], {
      title: 'List cron jobs',
      output: closedObjectSchema({ jobs: arrayOf(OPEN_OBJECT) }, ['jobs']),
      annotations: READ_ONLY_ANNOTATIONS,
    }),
    tool('cron_delete', 'Delete a cron job by id.', {
      id: { type: 'string', minLength: 1, maxLength: 128 },
    }, ['id'], {
      title: 'Delete a cron job',
      output: closedObjectSchema(
        { id: { type: 'string' }, deleted: { type: 'boolean' } },
        ['id', 'deleted'],
      ),
      annotations: DESTRUCTIVE_ANNOTATIONS,
    }),
    tool('cron_update', 'Update a cron job by id. Same behavior as cron_create: cron jobs inject prompts back into this agent; they do not deliver channel messages or spawn agents.', {
      id: { type: 'string', minLength: 1, maxLength: 128 },
      cron: { type: 'string', minLength: 1, maxLength: 200 },
      prompt: { type: 'string', minLength: 1, maxLength: 20000 },
      recurring: { type: 'boolean' },
      tz: { type: 'string', minLength: 1, maxLength: 100 },
      title: { type: ['string', 'null'], minLength: 1, maxLength: 200 },
      enabled: { type: 'boolean' },
    }, ['id'], {
      title: 'Update a cron job',
      output: cronJobSchema(),
      annotations: MUTATING_ANNOTATIONS,
    }),
    tool('cron_run_now', 'Fire one cron job once now, still respecting defer-until-idle.', {
      id: { type: 'string', minLength: 1, maxLength: 128 },
    }, ['id'], {
      title: 'Run a cron job now',
      output: closedObjectSchema(
        { id: { type: 'string' }, status: { type: 'string' } },
        ['id', 'status'],
      ),
      annotations: MUTATING_ANNOTATIONS,
    }),
  ];
}

function cronToolDefinitions(scope: CronMcpScope): McpToolDefinition[] {
  return cronToolMetadata().map((metadata) => ({
    ...metadata,
    handler: (args) => callTool(metadata.name, args, scope),
  }));
}

async function callTool(
  name: string,
  args: Record<string, unknown>,
  scope: CronMcpScope,
): Promise<Record<string, unknown>> {
  const mapped = mapToolCall(name, args);
  // The cron target is descriptor-bound, NOT model-supplied: strip any
  // dispatcher_id/team_id the tool arguments tried to inject, then apply the
  // process-scoped binding LAST so it always wins. Otherwise a TeamLeader cron
  // MCP could pass an extra team_id (or any cron MCP an extra dispatcher_id) to
  // reach another scheduler, breaking the per-conversational-agent boundary.
  const safeParams = { ...mapped.params };
  delete safeParams['dispatcher_id'];
  delete safeParams['team_id'];
  return forwardAdmin({
    method: mapped.method,
    params: {
      ...safeParams,
      dispatcher_id: scope.dispatcherId,
      ...(scope.teamId !== undefined ? { team_id: scope.teamId } : {}),
    },
    socketPath: scope.socketPath,
    publicErrors: PUBLIC_ERRORS,
    project: mapped.project,
  });
}

type ProjectFn = (value: unknown) => Record<string, unknown>;

function cronJobSchema(): Record<string, unknown> {
  return closedObjectSchema(
    {
      id: { type: 'string' },
      dispatcher_id: { type: 'string' },
      title: { type: 'string' },
      cron: { type: 'string' },
      tz: { type: 'string' },
      recurring: { type: 'boolean' },
      action: OPEN_OBJECT,
      deliver: OPEN_OBJECT,
      enabled: { type: 'boolean' },
      created_at: { type: 'integer' },
      updated_at: { type: 'integer' },
      next_run_at: { type: ['integer', 'null'] },
      last_fired_at: { type: ['integer', 'null'] },
    },
    [
      'id',
      'dispatcher_id',
      'cron',
      'tz',
      'recurring',
      'action',
      'enabled',
      'created_at',
      'updated_at',
      'next_run_at',
      'last_fired_at',
    ],
  );
}

function mapToolCall(
  name: string,
  args: Record<string, unknown>,
): { method: string; params: Record<string, unknown>; project: ProjectFn } {
  switch (name) {
    case 'cron_create':
      return {
        method: 'scheduler.cron.create',
        params: args,
        project: projectCronJob,
      };
    case 'cron_list':
      return { method: 'scheduler.cron.list', params: {}, project: projectList };
    case 'cron_delete':
      return { method: 'scheduler.cron.delete', params: args, project: projectDelete };
    case 'cron_update':
      return {
        method: 'scheduler.cron.update',
        params: args,
        project: projectCronJob,
      };
    case 'cron_run_now':
      return { method: 'scheduler.cron.run_now', params: args, project: projectRunNow };
    default:
      throw new Error(`unknown cron tool '${String(name)}'`);
  }
}

function projectList(value: unknown): Record<string, unknown> {
  const obj = asRecord(value, 'cron list result');
  return { jobs: obj['jobs'] ?? [] };
}

function projectCronJob(value: unknown): Record<string, unknown> {
  const obj = asRecord(value, 'cron job result');
  return {
    id: obj['id'],
    dispatcher_id: obj['dispatcher_id'],
    ...(obj['title'] !== undefined ? { title: obj['title'] } : {}),
    cron: obj['cron'],
    tz: obj['tz'],
    recurring: obj['recurring'],
    action: obj['action'],
    ...(obj['deliver'] !== undefined ? { deliver: obj['deliver'] } : {}),
    enabled: obj['enabled'],
    created_at: obj['created_at'],
    updated_at: obj['updated_at'],
    next_run_at: obj['next_run_at'],
    last_fired_at: obj['last_fired_at'],
  };
}

function projectDelete(value: unknown): Record<string, unknown> {
  const obj = asRecord(value, 'cron delete result');
  return { id: obj['id'], deleted: obj['deleted'] };
}

function projectRunNow(value: unknown): Record<string, unknown> {
  const obj = asRecord(value, 'cron run_now result');
  return { id: obj['id'], status: obj['status'] };
}

function tool(
  name: string,
  description: string,
  properties: Record<string, unknown>,
  required: string[],
  meta: {
    title: string;
    output: Record<string, unknown>;
    annotations: McpToolMetadata['annotations'];
  },
): McpToolMetadata {
  return toolMetadata({
    name,
    title: meta.title,
    description,
    properties,
    required,
    outputSchema: meta.output,
    annotations: meta.annotations,
  });
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}
