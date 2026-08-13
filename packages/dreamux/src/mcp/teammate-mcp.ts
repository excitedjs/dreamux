import type { Readable, Writable } from 'node:stream';

import { adminSocketPath as defaultAdminSocketPath } from '../platform/paths.js';
import { validateDispatcherId } from '../state/dispatcher-id.js';
import { validateTeamId } from '../service/team-collection/types.js';
import {
  MAX_WORKFLOW_MAX_CONCURRENCY,
  MIN_WORKFLOW_MAX_CONCURRENCY,
} from '../service/workflow-service/limits.js';
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
  SUBMISSION_TURN_SCHEMA,
  arrayOf,
  closedObjectSchema,
  forwardAdmin,
  publicErrorRules,
  toolMetadata,
  type PublicErrorRule,
} from './tool-catalog.js';

export type TeamMateMcpCallerKind = 'dispatcher' | 'team_leader';

export interface TeamMateMcpOptions {
  dispatcherId: string;
  callerKind: TeamMateMcpCallerKind;
  teamId?: string;
  adminSocketPath?: string;
  input?: Readable;
  output?: Writable;
  transport?: RunMcpServerOptions['transport'];
  log?: (message: string) => void;
}

interface TeamMateMcpScope {
  dispatcherId: string;
  callerKind: TeamMateMcpCallerKind;
  teamId?: string;
  socketPath: string;
}

const SERVER_IDENTITY = { name: 'dreamux-teammate', version: '0.3.0' };

/** Admin errors whose message is safe to surface as a public tool error. */
const PUBLIC_ERRORS: readonly PublicErrorRule[] = [
  ...publicErrorRules(
    [
      'teammate.spawn',
      'teammate.send',
      'teammate.close',
      'teammate.history',
      'teammate.list',
      'teammate.status',
      'teammate.last',
      'teammate.capabilities',
      'workflow.run',
      'workflow.status',
      'workflow.stop',
      'workflow.list',
    ],
    ['BAD_REQUEST', 'DISPATCHER_NOT_FOUND', 'TEAM_NOT_FOUND'],
  ),
];

export async function runTeamMateMcp(opts: TeamMateMcpOptions): Promise<void> {
  const dispatcherId = validateDispatcherId(opts.dispatcherId);
  const callerKind = validateCallerKind(opts.callerKind);
  const teamId = callerKind === 'team_leader' ? validateRequiredTeamId(opts.teamId) : undefined;
  const socketPath = opts.adminSocketPath ?? defaultAdminSocketPath();
  const scope: TeamMateMcpScope = {
    dispatcherId,
    callerKind,
    ...(teamId !== undefined ? { teamId } : {}),
    socketPath,
  };
  await runMcpServer({
    identity: SERVER_IDENTITY,
    tools: teammateToolDefinitions(scope),
    ...(opts.input !== undefined ? { input: opts.input } : {}),
    ...(opts.output !== undefined ? { output: opts.output } : {}),
    ...(opts.transport !== undefined ? { transport: opts.transport } : {}),
    ...(opts.log !== undefined ? { log: opts.log } : {}),
  });
}

/**
 * Public tool advertisement metadata for the caller kind. Kept as a pure,
 * transport-free builder (the input schema, descriptions, and now the output
 * schema and annotations) so the contract-whitelist and prompt-registry gates
 * can inspect it directly without a running server.
 */
export function teammateTools(
  callerKind: TeamMateMcpCallerKind,
): Array<Record<string, unknown>> {
  return teammateToolMetadata(callerKind) as unknown as Array<Record<string, unknown>>;
}

function teammateToolMetadata(callerKind: TeamMateMcpCallerKind): McpToolMetadata[] {
  const readTools: McpToolMetadata[] = [
    tool('history', 'Search this TeamMate set for recovery (closed included). A compact recovery list keyed by concrete name, not a raw event timeline. Returns { items, next_cursor }.', {
      name: { type: 'string', minLength: 1, maxLength: 64 },
      status: {
        type: 'string',
        enum: ['starting', 'running', 'degraded', 'closed', 'stopped'],
      },
      agent_runtime: { type: 'string', minLength: 1, maxLength: 128 },
      repo: { type: 'string', minLength: 1, maxLength: 4096 },
      grep: { type: 'string', minLength: 1, maxLength: 500 },
      since: { type: 'integer' },
      until: { type: 'integer' },
      limit: { type: 'integer', minimum: 1, maximum: 100 },
      cursor: { type: 'string', minLength: 1, maxLength: 1000 },
    }, [], {
      title: 'Search TeamMates',
      output: closedObjectSchema(
        { items: arrayOf(OPEN_OBJECT), next_cursor: { type: ['string', 'null'] } },
        ['items', 'next_cursor'],
      ),
      annotations: READ_ONLY_ANNOTATIONS,
    }),
    tool('list', 'List this TeamMate set (compact rows: concrete name, status, agent runtime, intent essentials).', {}, [], {
      title: 'List TeamMates',
      output: closedObjectSchema({ teammates: arrayOf(OPEN_OBJECT) }, ['teammates']),
      annotations: READ_ONLY_ANNOTATIONS,
    }),
    tool('status', 'Read one TeamMate identity and live runtime status by its concrete name.', {
      name: { type: 'string', minLength: 1, maxLength: 64 },
    }, ['name'], {
      title: 'Read TeamMate status',
      output: closedObjectSchema({ teammate: OPEN_OBJECT }, ['teammate']),
      annotations: READ_ONLY_ANNOTATIONS,
    }),
    tool('last', 'Read a TeamMate\'s most recent settled turn(s) by concrete name. Reads the TeamMate record first, then folds the recent settled turns from its per-name turns archive; it never starts or resumes a runtime, so it works for a closed/stopped TeamMate. This is the fallback when a completion was not delivered. turns defaults to 1 (range 1..5); the newest turn is last.', {
      name: { type: 'string', minLength: 1, maxLength: 64 },
      turns: { type: 'integer', minimum: 1, maximum: 5 },
    }, ['name'], {
      title: 'Read recent TeamMate turns',
      output: closedObjectSchema(
        {
          teammate: OPEN_OBJECT,
          requested_turns: { type: 'integer' },
          returned_turns: { type: 'integer' },
          turns: arrayOf(OPEN_OBJECT),
        },
        ['teammate', 'requested_turns', 'returned_turns', 'turns'],
      ),
      annotations: READ_ONLY_ANNOTATIONS,
    }),
    tool('get_capabilities', 'List TeamMate verbs and spawnable agent runtime ids.', {}, [], {
      title: 'List TeamMate capabilities',
      output: closedObjectSchema(
        { verbs: arrayOf({ type: 'string' }), agent_runtimes: arrayOf(OPEN_OBJECT) },
        ['verbs', 'agent_runtimes'],
      ),
      annotations: READ_ONLY_ANNOTATIONS,
    }),
  ];
  const spawnProperties: Record<string, unknown> = {
    name_prefix: { type: 'string', minLength: 1, maxLength: 64 },
    prompt: { type: 'string', minLength: 1, maxLength: 20000 },
    agent_runtime: {
      type: 'string',
      description:
        'Spawnable agents[].id returned by get_capabilities.agent_runtimes[].id.',
    },
    intent: { type: 'string', minLength: 1, maxLength: 2000 },
    identity: { type: 'string', minLength: 1, maxLength: 4000 },
  };
  if (callerKind === 'dispatcher') {
    spawnProperties['repo'] = repoInputSchema();
  }
  const spawnDescription = callerKind === 'dispatcher'
    ? 'Start a resumable TeamMate agent managed by this dispatcher and submit its first turn. name_prefix is the requested label; spawn RETURNS the concrete, never-reused name that all later send/status/last/close MUST use. Use get_capabilities.agent_runtimes[].id as agent_runtime. intent is required: it is the durable recovery subject. repo is optional: omit it to let Dreamux allocate a fresh per-TeamMate work directory, or pass { mode: reuse-cwd | managed, path?, base_ref?, branch?, slug?, cleanup? } to choose an existing path or create a managed git worktree.'
    : 'Start a resumable TeamMate agent in this Team\'s shared workspace and submit its first turn. name_prefix is the requested label; spawn RETURNS the concrete, never-reused name that all later send/status/last/close MUST use. Use get_capabilities.agent_runtimes[].id as agent_runtime. intent is required: it is the durable recovery subject. Coordinate edits so only one TeamMate writes the shared workspace unless the work is read-only or edits are independent. This tool does not accept a repo parameter.';
  const teammateReceiptSchema = closedObjectSchema(
    { teammate: OPEN_OBJECT, turn: SUBMISSION_TURN_SCHEMA },
    ['teammate', 'turn'],
  );
  const workflowTools: McpToolMetadata[] = [
    tool(
      'workflow_run',
      'Load the bundled `workflow` skill before use. Start a deterministic multi-agent workflow from an inline module script (`script`) or a local file path (`scriptPath`) and return { run_id } immediately; Dreamux pushes one terminal completion when the run finishes.',
      {
        script: { type: 'string', minLength: 1 },
        scriptPath: { type: 'string', minLength: 1 },
        args: {
          type: ['object', 'array', 'string', 'number', 'boolean', 'null'],
          description:
            'Optional direct JSON value available as the script-global args. ' +
            'Pass objects and arrays directly; do not JSON.stringify them.',
        },
        max_concurrency: {
          type: 'integer',
          minimum: MIN_WORKFLOW_MAX_CONCURRENCY,
          maximum: MAX_WORKFLOW_MAX_CONCURRENCY,
        },
      },
      [],
      {
        title: 'Run a workflow',
        output: closedObjectSchema({ run_id: { type: 'string' } }, ['run_id']),
        annotations: MUTATING_ANNOTATIONS,
        inputConstraints: {
          anyOf: [{ required: ['script'] }, { required: ['scriptPath'] }],
        },
      },
    ),
    tool(
      'workflow_status',
      'Load the bundled `workflow` skill before use. Read phase, agent progress, concrete TeamMate names, and terminal result for one workflow run.',
      { run_id: workflowRunIdSchema() },
      ['run_id'],
      {
        title: 'Read workflow status',
        output: workflowRunSchema(),
        annotations: READ_ONLY_ANNOTATIONS,
      },
    ),
    tool(
      'workflow_stop',
      'Load the bundled `workflow` skill before use. Stop one running workflow and return its resulting status.',
      { run_id: workflowRunIdSchema() },
      ['run_id'],
      {
        title: 'Stop a workflow',
        output: closedObjectSchema(
          { run_id: { type: 'string' }, status: { type: 'string' } },
          ['run_id', 'status'],
        ),
        annotations: DESTRUCTIVE_ANNOTATIONS,
      },
    ),
    tool(
      'workflow_list',
      'Load the bundled `workflow` skill before use. List workflow runs in the current dispatcher or TeamLeader caller scope.',
      {},
      [],
      {
        title: 'List workflows',
        output: closedObjectSchema({ runs: arrayOf(workflowRunSchema()) }, ['runs']),
        annotations: READ_ONLY_ANNOTATIONS,
      },
    ),
  ];
  return [
    tool(
      'spawn',
      spawnDescription,
      spawnProperties,
      ['name_prefix', 'prompt', 'intent'],
      {
        title: 'Spawn a TeamMate',
        output: teammateReceiptSchema,
        annotations: MUTATING_ANNOTATIONS,
      },
    ),
    tool('send', 'Send a turn to a TeamMate agent; reopens a closed one from the runtime-native session_id recorded on it (interpreted by its agent_runtime) first. Pass intent to update the recorded recovery subject before the turn.', {
      name: { type: 'string', minLength: 1, maxLength: 64 },
      prompt: { type: 'string', minLength: 1, maxLength: 20000 },
      intent: { type: 'string', minLength: 1, maxLength: 2000 },
    }, ['name', 'prompt'], {
      title: 'Send a TeamMate turn',
      output: teammateReceiptSchema,
      annotations: MUTATING_ANNOTATIONS,
    }),
    tool('close', 'Close a named TeamMate agent and retain its history; send reopens it later. note is required: it records why a recoverable session was stopped.', {
      name: { type: 'string', minLength: 1, maxLength: 64 },
      note: { type: 'string', minLength: 1, maxLength: 2000 },
    }, ['name', 'note'], {
      title: 'Close a TeamMate',
      output: closedObjectSchema({ teammate: OPEN_OBJECT }, ['teammate']),
      annotations: DESTRUCTIVE_ANNOTATIONS,
    }),
    ...readTools,
    ...workflowTools,
  ];
}

/**
 * The full caller-bound tool set: metadata plus the handler closure that maps
 * validated args to the canonical admin method, applies descriptor-bound scope
 * last, and projects the admin value into the public MCP result.
 */
function teammateToolDefinitions(scope: TeamMateMcpScope): McpToolDefinition[] {
  return teammateToolMetadata(scope.callerKind).map((metadata) => ({
    ...metadata,
    handler: (args) => callTool(metadata.name, args, scope),
  }));
}

async function callTool(
  name: string,
  args: Record<string, unknown>,
  scope: TeamMateMcpScope,
): Promise<Record<string, unknown>> {
  const mapped = mapToolCall(name, args);
  return forwardAdmin({
    method: mapped.method,
    // Descriptor-bound scope is applied LAST so model-supplied properties can
    // never override the dispatcher/team binding this process serves.
    params: {
      dispatcher_id: scope.dispatcherId,
      ...mapped.params,
      caller_kind: scope.callerKind,
      ...(scope.teamId !== undefined ? { team_id: scope.teamId } : {}),
    },
    socketPath: scope.socketPath,
    publicErrors: PUBLIC_ERRORS,
    project: mapped.project,
  });
}

type ProjectFn = (value: unknown) => Record<string, unknown>;

function mapToolCall(
  name: string,
  args: Record<string, unknown>,
): { method: string; params: Record<string, unknown>; project: ProjectFn } {
  switch (name) {
    case 'spawn':
      return {
        method: 'teammate.spawn',
        params: args,
        project: projectTeammateTurn,
      };
    case 'send':
      return { method: 'teammate.send', params: args, project: projectTeammateTurn };
    case 'close':
      return { method: 'teammate.close', params: args, project: projectTeammate };
    case 'history':
      return { method: 'teammate.history', params: args, project: projectHistory };
    case 'list':
      return { method: 'teammate.list', params: {}, project: projectList };
    case 'status':
      return { method: 'teammate.status', params: args, project: projectStatus };
    case 'last':
      return { method: 'teammate.last', params: args, project: projectLast };
    case 'get_capabilities':
      return { method: 'teammate.capabilities', params: {}, project: projectCapabilities };
    case 'workflow_run':
      return { method: 'workflow.run', params: args, project: projectWorkflowRun };
    case 'workflow_status':
      return { method: 'workflow.status', params: args, project: projectWorkflowStatus };
    case 'workflow_stop':
      return { method: 'workflow.stop', params: args, project: projectWorkflowStop };
    case 'workflow_list':
      return { method: 'workflow.list', params: {}, project: projectWorkflowList };
    default:
      throw new Error(`unknown TeamMate tool '${String(name)}'`);
  }
}

function projectTeammateTurn(value: unknown): Record<string, unknown> {
  const obj = asRecord(value, 'teammate result');
  return { teammate: obj['teammate'], turn: obj['turn'] };
}

function projectTeammate(value: unknown): Record<string, unknown> {
  const obj = asRecord(value, 'teammate result');
  return { teammate: obj['teammate'] };
}

function projectHistory(value: unknown): Record<string, unknown> {
  const obj = asRecord(value, 'history result');
  return { items: obj['items'] ?? [], next_cursor: obj['next_cursor'] ?? null };
}

function projectList(value: unknown): Record<string, unknown> {
  const obj = asRecord(value, 'list result');
  return { teammates: obj['teammates'] ?? [] };
}

function projectStatus(value: unknown): Record<string, unknown> {
  const obj = asRecord(value, 'status result');
  return { teammate: obj['teammate'] };
}

function projectLast(value: unknown): Record<string, unknown> {
  const obj = asRecord(value, 'last result');
  return {
    teammate: obj['teammate'],
    requested_turns: obj['requested_turns'],
    returned_turns: obj['returned_turns'],
    turns: obj['turns'] ?? [],
  };
}

function projectCapabilities(value: unknown): Record<string, unknown> {
  const obj = asRecord(value, 'capabilities result');
  return { verbs: obj['verbs'] ?? [], agent_runtimes: obj['agent_runtimes'] ?? [] };
}

function projectWorkflowRun(value: unknown): Record<string, unknown> {
  const obj = asRecord(value, 'workflow run result');
  return { run_id: obj['run_id'] };
}

function projectWorkflowStop(value: unknown): Record<string, unknown> {
  const obj = asRecord(value, 'workflow stop result');
  return { run_id: obj['run_id'], status: obj['status'] };
}

function projectWorkflowStatus(value: unknown): Record<string, unknown> {
  const obj = asRecord(value, 'workflow status result');
  return projectWorkflowRecord(obj);
}

function projectWorkflowList(value: unknown): Record<string, unknown> {
  const obj = asRecord(value, 'workflow list result');
  const runs = obj['runs'];
  if (!Array.isArray(runs)) return { runs: [] };
  return {
    runs: runs.map((run) => projectWorkflowRecord(asRecord(run, 'workflow list row'))),
  };
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
    inputConstraints?: Record<string, unknown>;
  },
): McpToolMetadata {
  return toolMetadata({
    name,
    title: meta.title,
    description,
    properties,
    required,
    ...(meta.inputConstraints !== undefined
      ? { inputConstraints: meta.inputConstraints }
      : {}),
    outputSchema: meta.output,
    annotations: meta.annotations,
  });
}

function workflowRunIdSchema(): Record<string, unknown> {
  return {
    type: 'string',
    minLength: 1,
    pattern: '^[a-z0-9-]+$',
  };
}

function workflowRunSchema(): Record<string, unknown> {
  return closedObjectSchema(
    {
      version: { type: 'integer', const: 1 },
      run_id: workflowRunIdSchema(),
      dispatcher_id: { type: 'string' },
      team_id: { type: ['string', 'null'] },
      caller_kind: { type: 'string', enum: ['dispatcher', 'team_leader'] },
      script_hash: { type: 'string' },
      status: {
        type: 'string',
        enum: ['running', 'completed', 'failed', 'stopped'],
      },
      max_concurrency: { type: 'integer' },
      phase: { type: ['string', 'null'] },
      last_log: { type: ['string', 'null'] },
      agents: arrayOf(workflowAgentSchema()),
      // This is the one intentionally open JSON-valued extension field.
      result: {},
      error: { type: ['string', 'null'] },
      created_at: { type: 'integer' },
      updated_at: { type: 'integer' },
      ended_at: { type: ['integer', 'null'] },
    },
    [
      'version',
      'run_id',
      'dispatcher_id',
      'team_id',
      'caller_kind',
      'script_hash',
      'status',
      'max_concurrency',
      'phase',
      'last_log',
      'agents',
      'result',
      'error',
      'created_at',
      'updated_at',
      'ended_at',
    ],
  );
}

function workflowAgentSchema(): Record<string, unknown> {
  return closedObjectSchema(
    {
      index: { type: 'integer' },
      name: { type: ['string', 'null'] },
      label: { type: ['string', 'null'] },
      phase: { type: ['string', 'null'] },
      turn_id: { type: ['string', 'null'] },
      status: {
        type: 'string',
        enum: ['queued', 'running', 'completed', 'failed', 'stopped'],
      },
      created_at: { type: 'integer' },
      settled_at: { type: ['integer', 'null'] },
    },
    [
      'index',
      'name',
      'label',
      'phase',
      'turn_id',
      'status',
      'created_at',
      'settled_at',
    ],
  );
}

function projectWorkflowRecord(obj: Record<string, unknown>): Record<string, unknown> {
  return {
    version: obj['version'],
    run_id: obj['run_id'],
    dispatcher_id: obj['dispatcher_id'],
    team_id: obj['team_id'],
    caller_kind: obj['caller_kind'],
    script_hash: obj['script_hash'],
    status: obj['status'],
    max_concurrency: obj['max_concurrency'],
    phase: obj['phase'],
    last_log: obj['last_log'],
    agents: obj['agents'],
    result: obj['result'],
    error: obj['error'],
    created_at: obj['created_at'],
    updated_at: obj['updated_at'],
    ended_at: obj['ended_at'],
  };
}

export function repoInputSchema(): Record<string, unknown> {
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      mode: { type: 'string', enum: ['reuse-cwd', 'managed'] },
      path: { type: 'string', minLength: 1, maxLength: 4096 },
      base_ref: { type: 'string', minLength: 1, maxLength: 256 },
      branch: { type: 'string', minLength: 1, maxLength: 256 },
      slug: { type: 'string', minLength: 1, maxLength: 64 },
      cleanup: { type: 'string', enum: ['keep', 'delete-on-close'] },
    },
    required: ['mode'],
  };
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function validateCallerKind(value: string): TeamMateMcpCallerKind {
  if (value === 'dispatcher' || value === 'team_leader') return value;
  throw new Error("caller kind must be 'dispatcher' or 'team_leader'");
}

function validateRequiredTeamId(value: string | undefined): string {
  if (value === undefined || value === '') {
    throw new Error('team_leader caller requires team id');
  }
  return validateTeamId(value);
}
